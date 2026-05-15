# TTCtl — Claude Instructions

> Development guidelines for AI-assisted development of TTCtl

## Project Overview

**TTCtl** is an unofficial CLI and MCP server for the [Toptal Talent](https://talent.toptal.com)
platform, published as `ttctl` on npm. See [README](README.md) for the project's
use policy and disclaimer (the README is authoritative; do not duplicate the
disclaimer enumeration in other files — link to it).

- **License**: AGPL-3.0-only
- **Runtime**: Node.js >= 22.19.0, ESM only
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

## Schema/contract validation rule

Any implementation that consumes a research note marked **INFERRED**,
**UNVERIFIED**, or that fills a documented schema gap (e.g. a
`Scalars.Unknown` mutation input, an enum with a `_UNKNOWN` placeholder, a
Pattern N input shape) **MUST** ship with a live integration test
(`*.e2e.test.ts`, gated by `TTCTL_E2E=1`) that exercises the wire format
BEFORE the change merges.

Unit tests with mocks are insufficient because:

- Mocks accept whatever shape the code sends; they cannot detect contract
  mismatches.
- The whole point of "INFERRED" is that the wire format is best-effort —
  the only authority is the live API.

Examples of triggers:

- Any new mutation against `talent_profile/graphql` whose input shape was
  inferred from `research/notes/10-mutation-input-patterns.md` patterns.
  Historical examples: **#59** — `auth.ts` shipped on the inferred claim
  that cookies sufficed for `talent_schema`, with the auth-header
  injection point flagged unverified (R8-merged decompile gap); unit
  tests passed against mocks, the live API rejected. **#60** —
  `UPDATE_BASIC_INFO` shipped using Pattern 1's input wrapper key, which
  was wrong for that specific operation; unit tests passed, the live API
  would have rejected on first use.
- Any new query against any surface whose response type is synthesized
  from the schema-coverage gap region (~370 ops without live captures
  per `research/notes/11`).
- Any new GraphQL operation NOT present in `codegen.config.ts` documents
  at the time of writing — hand-rolling the operation IS the inference
  act.

The E2E test must hit the live API and assert at least:

- Operation succeeds (HTTP 200, no GraphQL `errors[]`).
- Response contains the asserted fields (positive shape check).
- For mutations: round-trip the change and verify it persisted (where
  reasonable).

E2E tests are gated by `TTCTL_E2E=1` and never run in CI (no live
credentials in CI). Validation happens locally; the PR description must
include a transcript or screenshot of the passing E2E run.

### Code-review checklist

PRs touching any of the following must explicitly state in the PR body
whether this rule was triggered and, if so, how it was satisfied (E2E
test path + transcript):

- `packages/core/src/auth.ts`
- Any file under `packages/core/src/services/profile/` (the
  talent-profile domain services — e.g. `services/profile/basic/index.ts`
  for `UPDATE_BASIC_INFO`)
- Any new GraphQL operation — query, mutation, or subscription — whose
  document was hand-authored rather than generated from a live capture

If the rule was NOT triggered (e.g. the change touches only types,
refactors without altering wire format, or otherwise does not introduce
an inferred contract), state that explicitly. Silence is not
satisfaction.

For any new GraphQL operation (regardless of how the document was
authored), the PR body must additionally declare the wire-validation
track choice — `T1` / `T2` / `NEITHER` — per § Track 1 vs Track 2
disposition below. This is an independent gate from the schema/contract
rule above; both apply.

### E2E coverage gate

`scripts/check-e2e-coverage.ts` (wired into `pnpm lint`) is the
structural CI-time mirror of the review-time rule above. It walks
`packages/core/src/**` for literal `operationName: "X"` invocations
against `talent-profile` or `scheduler` surfaces and cross-references
against `// e2e-covers: X` directives in `packages/e2e/src/**/*.e2e.test.ts`.

- **Cover** an operation by adding `// e2e-covers: <OpName>` (or a
  comma-separated list) to the e2e file that exercises it.
- **Exempt** an operation by placing `// e2e-exempt: <reason>` within
  five lines preceding the `operationName:` literal.
- **Default mode** is warn-only (exit 0). Set
  `E2E_COVERAGE_STRICT=1` (or pass `--strict`) to fail on uncovered
  in-scope operations once the existing gap is paid down.

Helper-wrapped invocations that pass `operationName` as a positional
parameter (e.g. `callTalentProfile(token, "X", ...)`, `callGateway(token, "X", ...)`)
are detected via an allowlist of registered helper names + their
hardcoded surface — see `HELPER_SIGNATURES` in
`scripts/check-e2e-coverage.ts`. Adding a new helper that crosses a
surface boundary requires registering its name + surface there; the
script header documents the protocol. For one-off dynamic-dispatch
sites the helper can't model, place an `// e2e-exempt: <reason>`
marker at the call site.

### Wire-shape snapshots

Post-merge wire-drift detection sibling to the rule above. E2E runs
that call `assertWireShapeStable(...)` diff the live response shape
against a committed `packages/e2e/src/wire-snapshots/<OpName>.snapshot.json`;
updates require `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` (never silent). See
[`packages/e2e/src/wire-snapshots/README.md`](packages/e2e/src/wire-snapshots/README.md)
for the workflows (add / update / triage) and the redaction policy.
This rule governs PR-introduction; snapshots govern continuous
detection across already-shipped ops.

### Track 1 vs Track 2 disposition

Corollary to the schema/contract rule above. Once a new GraphQL op
passes the live-E2E gate, its ongoing wire-validation regime is one
of three dispositions per the hybrid validation strategy
([ADR-006](hq/engineering/adr/ADR-006-hybrid-wire-validation.md) / #280):

- **T1 — Wire-shape snapshots**. Structure-only manifest captured at
  E2E time, committed per-op at
  `packages/e2e/src/wire-snapshots/<OpName>.snapshot.json`, asserted
  on every `TTCTL_E2E=1` run via `assertWireShapeStable(...)`; updates
  gated by `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`. Default for ops whose
  synthesized schema is gappy (i.e., the op is in the codegen-exclusion
  lists).
- **T2 — Codegen-Zod**. Generated Zod schema passed as the optional
  `schema:` argument to `callGateway` / `callTalentProfile`; a
  `ZodError` maps to a domain `WIRE_SHAPE_ERROR` code on the per-service
  error taxonomy (see [`docs/wire-validation-error-format.md`](docs/wire-validation-error-format.md)
  / #281). Available only when the op is in the **trusted catalog** —
  i.e., codegen produced a `<OpName>(Query|Mutation|Subscription)` type
  in `packages/core/src/__generated__/{zod-schemas,talent-profile-zod-schemas}.ts`.
- **NEITHER**. No active wire-validation. Currently applies only to
  the `scheduler` surface (no synthesized SDL).

The disposition is **derived**, not chosen — `T2` iff the op has a
generated operation type; `T1` otherwise. The authoritative per-op
classification lives in
[`docs/wire-validation-routing.md`](docs/wire-validation-routing.md)
(#289 / X-1) and is a mechanical consequence of codegen state at the
manifest's commit time. The manifest must be updated in the same PR
as any new op invocation.

**For ANY new op**: the PR body must declare the chosen track and
rationale. `T1` requires a committed `<OpName>.snapshot.json`. `T2`
requires the generated schema passed as the `schema:` argument at the
call site. `NEITHER` requires an explicit reason (currently expected
only for `scheduler`-surface ops). This is in addition to the
schema/contract rule trigger declaration above; both apply.

**Existing-op drift detection** is structurally enforced by the two
tracks plus the coverage gate:

- T1 snapshots — diff structural shape on every `TTCTL_E2E=1` run per
  [`packages/e2e/src/wire-snapshots/README.md`](packages/e2e/src/wire-snapshots/README.md)
  (#287 / WS-4).
- T2 Zod schemas — runtime `WIRE_SHAPE_ERROR` envelope on the next
  live call when the wire drifts (production-side detection).
- E2E coverage gate (`scripts/check-e2e-coverage.ts`) ensures every
  in-scope op is either snapshot-covered or explicitly exempt.

**Originating incident**: this entire regime was motivated by PR #275
(`TimesheetRecord.duration` declared `number` seconds while the wire
returned `string` minutes — an 8-hour day rendered as `0.13h` in
`ttctl timesheet show`). The duration bug was a _pre-existing_ op
with post-merge drift, outside the schema/contract rule's new-op
coverage class. T1 + T2 close that gap.

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

### Bootstrap: `ttctl auth init`

`ttctl auth init` is the recommended first command for a fresh install. It
scaffolds a Form A or Form B `~/.ttctl.yaml` interactively via
`@clack/prompts` (already pinned in the catalog) and writes the file
atomically at mode `0o600` via `writeNewConfig` in
`packages/core/src/configWriter.ts` (sibling primitive to `performYamlMutation`
— same temp+rename+fsync+chmod dance, no pre-existing file required).

Flow:

1. **Non-TTY refusal**: `process.stdin.isTTY === false` exits non-zero
   BEFORE any prompt. CI/piped contexts get a clear message; the prompt
   library is never reached.
2. **Existence gate**: target file already exists AND `--force` not
   passed → `ConfigError(PERMISSION)`. The CLI surfaces the path and the
   `--force` hint verbatim.
3. **Form selector**: `1Password reference (recommended)` or
   `Literal username/password (discouraged)`.
4. **Form A (1Password)**: detects the `op` CLI via `op --version`. On
   present: vault picker (`op vault list --format json`, zod-validated)
   → LOGIN-category item picker (`op item list --vault <V> --categories
Login --format json`) → confirm. On absent OR JSON-shape failure: a
   stderr-style warning then a freeform `op://[ACCOUNT/]VAULT/ITEM`
   prompt with the same regex as `OnePasswordReferenceSchema`.
5. **Form B (literal)**: explicit `Plaintext credentials in config are
discouraged…` confirmation; default `N` aborts cleanly with no file
   written. On `Y`: email-regex-validated username + masked password
   prompt.
6. **Persist**: `writeNewConfig(targetPath, yaml, { force })` — applies
   `assertSafePath` (sync-root + symlink refusal), validates the
   composed YAML against `ConfigLoadSchema` BEFORE writing, then atomic
   temp+rename+fsync(parent dir).
7. **Confirmation**: stdout receives `Wrote config to <path> (form A:
1Password reference)` or `… (form B: literal credentials)`; exit 0.

Cancellation at any prompt (Ctrl-C / Esc) returns `refused/cancelled`,
prints `Aborted (no file written).`, and exits non-zero.

Flags:

- `--config <path>` — output path (default: `~/.ttctl.yaml`). Parent
  directories created with `mkdir -p` semantics.
- `--force` — overwrite existing file. Without it, the existence gate
  refuses and exits non-zero.

The command intentionally never captures a bearer token — output is
always Form A or Form B shape (no `auth.token` field). Run
`ttctl auth signin` afterward to capture the bearer.

### Migration from pre-#107 shape

Pre-#107, `auth` was a top-level **string** (`auth: "op://..."` — the
1Password reference lived directly at `auth`, with no surrounding block).
Post-#107, `auth` is a **structured block** with `credentials` and `token`
sub-fields (Forms A-D above).

`loadConfigFile` detects the legacy shape **pre-Zod** (after `parseYaml`,
before `ConfigLoadSchema.safeParse`) and throws `ConfigError(VALIDATION)`
with a copy-pasteable migration hint that names the offending shape
literally and the corrected shape literally:

Legacy (pre-#107):

```yaml
auth: "op://Personal/ttctl"
```

Corrected (post-#107, Form A):

```yaml
auth:
  credentials: "op://Personal/ttctl"
```

The error code stays `VALIDATION` (preserves the CLI/MCP exit-code
contract from #107). The migration hint is part of `ConfigError.message`,
not a separate stderr emit, so JSON wire-format consumers see one coherent
`{ code, message }` payload. Other malformed shapes (typos, missing fields,
wrong sub-field types) continue to flow through the field-named superRefine
path — only the auth-as-string case triggers this dedicated message.

### Lifecycle

`ttctl auth signin` resolves the source credentials, calls
`EmailPasswordSignIn` (persisted-query mode against the mobile gateway),
captures the bearer token, and writes it BACK into the SAME YAML file
under `auth.token` via `persistAuthToken` (`yaml.parseDocument` + `setIn`

- atomic temp-rename + chmod 0o600). Comments, key order, and scalar
  styles in the source YAML are preserved.

`ttctl auth signout` first attempts a SERVER-SIDE signal via
`core.signOut(token)` — issues the `LogOut` mutation against
`talent_profile/graphql` (Cloudflare-protected; `impersonatedTransport`)
authenticated with the captured bearer (`Authorization: Token token=<X>`).
After the server-side call returns (or fails), the CLI then removes the
local `auth.token` field via `clearAuthToken` (`deleteIn`). The field
is REMOVED, not emptied to `""` — empty-string tokens are treated as
data and the security architecture mandates absence-not-emptiness for
revocation.

**Empirical scope of the LogOut mutation (#180, captured 2026-05-12,
delayed-probe investigation across t=0/30/60/180/300s):**
the `LogOut` mutation succeeds (`data.logOut.success === true`) but does
NOT invalidate the captured bearer for subsequent `mobile-gateway` calls.
A `getAuthStatus(token)` probe of a freshly-issued bearer returns
`{ status: "valid", email }` at t=0 AND at t=30s/60s/180s/300s after the
LogOut returns — the gateway accepts the bearer across the entire
5-minute probe window. The schema/decompile evidence aligns: `LogOutInput`
is empty by design (`{ _placeholder: String }`), no alternative revocation
mutation exists on either surface, and `research/notes/01-overview.md`
§ Logout flow describes Android client-side cleanup (token clear + Apollo
cache reset) rather than server-side bearer invalidation. The mutation
likely terminates web-session-side state at `talent_profile` (cookies,
Apollo cache reset) but the long-lived bearer issued by
`EmailPasswordSignIn` survives. The 24-72h aging-out remains the
**load-bearing revocation defense**; `LogOut` is **defense-in-depth**: a
signal to Toptal's audit log + web-session/cookie cleanup + a
forward-compatible call site if Toptal ever wires up server-side bearer
revocation. The local `clearAuthToken` is the only guaranteed end-state.
Naming throughout TTCtl reflects this scope — the discriminant is
`logged-out`, NOT `revoked` (the latter would overclaim).

`core.signOut(token)` returns a `SignOutResult` discriminated union
(`{ status: "logged-out" } | { status: "invalid"; reason } | { status:
"unreachable"; reason }`) — NEVER throws. Failure semantics mirror
`getAuthStatus`:

- `logged-out` — talent_profile/graphql responded 2xx +
  `data.logOut.success: true`. The LogOut flow was acknowledged on the
  talent_profile side. Does NOT imply downstream bearer invalidation —
  see scope note above.
- `invalid` — bearer was already invalid server-side (401/403 or top-level
  `errors[].extensions.code` matched `isAuthRevokedExtensionCode`). User
  intent (kill the bearer) is satisfied transitively; the CLI proceeds to
  clear local.
- `unreachable` — could not deliver the LogOut signal (network, HTTP 5xx,
  unexpected wire shape, or `data.logOut.success: false`). The CLI emits
  a stderr warning and STILL clears the local token — the bearer ages out
  server-side in 24-72h as the load-bearing defense. The user is locally
  logged out regardless.

CLI `runAuthSignOut` surfaces the server-side outcome in the JSON / YAML
output via a `serverLogOut: "logged-out" | "already-invalid" | "skipped" |
"unreachable"` field on the `signed-out` variant. Exit code stays 0 across
all four — `unreachable` is a soft warning, not a failure. `skipped` fires
when the local config carries no `auth.token` (idempotent no-op; the
server is never called).

`runGlobalTeardown` (E2E parent-process teardown, post-#171 / #180) wires
the same `signOut` call into cleanup: reads the sandbox bearer, attempts
the LogOut mutation via `core.signOut`, records the outcome in
`<sandbox>/.teardown-receipt.json` under `serverLogOut: boolean | null`
and `serverLogOutError: string | null`. `serverLogOut: null` indicates
no token was present (nothing to call with); `false` indicates the
LogOut signal could not be delivered (network failure, etc.) with the
reason captured in `serverLogOutError`. The local clear
(`clearAuthToken`) runs unconditionally — server-side is best-effort.

`ttctl auth status` and all authenticated commands read
`config.auth.token` directly from the parsed config — no separate file
load. Every subsequent GraphQL request authenticates by replaying
`Authorization: Token token=<X>`. See
`hq/engineering/adr/ADR-005-auth-model.md` for the canonical
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
  write). Mtime drift remains the second-line defense against
  lock-disregarding writers (e.g. a manual editor save) even with the
  cross-process lock in place.
- **Cross-process write-back lock** — `persistAuthToken` and
  `clearAuthToken` acquire an advisory exclusive lock on
  `<configPath>.lock` (sibling directory, atomic-mkdir-based, via
  `proper-lockfile`) before the read-stat baseline and release it after
  the rename. Two concurrent ttctl processes (CLI signin + long-running
  MCP tool call) cannot interleave their write paths — the second
  waits up to 1s and then sees the first's committed file. On
  contention timeout, throws `ConfigError(code: 'LOCKED')` rather than
  blocking indefinitely. Cross-platform (Linux/macOS/Windows) — the
  sibling-lockfile pattern works on any filesystem with atomic `mkdir`,
  unlike `flock(2)` which would not survive the inode swap on rename.
- **Bearer rescue on persist failure** — `AuthTokenPersistError`
  surfaces the captured bearer verbatim in the message so the operator
  can save it manually if the post-signin write fails (read-only FS,
  full disk).

### Debug logging on persist/clear

`persistAuthToken` and `clearAuthToken` emit structured debug records
(one JSON object per line) on **stderr** when the env var
`TTCTL_DEBUG_CONFIG=1` is set. Any other value (including empty string,
`0`, `true`, or unset) keeps the logger silent — the env-gate is read
ONCE at module load so the disabled path is constant-folded by V8 (no
per-call overhead, no record construction).

Stream choice is stderr deliberately so `-o json` mode on the CLI stays
uncontaminated. The log shape is a discriminated union:

| Event               | Per-event fields                                     | Emit point                                        |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `prewrite_checks`   | `symlink_ok`, `syncroot_ok`, `perm_ok`               | After `assertSafePath` (gates passed)             |
| `lock_acquired`     | `wait_ms` (monotonic)                                | After `acquireConfigLock` resolves                |
| `stat_baseline`     | `mtime_ms`, `mode_octal`                             | After first `stat()`                              |
| `tempfile_written`  | `temp_path`, `size_bytes`                            | After `fh.sync()` + `fh.close()`                  |
| `final_state`       | `mode_applied` (octal string)                        | After defensive `chmod`                           |
| `mtime_drift_check` | `delta_ms`, `pass`                                   | After post-write `stat()`                         |
| `rename_completed`  | (none)                                               | After `rename()`                                  |
| `lock_released`     | `duration_ms` (monotonic via `performance.now()`)    | In `finally` after `release()`                    |
| `error`             | `error_class`, `error_message`, `lock_held_at_error` | In `catch` for any throw inside the locked region |

Every record carries the common base fields `ts` (ISO-8601), `op`
(`"persist"` or `"clear"`), `path` (absolute config path), and `event`
(the discriminator). The bearer token is **never** in any allowlisted
shape — bearer-absence is enforced at the type level by the discriminated
union, AND verified at runtime by
`packages/core/src/__tests__/persistAuthToken-debug.test.ts` substring
asserts across happy + error paths (R-7 mitigation per the design risk
register).

Error path always includes a trailing `lock_released` event — the lock
release is in a `finally` regardless of which invariant fired (read-fail,
parse-fail, validate-fail, mtime-drift, write-fail, rename-fail).
Asserting "`lock_released` present" is the proof of "no leaked lock" in
tests.

Inspect a trace with `jq`:

```sh
TTCTL_DEBUG_CONFIG=1 ttctl auth signin 2> >(tee debug.log >&2)
jq -c 'select(.op == "persist") | {event, mtime_ms, mode_octal, delta_ms, pass}' debug.log
```

The empty-token caller-bug check fires synchronously BEFORE
`performYamlMutation` runs, so `persistAuthToken("", path)` emits zero
records. Same for `assertSafePath` failures (symlink-refused,
sync-root-refused) — those throw `ConfigError(PERMISSION)` before the
lock is acquired, so no lock-related events fire. Both cases are
intentional: the debug taxonomy starts at the lock and tracks the
critical write window.

### MCP session lifetime and config path

The MCP server is a long-lived process — a single `ttctl mcp` invocation
hosts every tool call for the duration of the connected client session
(Claude Desktop / Claude Code / Cursor / Windsurf, typically minutes to
hours). The CLI's per-invocation `resolveConfig()` model would not be
safe here: a parent shell that re-exports `TTCTL_CONFIG_FILE` between
two tool calls would split the session's READ and WRITE targets — the
first call would land on `/A/.ttctl.yaml`, the next on `/B/.ttctl.yaml`,
and a captured bearer would persist to a different file than the one
read on the same session.

**Path-capture-on-startup** (#113) closes this:

- `buildServer({ configPath? })` in `packages/mcp/src/server.ts` calls
  `resolveConfig({ path: configPath })` ONCE at server-construction
  time. The resolved absolute path is captured into a closure and bound
  into three per-tool auth resolvers (`createToolAuthResolver`,
  `createTokenLoader`, `createTokenResolver`) before any tool callback
  runs.
- Per-tool callbacks invoke their resolver via the dependency-injection
  context (`ToolRegistrationContext` in `packages/mcp/src/tools/_shared.ts`).
  Each resolver re-reads the captured path on every call (so a sibling
  `ttctl auth signin` that rotates the token is picked up on the next
  tool invocation), but the path itself is immutable for the session
  lifetime — env-var shifts after startup do NOT retarget reads or
  writes.
- The umbrella entry (`packages/ttctl/src/cli.ts`) parses
  `--config <path>` from `argv` after the `mcp` subcommand position and
  threads it into `runMcpStdio({ configPath })`. The flag wins over
  `TTCTL_CONFIG_FILE`, mirroring the CLI surface's precedence
  (`--config` → env → `~/.ttctl.yaml`).
- **Fail-fast on `NO_CREDS`** — when no candidate config resolves at
  startup, the `ConfigError(NO_CREDS)` propagates verbatim; the
  umbrella's MCP branch renders `Error (NO_CREDS): …` to stderr and
  exits non-zero. The server does NOT start in a half-initialized state
  that would lazy-fail at first tool invocation.

The CLI surface is unchanged in this regard — each CLI invocation is
short-lived and continues to resolve config per-invocation via
`resolveConfigForCli()`.

There are NO profiles. TTCtl operates against the user's own Toptal Talent
profile, period.

### MCP-side diagnostic logging (`TTCTL_DEBUG_MCP`)

The MCP server (issue #224) ships a structured-event debug taxonomy
mirroring the config-write taxonomy (`TTCTL_DEBUG_CONFIG`) but scoped
to per-session activity inside the long-lived MCP process.

Setting `TTCTL_DEBUG_MCP=1` (any other value, including empty string,
keeps the path silent) emits one JSON object per line to **stderr** —
the stdout data channel is owned by the MCP JSON-RPC protocol and is
never touched. Four event types ship in v1:

| Event                   | Fired                                              | Fields                                                                                                                        |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `mcp_tool_invoke_start` | BEFORE each tool callback runs                     | `tool`, `args_redacted`                                                                                                       |
| `mcp_tool_invoke_end`   | AFTER each tool callback resolves OR throws        | `tool`, `duration_ms` (monotonic), `status: "ok" \| "error" \| "throw"`                                                       |
| `mcp_auth_resolve`      | On each auth-resolver invocation (per tool call)   | `mtime_ms` (config file mtime, or `null` on stat fail), `token_fresh`, `outcome: "ok" \| "unauthenticated" \| "config_error"` |
| `mcp_transport_error`   | When a transport-class throw bubbles out of a tool | `tool`, `surface`, `error_class`, `status: number \| null`                                                                    |

Every record carries the common base fields `ts` (ISO-8601) and `event`
(the discriminator). The bearer is **never** in any allowlisted shape —
type-system enforcement at the union variants + runtime substring
assertion in `packages/mcp/src/__tests__/diagnostic.test.ts` + a
two-pass redaction on `args_redacted` (`redactBody` field-name pass +
`scrubBearerPatternInStrings` value-pattern pass per
`packages/mcp/src/diagnostic.ts`). The pattern is the same as the
config-write taxonomy (R-7 mitigation).

Inspect a trace with `jq`:

```sh
TTCTL_DEBUG_MCP=1 ttctl mcp 2> >(tee mcp-debug.log >&2)
# In another terminal, drive tool calls through your MCP client.
# Latency breakdown:
jq -c 'select(.event == "mcp_tool_invoke_end") | {tool, duration_ms, status}' mcp-debug.log
# Auth-resolver cache misses (token rotation detection):
jq -c 'select(.event == "mcp_auth_resolve" and .token_fresh == true)' mcp-debug.log
# Cloudflare 403 / transport-class regressions:
jq -c 'select(.event == "mcp_transport_error")' mcp-debug.log
```

The logger is also injectable for tests via `setMcpDiagnosticLogger`
(exported from `@ttctl/mcp`) — production callers omit the parameter
to `runMcpStdio`; tests pass a capturing function. Either path keeps
the four-event surface stable.

### MCP file-upload defense-in-depth gates (`TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY`)

Every MCP tool that consumes a `file: string` / `filePath: string` and
forwards it to a Toptal upload mutation applies two defense-in-depth
gates at the MCP layer BEFORE the apply path runs (issue #221, audit
CRIT-007). The gates protect against the file-exfiltration prompt-
injection variant documented in `SECURITY.md` § MCP Trust Model.

**Path-prefix sandbox**: Resolves the supplied path (normalises `..`,
makes it absolute) and refuses anything outside `~/Documents`,
`~/Downloads`, or `~/Desktop`. Sibling-name guard:
`~/Documents_secret/` does NOT match `~/Documents`. The sandbox can be
bypassed by setting `TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY=1` in the MCP
server's environment (any other value, including empty / `"0"` /
`"true"`, keeps it enforced). The bypass is read per-call, so a
sibling `ttctl auth signin` or a config reload does not need to
restart the MCP server to pick up an env-shift — but per the #113
config-path capture rule, the path itself is captured once at startup,
so env-shifts mid-session never retarget the sandbox prefix list
(home-directory anchor stays stable).

**Extension allowlist**: Per `UPLOAD_CATEGORIES` in
`packages/mcp/src/tools/file-upload.ts`:

- `basicPhoto` / `portfolioCover` — images only (`.jpg`, `.jpeg`,
  `.png`, `.gif`, `.webp`). Profile photos and portfolio covers render
  on the public profile; non-image extensions have no legitimate use.
- `resume` — common resume document formats (`.pdf`, `.docx`, `.doc`,
  `.txt`, `.rtf`, `.odt`).
- `portfolioFile` — broad attachment allowlist (documents, images,
  archives, media) that explicitly excludes secret-correlated
  extensions (`.pub`, `.env`, `.db`, `.sqlite`, `.sh`, `.exe`) and
  extensionless files (`id_rsa`, `credentials`, `config`). The empty-
  extension case is refused unconditionally — `path.extname("id_rsa")`
  returns `""` and no allowlist contains it.

Case-insensitive match (`Foo.PDF` matches `.pdf`). The env override
disables the path sandbox ONLY; extension allowlist always applies
regardless.

Order of checks: **extension first**, then sandbox. The extension
check is cheap and the message is more actionable when both gates
would have failed.

**Apply-path-only**: The gate runs on the apply branch but NOT the
dry-run branch (no file is read in `dryRun: true` preview mode, so the
exfiltration surface is absent). MCP clients can probe the wire shape
of an upload with a sandbox-outside path under `dryRun: true` without
disabling the gate.

The shared decoder `decodeFileUploadInput(input, category)` enforces
both gates for `filePath` and the extension gate for the base64 buffer
branch (path sandbox is N/A in buffer mode — no path is consumed).
`ttctl_profile_basic_photo_upload` calls `validateUploadPath` directly
because its tool schema uses a bare `file: string` field rather than
the `fileUploadInputSchema` fragment (the buffer-mode dual-input shape
is intentionally omitted for binary uploads through MCP).

The CLI surface is intentionally pass-through — user intent is explicit
at the shell, and the operator typing `ttctl profile resume upload
~/.ssh/id_rsa` is not a prompt-injection victim.

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
`'NO_CREDS' | 'PARSE' | 'VALIDATION' | 'PERMISSION' | 'LOCKED'` — so CLI/MCP
error handlers can branch on the code rather than string-match the message.
The CLI surfaces it as the JSON wire-format `code` field; the MCP server
includes it in the rendered tool-error text. `LOCKED` fires when the
write-back lock is held by another ttctl process longer than the ≤1s
contention budget — the recommended UX response is "wait briefly and retry".

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
(ADR-001), cookie-jar auth (ADR-002, superseded by ADR-005 post-#107),
safe-mode mutation interceptor (ADR-003), operation extraction strategy
(ADR-004), and the canonical bearer-token auth model (ADR-005 — see
`hq/engineering/adr/ADR-005-auth-model.md`).

The `research/` repo's artifacts are the source for `pnpm codegen` —
`graphql-codegen` reads `research/graphql/gateway/schema.graphql` (synthesized SDL) and
operation documents to generate typed clients. The codegen config
(`codegen.config.ts`) assumes `research/` is a sibling directory at
`../research/` relative to the ttctl repo root. The generated TypeScript at
`packages/core/src/__generated__/graphql.ts` is committed so contributors
without research-repo access can build and consume the types; re-running
`pnpm codegen` requires the sibling working copy and overwrites the file.

## CI/CD

- **CI**: Runs on push/PR to `main`; 3-OS × 2-Node matrix (ubuntu/macos/windows × Node 22/24); builds, lints, license-checks, tests. Node 22 is the declared `engines.node` minimum; Node 24 is the current LTS the release action defaults to. Both must pass before merge.
- **Release**: Triggered by GitHub Release publish; validates, stamps version from git tag, publishes to npm with provenance
- **Setup**: Composite action at `.github/actions/setup/` accepts a `node-version` input (default `24`); installs pnpm + Node.js + frozen lockfile + Turbo cache (cache key scoped by Node major).

### Branch Protection

The `main` branch is protected with the following rules:

- **Require pull request before merging**
- **Require status checks to pass**: The `CI` job (ci-gate) must pass before merging
- **Require branches to be up to date**: Feature branches must be rebased on latest `main`
- **Admin bypass**: Admins may bypass branch protection rules when necessary
