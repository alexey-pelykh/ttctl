# Release rollback runbook

This is the operational playbook for **withdrawing a bad release** of TTCtl. It
covers the decision tree (deprecate vs unpublish vs roll-forward), the
**manual `npm deprecate` procedure** on the npm side (there is no automated
workflow — see [§ Authorization model](#authorization-model)), the surfaces that
need a coordinated update (npm, MCP registry, Smithery, GitHub Release), and
the consumer-communication templates.

> **Audience**: project maintainer(s) responding to a bad release under time
> pressure. Read once cold; treat as a checklist when actually rolling back.

## When to use this runbook

You discovered, post-publish, that a released version of TTCtl is broken,
exposes a security issue, or otherwise must be withdrawn. Symptoms include
(non-exhaustive):

- `npx ttctl@<version> --version` errors on a supported platform.
- A reproducible crash in a tool surface (CLI sub-command, MCP tool call).
- A captured-bearer leak path in logs, error messages, or `--output json`
  payloads (the secret-leakage NFRs trip).
- A Cloudflare-impersonation regression that no longer passes the
  `talent-profile` / `scheduler` surfaces (`Cf403Error` everywhere).
- A dependency CVE that ships in the released tarball with no clean
  upgrade path on the affected version line.
- A licensing or compliance regression (an AGPL-incompatible dep slipped
  past `pnpm license-check`).

If the release was published in the last **72 hours** AND has **zero
dependents** in the registry, `npm unpublish` is on the table (see [Decision
tree](#decision-tree) below). Outside that window, `npm deprecate` plus a
fixed re-publish is the only path.

## What is locked

TTCtl publishes to multiple write-once or partially-write-once surfaces. Know
the constraint surface before deciding what action to take.

| Surface        | Identifier(s)                                       | Mutability                                                                                          |
| -------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| npm registry   | `ttctl`, `@ttctl/core`, `@ttctl/cli`, `@ttctl/mcp`  | `npm unpublish` ≤72h after publish AND zero dependents; `npm deprecate` anytime; version is burned. |
| MCP registry   | `io.github.alexey-pelykh/ttctl` (via `server.json`) | Manifest can be re-submitted with a new version pointer; old version entries do not vanish.         |
| Smithery       | `ttctl@<version>` coordinate in `smithery.yaml`     | Re-submission updates the published coordinate; old entries remain on the registry.                 |
| GitHub Release | git tag (e.g. `v0.1.0`)                             | Tag is immutable in practice (do **not** force-push). Release notes / body can be edited.           |
| Git history    | commit on `main`                                    | Immutable on the protected branch — fix forward only.                                               |

Two consequences fall out of this:

1. **npm publishes are permanent at the version level.** Once `0.1.0` ships,
   the version string `0.1.0` can never be reused. The deprecation message
   stays attached to it forever; consumers who pinned `^0.1.0` keep
   resolving to it until they bump.
2. **The MCP registry and Smithery surface separate, slower revocation
   paths.** An `npm deprecate` does **not** retract the MCP-registry or
   Smithery manifest pointers — those need a manual re-submission cycle.
   See [Cross-surface rollback](#cross-surface-rollback) for the order
   of operations.

## Decision tree

```
Bad release shipped: vX.Y.Z
        │
        ▼
Within 72h of publish AND zero dependents on registry?
        │
        ├── YES ─→ `npm unpublish` is allowed
        │           │
        │           ▼
        │     Is the bug security-sensitive?
        │           │
        │           ├── YES ─→ unpublish + GitHub Security Advisory + hotfix vX.Y.Z+1
        │           └── NO  ─→ unpublish + hotfix vX.Y.Z+1
        │
        └── NO ─→ `npm deprecate` (this is the default path)
                    │
                    ▼
              Run the manual `npm deprecate` procedure
                    │
                    ▼
              Re-submit MCP-registry manifest + Smithery coordinate
              pointing at the fixed version (after vX.Y.Z+1 publishes)
                    │
                    ▼
              Hotfix vX.Y.Z+1 (full release pipeline) + GitHub Release banner
                    │
                    ▼
              Post-incident review (root cause, gate gaps, prevention)
```

The 72h unpublish path is **almost never** the right answer for TTCtl.
Lockstep monorepo versioning means every release covers four interdependent
packages — unpublishing `ttctl@X.Y.Z` while leaving `@ttctl/core@X.Y.Z` live
is a foot-gun that hands consumers a broken `npx ttctl` (the umbrella tries
to resolve the matching core version that no longer exists). If you go the
unpublish route, you must unpublish all four packages together AND in the
correct order (`ttctl` first as it depends on `@ttctl/core`, `@ttctl/cli`,
`@ttctl/mcp`; then those three; then verify no stranded `ttctl@X.Y.Z`
remains in the registry).

When in doubt, **deprecate-and-roll-forward**: the deprecation warning fires
on subsequent `npm install`s, and the hotfix version supplies the actual
remediation. This is the strategy this runbook is built around.

## Manual `npm deprecate` procedure

There is no automated rollback workflow. Rollback is a **break-glass,
maintainer-local operation** that requires an authenticated `npm` CLI
session and the maintainer's interactive 2FA / WebAuthn / passkey factor
per operation. The npmjs.com web UI is **not** a substitute — see
[§ If the CLI is unavailable](#if-the-cli-is-unavailable).

See [§ Authorization model](#authorization-model) below for why automation
is not possible today and what would have to change for that to flip.

> **Operational SLA**: rollback requires a maintainer reachable at a
> terminal with their npm credentials. Target: one maintainer reachable
> within hours, not days.

### Pre-requisites

- Maintainer-local `npm` CLI installed and on `PATH` (any version ≥10).
- Maintainer logged in to npmjs.com with read/write access to all four
  packages (`ttctl`, `@ttctl/core`, `@ttctl/cli`, `@ttctl/mcp`).
- The fixed (hotfix) version has been published (or is in flight) — the
  deprecation message must name it.

### Step-by-step (CLI)

1. **Authenticate locally** (if not already logged in this session):

   ```sh
   npm login
   ```

   Completes via browser + 2FA / WebAuthn / passkey per the account's
   configured factors. Verify with `npm whoami` (should print your npm
   username, not error with `E401`).

2. **Deprecate all four packages in lockstep**. Use the same `<VERSION>`
   and `<REASON>` everywhere. Set both as shell variables to keep the
   loop tight and prevent typos:

   ```sh
   VERSION="0.1.0"  # exact semver, no leading 'v'
   REASON="Bad release ${VERSION}: <root cause>. Upgrade to <hotfix-version>. See https://github.com/alexey-pelykh/ttctl/security/advisories/<id>"

   for pkg in ttctl @ttctl/core @ttctl/cli @ttctl/mcp; do
     echo "Deprecating ${pkg}@${VERSION}..."
     npm deprecate "${pkg}@${VERSION}" "$REASON"
   done
   ```

   `npm deprecate` is idempotent with the same `<REASON>` string. On
   failure for any package (typo, credentials, network), fix the cause
   and re-run the loop.

3. **Verify each deprecation landed**:

   ```sh
   for pkg in ttctl @ttctl/core @ttctl/cli @ttctl/mcp; do
     echo -n "${pkg}@${VERSION}: "
     npm view "${pkg}@${VERSION}" deprecated
   done
   ```

   Each line should print your deprecation message (not an empty line).
   If any line is empty, the registry didn't persist that package's
   deprecation; re-run the deprecate loop for the missing package.

### If the CLI is unavailable

npmjs.com's web UI **cannot deprecate an individual version**. Its only
deprecation control (package page → **Settings** → **Deprecate package**)
deprecates the **entire package** — every version, including the hotfix
you just published — per [npm's own documentation](https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions/).
Version-scoped deprecation is **CLI-only**. There is therefore no clean
web-UI fallback for a version rollback.

If the maintainer's `npm` CLI is unavailable mid-incident, the fallback
is to **restore CLI access**, not to substitute the web UI:

- Run the [§ Step-by-step (CLI)](#step-by-step-cli) procedure from a
  different machine with `npm` installed — the procedure needs only
  `npm login` plus network, no repository checkout.
- If `npm login` itself is failing, that is the incident to fix first:
  check for an unavailable 2FA device, an account lockout, or an npm
  status incident at <https://status.npmjs.org>.

**Whole-package web-UI deprecation is a last resort only.** If CLI
access genuinely cannot be restored and the bad version must be flagged
_now_, **Settings → Deprecate package** will surface a warning on every
`npm install` of that package — but it also flags the good versions,
including the hotfix. If you take this path, treat it as temporary. The
moment CLI access is back, recover in this order (the reverse of the
plain rollback flow):

1. **Clear the package-level message first** via the un-deprecate CLI
   loop in [§ Un-deprecation](#un-deprecation) — `npm deprecate
pkg ""` clears the deprecation across _every_ version of `pkg`,
   including any version you scope next.
2. **Then re-scope the deprecation to the bad version** by running the
   normal CLI procedure ([§ Step-by-step (CLI)](#step-by-step-cli))
   against `${VERSION}` of the bad release.

Reversing the order silently undoes the version-scoped message you just
set.

### Un-deprecation

If a deprecation was set in error, un-deprecate by re-running the same
procedure with an empty reason string. Via CLI:

```sh
for pkg in ttctl @ttctl/core @ttctl/cli @ttctl/mcp; do
  npm deprecate "${pkg}@${VERSION}" ""
done
```

Like deprecation itself, version-scoped un-deprecation is CLI-only. The
web UI's **Settings → Deprecate package** control un-deprecates the
whole package (clears the message from every version) when re-run with
an empty message — a blunt instrument, same caveat as
[§ If the CLI is unavailable](#if-the-cli-is-unavailable).

### Authorization model

`npm deprecate` requires the maintainer's interactive 2FA / WebAuthn /
passkey approval per operation. There is no service-account or
long-lived-token automation path today:

- **OIDC trusted publishing** (which [`release.yml`](../../.github/workflows/release.yml)
  uses for `npm publish`) authorizes `npm publish` only. The npm OIDC
  scope **does not currently cover** `npm deprecate` or `npm unpublish`.
- **Granular automation tokens** that would have authorized `npm deprecate`
  from CI are no longer issued for this account — npmjs.com is now
  **OIDC-only**.

Result: the four packages cannot be deprecated from GitHub Actions
without a maintainer-held secret that the registry will no longer issue.

If npm later extends OIDC to cover `npm deprecate` (no public roadmap as
of 2026-05-14), the automated `deprecate-release` workflow can be revived
from git history — added by PR #260 (issue #220), removed for issue #267
alongside this runbook rewrite. Subscribe to the [npm blog](https://github.blog/changelog/label/npm/)
for OIDC scope announcements.

### Incident-response implications

Because rollback is maintainer-local:

- **Maintainer reachability is a release-readiness gate.** Before
  shipping `0.1.0` GA, confirm at least one maintainer is reachable at
  short notice with their npm credentials ready to use.
- **Document maintainer presence at release time.** When cutting a
  release, the maintainer who triggers it should remain reachable for
  the post-release window (24-72h is typical for surfacing show-stopper
  regressions).
- **Treat the bad-release window as an active incident.** Page (or
  page-equivalent) the on-call maintainer rather than waiting on
  asynchronous channels.

## Cross-surface rollback

A complete rollback covers four surfaces beyond npm. Run them in this
order to minimize the window where consumers see an inconsistent picture.

### 1. npm (immediate — minutes)

Run the [manual `npm deprecate` procedure](#manual-npm-deprecate-procedure)
above. The procedure's Step 3 already runs the `npm view … deprecated`
loop and confirms each package picked up the deprecation message — do
not re-run it separately.

### 2. GitHub Release (immediate — minutes)

Edit the release notes for the affected tag to prepend a `⚠️
DEPRECATED` banner. Use the [GitHub Release banner](#github-release-banner)
template below.

```sh
gh release edit v<version> --notes-file <(cat <<'EOF'
> ⚠️ **DEPRECATED — DO NOT USE.** Upgrade to v<fixed-version>. See
> [GHSA-xxxx-xxxx-xxxx](https://github.com/alexey-pelykh/ttctl/security/advisories/GHSA-xxxx-xxxx-xxxx)
> for details.

<original release notes here>
EOF
)
```

Tag itself is **not** force-pushed; only release-body text is edited. The
git tag remains immutable.

### 3. Hotfix release (~30-60 minutes)

Follow the standard release flow from
[`release.yml`](../../.github/workflows/release.yml):

1. Land the fix on `main` via a normal PR. Commit message format:
   `(fix) <root cause> (#<issue>)`. Reference the deprecated version in
   the PR description.
2. Cut a new tag matching the bumped semver:

   ```sh
   gh release create v<fixed-version> \
     --target main \
     --generate-notes \
     --title "v<fixed-version> — rollback of v<bad-version>"
   ```

3. Watch the workflow:

   ```sh
   gh run watch
   ```

4. Verify the provenance gate passes for all four packages (the
   `Verify provenance attestations` step in `release.yml`).
5. Smoke-test on a clean machine: `npx ttctl@<fixed-version> --version`.

### 4. MCP registry (~hours, manual)

The MCP registry surfaces `io.github.alexey-pelykh/ttctl` via the
[`server.json`](../../server.json) manifest. The release pipeline stamps the
manifest's `.version` and `.packages[0].version` at publish time, but the
MCP registry itself does not auto-pull updates — the manifest must be
re-submitted.

After the hotfix lands and `<fixed-version>` is live on npm:

1. Confirm `server.json` at the `v<fixed-version>` tag shows the new
   version in both fields:

   ```sh
   git show v<fixed-version>:server.json | jq '.version, .packages[0].version'
   ```

2. Re-submit the manifest per the MCP registry submission path (see the
   MCP-registry submission tracker in the project for the canonical
   procedure).

The deprecated version's entry on the MCP registry does **not** vanish; it
remains as a historical record. Consumers using newer manifests will resolve
to `<fixed-version>`.

### 5. Smithery (~hours, manual)

[`smithery.yaml`](../../smithery.yaml) declares the `npx ttctl@<version>`
coordinate Smithery invokes for the MCP server. The release pipeline stamps
the version at publish, but Smithery — like the MCP registry — caches the
last-submitted manifest until the next submission.

After the hotfix lands:

1. Confirm `smithery.yaml` at the `v<fixed-version>` tag shows the new
   coordinate:

   ```sh
   git show v<fixed-version>:smithery.yaml | grep "ttctl@"
   # Expected: 'ttctl@<fixed-version>'
   ```

2. Re-submit per the Smithery submission path.

## Communication templates

These go out **alongside** the technical rollback, not after. Consumers who
re-run `npm install` between the bug discovery and the deprecation see the
broken release; getting the message out beats a perfectly worded
post-incident write-up.

### npm deprecation message (≤120 chars)

The `<REASON>` argument to `npm deprecate`. Strict shape:

```
Bad release <vX.Y.Z>: <one-line root cause>. Upgrade to <vX.Y.Z+1>. See <advisory or release URL>.
```

Examples:

- `Bad release 0.1.0: Cloudflare 403 regression. Upgrade to 0.1.1. See https://github.com/alexey-pelykh/ttctl/releases/tag/v0.1.1`
- `Bad release 0.1.0: bearer leak in --output json. Upgrade to 0.1.1. See https://github.com/alexey-pelykh/ttctl/security/advisories/GHSA-xxxx-xxxx-xxxx`

### GitHub Release banner

Prepend to the existing release body via `gh release edit`:

````markdown
> ⚠️ **DEPRECATED — DO NOT USE.**
>
> This release was withdrawn on YYYY-MM-DD. Upgrade to
> [v<fixed-version>](https://github.com/alexey-pelykh/ttctl/releases/tag/v<fixed-version>).
>
> **Reason**: <one paragraph — what broke, who is affected, severity>.
>
> **Migration**:
>
> ```sh
> npm install -g ttctl@<fixed-version>
> # or
> npx ttctl@<fixed-version> --version
> ```
>
> **Timeline**:
>
> - YYYY-MM-DD HH:MM UTC — issue discovered.
> - YYYY-MM-DD HH:MM UTC — hotfix v<fixed-version> released.
> - YYYY-MM-DD HH:MM UTC — v<bad-version> deprecated on npm.
>
> See [GHSA-xxxx-xxxx-xxxx](https://github.com/alexey-pelykh/ttctl/security/advisories/GHSA-xxxx-xxxx-xxxx)
> for security-sensitive issues; otherwise see
> [issue #N](https://github.com/alexey-pelykh/ttctl/issues/N) for the
> incident thread.

---

<original release notes here>
````

### Security advisory (for security-sensitive rollbacks)

Open via [GitHub Security Advisories](https://github.com/alexey-pelykh/ttctl/security/advisories/new).
Required fields:

- **Severity**: Critical / High / Medium / Low (use CVSS v3.1 vector).
- **Affected versions**: range string (e.g. `>= 0.1.0, < 0.1.1`).
- **Patched version**: `<fixed-version>`.
- **Description**: redacted of exploitation details until the fix is live;
  expand after the patched version has been out for ≥7 days.
- **Workarounds**: any in-the-meantime mitigation (e.g. "downgrade to
  `0.0.99`", "do not pass `--debug` until upgraded").
- **Credit**: only with reporter's explicit consent.

The advisory unlocks `npm audit` notifications for downstream consumers,
which is the highest-leverage broadcast channel TTCtl has access to.

### CHANGELOG.md entry

Add to the **Unreleased** section (or, after the hotfix tag, to the hotfix
version section) under a `Security` heading for security issues, otherwise
under `Fixed`:

```markdown
### Security

- **CVE-YYYY-XXXXX / GHSA-xxxx-xxxx-xxxx — <one-line summary> (#N)**.
  Affects `ttctl@>= 0.1.0, < 0.1.1`. Upgrade to `0.1.1` immediately.
  v0.1.0 was deprecated on npm on YYYY-MM-DD.
```

## Post-rollback verification

Run this checklist after the deprecation lands AND the hotfix is published.
Skipping any item leaves a hole consumers will find at the worst moment.

- [ ] **npm deprecation visible** for all four packages:

  ```sh
  for pkg in ttctl @ttctl/core @ttctl/cli @ttctl/mcp; do
    echo -n "$pkg@<bad-version>: "
    npm view "$pkg@<bad-version>" deprecated
  done
  ```

  Each line prints your deprecation message.

- [ ] **`npm install` warning fires**:

  ```sh
  npm install -g ttctl@<bad-version> 2>&1 | grep -i deprecat
  ```

  Should print the deprecation warning to stderr.

- [ ] **Hotfix is `latest`**:

  ```sh
  for pkg in ttctl @ttctl/core @ttctl/cli @ttctl/mcp; do
    echo "$pkg latest: $(npm view "$pkg" version)"
  done
  ```

  All four print `<fixed-version>`.

- [ ] **Smoke install on a clean machine** (macOS, Linux, Windows where
      practical):

  ```sh
  npx ttctl@<fixed-version> --version
  npx ttctl@<fixed-version> --help
  ```

  Both exit 0 with no stack traces.

- [ ] **GitHub Release banner** is live on the bad release tag.

- [ ] **MCP-registry manifest** re-submitted (if applicable) and pointing
      at `<fixed-version>`.

- [ ] **Smithery manifest** re-submitted (if applicable) and pointing at
      `<fixed-version>`.

- [ ] **Security advisory** published (if applicable) and is reachable at
      the URL named in the deprecation message and release banner.

- [ ] **Post-incident review** scheduled and an issue opened for each
      identified gate gap. Reference back to this runbook in the issue
      bodies.

## Dry-run rehearsal

The first incident is the wrong time to discover that the procedure has
never been run end-to-end. Before the first GA release, run a rehearsal
pass against a pre-release tag (see [#211](https://github.com/alexey-pelykh/ttctl/issues/211)
for the `v0.1.0-rc.1` cut):

1. Cut `v0.1.0-rc.1` per #211 (publishes all four packages on the `next`
   dist-tag).
2. Run the [manual `npm deprecate` procedure](#manual-npm-deprecate-procedure)
   with:
   - `VERSION`: `0.1.0-rc.1`
   - `REASON`: `Rehearsal — release-rollback runbook validation. Not a real deprecation.`
3. Verify each of the four packages reports the deprecation message via
   `npm view <pkg>@0.1.0-rc.1 deprecated`.
4. **Un-deprecate** to leave the registry in a clean post-rehearsal
   state. Re-run the procedure with an **empty** reason string — see
   [§ Un-deprecation](#un-deprecation).
5. Record the dry-run outcome on #211 (or its successor issue), including
   the wall-clock time spent on each step (auth, deprecate loop, verify,
   un-deprecate). The timings calibrate the SLA in
   [§ Manual `npm deprecate` procedure](#manual-npm-deprecate-procedure).

The rehearsal is **deferred** from the initial runbook landing because it
depends on #211 (`v0.1.0-rc.1`). Until #211 lands, the procedure is
documented but unrehearsed.

## Anti-patterns

**Force-pushing the git tag to "fix" a release.**
Tags are immutable in practice. Consumers and the npm provenance attestation
both reference the original commit SHA. Force-pushing creates ambiguity
without removing the bad artifact.

**Deprecating only `ttctl` and leaving `@ttctl/core` / `@ttctl/cli` /
`@ttctl/mcp` live.**
The umbrella tries to resolve the matching version across the workspace.
Half-deprecated state confuses package managers and security scanners.
Always deprecate all four packages in the same operational window — the
CLI loop in [§ Step-by-step (CLI)](#step-by-step-cli) iterates all four
with one identical message, which is exactly the invariant to preserve.

**Skipping the GitHub Release banner.**
Users who installed via `npm install -g ttctl@<version>` see the
deprecation warning. Users who copy a `git clone && pnpm install` recipe
from the README or release page never hit `npm install`. The release-page
banner is their only signal.

**Deprecating without a roll-forward target.**
A deprecation message that doesn't name the fixed version is a dead end.
Always publish the hotfix BEFORE running the deprecation procedure (or in
the same operational window — see [Cross-surface rollback](#cross-surface-rollback)
ordering).

**Reusing a deprecation reason verbatim across versions.**
Each deprecation gets its own message naming its own hotfix target. If
`0.1.0` and `0.1.1` are both deprecated for the same root cause but
point at different fixed versions (`0.1.0 → 0.1.2`, `0.1.1 → 0.1.3`),
write two separate messages — the deprecation attaches to a single
version, and so does its hotfix pointer.

**Treating `npm unpublish` as the default.**
The 72h window almost never applies (dependents in the registry, multiple
packages per release). Even when it does, the version string is burned —
you can never publish `0.1.0` again. Deprecate-and-roll-forward is the
default; unpublish is the exception.

## Related references

- [`.github/workflows/release.yml`](../../.github/workflows/release.yml) —
  the canonical publish workflow this runbook complements.
- [`CHANGELOG.md`](../../CHANGELOG.md) — record of past releases and rollbacks.
- [#211](https://github.com/alexey-pelykh/ttctl/issues/211) — the rc.1
  rehearsal release this runbook will be dry-run against.
- [#267](https://github.com/alexey-pelykh/ttctl/issues/267) — the OIDC-only
  constraint that removed the automated `deprecate-release` workflow.
  Subscribe via the npm blog for OIDC scope announcements that would
  re-enable automation.
