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
- Recommended: **A logged-in Chrome session at `talent.toptal.com`** so that Cloudflare's `cf_clearance` cookie is available when refresh is required

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

# 2. Create a config file
cat > .ttctl.yaml <<'EOF'
auth: "op://Personal/ttctl"
EOF

#    (Alternatively, in the global location at $XDG_CONFIG_HOME/ttctl/config.yaml)

# 3. Verify you can sign in
ttctl auth status

# 4. View your profile
ttctl profile show
```

> **First run** will sign in via `EmailPasswordSignIn`, capture session cookies into `~/.ttctl/session.cookies` (mode `0600`), and use them for subsequent calls. The `op` CLI will be invoked once per session to resolve your credentials.

## Configuration

TTCtl uses a single config file — **no profiles, no environment-variable overrides**. Discovery order:

1. `./.ttctl.yaml` (current working directory) — useful for project-scoped use
2. `$XDG_CONFIG_HOME/ttctl/config.yaml` — defaults to `~/.config/ttctl/config.yaml`

### `auth` — Two valid forms

The `auth` key is **polymorphic** on type:

#### Form A — string (1Password reference, RECOMMENDED)

```yaml
auth: "op://Personal/ttctl"
```

TTCtl parses `op://VAULT/ITEM` and runs `op item get ITEM --vault VAULT --fields username,password --format json`. The 1Password item must have both `username` and `password` fields populated.

#### Form B — object (literal, dev/testing only)

```yaml
auth:
  email: "you@example.com"
  password: "hunter2"
```

> Discouraged for daily use. Plaintext credentials in config files leak through backups, sync clients, and accidental commits. Form A is what you want.

> **Per-field references like `auth: "op://Personal/ttctl/username"` are NOT supported.** The schema rejects them. Use Form A (item-level reference) — TTCtl always reads both `username` and `password` fields from a single item.

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

> **Trust model**: any process that can spawn `ttctl mcp` gets full access to your Toptal Talent profile through your saved session cookies. Don't grant MCP access to untrusted AI agents. See [SECURITY.md](SECURITY.md).

## How TTCtl works under the hood

The Toptal Talent platform exposes three GraphQL endpoints:

- `https://www.toptal.com/gateway/graphql/talent/graphql` — used by the mobile app; accepts plain HTTPS + session cookies
- `https://www.toptal.com/api/talent_profile/graphql` — used by the web profile editor; **Cloudflare-protected** (requires browser TLS fingerprint impersonation)
- `https://scheduler.toptal.com/api/graphql` — used by the scheduler; separate Cloudflare zone

TTCtl uses two transports:

- **Stock** ([`undici`](https://github.com/nodejs/undici)) for the mobile gateway endpoint
- **TLS-impersonating** ([`node-wreq`](https://www.npmjs.com/package/node-wreq) with the `chrome_146` profile) for the Cloudflare-protected endpoints

Authentication is **cookie-jar based** (per [ADR-002](https://github.com/ttctl/research/blob/main/docs/decisions/ADR-002-auth-cookie-jar.md)): TTCtl POSTs `EmailPasswordSignIn` in persisted-query mode (SHA-256 hash from a captured operations catalog), captures `Set-Cookie` headers into a Mozilla-format jar at `~/.ttctl/session.cookies` (or `$XDG_DATA_HOME/ttctl/session.cookies`), and replays them on subsequent calls.

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
