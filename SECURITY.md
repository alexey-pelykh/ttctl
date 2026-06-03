# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in TTCtl, please report it responsibly
by emailing **alexey.pelykh@gmail.com**. Do not open a public issue.

You should receive a best-effort response within 7 days. Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce or a proof-of-concept.
- The version of TTCtl you tested against.

## Abuse reporting

If you believe TTCtl is being misused against Toptal's platform — spam, mass automation, scraping of other talents' data, application bombing, engagement-signal manipulation, or any behavior violating Toptal's Terms of Service — please contact the maintainer:

- **GitHub issue**: file at https://github.com/alexey-pelykh/ttctl/issues with label `abuse-report`.
- **Email**: alexey.pelykh@gmail.com (best-effort response within 7 days).

The maintainer takes platform-integrity concerns seriously and will investigate credible reports. TTCtl is designed for fair use against the user's own profile; the disclaimer (README + website) makes this scope explicit.

This is NOT a coordinated-disclosure channel for security vulnerabilities; for that, see § Reporting a Vulnerability above.

## Security Model

### Credential Handling

TTCtl authenticates against the Toptal Talent platform using a **bearer
session token** issued by `EmailPasswordSignIn` (per
`hq/engineering/adr/ADR-005-auth-model.md`). The token is replayed on every
GraphQL request as `Authorization: Token token=<X>` — cookies are NOT used.

