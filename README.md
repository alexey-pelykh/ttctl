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

If you encounter misuse of TTCtl, please see [Abuse reporting in SECURITY.md](SECURITY.md#abuse-reporting).

Architectural friction in the codebase (sequential rate limits, single-credential design, no batch parallelism on automation-prone endpoints) is intentional. Don't remove it.

"Toptal" is a trademark of Toptal LLC. The name appears in this project's description as **nominative fair use** only — TTCtl is not a Toptal brand.

## What It Does

TTCtl gives you (and your AI assistants, via [MCP](https://modelcontextprotocol.io)) programmatic access to your own Toptal Talent profile:

- **Profile** — view and update your talent profile (basic info, skills, employment, education, certifications, industries, portfolio, visas, resume, external links, reviews, photo)
- **Applications** — review your activity items (applications, availability requests, interviews, engagement signals); per-status-group counts via `applications stats`
- **Engagements** — view current and past engagements; manage engagement breaks; per-status counts via `engagements stats`
- **Jobs** — browse opportunities; manage saved / viewed / not-interested signals; configure search subscription
- **Timesheets** — list, view, and submit timesheet billing cycles
- **Availability** — view and update working hours and allocated weekly hours
- **Contracts** — view talent-level contracts (Toptal Direct, MSA, etc.)
- **Payments** — view payout history and payment methods; submit rate-change requests
- **Auth** — bootstrap config, sign in, check status, sign out

Surfaces are gated to read-heavy / personal use. Operations that would enable mass automation against the platform are deliberately not exposed.

## Prerequisites

- **Node.js** >= 22.19.0
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

### Hardened install (recommended)

For maximum supply-chain safety, install with `postinstall` hooks disabled:

```sh
npm install -g --ignore-scripts ttctl
```

`--ignore-scripts` blocks `preinstall` / `postinstall` / `prepare` hooks
across the entire dependency tree at install time. This prevents a
compromised transitive dep (PhantomRaven, Shai-Hulud, etc.) from
executing code on your machine during install — closing the
most-exploited supply-chain attack vector against package-manager users.

TTCtl itself ships no install-time hooks. Disabling them is purely a
defense against malicious behavior in dependencies you don't directly
control. See [SECURITY § User-install supply-chain hardening](SECURITY.md#user-install-supply-chain-hardening).

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

### Data-handling — what MCP tools return into your assistant's context

When an AI assistant calls a TTCtl MCP tool, the tool's response payload — your profile, your engagements, your payouts, your contracts — enters the assistant's context window. From that point, **your AI-assistant host decides** what happens to that data: whether it's persisted to chat history, indexed into a vector database, surfaced to other tools loaded in the same session, or uploaded as part of telemetry.

TTCtl cannot pin host behaviour. The defenses live in your operator choices. Three concrete recommendations:

1. **Pick a host that matches your privacy posture.** Current host defaults (as of 2026-05; expected to drift) — Claude Code: per-session, opt-in cross-session persistence; Claude Desktop: default-on local chat-history persistence; Cursor: default-on local persistence + default-on vector-DB indexing of tool outputs; Windsurf: similar to Cursor; ChatGPT desktop: vendor-managed, assume persistent. The vector-indexing hosts (Cursor / Windsurf) can re-surface your Toptal data into a future, unrelated conversation if a semantic query matches — this is the highest-friction property of the persistence destinations.
2. **Use private / ephemeral chat modes** for sessions that exercise TTCtl tools returning third-party free-text — namely engagement comments, application messages, job descriptions, contract clauses, and review comments. Operators who routinely browse jobs or read engagement notes via the assistant should consider a host-side workspace dedicated to TTCtl tasks (Cursor: separate workspace; Claude Code: per-project scoping).
3. **Do not co-load TTCtl with outbound tools you don't control.** A web-fetch tool, an arbitrary-filesystem-write tool, or a sibling MCP server with its own apply path makes cross-tool exfiltration a realistic threat: an adversarial instruction embedded in a Toptal engagement note could chain into the sibling tool's apply path, with no `dryRun` gate. The mitigation is session-level — keep TTCtl in sessions where the loaded tools are operator-trusted.

The full threat model — including the per-tool audit, severity rubric, mitigation trade-off analysis, and residual risk register — is in [`docs/security/mcp-leakage-threat-model.md`](docs/security/mcp-leakage-threat-model.md). The companion section in [SECURITY.md § MCP Trust Model](SECURITY.md#mcp-trust-model) covers the input-side defenses (state-change mitigation via `dryRun`, file-upload sandbox).

## Troubleshooting

### Debug logs for `auth signin` / `auth signout`

When the post-signin write-back to `~/.ttctl.yaml` does something unexpected — silent overwrite, mtime-drift refusal, lock contention, mysterious "Refusing to write" message — turn on the structured debug log to see exactly which invariant fired and what the file's state was at each step:

```sh
TTCTL_DEBUG_CONFIG=1 ttctl auth signin
```

Output is one JSON object per line on **stderr** (so `-o json` mode on stdout stays clean). The bearer token is **never** logged. Pipe through `jq` to inspect:

```sh
TTCTL_DEBUG_CONFIG=1 ttctl auth signin 2> debug.log
jq -c '.' debug.log
```

Each record carries `ts` (ISO-8601), `op` (`persist` or `clear`), `path`, and `event`. Event-specific fields tell you what happened:

| Event               | Meaning                                  | Useful fields                                         |
| ------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `prewrite_checks`   | Symlink/sync-root gates passed           | `symlink_ok`, `syncroot_ok`, `perm_ok`                |
| `lock_acquired`     | Got the cross-process write lock         | `wait_ms` (was there contention?)                     |
| `stat_baseline`     | Captured pre-write file state            | `mtime_ms`, `mode_octal`                              |
| `tempfile_written`  | Temp file flushed to disk                | `temp_path`, `size_bytes`                             |
| `final_state`       | Mode applied to temp before rename       | `mode_applied`                                        |
| `mtime_drift_check` | Concurrency re-check vs baseline         | `delta_ms`, `pass` (false ⇒ another writer raced you) |
| `rename_completed`  | Atomic rename to canonical path          | —                                                     |
| `lock_released`     | Lock released in `finally`               | `duration_ms` (total hold)                            |
| `error`             | Something threw inside the locked region | `error_class`, `error_message`, `lock_held_at_error`  |

If you ever see an `error` event without a following `lock_released`, that would be a leaked lock — file an issue. The error path always emits `lock_released` (the release lives in the `finally`, runs regardless of which invariant fired).

When `TTCTL_DEBUG_CONFIG` is unset (or set to anything other than literal `1` — `0`, `true`, empty string all count as "off"), the logger is silent and pays zero per-call overhead.

### Remote kill-switch (wire-break defense)

TTCtl is reverse-engineered from Toptal's APK; the wire format can change without notice. As a defense-in-depth signal, the CLI fetches a small JSON manifest at startup from `https://raw.githubusercontent.com/alexey-pelykh/ttctl/main/status/known-broken.json` and emits a warning (or refuses to run) when the running version is listed as known-broken. The MCP server does the same at `buildServer` time, plus a recurring ~24h refetch — but always warns, never refuses (refusing a long-lived server interrupts in-flight tool calls).

- **Latency cost**: synchronous fetch with a 3 s timeout. Typical latency 50–200 ms against raw.githubusercontent.com; worst-case 3 s before the action runs.
- **Privacy**: the fetch sends only the default Node `fetch` headers — no version, no account identifier, no telemetry. Install-count tracking is intentionally deferred.
- **Fail-silent**: every error path (network, timeout, 404, malformed manifest) is swallowed. The kill-switch can NEVER itself cause a denial-of-service when the maintainer's repo is briefly unreachable.
- **Override** — disable the check entirely with:

  ```sh
  export TTCTL_DISABLE_KILL_SWITCH=1
  ```

  Captured at module load (matches the `TTCTL_DEBUG_CONFIG` / `TTCTL_DEBUG_MCP` / `TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY` conventions). Any other value (empty string, `0`, `true`) keeps the check enabled.

The detection sources, severity tiers, response cadence, and C&D / legal posture are documented in [`docs/operations/wire-breakage-runbook.md`](docs/operations/wire-breakage-runbook.md). The manifest schema and update procedure live in [`status/README.md`](status/README.md).

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

For a longer write-up of the project's posture on trademark use, Terms of Service, the AGPL choice, and the fair-use tradition this kind of tool sits in, see [`docs/legitimacy.md`](docs/legitimacy.md).

## Support

TTCtl is reverse-engineered from Toptal's APK; the wire format can change without notice, and the maintainer's only signal that something has shifted is **your report**. There is no telemetry, no error-reporting endpoint, no install-count tracking — the channels below are the entire return path.

### Wire broke for you — `ttctl <command>` failing

If a TTCtl command errors or returns an unexpected response (404, cryptic GraphQL error, `WIRE_SHAPE_ERROR` envelope, etc.), open a [**Wire broke for me**](https://github.com/alexey-pelykh/ttctl/issues/new?template=wire-broke-for-me.yml) issue. The template captures `ttctl --version`, the failing command, the error text, and whether `ttctl auth status` still succeeds — enough for the maintainer to triage against the kill-switch manifest at [`status/known-broken.json`](status/known-broken.json) and the [wire-breakage runbook](docs/operations/wire-breakage-runbook.md).

Before filing, check the kill-switch manifest at <https://raw.githubusercontent.com/alexey-pelykh/ttctl/main/status/known-broken.json> — if your version is listed, the maintainer is already aware.

### MCP host failed to invoke a tool

If an MCP host (Claude Desktop, Claude Code, Cursor, Windsurf, etc.) could not surface or invoke a TTCtl tool — the failure is at the **host ↔ server boundary**, not the Toptal wire — open an [**MCP host failed to invoke a tool**](https://github.com/alexey-pelykh/ttctl/issues/new?template=mcp-tool-issue.yml) issue. The template captures host product + version, the failing tool name, the host's surfacing of the error, and the optional `TTCTL_DEBUG_MCP=1` server-side trace.

### Questions, ideas, "is this expected?"

Use [Discussions](https://github.com/alexey-pelykh/ttctl/discussions) for questions, usage help, ideas, or "did anyone else see this?" — the issue tracker is reserved for confirmed breakages and feature requests.

### Security vulnerabilities

**Do not** open a public issue for security vulnerabilities. See [SECURITY.md § Reporting a Vulnerability](SECURITY.md#reporting-a-vulnerability) for the coordinated-disclosure channel.

### Abuse reporting

See [SECURITY.md § Abuse reporting](SECURITY.md#abuse-reporting) if you've observed TTCtl being used in ways that violate Toptal's Terms of Service (mass automation, recruiter scraping, engagement-signal manipulation, etc.).

### Privacy when reporting

`~/.ttctl.yaml` carries your captured bearer token (`auth.token`, shape `user_<24hex>_<20alnum>`). **Never paste it in a public issue or Discussions thread.** TTCtl's debug emitters (`TTCTL_DEBUG_CONFIG`, `TTCTL_DEBUG_MCP`) are designed to never print bearer values, but transcripts from your shell may include them — scan before pasting and redact as `<REDACTED>`.

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
