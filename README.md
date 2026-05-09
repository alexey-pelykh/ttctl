# TTCtl

[![CI](https://github.com/alexey-pelykh/ttctl/actions/workflows/ci.yml/badge.svg)](https://github.com/alexey-pelykh/ttctl/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ttctl?logo=npm)](https://www.npmjs.com/package/ttctl)
[![npm downloads](https://img.shields.io/npm/dm/ttctl?logo=npm)](https://www.npmjs.com/package/ttctl)
[![GitHub Repo stars](https://img.shields.io/github/stars/alexey-pelykh/ttctl?style=flat&logo=github)](https://github.com/alexey-pelykh/ttctl)
[![License](https://img.shields.io/github/license/alexey-pelykh/ttctl)](LICENSE)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-3.0-4baaaa.svg)](CODE_OF_CONDUCT.md)

Personal-productivity CLI and MCP server for your own [Toptal Talent](https://talent.toptal.com) profile.

## ⚠️ Unofficial — Personal Use Only

**TTCtl is NOT affiliated with, endorsed by, or supported by Toptal LLC.** It is a personal-productivity tool that interacts with Toptal Talent's web/mobile interfaces using your own session, exclusively for your own profile's data.

This tool is built for **fair use** and shared in case it's useful to other Toptal talents who want similar tooling for their own profiles. It is **NOT** to be used for:

- Spam or unsolicited outreach to recruiters / clients
- Mass automation of job applications, profile updates, or messaging
- Engagement-signal manipulation, application bombing, recruiter scraping
- Operating against profiles that aren't your own
- Any behavior that violates [Toptal's Terms of Service](https://www.toptal.com/tos) or burdens the platform

Architectural friction in the codebase (sequential rate limits, single-credential design, no batch parallelism on automation-prone endpoints) is intentional. Don't remove it.

"Toptal" is a trademark of Toptal LLC. The name appears in this project's description as **nominative fair use** only — TTCtl is not a Toptal brand.

## What It Does

TTCtl gives you (and your AI assistants, via [MCP](https://modelcontextprotocol.io)) programmatic access to your own Toptal Talent profile:

- **Profile** — view and update your talent profile, skills, availability, rates
- **Timesheets** — list, view, and manage your timesheet entries
- **Applications** — review your application history and status (no batch creation)
- **Stats** — your earnings, utilization, ranking metrics
- **Scheduler** — view your interview schedule

Surfaces are gated to read-heavy / personal use. Operations that would enable mass automation against the platform are deliberately not exposed.

## Prerequisites

- **Node.js** >= 24
- A **Toptal Talent** profile (you must be a Toptal talent to use this — it has no value to anyone else)
- Recommended: **[1Password CLI](https://developer.1password.com/docs/cli/get-started/)** (`op`) for credential resolution

## Installation

```sh
npm install -g ttctl
```

Or run directly with npx:

```sh
npx ttctl --help
```

## Quick Start

```sh
# 1. Install
npm install -g ttctl

# 2. Bootstrap a config interactively (recommended)
#    Walks you through Form A (1Password reference; vault + item picker
#    when the `op` CLI is installed) or Form B (literal credentials,
#    explicit warning). Output: ~/.ttctl.yaml at mode 0600.
ttctl auth init

# 3. Sign in (captures the bearer back into ~/.ttctl.yaml under auth.token)
ttctl auth signin

# 4. Verify
ttctl auth status

# 5. View your profile
ttctl profile show
```

> **`ttctl auth init`** scaffolds a fresh `~/.ttctl.yaml` interactively. Choose Form A (1Password reference, recommended) or Form B (literal credentials, discouraged — guarded by an explicit warning). On Form A with the `op` CLI installed, a vault picker and a LOGIN-category item picker run. Without `op` or on JSON-shape failure, the prompt falls back to a freeform `op://VAULT/ITEM` reference. The output file is written atomically at mode `0600` and refuses to overwrite an existing file unless `--force` is passed. The command is interactive only — pipe stdin or a non-TTY context exits non-zero with a clear message.

> **`ttctl auth signin`** runs the `EmailPasswordSignIn` GraphQL mutation, captures the session bearer, and writes it BACK into the same `~/.ttctl.yaml` file under `auth.token` (atomic write; comments preserved; mode `0600`). All subsequent commands replay it as `Authorization: Token token=<X>` on every GraphQL request. The `op` CLI is invoked only at signin time to resolve your credentials. There is **no separate token file** — your config and your live session live in one YAML.

> **Hand-authoring** the config also works (drop a YAML file at `~/.ttctl.yaml`, `chmod 600`); see the [Configuration](#configuration) section below for the four valid `auth` shapes. `ttctl auth init` is the recommended starting point.

## Configuration

TTCtl uses a single config file — **no profiles**. The config-file path is resolved deterministically (highest precedence wins):

1. `--config <path>` flag — explicit override (per-invocation).
2. `TTCTL_CONFIG_FILE` env var — process-scoped (CI, direnv).
3. `~/.ttctl.yaml` — POSIX home dotfile (only fallback).

XDG paths (`$XDG_CONFIG_HOME/ttctl/config.yaml`, `~/.config/ttctl/config.yaml`) and the current-working-directory `./.ttctl.yaml` are **not** auto-discovered. To use a project-local config, point `TTCTL_CONFIG_FILE` at it via direnv:

```sh
# .envrc in your project root (requires `direnv` installed and `direnv allow` run)
export TTCTL_CONFIG_FILE="$PWD/.ttctl.yaml"
```

### Sync-root exclusion

TTCtl **refuses to persist** the captured bearer when the config file lives under a known cloud-sync prefix:

| Path prefix                   | Service            |
| ----------------------------- | ------------------ |
| `~/Library/Mobile Documents/` | macOS iCloud Drive |
| `~/Dropbox/`                  | Dropbox            |
| `~/iCloud Drive/`             | iCloud (alt name)  |
| `~/OneDrive/`                 | OneDrive           |
| `~/Google Drive/`             | Google Drive       |
| `~/Box/`, `~/Box Sync/`       | Box                |

Persisting a bearer under any of these would silently replicate it off-host. If you need a project-local config, keep it OUTSIDE these directories and route via `TTCTL_CONFIG_FILE` (direnv recipe above). The sibling-name guard prevents false positives — `~/DropboxOther/` is fine.

### `auth` — four valid lifecycle states

The `auth` block is **structured** with optional `credentials` and `token` fields. Four valid shapes correspond to the lifecycle states:

#### Form A — credentials via 1Password reference (RECOMMENDED, signin populates `auth.token`)

```yaml
# Single 1Password account (or relying on `OP_ACCOUNT` env / op default)
auth:
  credentials: "op://Personal/ttctl"

# Multiple 1Password accounts — pin one explicitly
auth:
  credentials: "op://my-account/Personal/ttctl"
```

TTCtl parses `op://[ACCOUNT/]VAULT/ITEM` and runs `op item get ITEM --vault VAULT [--account ACCOUNT] --format json`, then resolves credentials by matching fields with `purpose: USERNAME` and `purpose: PASSWORD` — the canonical semantic identifiers 1Password sets automatically for **LOGIN-category** items (including browser-autosaved logins where the field labels are the HTML form input names like `user[email]`).

The optional `ACCOUNT` segment is required only when you have multiple `op` accounts configured (`op account list`); single-account setups can omit it. ACCOUNT may be the account UUID, the shorthand set via `op account add`, or the sign-in email — TTCtl forwards the value verbatim to `op` for validation.

#### Form B — literal credentials (dev/testing only)

```yaml
auth:
  credentials:
    username: "you@example.com" # value is your Toptal email; field name matches 1P USERNAME purpose
    password: "hunter2"
```

> Discouraged for daily use. Plaintext credentials in config files leak through backups, sync clients, and accidental commits. Form A is what you want.

> **Per-field references (4+ segments, e.g. `op://Personal/ttctl/Section/username`) are NOT supported.** The schema rejects them. Use Form A (item-level reference) — TTCtl always reads both USERNAME and PASSWORD fields from a single LOGIN item.

#### Form C — token only (out-of-band bootstrap)

```yaml
auth:
  token: "user_<24hex>_<20alnum>"
```

The bearer is supplied directly. `ttctl auth signin` is not applicable (refused with `NO_CREDENTIALS`). Useful for the E2E sandbox and for deployments that bootstrap a token via a side-channel.

#### Form D — credentials + token (post-signin Form A or B)

```yaml
auth:
  credentials: "op://Personal/ttctl"
  token: "user_<24hex>_<20alnum>"
```

The on-disk shape after a successful `ttctl auth signin` against a Form A or B config. Both fields coexist; signout removes the `token` field (returning to Form A or B) without touching `credentials`.

## MCP Integration

TTCtl implements the [Model Context Protocol](https://modelcontextprotocol.io) (MCP) so AI assistants can interact with your Toptal Talent profile through natural language. Run `ttctl mcp` to start an MCP server on stdio.

### MCP Client Configuration

<details>
<summary><b>Claude Desktop</b></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ttctl": {
      "command": "npx",
      "args": ["ttctl", "mcp"]
    }
  }
}
```

</details>

<details>
<summary><b>Claude Code</b></summary>

```sh
claude mcp add ttctl -- npx ttctl mcp
```

</details>

<details>
<summary><b>Cursor</b></summary>

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "ttctl": {
      "command": "npx",
      "args": ["ttctl", "mcp"]
    }
  }
}
```

</details>

> **Trust model**: any process that can spawn `ttctl mcp` gets full access to your Toptal Talent profile through your saved auth token. Don't grant MCP access to untrusted AI agents. See [SECURITY.md](SECURITY.md).

## How TTCtl works under the hood

The Toptal Talent platform exposes three GraphQL endpoints:

- `https://www.toptal.com/gateway/graphql/talent/graphql` — used by the mobile app; accepts plain HTTPS + session cookies
- `https://www.toptal.com/api/talent_profile/graphql` — used by the web profile editor; **Cloudflare-protected** (requires browser TLS fingerprint impersonation)
- `https://scheduler.toptal.com/api/graphql` — used by the scheduler; separate Cloudflare zone

TTCtl uses two transports:

- **Stock** ([`undici`](https://github.com/nodejs/undici)) for the mobile gateway endpoint
- **TLS-impersonating** ([`node-wreq`](https://www.npmjs.com/package/node-wreq) with the `chrome_146` profile) for the Cloudflare-protected endpoints

Authentication is **bearer-token based** (per ADR-005 in the private `ttctl/research` repo): TTCtl POSTs `EmailPasswordSignIn` in persisted-query mode (SHA-256 hash from a captured operations catalog), captures the returned session token, persists it back into the same `~/.ttctl.yaml` config under `auth.token` (atomic write, mode `0600`), and replays it as `Authorization: Token token=<X>` on every subsequent GraphQL request. Cookies are NOT used; Chrome TLS impersonation alone passes Cloudflare on the protected surfaces.

The reverse-engineering artifacts (APK decoded, GraphQL operations catalog, schema synthesis, ADRs) live in a separate **private** repository (`ttctl/research`). They are not redistributable.

## Disclaimer

TTCtl is an **independent personal-productivity project** not affiliated with, endorsed by, or officially connected to **Toptal**, Toptal LLC, or any Toptal entity.

This software is provided to you, the Toptal talent, as a tool for managing **your own** profile data more efficiently. Using it to interact with profiles other than your own, to scale outreach beyond what a human can do manually, to manipulate platform-side metrics, or to extract data about other parties violates the spirit of fair use and Toptal's Terms of Service.

The maintainer disclaims any warranty and accepts no liability for use that violates platform terms. If Toptal LLC objects to TTCtl's existence and reaches out in good faith, the maintainer will work with them to address the concern.

"Toptal" is a trademark of Toptal LLC. Use of the name in this project's description is **nominative fair use** only — to identify the third-party platform that TTCtl interacts with.

## Code of Conduct

This project adopts the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md) (version 3.0). The Code applies to all project spaces and to anyone interacting with the project — issue tracker, pull requests, MCP server interactions, and any other channel.

To report a concern, email <alexey.pelykh@gmail.com>. Pseudonymous reports are accepted; truly anonymous reports are not feasible (the maintainer reads the inbox directly). Best-effort response within 7 days.

## License

[AGPL-3.0-only](LICENSE)

### What AGPL means for you

- **Using `ttctl` as a CLI tool or MCP server** does not make your code AGPL-licensed. Running the tool, scripting around it, or connecting it to your applications is normal use — no license obligations arise.
- **Using `@ttctl/core` as a library** (importing it into your code) means your combined work is covered by AGPL-3.0. If you distribute that combined work, you must make its source available under AGPL-compatible terms.
- **Modifying and distributing TTCtl itself** requires you to share your changes under AGPL-3.0.
- **Commercial licensing** is not currently offered. TTCtl is a personal-productivity project, not a product.