Credentials and the captured bearer live in a single config file
(`~/.ttctl.yaml` by default). The `auth` block has four valid lifecycle
shapes; see [README § Configuration](README.md#configuration) for the
canonical reference.

| Form | Shape                                                                        | Recommended      |
| ---- | ---------------------------------------------------------------------------- | ---------------- |
| A    | `auth.credentials: "op://VAULT/ITEM"` (1Password reference)                  | yes              |
| B    | `auth.credentials: { username, password }` (literal)                         | dev/testing only |
| C    | `auth.token: "user_<24hex>_<20alnum>"` (out-of-band bootstrap)               | E2E sandbox      |
| D    | `auth.credentials: ... + auth.token: ...` (post-signin state of Form A or B) | typical          |

When the 1Password form is used, TTCtl shells out to `op item get` at signin
time only to resolve `username` and `password`. Credentials are not persisted
by TTCtl. After `ttctl auth signin` succeeds, the captured bearer is written
atomically back into the **same** `~/.ttctl.yaml` under `auth.token`.

### Enforced Security Gates

The following gates fire at runtime — they are documented here because the
auditable surface area depends on them being known to security-conscious
operators, not just resident in the code:

| Gate                                                             | Defends Against                                                           | Source                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| File mode `0o600` on persist                                     | Co-tenant read of bearer                                                  | `packages/core/src/configWriter.ts`       |
| Refuse-load on world-writable mode                               | TOCTOU credential swap                                                    | `packages/core/src/config.ts`             |
| Refuse-write on symlink                                          | Swap-target attack                                                        | `packages/core/src/configWriter.ts`       |
| Refuse-write under sync-root prefix                              | Bearer replicating to iCloud / Dropbox / OneDrive / Google Drive / Box    | `packages/core/src/configWriter.ts`       |
| Mtime drift detection                                            | Concurrent write or backup-restore racing the write window                | `packages/core/src/configWriter.ts`       |
| Cross-process advisory lock (proper-lockfile)                    | Two ttctl processes interleaving auth writes                              | `packages/core/src/configLock.ts`         |
| Bearer rescue on persist failure                                 | Silent loss of captured bearer on read-only FS / full disk                | `packages/core/src/configWriter.ts`       |
| Bearer-pattern leakage scanner in CI                             | Accidental commit of `user_<24hex>_<20alnum>` strings                     | `scripts/check-secret-leakage.ts`         |
| Single-source-of-truth redaction module                          | Drift between runtime debug logger and lint scanner                       | `packages/core/src/lib/redact.ts`         |
| `--debug` bearer-absence enforcement at runtime AND test         | Bearer ever appearing in any allowlisted debug record shape               | `packages/core/src/lib/redact.ts` + tests |
| Crash-path bearer scrub (uncaughtException + unhandledRejection) | Captured bearer leaking through a crash log on the way out of the process | `packages/cli/src/crash-handlers.ts`      |
| MCP path-capture-on-startup                                      | Mid-session env-var shifts retargeting reads/writes                       | `packages/mcp/src/server.ts`              |
| MCP file-upload path-prefix sandbox                              | Prompt-injection exfiltration of files outside the upload sandbox         | `packages/mcp/src/tools/file-upload.ts`   |
| MCP file-upload extension allowlist                              | Prompt-injection exfiltration of extensionless / non-document secrets     | `packages/mcp/src/tools/file-upload.ts`   |

The sync-root list (iCloud Drive, Dropbox, OneDrive, Google Drive, Box) is
documented in [README § Sync-root exclusion](README.md#sync-root-exclusion).
Persisting a bearer to a sync-replicated directory is refused outright with
a sibling-name guard preventing false positives (`~/DropboxOther/` is fine).

### Crash-output secret invariant

The CLI binary entry (`packages/ttctl/src/cli.ts`) installs global
`uncaughtException` and `unhandledRejection` handlers via
`installCrashHandlers()` from `@ttctl/cli` BEFORE any other code runs.
The handlers ensure that **no captured Toptal session bearer can appear
verbatim in any crash output** the process emits on its way out.

Mechanism:

- The crash log shape is fixed: `[<kind>] <ErrorName>: <message>` followed
  by the stack (when present). Nothing else — `process.env`, `process.argv`,
  CWD, and other ambient runtime state are intentionally omitted.
- The assembled message + stack is passed through `redactString` from
  `@ttctl/core` (single source of truth alongside `redactBody` /
  `redactHeaders`), which replaces every `user_<24hex>_<20alnum>` match
  with `***REDACTED***`.
- Output goes to `process.stderr` only. The data channel `process.stdout`
  (where `-o json` / `-o yaml` envelopes ship) is never touched by the
  crash path — a partially-flushed JSON envelope is preferable to one
  contaminated by an unrelated stack trace.
- Exit code is `1` (non-zero) for both crash kinds.

**Scope and limits:**

- The scrub catches the **bearer pattern** because TTCtl knows what its
  bearers look like. It does NOT catch literal 1Password-resolved
  passwords interpolated into a thrown error's `.message` or `.stack` —
  detecting those would require a runtime registry of known in-memory
  secrets, which is out of scope (see § Future telemetry design rule).
  The structural defense is that auth flows do not interpolate the
  resolved password into thrown errors at all.
- The crash handlers only fire for **process-level** unhandled throws.
  Anything caught and rendered by command handlers goes through
  `presentTtctlError` / per-command formatters; those paths separately
  use `redactBody` and `redactHeaders` on structured envelopes.
- `--inspect` is a separate channel — see § Inspector / heap-dump risk
  below. The crash scrub does not protect heap contents exposed through
  the V8 inspector port.

The crash-handler scrub is **defense-in-depth**, not the load-bearing
defense. Load-bearing defenses are: (1) credential resolution happens
at signin time only and the password is not held in memory beyond the
call; (2) the captured bearer is stored on disk at mode `0o600` and
replayed on each request without being interpolated into log lines; (3)
the existing redaction pipeline scrubs the bearer from `--verbose` /
`--debug` output BEFORE any line reaches stderr.

### Future telemetry design rule

TTCtl does NOT currently ship telemetry, crash-reporting, or any
analytics that emit data to a remote service. **If telemetry is ever
added**, it MUST satisfy these invariants at design time:

| Invariant                                            | What it requires                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass the redaction pipeline                          | Every outbound payload runs through `redactBody` / `redactHeaders` / `redactString` from `@ttctl/core` before serialization. The single-source-of-truth gate above forbids per-feature redaction.                                                  |
| Bearer-absence at runtime AND test                   | Mirror the pattern from `--debug` (`packages/core/src/lib/diagnostic-log.ts` + tests): assert a fresh bearer cannot appear in any allowlisted record shape, enforced both at runtime via a typed schema and at test time via substring assertions. |
| No `process.env`, `process.argv`, or CWD in payloads | The crash-output invariant extends here: env vars and argv carry shell-completion fragments, 1Password session tokens (`OP_SESSION_*`), and other secrets that the application side cannot pre-redact. Don't ship them.                            |
| Opt-in only                                          | Telemetry must be off by default. Operators opt in via an explicit config setting or env var; opt-out semantics are inadequate because the first crash before opt-out could ship the leak.                                                         |
| No PII without justification                         | Email, profile IDs, talent IDs, and proposal IDs are all PII in the Toptal Talent context. A telemetry channel that ships these must justify each field individually.                                                                              |

This is a **design rule**, not implementation work — it gates any future
PR that introduces telemetry, crash-reporting, error-aggregation, or
similar outbound observability features. The same rule applies to any
optional uploader hook the MCP layer might expose to its clients.

### Inspector / heap-dump risk

Running Node.js with `--inspect`, `--inspect-brk`, or `--inspect-port`
opens a **V8 inspector port** that lets any local process connect over
the Chrome DevTools Protocol and read arbitrary heap memory. Anything
TTCtl resolves into memory — the captured bearer token, the
1Password-resolved password during signin, parsed `~/.ttctl.yaml`
contents — is reachable via the inspector while the process is alive.

**TTCtl never enables `--inspect` by default.** The CLI bin
(`packages/ttctl/src/cli.ts`) shells out to whatever flags the user
passes to `node`; TTCtl itself does not inject `--inspect` flags via
`NODE_OPTIONS`, `package.json` scripts, or any other channel. The
invariant is structural: zero call sites in the project enable the
inspector programmatically.

If you choose to run `ttctl --inspect` for debugging (or set
`NODE_OPTIONS=--inspect` in your shell), be aware that:

- The inspector port defaults to `127.0.0.1:9229`. Any process on the
  same machine — including a compromised browser tab connecting via
  WebSocket — can connect and dump the heap.
- Heap dumps written via `node --heap-prof` or the DevTools Memory tab
  contain the bearer and any other in-memory secret verbatim. Treat
  the resulting `.heapprofile` / `.heapsnapshot` files as you would
  treat `~/.ttctl.yaml` itself: chmod 0o600, never commit, never
  attach to a public issue.
- The MCP server is especially exposed because it is long-lived. The
  recommended posture is to never run `ttctl mcp` under `--inspect`
  unless you are debugging the server itself.

### Bearer Revocation — Empirical Scope

`ttctl auth signout` attempts the `LogOut` mutation against
`talent_profile/graphql` and then unconditionally removes the local
`auth.token` field. **Empirically** (#180, 2026-05-12), the server-side
LogOut mutation acknowledges success (`data.logOut.success === true`) but
does NOT invalidate the bearer for subsequent `mobile-gateway` requests
across a 5-minute probe window. The **load-bearing revocation defense is the
24-72h server-side aging-out** of the captured bearer; the `LogOut` call is
defense-in-depth (audit signal + web-session cookie cleanup + a forward-
compatible call site).

Discriminants in TTCtl's source reflect this scope: the local-clear status
is `logged-out`, never `revoked`.

### Threat Model Assumptions

| Assumption                            | Rationale                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| The local machine is trusted          | Bearer is mode-0o600 plaintext on disk; FS-level protection only                          |
| 1Password CLI is trusted              | When `auth.credentials: "op://..."` is configured, TTCtl trusts the `op` binary           |
| The Toptal Talent platform is trusted | All API calls are made over HTTPS to `*.toptal.com`                                       |
| The host where MCP runs is trusted    | MCP stdio transport is process-level; anyone who spawns `ttctl mcp` gets full tool access |

The literal `auth.credentials: { username, password }` form (Form B) stores
plaintext credentials in the YAML config and is discouraged for daily use.
Backups, sync clients, and accidental commits all expose plaintext config
files; Form A (1Password reference) removes the plaintext-on-disk surface
entirely.

### MCP Trust Model

TTCtl exposes an MCP server (`ttctl mcp`) that gives MCP clients programmatic
access to your Toptal Talent profile via the captured bearer.

#### Transport

The MCP server uses **stdio transport**. The MCP client (e.g., Claude
Desktop) spawns `ttctl mcp` as a child process and communicates over
stdin/stdout — no network listener, no authentication token. The trust
boundary is **process-level**: any process that can spawn `ttctl mcp` gets
full access to every registered tool, scoped to your own Toptal Talent
profile.

#### Prompt Injection Risk — Two Variants

When the MCP client is an AI agent, the agent processes data from various
sources, some of which may be untrusted (incoming messages, third-party
documents, web content). Adversarial input can attempt two distinct
attacks:

1. **State-change injection**: induce the agent to invoke profile updates,
   application state changes, or other mutations the operator did not
   intend. Mutating MCP tools support `dryRun` precisely so operator review
   is the recovery path.
2. **File-exfiltration injection**: induce the agent to call file-upload
   tools (`ttctl_profile_basic_photo_upload`, `ttctl_profile_resume_upload`,
   portfolio upload tools) with an arbitrary host path that reads sensitive
   local files (`~/.ssh/id_rsa`, `~/.aws/credentials`, etc.) and uploads
   them to Toptal under the operator's own bearer-trusted channel. Two
   defense-in-depth gates apply at the MCP layer for every file-upload
   tool: a **path-prefix sandbox** that refuses reads outside
   `~/Documents`, `~/Downloads`, and `~/Desktop`, and a per-tool
   **extension allowlist** that refuses non-image extensions for photo /
   portfolio-cover uploads, non-document extensions for resume uploads,
   and explicitly excludes secret-correlated extensions
   (`.pub`, `.env`, `.db`, `.sqlite`, `.sh`, extensionless files like
   `id_rsa`) from the broadest portfolio-attachment allowlist. The
   threat-model anchor — `ttctl_profile_resume_upload({ filePath:
"~/.ssh/id_rsa" })` — fails both gates and never reaches the apply
   path. The sandbox can be bypassed by setting
   `TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY=1` in the MCP server's environment
   (extension allowlist still applies); MCP operators staging upload
   candidates outside the default safe directories may opt in.
   **Operators should still treat file-upload tool invocations from
   untrusted prompt contexts as suspicious** — the gates raise the bar
   but do not eliminate the need for review when an agent is processing
   untrusted content.

#### Response-Side Leakage — Operator Awareness (#265)

The two prompt-injection variants above protect the **input** side:
state-change mutations are gated by `dryRun` review, and the file-upload
input path is sandboxed. The **response** side — what the MCP tool sends
BACK into the AI assistant's context — is a separate threat surface
covered by [`docs/security/mcp-leakage-threat-model.md`].

Three response-side threats matter:

1. **PII persistence in AI-assistant chat history / vector databases.**
   Tool output enters the assistant's context and may be persisted by
   the host vendor (Claude Desktop / Cursor / Windsurf default to local
   chat-history persistence; Cursor and Windsurf additionally index tool
   outputs into a vector DB by default). Persistence destinations are a
   host-vendor decision outside TTCtl's control.
2. **Indirect prompt injection via Toptal-side free-text.** Engagement
   notes, application messages, contract clauses, job descriptions, and
   review comments can carry adversarial instructions written by third
   parties. Tools that surface this content are tagged High on the
   injection severity axis (per the threat-model § 5 audit) and carry an
   in-description third-party-content notice (composed at registration
   time — see `packages/mcp/src/data-handling.ts`).
3. **Cross-tool exfiltration** when TTCtl shares a session with outbound
   tools the host has loaded. An injection in TTCtl's response payload
   can chain into a sibling tool's apply path; `dryRun` does not gate
   sibling tools.

**Operator-side mitigations**:

- Treat the [README § MCP Integration](README.md#mcp-integration)
  guidance as required reading before enabling the server on a
  long-lived host.
- Use private / ephemeral chat modes when invoking TTCtl tools that
  return third-party free-text.
- Where the host supports it, exclude TTCtl tool outputs from vector-DB
  indexing (Cursor: `.cursorrules`; Windsurf: workspace settings).
- Do not co-load TTCtl with outbound tools (web-fetch, arbitrary-write
  filesystem tools) you do not control in the same session.

**Sanitization is intentionally not implemented at the MCP layer.**
Heuristic sanitization gives false security disproportionate to its
partial coverage; sentinel-envelope wrapping is currently not honored by
any major MCP host. The full trade-off analysis is in the threat-model
document § 7.

[`docs/security/mcp-leakage-threat-model.md`]: docs/security/mcp-leakage-threat-model.md

### User-install supply-chain hardening

The Toptal Talent platform has no public API; TTCtl is built from a
hand-curated dep tree resolved through pnpm with `--frozen-lockfile`
during build and publish. The defenses that exist at build/publish time
are:

| Defense                                                                 | Where                              | What it stops                                          |
| ----------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `--frozen-lockfile`                                                     | `.github/actions/setup/action.yml` | Lockfile drift / unauthorized version bumps in CI      |
| `--ignore-scripts` at CI install                                        | `.github/actions/setup/action.yml` | Postinstall RCE in transitive deps reaching CI runners |
| `pnpm audit --audit-level=high`                                         | `.github/workflows/release.yml`    | Publishing a release while a high/critical CVE exists  |
| Workspace dep-confusion guard                                           | `scripts/check-dep-confusion.ts`   | `@ttctl/*` dep accidentally resolving to public npm    |
| Pinned action SHAs (with version comments)                              | `.github/workflows/*.yml`          | Mutable-tag substitution in GitHub Actions             |
| npm-registry Sigstore provenance (`pnpm publish --provenance`)          | `.github/workflows/release.yml`    | Forged or untraceable releases on the npm registry     |
| GitHub-side build-provenance attestation (`attest-build-provenance@v4`) | `.github/workflows/release.yml`    | Tarball substitution outside the npm registry          |
| CycloneDX SBOMs per published package + workspace aggregate             | `.github/workflows/release.yml`    | Opaque dependency graph — blocks downstream CVE audit  |

For the end user installing `ttctl` on their own laptop, the
recommended posture is to install with postinstall hooks disabled:

```sh
npm install -g --ignore-scripts ttctl
```

This blocks `preinstall` / `postinstall` / `prepare` hooks across the
entire dependency tree at install time. PhantomRaven (126 packages,
86,000 installs) and Shai-Hulud (500+ auto-propagated packages) — both
2025 incidents — demonstrate that a compromised transitive dep can
execute arbitrary code on the installing machine during `npm install`,
exposing the user's unlocked 1Password session, SSH agent, and shell
history. `--ignore-scripts` closes that window.

TTCtl itself ships no install-time hooks; the `package.json` of every
published workspace package has no `preinstall` / `postinstall` /
`prepare` script that requires execution. Disabling install scripts is
therefore zero-cost for TTCtl users and a meaningful defense against
behavior in dependencies the maintainer does not directly control.

See [README § Hardened install](README.md#hardened-install-recommended)
for the user-facing install snippet.

#### Verifying provenance and consuming SBOMs

Each tagged release publishes two independent provenance attestations
that anchor the artifact to this GitHub Actions build:

1. **npm-registry side** — visible in `npm view <pkg>@<version> --json`
   under `.dist.attestations.provenance`, signed via npm's OIDC trusted-
   publishing flow. The CI gate `Verify provenance attestations` in
   `release.yml` fails the release if this is absent.
2. **GitHub side** — signed by `actions/attest-build-provenance` and
   stored in the public Sigstore transparency log. Verify against any
   published tarball with the `gh` CLI:

   ```sh
   # Against an npm-served tarball (anyone, no auth required):
   curl -fsSL "$(npm view ttctl@<version> --json | jq -r '.dist.tarball')" -o ttctl.tgz
   gh attestation verify ttctl.tgz --owner alexey-pelykh

   # Or against a tarball downloaded from the GitHub Release assets:
   gh release download v<version> --pattern '*.tgz' --repo alexey-pelykh/ttctl
   gh attestation verify ./ttctl-<version>.tgz --owner alexey-pelykh
   ```

CycloneDX 1.6 SBOMs are uploaded to each GitHub Release as `.cdx.json`
assets — one per published package (`@ttctl/core`, `@ttctl/cli`,
`@ttctl/mcp`, `ttctl`) plus a workspace aggregate. Audit the full
transitive dependency graph against your CVE/license policy with any
CycloneDX-compatible tool (e.g., `osv-scanner --sbom`, `grype sbom:...`,
`cdxgen-cli vex`):

```sh
gh release download v<version> --pattern '*.cdx.json' --repo alexey-pelykh/ttctl
osv-scanner --sbom ttctl-<version>.cdx.json
```

### Recommendations

- Store credentials via 1Password references (Form A) rather than literal
  `username` / `password` (Form B).
- Restrict file permissions on `~/.ttctl.yaml` to the owning user
  (`chmod 600 ~/.ttctl.yaml`). TTCtl writes at `0o600` on persist; ensure
  the file is also at `0o600` after any manual edit.
- Do not commit `.ttctl.yaml` files to version control. Add them to
  `.gitignore`.
- Do not place `~/.ttctl.yaml` under a cloud-sync directory. TTCtl refuses
  to write captured bearers under iCloud / Dropbox / OneDrive / Google
  Drive / Box prefixes; respecting this refusal is a load-bearing defense.
- Do not grant MCP access to untrusted AI agents. Any MCP client that can
  spawn `ttctl mcp` receives full access to all registered tools.
- Review agent tool calls for state-changing operations when using an AI
  agent as the MCP client; use `dryRun` to preview before applying.
- Be vigilant about file-upload tool invocations from contexts where the
  agent may have processed untrusted content (see "Prompt Injection Risk"
  above).
- Keep TTCtl up to date to benefit from security fixes — particularly the
  TLS impersonation profile, which must track current Chrome stable.

## Supported Versions

Security fixes are applied to the latest release only. There is no long-term
support for older versions.

## Project Use Policy

For the project's use policy and the boundaries of intended use, see the
[README](README.md). TTCtl is a personal-productivity tool intended for use
against the operator's own Toptal Talent profile only.
