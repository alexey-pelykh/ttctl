# Configuration

TTCtl reads a single YAML config file per invocation. There are no profiles, no per-profile overrides, and no environment-variable overrides for individual fields — the only env knob is `TTCTL_CONFIG_FILE`, which controls **which** file is loaded.

This page is the canonical deep reference. The [README](../README.md) covers the everyday-use shape (the four `auth` forms, the sync-root list, the trust model); this document covers the full resolution chain, the structured schema, every error code, the security gates the loader and writer enforce, the bootstrap and signin/signout lifecycle, and the pre-#107 migration path.

The authoritative implementation lives in [`@ttctl/core`](../packages/core/src/):

- `config.ts` — `ConfigLoadSchema`, `ConfigError`, `discoverConfigPath`, `resolveConfig`, `loadConfigFile`.
- `configWriter.ts` — `assertSafePath`, `performYamlMutation`, `persistAuthToken`, `clearAuthToken`, `writeNewConfig`.
- `configLock.ts` — `acquireConfigLock` (advisory write-back lock).

If this page disagrees with the code, the code wins — please file an issue.

## Config-file resolution

`resolveConfig()` selects exactly one config-file path per invocation, in this precedence (highest → lowest):

| Rank | Source                      | Notes                                                                                                                                  |
| ---- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `--config <path>` (CLI)     | Used verbatim. The CLI pre-checks existence at invocation time and surfaces `ConfigError(code: NO_CREDS)` before any sub-command runs. |
| 2    | `TTCTL_CONFIG_FILE` env var | Used verbatim. Same treatment as `--config` — no existence pre-check inside `resolveConfig` itself.                                    |
| 3    | `~/.ttctl.yaml`             | POSIX home dotfile; only fallback. Required to exist on disk.                                                                          |

Resolution behavior:

