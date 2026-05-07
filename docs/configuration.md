# Configuration

TTCtl reads a single YAML config file per invocation. There are no profiles, no per-profile overrides, and no environment-variable overrides for individual fields — the only env knob is `TTCTL_CONFIG_FILE`, which controls **which** file is loaded.

This page is the canonical reference. The [README](../README.md) covers everyday use; this document covers the full precedence chain, every supported field, error semantics, and migration guidance.

## Config-file resolution

`resolveConfig()` (in `@ttctl/core`) selects exactly one config-file path per invocation, in this precedence (highest → lowest):

| Rank | Source                               | Notes                                                                                    |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1    | `--config <path>` flag (CLI, future) | Used verbatim. Companion issue: [#93](https://github.com/alexey-pelykh/ttctl/issues/93). |
| 2    | `TTCTL_CONFIG_FILE` env var          | Used verbatim. Same treatment as the explicit flag.                                      |
| 3    | `$XDG_CONFIG_HOME/ttctl/config.yaml` | Only when `XDG_CONFIG_HOME` is set **and** the file exists.                              |
| 4    | `~/.config/ttctl/config.yaml`        | POSIX home default. Only when the file exists.                                           |

Notes:

- Ranks 1 and 2 are used **verbatim** — no existence pre-check at the resolver. If the file is missing, the call surfaces a `ConfigError` with code `NO_CREDS` once the load is attempted. This makes debugging easier (the path you set is the path the error mentions) and keeps the resolver pure.
- Ranks 3 and 4 require the file to exist on disk. If `XDG_CONFIG_HOME` is set but its `ttctl/config.yaml` does not exist, resolution falls through to rank 4 — it does not error out at rank 3.
- The current-working-directory `./.ttctl.yaml` is **not** auto-discovered. This is a breaking change vs versions before the [#92](https://github.com/alexey-pelykh/ttctl/issues/92) refactor. See [Migration](#migration-from-cwd-discovery) below.

When all four ranks miss, `resolveConfig` throws `ConfigError(code: 'NO_CREDS')`. If the resolver finds nothing and a CWD `.ttctl.yaml` does happen to exist, the error includes a deprecation hint pointing at `TTCTL_CONFIG_FILE` (or the future `--config` flag).

## Schema

```yaml
# Required: credential source (string or object — see "Auth forms" below)
auth: "op://Personal/ttctl"

# Optional: where to persist the captured session token on disk
auth-token-path: "./auth.token" # or absolute, e.g. "/var/run/ttctl/auth.token"
```

No other top-level keys are supported. Unknown keys cause `ConfigError(code: 'VALIDATION')`.

### `auth` — credential source

Polymorphic on type:

#### String — 1Password item reference (recommended)

| Form      | Example                                  | When to use                                                                                                                                          |
| --------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2-segment | `auth: "op://Personal/ttctl"`            | Single 1Password account, or relying on `OP_ACCOUNT` env / `op` CLI default.                                                                         |
| 3-segment | `auth: "op://my-account/Personal/ttctl"` | Multiple 1Password accounts — pin one explicitly. The first segment is forwarded to `op` as `--account` (accepts UUID, shorthand, or sign-in email). |

Per-field references (4+ segments, e.g. `op://Personal/ttctl/Section/username`) are **rejected** by the schema. TTCtl always reads `username` and `password` fields from a single LOGIN-category item.

#### Object — literal credentials (dev/testing only)

```yaml
auth:
  email: "you@example.com"
  password: "hunter2"
```

Discouraged for daily use — plaintext credentials in config files leak through backups, sync clients, and accidental commits. `chmod 600 <config-file>` is mandatory if you do use this form.

### `auth-token-path` — token storage location

Resolution order (handled by `resolveAuthTokenPath` in `@ttctl/core`):

1. `auth-token-path` from the config file, if set and non-empty:
   - Absolute path → used verbatim.
   - Relative path → resolved relative to `dirname(<config-file>)` (the directory containing the loaded config file).
2. Windows: `%APPDATA%/ttctl/auth.token` (fallback `%USERPROFILE%/AppData/Roaming/ttctl/auth.token`).
3. POSIX: `$XDG_DATA_HOME/ttctl/auth.token` if `XDG_DATA_HOME` is set and non-empty; otherwise `~/.ttctl/auth.token`.

There is no env-var override for `auth-token-path` itself — the env knob (`TTCTL_CONFIG_FILE`) selects which config file to load, and `auth-token-path` is then read out of that file like any other field.

## Common patterns

### Repo-local config via direnv

Use `TTCTL_CONFIG_FILE` plus [direnv](https://direnv.net) when you want a per-project config (different 1Password vault, separate token sandbox, etc.):

```sh
# .envrc in your project root
export TTCTL_CONFIG_FILE="$PWD/.ttctl.yaml"
```

Then run `direnv allow` once. While inside the project directory, TTCtl loads `<project>/.ttctl.yaml`; outside it, the XDG/home default applies.

A typical `.ttctl.yaml` for this pattern:

```yaml
auth: "op://Project-Vault/ttctl"
auth-token-path: "./.ttctl.token" # token lives next to the config, not in ~
```

Pair with `.gitignore`:

```text
.ttctl.yaml
.ttctl.token
```

### CI / agent deployments

Pass `TTCTL_CONFIG_FILE` as an absolute path. The MCP server has no CLI flags, so `TTCTL_CONFIG_FILE` is the only knob:

```sh
TTCTL_CONFIG_FILE=/run/secrets/ttctl-config.yaml ttctl mcp
```

The same env var works for the CLI:

```sh
TTCTL_CONFIG_FILE=/run/secrets/ttctl-config.yaml ttctl profile show
```

### Multi-config dev (rare)

Keep separate configs at known paths and switch via `TTCTL_CONFIG_FILE`. Each config can pin its own `auth-token-path` so the persisted tokens don't collide:

```sh
TTCTL_CONFIG_FILE=~/.config/ttctl/config-personal.yaml ttctl auth status
TTCTL_CONFIG_FILE=~/.config/ttctl/config-test.yaml     ttctl auth status
```

## Errors and exit codes

`ConfigError` carries a discriminator code so handlers can branch on the code rather than pattern-match prose messages:

| Code         | When it fires                                                               |
| ------------ | --------------------------------------------------------------------------- |
| `NO_CREDS`   | Resolution chain returns nothing, or the chosen path doesn't exist on disk. |
| `PARSE`      | YAML parse error (malformed file).                                          |
| `VALIDATION` | Schema validation error (wrong shape, missing fields, unknown keys).        |
| `PERMISSION` | File exists but is inaccessible (EACCES / EPERM).                           |

The CLI surfaces the code in its JSON wire-format `code` field. The MCP server includes it in the rendered tool-error text (`(Code: NO_CREDS)`, etc.).

A separate non-fatal warning fires when the config file is group/world readable on POSIX (`mode & 0o077 != 0`):

```text
WARNING: config file <path> is group/world readable (mode 0644). It may contain a 1Password reference or plaintext password. Run: chmod 600 <path>
```

This is informational — it does not produce a `PERMISSION`-coded error. The recommended posture is `chmod 600 <config-file>`.

## Migration from CWD discovery

Earlier versions auto-discovered `./.ttctl.yaml` in the current working directory. That behavior was removed because:

- It made tool behavior depend on `process.cwd()`, which is fragile under shell aliases, IDE integrations, and MCP clients that spawn from arbitrary directories.
- It silently surfaced different credentials for the same user in different shells, which is a footgun.
- The MCP server is typically spawned from the MCP client's working directory, which is rarely the user's project root.

If you previously relied on `./.ttctl.yaml` in CWD, pick the option that fits:

| You want…              | Do this                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Same config everywhere | Move it to `~/.config/ttctl/config.yaml`. No further changes.                                                        |
| Project-local config   | Keep `<project>/.ttctl.yaml`, add a `.envrc` with `export TTCTL_CONFIG_FILE="$PWD/.ttctl.yaml"`, run `direnv allow`. |
| One-off / scripted     | `TTCTL_CONFIG_FILE=<path> ttctl <command>` per invocation.                                                           |

If you run `ttctl` (or a tool depending on it) and a `./.ttctl.yaml` exists in CWD but the resolution chain finds nothing, the `NO_CREDS` error message includes a hint pointing at `TTCTL_CONFIG_FILE` and the legacy file's path. That's a one-time nudge — once `TTCTL_CONFIG_FILE` is set or the file is moved into `~/.config/ttctl/config.yaml`, the hint goes away.

## Related issues

- [#92](https://github.com/alexey-pelykh/ttctl/issues/92) — Drop CWD config discovery; add `TTCTL_CONFIG_FILE`. Landed.
- [#93](https://github.com/alexey-pelykh/ttctl/issues/93) — Add `--config` CLI flag. Companion to this refactor.
- [#94](https://github.com/alexey-pelykh/ttctl/issues/94) — Rewrite the E2E harness around `TTCTL_CONFIG_FILE`. Wave 3.
- [#95](https://github.com/alexey-pelykh/ttctl/issues/95) — Wire `TTCTL_CONFIG_FILE` through the MCP layer + this doc.
