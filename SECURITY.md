# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in TTCtl, please report it responsibly
by emailing **oleksii@pelykh.com**. Do not open a public issue.

You should receive a best-effort response within 7 days. Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce or a proof-of-concept.
- The version of TTCtl you tested against.

## Abuse reporting

If you believe TTCtl is being misused against Toptal's platform — spam, mass automation, scraping of other talents' data, application bombing, engagement-signal manipulation, or any behavior violating Toptal's Terms of Service — please contact the maintainer:

- **GitHub issue**: file at https://github.com/alexey-pelykh/ttctl/issues with label `abuse-report`.
- **Email**: oleksii @ pelykh.consulting (best-effort response within 7 days).

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

| Gate                                                     | Defends Against                                                        | Source                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| File mode `0o600` on persist                             | Co-tenant read of bearer                                               | `packages/core/src/configWriter.ts`       |
| Refuse-load on world-writable mode                       | TOCTOU credential swap                                                 | `packages/core/src/config.ts`             |
| Refuse-write on symlink                                  | Swap-target attack                                                     | `packages/core/src/configWriter.ts`       |
| Refuse-write under sync-root prefix                      | Bearer replicating to iCloud / Dropbox / OneDrive / Google Drive / Box | `packages/core/src/configWriter.ts`       |
| Mtime drift detection                                    | Concurrent write or backup-restore racing the write window             | `packages/core/src/configWriter.ts`       |
| Cross-process advisory lock (proper-lockfile)            | Two ttctl processes interleaving auth writes                           | `packages/core/src/configLock.ts`         |
| Bearer rescue on persist failure                         | Silent loss of captured bearer on read-only FS / full disk             | `packages/core/src/configWriter.ts`       |
| Bearer-pattern leakage scanner in CI                     | Accidental commit of `user_<24hex>_<20alnum>` strings                  | `scripts/check-secret-leakage.ts`         |
| Single-source-of-truth redaction module                  | Drift between runtime debug logger and lint scanner                    | `packages/core/src/lib/redact.ts`         |
| `--debug` bearer-absence enforcement at runtime AND test | Bearer ever appearing in any allowlisted debug record shape            | `packages/core/src/lib/redact.ts` + tests |
| MCP path-capture-on-startup                              | Mid-session env-var shifts retargeting reads/writes                    | `packages/mcp/src/server.ts`              |

The sync-root list (iCloud Drive, Dropbox, OneDrive, Google Drive, Box) is
documented in [README § Sync-root exclusion](README.md#sync-root-exclusion).
Persisting a bearer to a sync-replicated directory is refused outright with
a sibling-name guard preventing false positives (`~/DropboxOther/` is fine).

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
   them to Toptal under the operator's own bearer-trusted channel. **MCP
   operators should treat file-upload tool invocations from untrusted
   prompt contexts as dangerous**; defense-in-depth gates at the MCP layer
   for this variant are tracked as remediation work and not yet shipped.

### User-install supply-chain hardening

The Toptal Talent platform has no public API; TTCtl is built from a
hand-curated dep tree resolved through pnpm with `--frozen-lockfile`
during build and publish. The defenses that exist at build/publish time
are:

| Defense                                    | Where                              | What it stops                                          |
| ------------------------------------------ | ---------------------------------- | ------------------------------------------------------ |
| `--frozen-lockfile`                        | `.github/actions/setup/action.yml` | Lockfile drift / unauthorized version bumps in CI      |
| `--ignore-scripts` at CI install           | `.github/actions/setup/action.yml` | Postinstall RCE in transitive deps reaching CI runners |
| `pnpm audit --audit-level=high`            | `.github/workflows/release.yml`    | Publishing a release while a high/critical CVE exists  |
| Workspace dep-confusion guard              | `scripts/check-dep-confusion.ts`   | `@ttctl/*` dep accidentally resolving to public npm    |
| Pinned action SHAs (with version comments) | `.github/workflows/*.yml`          | Mutable-tag substitution in GitHub Actions             |

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