- Ranks 1 and 2 are used **verbatim** — no existence pre-check at the resolver. If the file is missing, the load attempt surfaces `ConfigError(code: NO_CREDS)` with the actual path you supplied. This keeps the resolver pure and makes debugging trivial (the path in the error is the path you set).
- Rank 3 requires the file to exist; otherwise the chain falls through and `resolveConfig` throws `ConfigError(code: NO_CREDS)`.
- The current-working-directory `./.ttctl.yaml` is **not** auto-discovered (removed in [#92](https://github.com/alexey-pelykh/ttctl/issues/92)). See [Migration from CWD discovery](#migration-from-cwd-discovery) below.
- XDG paths (anything under `$XDG_CONFIG_HOME` or `~/.config`) are **not** consulted (removed in [#107](https://github.com/alexey-pelykh/ttctl/issues/107) when the captured bearer moved into the same YAML; `~/.ttctl.yaml` became the canonical home location).

When all three ranks miss AND a CWD `.ttctl.yaml` happens to exist, the `NO_CREDS` error message includes a one-time deprecation hint pointing at `TTCTL_CONFIG_FILE`:

```text
No config found via --config, TTCTL_CONFIG_FILE, or ~/.ttctl.yaml.
Note: a CWD .ttctl.yaml was found at /Users/you/project/.ttctl.yaml but is
not auto-discovered. Set TTCTL_CONFIG_FILE=/Users/you/project/.ttctl.yaml
(e.g. via direnv) or move it to ~/.ttctl.yaml.
```

## Schema

The top-level shape is a single required key. Schematically:

```text
auth:
  credentials: <string OR object> # optional
  token: <string>                 # optional
```

At least one of `credentials` or `token` must be present — empty `auth: {}` is rejected. The fully-specified shapes are described below as Forms A-D.

`ConfigLoadSchema` is **strict**:

- No top-level keys other than `auth` are accepted. Unknown keys → `ConfigError(code: VALIDATION)`.
- The `auth` block itself is strict — only `credentials` and `token` are accepted as sub-fields.
- At least one of `auth.credentials` or `auth.token` must be present. Empty `auth: {}` is rejected by the LOAD schema with a `VALIDATION` error.

`ConfigWriteSchema` is a permissive sibling used by `persistAuthToken` and `clearAuthToken` during the brief mid-lifecycle window between mutation and disk-write. The write schema accepts empty `auth: {}`; the next load against the same file then enforces the LOAD schema's "at least one of" rule.

### `auth.credentials` — credential source

Polymorphic on YAML node type. The runtime collapses both shapes into a single internal `{ email, password }` pair when `auth signin` runs.

#### String — 1Password item reference (Form A, recommended)

| Form      | Example                                   | When to use                                                                                                                                  |
| --------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 2-segment | `credentials: "op://Personal/ttctl"`      | Single 1Password account, or relying on `OP_ACCOUNT` env / `op` CLI default account.                                                         |
| 3-segment | `credentials: "op://acct/Personal/ttctl"` | Multiple 1Password accounts — pin one explicitly. The first segment is forwarded to `op` as `--account` (UUID, shorthand, or sign-in email). |

The regex (`config.ts:28`) enforces 2 or 3 path segments. Per-field references (4+ segments, e.g. `op://Personal/ttctl/Section/username`) are **rejected**. TTCtl always reads both `USERNAME` and `PASSWORD` fields from a single LOGIN-category item, by 1Password `purpose:` semantic identifier — not by display label.

#### Object — literal credentials (Form B, dev/testing only)

```yaml
auth:
  credentials:
    username: "you@example.com"
    password: "hunter2"
```

- `username` is the field name (matching 1Password's `USERNAME` purpose). The **value** must be a valid email address — Toptal's `EmailPasswordSignIn` mutation only accepts emails.
- `password` must be a non-empty string.
- The object is strict — unknown keys are rejected.

Discouraged for daily use: plaintext credentials in config files leak through backups, sync clients, and accidental commits. `chmod 600 <config-file>` is mandatory if you do use this form.

### `auth.token` — captured bearer

After a successful `ttctl auth signin`, the captured session bearer is persisted under `auth.token`:

```yaml
auth:
  credentials: "op://Personal/ttctl"
  token: "user_<24hex>_<20alnum>"
```

The token is a non-empty string. The shape is enforced by Zod but the format (`user_<24hex>_<20alnum>`) is documented for orientation only — TTCtl does not validate the structure, it just replays it as `Authorization: Token token=<X>` to the Toptal API.

`ttctl auth signout` REMOVES the `token` field (it does not set it to an empty string). Empty-string tokens are treated as data; absence-not-emptiness is the revocation signal.

### Four valid lifecycle states

The combination of optional `credentials` and optional `token` produces four shapes that round-trip through TTCtl's lifecycle without re-authoring the file:

| Form | `credentials` | `token` | When this state occurs                                                                                       |
| ---- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| A    | present       | absent  | Hand-authored 1Password reference, pre-signin. The most common starting state.                               |
| B    | present       | absent  | Hand-authored `{ username, password }`, pre-signin. Same lifecycle position as Form A.                       |
| C    | absent        | present | Token supplied out-of-band (E2E sandbox, side-channel bootstrap). `signin` is refused with `NO_CREDENTIALS`. |
| D    | present       | present | Post-signin shape of Form A or B. `signout` removes the `token` field, returning to Form A or B.             |

Empty `auth: {}` (neither field present) is rejected by `ConfigLoadSchema`. It can transiently exist on-disk during signout when the source was Form C — at which point the next load surfaces a `VALIDATION` error guiding the user to re-author.

## Common patterns

### Repo-local config via direnv

When you want a per-project config (different 1Password vault, separate token sandbox), pair `TTCTL_CONFIG_FILE` with [direnv](https://direnv.net):

```sh
# .envrc in your project root (requires `direnv` installed and `direnv allow` run)
export TTCTL_CONFIG_FILE="$PWD/.ttctl.yaml"
```

Then `direnv allow` once. While inside the project directory, TTCtl loads `<project>/.ttctl.yaml`; outside it, the home default applies.

A typical `<project>/.ttctl.yaml`:

```yaml
auth:
  credentials: "op://Project-Vault/ttctl"
```

Pair with `.gitignore`:

```text
.ttctl.yaml
```

Keep the project-local config OUT of any cloud-sync directory (see [Security gates: sync-root refusal](#security-gates) below) — TTCtl refuses to persist the captured bearer under `~/Dropbox/`, `~/iCloud Drive/`, `~/OneDrive/`, etc.

### CI / agent deployments

Pass `TTCTL_CONFIG_FILE` as an absolute path. The MCP server has no CLI flags — `TTCTL_CONFIG_FILE` is the only knob:

```sh
TTCTL_CONFIG_FILE=/run/secrets/ttctl-config.yaml ttctl mcp
```

The same env var works for the CLI:

```sh
TTCTL_CONFIG_FILE=/run/secrets/ttctl-config.yaml ttctl profile show
```

In CI, the typical Form C bootstrap (token-only) is:

```yaml
auth:
  token: "user_<24hex>_<20alnum>"
```

`ttctl auth signin` is refused for Form C (no credentials to sign in with); `ttctl auth signout` is a no-op when there is no token.

### Multi-config dev (rare)

Keep separate configs at known paths and switch via `TTCTL_CONFIG_FILE`:

```sh
TTCTL_CONFIG_FILE=~/.ttctl-personal.yaml ttctl auth status
TTCTL_CONFIG_FILE=~/.ttctl-test.yaml     ttctl auth status
```

Each config carries its own captured bearer inline (`auth.token`); they cannot collide.

## Errors and exit codes

`ConfigError` carries a discriminator `code` so handlers can branch on the code rather than pattern-match prose messages:

| Code         | When it fires                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_CREDS`   | Resolution chain returns nothing, OR the chosen path doesn't exist on disk (`ENOENT`).                                                                   |
| `PARSE`      | YAML parse error (malformed file).                                                                                                                       |
| `VALIDATION` | Schema validation error (wrong shape, missing fields, unknown keys, legacy pre-#107 shape — see [Migration](#migration-from-pre-107-shapes)).            |
| `PERMISSION` | File exists but is inaccessible (`EACCES` / `EPERM`), OR is at an unsafe location (sync-root, symlink, world-writable mode).                             |
| `LOCKED`     | The advisory cross-process write-back lock could not be acquired within the contention budget (≤1s on macOS/Linux, ≤3s on Windows). Retry the operation. |

The CLI surfaces the code as the JSON wire-format `code` field. The MCP server includes it in the rendered tool-error text (`(Code: NO_CREDS)`, etc.).

### Field-named validation errors

`ConfigLoadSchema` failures produce one error message per offending field, named with the dotted path through the schema (not Zod's naked `Invalid input`):

```text
Config validation failed: auth.credentials.password: auth.credentials.password must be a non-empty string
Config validation failed: auth.credentials.username: auth.credentials.username must be a valid email address
Config validation failed: auth: auth must contain at least one of 'credentials' (op:// reference or { username, password } object) or 'token' (bearer string captured by `ttctl auth signin`)
```

The dotted-path renderer (`formatIssuePath` in `config.ts`) collapses Zod's `issue.path` array into a readable single line.

### Non-fatal permission warning

A separate non-fatal warning fires when the config file is group-readable or world-readable on POSIX (`mode & 0o077 != 0`, but NOT world-writable — that case is a hard refuse):

```text
WARNING: config file /Users/you/.ttctl.yaml is group/world readable (mode 0644).
It may contain a 1Password reference, plaintext password, or captured bearer.
Run: chmod 600 /Users/you/.ttctl.yaml
```

This is informational — it does NOT produce a `PERMISSION`-coded error. The recommended posture is `chmod 600 <config-file>`.

## Security gates

The loader (`loadConfigFile`) and writer (`performYamlMutation`) enforce a stack of pre-flight gates. Each gate has a single failure mode and a single recovery action:

| Gate                              | Where it runs            | Failure → Error code                                           | Recovery                                                                                                    |
| --------------------------------- | ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **World-writable refusal**        | `loadConfigFile` (read)  | `PERMISSION`                                                   | `chmod 600 <path>`                                                                                          |
| **Symlink refusal (write-side)**  | `assertSafePath` (write) | `PERMISSION`                                                   | Replace the symlink with a regular file containing the same auth credentials.                               |
| **Sync-root refusal**             | `assertSafePath` (write) | `PERMISSION`                                                   | Move the config out of the sync directory, or set `TTCTL_CONFIG_FILE` to a path elsewhere in your home.     |
| **Cross-process write-back lock** | `performYamlMutation`    | `LOCKED` (after ≤1s contention on macOS/Linux, ≤3s on Windows) | Wait briefly and retry.                                                                                     |
| **Mtime drift detection**         | `performYamlMutation`    | `AuthTokenPersistError` (bearer rescue)                        | Re-run `auth signin`. Drift means a concurrent writer (manual editor save, backup restore) raced the write. |
| **Defensive `chmod 0600`**        | `performYamlMutation`    | n/a (always applied)                                           | The temp file is opened with mode `0600`; a defensive `chmod(tmp, 0600)` runs before rename.                |

### World-writable refusal (load-side)

The loader rejects configs whose mode satisfies `mode & 0o002 != 0` (covers `0666`, `0777`, etc.). Closes a TOCTOU window on credential reads. Symlinked files ARE permitted on the read side — only the write-side refuses them (the swap-attack target is the write path, not the read).

### Symlink refusal (write-side)

Before mutating, the writer `lstat`s the path and refuses if it is a symbolic link. Closes the swap-`~/.ttctl.yaml`-for-symlink attack where an adversary redirects the captured bearer to an attacker-controlled file.

### Sync-root refusal

The writer refuses to persist a captured bearer if the absolute config path falls under any of:

| Prefix (under `$HOME`)        | Service            |
| ----------------------------- | ------------------ |
| `~/Library/Mobile Documents/` | macOS iCloud Drive |
| `~/Dropbox/`                  | Dropbox            |
| `~/iCloud Drive/`             | iCloud (alt name)  |
| `~/OneDrive/`                 | OneDrive           |
| `~/Google Drive/`             | Google Drive       |
| `~/Box/`, `~/Box Sync/`       | Box                |

Match is path-segment-boundary-based — a sibling like `~/DropboxOther/` does NOT match `~/Dropbox/`.

### Cross-process write-back lock

`persistAuthToken` and `clearAuthToken` acquire an advisory exclusive lock on a sibling `<configPath>.lock` directory (atomic `mkdir`-based, via `proper-lockfile`) before the stat baseline and release it after the rename. Two concurrent ttctl processes (CLI signin + long-running MCP tool call) cannot interleave their write paths. On contention timeout (≤1s on macOS/Linux, ≤3s on Windows — see [#362](https://github.com/alexey-pelykh/ttctl/issues/362)), the writer throws `ConfigError(code: LOCKED)` instead of blocking.

### Mtime drift detection

After writing the temp file and before renaming, the writer re-`stat`s the original config path. If the mtime moved between the baseline capture and the post-write check, the writer refuses the rename, unlinks the temp file, and throws an `AuthTokenPersistError` that carries the captured bearer in its `bearerRescue` field so the operator can save it manually. Drift indicates a lock-disregarding writer (manual editor save, backup restore, sync-client revert).

### Atomic write + defensive chmod

The write sequence is:

1. Open `<path>.tmp` with `O_WRONLY | O_CREAT | O_TRUNC` and mode `0o600`.
2. Write the new YAML.
3. `fsync` the file descriptor.
4. Defensive `chmod(tmp, 0600)` (umask-resilient).
5. `rename(tmp, <path>)` (atomic on POSIX/NTFS/APFS).
6. `fsync` the parent directory (crash durability).

If any step fails after the temp file is created, the temp file is unlinked. If the rename itself fails, the original `<path>` is untouched.

## Bootstrap: `ttctl auth init`

`ttctl auth init` is the recommended first command for a fresh install. It scaffolds a Form A or Form B `~/.ttctl.yaml` interactively (via `@clack/prompts`) and writes it atomically at mode `0o600` via `writeNewConfig` (the same temp+rename+fsync+chmod dance as `persistAuthToken`, with no pre-existing file required).

Flow:

1. **Non-TTY refusal**: piped or CI contexts exit non-zero BEFORE any prompt.
2. **Existence gate**: target file exists AND `--force` not passed → `ConfigError(PERMISSION)`.
3. **Form selector**: 1Password reference (recommended) or literal username/password (discouraged).
4. **Form A**: detects `op` CLI → vault picker → LOGIN-category item picker → confirm. If `op` is missing, falls back to a freeform `op://[ACCOUNT/]VAULT/ITEM` prompt with the same regex enforcement as the schema.
5. **Form B**: explicit "discouraged" confirmation (default `N`) → email-validated username + masked password prompt.
6. **Persist**: `writeNewConfig` validates the composed YAML against `ConfigLoadSchema` BEFORE writing, then atomic temp+rename+fsync.

Flags:

- `--config <path>` — output path (default: `~/.ttctl.yaml`). Parent directories created with `mkdir -p` semantics.
- `--force` — overwrite existing file.

The command intentionally never captures a bearer — output is always Form A or B shape. Run `ttctl auth signin` afterward to capture the bearer (which transitions the file to Form D).

## Signin / signout lifecycle

| Command              | Reads                              | Writes                                       | Server-side effect                                                               |
| -------------------- | ---------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `ttctl auth init`    | none (interactive)                 | new file at config path (Form A or B)        | none                                                                             |
| `ttctl auth signin`  | `auth.credentials` from config     | `auth.token` (transitions Form A/B → Form D) | issues `EmailPasswordSignIn` mutation; captures bearer                           |
| `ttctl auth signout` | `auth.token` (the captured bearer) | removes `auth.token` (Form D → Form A/B)     | issues `LogOut` mutation against `talent_profile` (best-effort — see scope note) |
| `ttctl auth status`  | `auth.credentials`, `auth.token`   | none                                         | probes `getAuthStatus` if a token is present                                     |

`signin` preserves comments, key order, and scalar styles in the source YAML — it uses `yaml.parseDocument` + `setIn` rather than re-serializing the whole document.

`signout`'s server-side `LogOut` mutation succeeds but does NOT invalidate the captured bearer for subsequent `mobile-gateway` calls. The 24-72h aging-out remains the load-bearing revocation defense; `LogOut` is defense-in-depth (audit log + web-session cleanup). The local `clearAuthToken` is the only guaranteed end-state. The CLI exit code is `0` across all four outcomes (`logged-out`, `already-invalid`, `skipped`, `unreachable`) — the `serverLogOut` field in `-o json` output surfaces which path was taken.

## Debug logging on persist / clear

When `TTCTL_DEBUG_CONFIG=1` is set, `persistAuthToken` and `clearAuthToken` emit structured debug records (one JSON object per line) to **stderr**. The env var is read ONCE at module load so the disabled path is constant-folded by V8 — no per-call overhead when off. The bearer token is **never** in any record shape (enforced at the TypeScript type level AND verified at runtime by `persistAuthToken-debug.test.ts`).

See [README § Debug logs for `auth signin` / `auth signout`](../README.md#debug-logs-for-auth-signin--auth-signout) for the event taxonomy and `jq` recipes.

## Migration from pre-#107 shapes

Pre-#107, the top-level `auth` value was polymorphic (either a 1Password reference as a bare string, or an object whose login field was named differently than today), and the captured bearer lived in a separate file pointed at by a token-path field. Post-#107, `auth` is a **structured block** with `credentials` and `token` sub-fields, and the captured bearer lives inline in the same YAML.

There are three legacy shapes you may have on disk; here is what to change:

| Pre-#107 (rejected at load)                              | Post-#107 (the supported shape)                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A bare 1Password reference as the `auth` value           | Nest the same reference under `auth.credentials` (see [Form A](#string--1password-item-reference-form-a-recommended)).                         |
| An object with a login-name field other than `username`  | Nest it under `auth.credentials` and rename the login field to `username` (see [Form B](#object--literal-credentials-form-b-devtesting-only)). |
| A top-level token-path field pointing at a separate file | Delete the field; the captured bearer now lives inline at `auth.token` after the next `ttctl auth signin`.                                     |

The most common legacy shape — the bare-string `auth` value — has a dedicated detector (`detectLegacyShape` in `config.ts`) that fires BEFORE Zod validation. The error message names your offending shape literally and prints the corrected structured shape, both copy-pasteable. (Other malformed shapes flow through the normal field-named validation path; see [Field-named validation errors](#field-named-validation-errors) above.)

After migrating, run `ttctl auth signin` — the captured bearer is written back inline.

## Migration from CWD discovery

Earlier versions auto-discovered `./.ttctl.yaml` in the current working directory. That behavior was removed in #92 because:

- It made tool behavior depend on `process.cwd()`, which is fragile under shell aliases, IDE integrations, and MCP clients that spawn from arbitrary directories.
- It silently surfaced different credentials for the same user in different shells — a footgun.
- The MCP server is typically spawned from the MCP client's working directory, which is rarely the user's project root.

If you previously relied on `./.ttctl.yaml` in CWD, pick the option that fits:

| You want…              | Do this                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Same config everywhere | Move it to `~/.ttctl.yaml`. No further changes.                                                                      |
| Project-local config   | Keep `<project>/.ttctl.yaml`, add a `.envrc` with `export TTCTL_CONFIG_FILE="$PWD/.ttctl.yaml"`, run `direnv allow`. |
| One-off / scripted     | `TTCTL_CONFIG_FILE=<path> ttctl <command>` per invocation.                                                           |

If you run `ttctl` and a `./.ttctl.yaml` exists in CWD but the resolution chain finds nothing, the `NO_CREDS` error message includes a one-time hint pointing at `TTCTL_CONFIG_FILE` and the legacy file's path. Once `TTCTL_CONFIG_FILE` is set (or the file is moved into `~/.ttctl.yaml`), the hint goes away.

## MCP session lifetime and config path

The MCP server is a long-lived process — a single `ttctl mcp` invocation hosts every tool call for the duration of the connected client session (Claude Desktop / Claude Code / Cursor / Windsurf, typically minutes to hours).

Path resolution runs ONCE at server-construction time and is captured into a closure. Per-tool callbacks invoke their resolver, which re-reads the captured path on every call (so a sibling `ttctl auth signin` that rotates the token is picked up), but the path itself is immutable for the session — a parent shell that re-exports `TTCTL_CONFIG_FILE` mid-session does NOT retarget reads or writes.

If no candidate config resolves at startup, `ConfigError(code: NO_CREDS)` propagates verbatim; the umbrella renders `Error (NO_CREDS): …` to stderr and exits non-zero. The server does not start in a half-initialized state.

The CLI surface is unchanged — each CLI invocation is short-lived and continues to resolve config per-invocation.

## Related issues

- [#92](https://github.com/alexey-pelykh/ttctl/issues/92) — Drop CWD config discovery; add `TTCTL_CONFIG_FILE`. Landed.
- [#93](https://github.com/alexey-pelykh/ttctl/issues/93) — Add `--config` CLI flag. Landed.
- [#107](https://github.com/alexey-pelykh/ttctl/issues/107) — Single-file model: structured `auth` block; captured bearer moves inline. Landed.
- [#113](https://github.com/alexey-pelykh/ttctl/issues/113) — MCP path-capture-on-startup. Landed.
- [#180](https://github.com/alexey-pelykh/ttctl/issues/180) — Server-side `LogOut` mutation (best-effort; client-side `auth.token` removal is the load-bearing revocation). Landed.
