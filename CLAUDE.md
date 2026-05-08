# TTCtl — Claude Instructions

> Development guidelines for AI-assisted development of TTCtl

## Project Overview

**TTCtl** is an unofficial CLI and MCP server for the [Toptal Talent](https://talent.toptal.com)
platform, published as `ttctl` on npm. See [README](README.md) for the project's
use policy and disclaimer (the README is authoritative; do not duplicate the
disclaimer enumeration in other files — link to it).

- **License**: AGPL-3.0-only
- **Runtime**: Node.js >= 24, ESM only
- **Language**: TypeScript (strict mode, ES2024 target, NodeNext modules)

## Repository Structure

```
ttctl/
  packages/
    core/    → @ttctl/core  (Toptal API client, auth, services, transport)
    cli/     → @ttctl/cli   (CLI commands, program definition)
    mcp/     → @ttctl/mcp   (MCP server)
    ttctl/   → ttctl        (umbrella: CLI + MCP compose)
    e2e/     → @ttctl/e2e   (private, E2E tests against live Toptal session)
  scripts/
    check-licenses.js       (SPDX license compliance)
```

## Package Dependency Graph

```
core ← cli ← ttctl (umbrella)
core ← mcp ←┘
core ← cli ← e2e (private)
core ← mcp ←┘
```

- `core` has no internal dependencies (leaf package)
- `cli` and `mcp` depend on `core`
- `ttctl` (umbrella) composes `cli` + `mcp`
- `e2e` depends on `core`, `cli`, and `mcp` (not the umbrella)

## Development Commands

```sh
pnpm install          # Install dependencies
pnpm build            # Build all packages (via Turbo)
pnpm test             # Run unit tests
pnpm test:e2e         # Run E2E tests (sequential, requires real session)
pnpm lint             # Lint all packages and root config files
pnpm license-check    # Verify dependency licenses
pnpm codegen          # Run graphql-codegen against research/graphql/gateway/schema.graphql
pnpm dev              # Watch mode
```

## Conventions

### Source Files

Every `.ts` and `.js` file MUST start with:

```ts
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH
```

ESLint enforces this via `@tony.ganchev/eslint-plugin-header`.

### Commit Messages

- Format: `(type) lowercase message` — e.g. `(feat) add timesheet sync`
- Types: `feat`, `fix`, `chore`, `docs`, `ci`, `refactor`, `test`
- Reference issues: `(fix) resolve cookie persistence (#12)`
- One logical change per commit

### Formatting

- Prettier with default configuration (no overrides)
- EditorConfig: 2-space indent for `.ts`, `.js`, `.json`, `.yaml`/`.yml`; LF line endings; UTF-8
- Max line length: 120 (EditorConfig)

### Dependencies

- Production dependencies must have licenses compatible with AGPL-3.0-only
- Allowed licenses: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, Unlicense, CC0-1.0, CC-BY-3.0, CC-BY-4.0 (see `scripts/check-licenses.js`)
- Use `workspace:^` for inter-package dependencies
- Use `catalog:` references in `pnpm-workspace.yaml` for shared version management
- Pin GitHub Actions to commit SHAs with version comments (e.g., `# v6.0.2`)

### Testing

- Unit tests: `*.test.ts` (co-located with source)
- E2E tests: `*.e2e.test.ts` (require real Toptal session)

### TypeScript

- Strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- Use `verbatimModuleSyntax` (explicit `type` imports)
- All packages use `composite: true` with project references
- ESLint uses `tseslint.configs.strictTypeChecked` (strict type-aware rules)
- Explicit `types: ["node"]` at base — TS 6 narrowed default ambient resolution; opt-in required for Node globals

## Auth Model

TTCtl uses a session bearer **token** (no cookies, no API keys), stored
inline in the same YAML config file as the credentials (single-file
model — post-#107). The user provides credentials and (optionally) a
captured token in one structured `auth` block:

```yaml
# Form A — 1Password reference for credentials (recommended; signin populates auth.token)
auth:
  credentials: "op://Personal/ttctl"

# Form A with explicit account (for users with multiple `op` accounts)
auth:
  credentials: "op://my-account/Personal/ttctl"

# Form B — literal credentials (dev/testing only, discouraged)
auth:
  credentials:
    username: "you@example.com" # value is the Toptal email; field name matches 1P USERNAME purpose
    password: "hunter2"

# Form C — token only (no credentials; out-of-band bootstrap, E2E sandbox)
auth:
  token: "user_<24hex>_<20alnum>"

# Form D — credentials + token (post-signin Form A or B)
auth:
  credentials: "op://Personal/ttctl"
  token: "user_<24hex>_<20alnum>"
```

The Zod schema in `packages/core/src/config.ts` ships TWO schemas:
`ConfigLoadSchema` (strict — rejects empty `auth: {}`, unknown fields,
malformed credentials) used by `loadConfigFile`; and `ConfigWriteSchema`
(permissive — permits empty mid-lifecycle) used by `persistAuthToken` /
`clearAuthToken`. `superRefine` produces field-named error messages
("auth.credentials.password: …") instead of zod's naked "Invalid input".

The 1Password reference accepts both `op://VAULT/ITEM` and
`op://ACCOUNT/VAULT/ITEM` (3-segment); the latter forwards `--account ACCOUNT`
to `op item get`. Per-field references (`op://Personal/ttctl/Section/username`,
4+ segments) are NOT supported — TTCtl always reads `username` and `password`
fields from a single LOGIN-category item by `purpose: USERNAME` /
`purpose: PASSWORD`.

### Lifecycle

`ttctl auth signin` resolves the source credentials, calls
`EmailPasswordSignIn` (persisted-query mode against the mobile gateway),
captures the bearer token, and writes it BACK into the SAME YAML file
under `auth.token` via `persistAuthToken` (`yaml.parseDocument` + `setIn`

- atomic temp-rename + chmod 0o600). Comments, key order, and scalar
  styles in the source YAML are preserved.

`ttctl auth signout` removes the `auth.token` field via `clearAuthToken`
(`deleteIn`). The field is REMOVED, not emptied to `""` — empty-string
tokens are treated as data and the security architecture mandates
absence-not-emptiness for revocation.

`ttctl auth status` and all authenticated commands read
`config.auth.token` directly from the parsed config — no separate file
load. Every subsequent GraphQL request authenticates by replaying
`Authorization: Token token=<X>`. See
`research/docs/decisions/ADR-005-token-auth.md` for the canonical
cross-surface auth-model decision and `research/notes/02-auth-and-clients.md`
for the empirical evidence.

Cookies are NOT load-bearing on any surface TTCtl currently uses
(`mobile-gateway`, `talent-profile`). Chrome TLS impersonation alone passes
Cloudflare in the happy path on `talent-profile`; no `cf_clearance` cookie is
required. (Scheduler has its own bearer chain — out of scope here, see
`research/notes/12-scheduler-auth-chain.md`.)

### Security gates (enforced by core)

- **File mode 0o600 on persist** — `persistAuthToken` writes the temp
  file at 0o600 and chmods defensively before the rename.
- **Refuse-load on world-writable** — `loadConfigFile` rejects configs
  with mode bits `& 0o002 != 0` (covers 0666, 0777). Closes a TOCTOU
  window on credential reads.
- **Refuse-write on symlink** — `persistAuthToken` `lstat`s the target
  and refuses `S_ISLNK`. Closes the swap-`~/.ttctl.yaml`-for-symlink
  attack. Load-side reads via symlink are permitted (read-only path,
  no TOCTOU on write).
- **Refuse-write under sync-root** — `persistAuthToken` rejects paths
  under `~/Library/Mobile Documents/`, `~/Dropbox/`, `~/iCloud Drive/`,
  `~/OneDrive/`, `~/Google Drive/`, `~/Box/`, `~/Box Sync/` so the
  captured bearer doesn't replicate off-host. Sibling-name guard
  (`~/DropboxOther/` does NOT match `~/Dropbox/`).
- **Mtime drift detection** — `persistAuthToken` re-stats the config
  immediately before the rename and refuses if the mtime changed during
  the write window (catches mid-session backup-restore or a concurrent
  write). Cross-process locking (CLI + long-running MCP) is out of
  scope for the current PR; an `flock` integration point is stubbed for
  a follow-up.
- **Bearer rescue on persist failure** — `AuthTokenPersistError`
  surfaces the captured bearer verbatim in the message so the operator
  can save it manually if the post-signin write fails (read-only FS,
  full disk).

There are NO profiles. TTCtl operates against the user's own Toptal Talent
profile, period.

### Config File Resolution

`resolveConfig()` in `packages/core/src/config.ts` selects ONE config-file
path per invocation, in this precedence (highest → lowest):

1. **Explicit `path` argument** — `resolveConfig({ path })` from the
   CLI's `--config <path>` global flag (#93). Used verbatim by core; the
   CLI layer pre-checks existence at invocation time and surfaces
   `ConfigError(code: NO_CREDS)` if missing, before any sub-command runs.
2. **`TTCTL_CONFIG_FILE` env var** — same verbatim treatment as the
   explicit arg. Useful for CI, multi-config setups, and direnv.
3. **`~/.ttctl.yaml`** — POSIX home dotfile; only fallback.

The CWD `./.ttctl.yaml` is NOT auto-discovered (closed in #92). XDG paths
(`$XDG_CONFIG_HOME/ttctl/config.yaml`, `~/.config/ttctl/config.yaml`) are
NOT consulted (closed in #107 — the single-file model places the captured
bearer in the same YAML, so `~/.ttctl.yaml` is the canonical home location).

When the resolution chain finds nothing AND a CWD `.ttctl.yaml` exists,
`resolveConfig` throws `ConfigError(code: "NO_CREDS")` with a deprecation
note pointing at `TTCTL_CONFIG_FILE` or the `--config` flag — the typical
direnv recipe is:

```sh
# .envrc in your project root (requires `direnv` installed and `direnv allow` run)
export TTCTL_CONFIG_FILE="$PWD/.ttctl.yaml"
```

`ConfigError` carries a `code` discriminator —
`'NO_CREDS' | 'PARSE' | 'VALIDATION' | 'PERMISSION'` — so CLI/MCP error
handlers can branch on the code rather than string-match the message. The
CLI surfaces it as the JSON wire-format `code` field; the MCP server
includes it in the rendered tool-error text.

`loadConfigFile` emits a stderr warning when the config file is group-
or other-readable on POSIX (`mode & 0o077 != 0` AND not world-writable).
World-writable files (`mode & 0o002 != 0`) are REFUSED outright with
`ConfigError(PERMISSION)`. The recommended posture is
`chmod 600 ~/.ttctl.yaml` — the file may carry a 1Password reference
(low risk on its own), a plaintext password (Form B), and/or a captured
bearer token (Form C/D, after signin).

## TLS Impersonation

The Toptal Talent platform exposes three GraphQL endpoints:

- `https://www.toptal.com/gateway/graphql/talent/graphql` — mobile gateway, accepts plain HTTPS
- `https://www.toptal.com/api/talent_profile/graphql` — web profile editor, **Cloudflare-protected** (requires Chrome TLS fingerprint impersonation)
- `https://scheduler.toptal.com/api/graphql` — scheduler, separate Cloudflare zone

TTCtl uses two transports in `packages/core/src/transport.ts`:

- **Stock** (`undici`) for the mobile gateway
- **Impersonated** (`node-wreq` with `chrome_146` profile, BoringSSL via Rust)
  for the Cloudflare-protected endpoints

Pin both `User-Agent: Chrome/146` and `node-wreq` profile `chrome_146` together;
identity-catalog freshness is critical (see `tls-fingerprinting` skill).

### Troubleshooting: Cloudflare 403

Empirically, Chrome TLS impersonation alone passes Cloudflare on the surfaces
TTCtl currently uses (`talent-profile`, `scheduler`). A 403 from these
surfaces therefore means Cloudflare has flipped a feature flag (e.g., a new
Turnstile challenge or bot-management heuristic) that we don't currently
handle.

When this happens, `impersonatedTransport` throws `Cf403Error` (exported from
`@ttctl/core`) instead of returning a `TransportResponse`. There is no
documented manual workaround — the error message asks the user to file an
issue at https://github.com/alexey-pelykh/ttctl/issues with the surface
name and a timestamp so we can investigate and re-engineer the response.

CLI commands that call into the impersonated transport must catch
`Cf403Error` (or let it propagate) so the message reaches the user verbatim
rather than being collapsed into a generic "request failed" string.

## Reverse-Engineering Artifacts

The Toptal Talent platform has no public API. TTCtl is built from artifacts in
the **private** `ttctl/research` repository — APK decompilation, GraphQL
operation extraction, schema synthesis, ADRs covering TLS impersonation
(ADR-001), cookie-jar auth (ADR-002), safe-mode mutation interceptor (ADR-003),
operation extraction strategy (ADR-004).

The `research/` repo's artifacts are the source for `pnpm codegen` —
`graphql-codegen` reads `research/graphql/gateway/schema.graphql` (synthesized SDL) and
operation documents to generate typed clients. The codegen config
(`codegen.config.ts`) assumes `research/` is a sibling directory at
`../research/` relative to the ttctl repo root. The generated TypeScript at
`packages/core/src/__generated__/graphql.ts` is committed so contributors
without research-repo access can build and consume the types; re-running
`pnpm codegen` requires the sibling working copy and overwrites the file.

## CI/CD

- **CI**: Runs on push/PR to `main`; 3-OS matrix (ubuntu, macos, windows); builds, lints, license-checks, tests
- **Release**: Triggered by GitHub Release publish; validates, stamps version from git tag, publishes to npm with provenance
- **Setup**: Composite action at `.github/actions/setup/` (pnpm + Node.js 24 + frozen lockfile + Turbo cache)

### Branch Protection

The `main` branch is protected with the following rules:

- **Require pull request before merging**
- **Require status checks to pass**: The `CI` job (ci-gate) must pass before merging
- **Require branches to be up to date**: Feature branches must be rebased on latest `main`
- **Admin bypass**: Admins may bypass branch protection rules when necessary
