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
pnpm codegen          # Run graphql-codegen against research/graphql/schema.graphql
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

TTCtl uses session cookies (no Bearer tokens, no API keys). The user provides
credentials in `.ttctl.yaml` via two valid forms:

```yaml
# Form A — 1Password reference (recommended)
auth: "op://Personal/ttctl"

# Form B — literal (dev/testing only, discouraged)
auth:
  email: "you@example.com"
  password: "hunter2"
```

The Zod schema in `packages/core/src/config.ts` is polymorphic on `auth`'s type
(string vs object). It rejects per-field op:// references
(`auth: "op://Personal/ttctl/username"` is NOT supported).

After sign-in via `EmailPasswordSignIn` (persisted-query mode), session cookies
are stored at `~/.ttctl/session.cookies` (or `$XDG_DATA_HOME/ttctl/session.cookies`)
in Mozilla format with `0600` permissions.

There are NO profiles. TTCtl operates against the user's own Toptal Talent
profile, period.

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

### Troubleshooting: `cf_clearance` 403

When an impersonated surface (`talent-profile` or `scheduler`) returns HTTP
403, `impersonatedTransport` throws `Cf403Error` (exported from
`@ttctl/core`) instead of returning a `TransportResponse`. The error message
walks the user through manual cookie refresh — `cf_clearance` is JA3 + IP
bound and cannot be regenerated programmatically because Cloudflare's
bot-management challenge requires a real browser session.

CLI commands that call into the impersonated transport must catch
`Cf403Error` (or let it propagate) so the message reaches the user verbatim
rather than being collapsed into a generic "request failed" string.
`talent-profile` and `scheduler` live in distinct Cloudflare zones, so the
refresh entry-point differs per surface (`https://talent.toptal.com/` vs
`https://scheduler.toptal.com/`); `Cf403Error.formatMessage` already swaps
the URL based on `surface`. See [issue #4](https://github.com/alexey-pelykh/ttctl/issues/4).

## Reverse-Engineering Artifacts

The Toptal Talent platform has no public API. TTCtl is built from artifacts in
the **private** `ttctl/research` repository — APK decompilation, GraphQL
operation extraction, schema synthesis, ADRs covering TLS impersonation
(ADR-001), cookie-jar auth (ADR-002), safe-mode mutation interceptor (ADR-003),
operation extraction strategy (ADR-004).

The `research/` repo's artifacts are the source for `pnpm codegen` —
`graphql-codegen` reads `research/graphql/schema.graphql` (synthesized SDL) and
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
