# Release rollback runbook

This is the operational playbook for **withdrawing a bad release** of TTCtl. It
covers the decision tree (deprecate vs unpublish vs roll-forward), the
`deprecate-release` workflow that automates the npm side, the surfaces that
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
   paths.** A `workflow_dispatch` deprecate on npm does **not** retract the
   MCP-registry or Smithery manifest pointers — those need a manual
   re-submission cycle. See [Cross-surface rollback](#cross-surface-rollback)
   for the order of operations.

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
              Run the `deprecate-release` workflow with version + reason
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

## The `deprecate-release` workflow

A `workflow_dispatch`-only GitHub Action at
[`.github/workflows/deprecate-release.yml`](../../.github/workflows/deprecate-release.yml)
runs `npm deprecate` across all four packages in lockstep. It is the
operational entry point for any non-emergency rollback decision.

### Trigger via the GitHub UI

1. Open <https://github.com/alexey-pelykh/ttctl/actions/workflows/deprecate-release.yml>.
2. Click **Run workflow** (top-right of the run list).
3. Fill in the two inputs:
   - **`version`** — the exact semver to deprecate, with no leading `v`
     (e.g. `0.1.0`, `0.1.0-rc.1`). Build metadata (`+build`) is rejected.
   - **`reason`** — the deprecation message users see at `npm install` time.
     Keep it ≤120 chars and actionable. Always name the fixed version.
4. Confirm the **`Use workflow from`** branch is `main`.
5. **Run workflow**.

### Trigger via `gh` CLI

```sh
gh workflow run deprecate-release.yml \
  --ref main \
  -f version=0.1.0 \
  -f reason='Bad release — upgrade to 0.1.1. Details: https://github.com/alexey-pelykh/ttctl/security/advisories/GHSA-xxxx-xxxx-xxxx'
```

Then watch the run:

```sh
gh run watch
```

### What the workflow does

For each of `ttctl`, `@ttctl/core`, `@ttctl/cli`, `@ttctl/mcp`:

1. Validates the input version against the same semver regex as
   [`release.yml`](../../.github/workflows/release.yml) (release and
   pre-release tags only; no build metadata).
2. Runs `npm deprecate <pkg>@<version> "<reason>"` using the
   `NPM_TOKEN` repository secret for authentication.
3. Verifies the deprecation landed by reading `npm view <pkg>@<version>
deprecated` and asserting the message is non-empty.

The workflow uses the `npm-publish` GitHub environment so the same branch /
tag protections that gate `release.yml` (deployment branches restricted to
`main` and `v*` tags) also apply to deprecation. A non-maintainer cannot
dispatch the workflow against the production environment.

### Pre-requisite: `NPM_TOKEN` secret

The workflow authenticates to npm via a granular automation token stored as
the `NPM_TOKEN` repository secret. npm's OIDC trusted-publishing flow
(used by [`release.yml`](../../.github/workflows/release.yml) for publishing)
**does not authorize `npm deprecate`** — that path is publish-scoped only.

Token requirements:

- **Type**: granular access token (npmjs.com → **Access Tokens** → **Generate
  New Token** → **Granular**).
- **Permissions**: `Read and write` for the four packages
  (`ttctl`, `@ttctl/core`, `@ttctl/cli`, `@ttctl/mcp`). The deprecate API
  requires write permission. **Do not** grant org-wide write.
- **Expiration**: 1 year, with a calendar reminder to rotate. Renew before
  expiry; a workflow that fails at incident time defeats the purpose.
- **Storage**: GitHub Settings → **Secrets and variables** → **Actions** →
  **New repository secret** named `NPM_TOKEN`. Do **not** scope it to the
  `npm-publish` environment alone — the workflow reads it at the repo-secret
  level so the environment gate still applies via deployment-branch rules.

If the token is missing or expired, the `Deprecate packages` step fails
with an `E401`/`E403` from npm. Rotate, re-run the workflow.

## Cross-surface rollback

A complete rollback covers four surfaces beyond npm. Run them in this
order to minimize the window where consumers see an inconsistent picture.

### 1. npm (immediate — minutes)

Run the [`deprecate-release` workflow](#the-deprecate-release-workflow)
above. Verify with:

```sh
for pkg in ttctl @ttctl/core @ttctl/cli @ttctl/mcp; do
  echo "=== $pkg ==="
  npm view "$pkg@<version>" deprecated
done
```

Each line should print your deprecation message (not an empty line).

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

The `reason` input to the `deprecate-release` workflow. Strict shape:

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

The first incident is the wrong time to discover that the workflow has
never run end-to-end. Before the first GA release, run a rehearsal pass
against a pre-release tag (see [#211](https://github.com/alexey-pelykh/ttctl/issues/211)
for the `v0.1.0-rc.1` cut):

1. Cut `v0.1.0-rc.1` per #211 (publishes all four packages on the `next`
   dist-tag).
2. Dispatch the `deprecate-release` workflow with:
   - `version`: `0.1.0-rc.1`
   - `reason`: `Rehearsal — release-rollback runbook validation. Not a real deprecation.`
3. Verify each of the four packages reports the deprecation message via
   `npm view <pkg>@0.1.0-rc.1 deprecated`.
4. (Optional) Un-deprecate by re-running the workflow with an empty
   `reason` — npm un-deprecates when the message string is empty. The
   workflow currently requires a non-empty reason; un-deprecation is a
   manual `npm deprecate <pkg>@<version> ""` step.
5. Record the dry-run outcome on #211 (or its successor issue).

The rehearsal is **deferred** from the initial runbook landing because it
depends on #211 (`v0.1.0-rc.1`). Until #211 lands, the workflow exists and
the procedure is documented but unrehearsed.

## Anti-patterns

**Force-pushing the git tag to "fix" a release.**
Tags are immutable in practice. Consumers and the npm provenance attestation
both reference the original commit SHA. Force-pushing creates ambiguity
without removing the bad artifact.

**Deprecating only `ttctl` and leaving `@ttctl/core` / `@ttctl/cli` /
`@ttctl/mcp` live.**
The umbrella tries to resolve the matching version across the workspace.
Half-deprecated state confuses package managers and security scanners.
Always run the workflow against all four; the workflow enforces this.

**Skipping the GitHub Release banner.**
Users who installed via `npm install -g ttctl@<version>` see the
deprecation warning. Users who copy a `git clone && pnpm install` recipe
from the README or release page never hit `npm install`. The release-page
banner is their only signal.

**Deprecating without a roll-forward target.**
A deprecation message that doesn't name the fixed version is a dead end.
Always publish the hotfix BEFORE running the workflow (or in the same
operational window — see [Cross-surface rollback](#cross-surface-rollback)
ordering).

**Reusing a deprecation reason verbatim across versions.**
Each deprecation gets its own message. If `0.1.0` and `0.1.1` are both
deprecated for the same root cause, two separate messages name two
separate fixed versions (`0.1.2`, `0.1.2`, respectively) — the deprecation
attaches to a single version, and so does its hotfix pointer.

**Treating `npm unpublish` as the default.**
The 72h window almost never applies (dependents in the registry, multiple
packages per release). Even when it does, the version string is burned —
you can never publish `0.1.0` again. Deprecate-and-roll-forward is the
default; unpublish is the exception.

## Related references

- [`.github/workflows/release.yml`](../../.github/workflows/release.yml) —
  the canonical publish workflow this runbook complements.
- [`.github/workflows/deprecate-release.yml`](../../.github/workflows/deprecate-release.yml)
  — the workflow this runbook drives.
- [`CHANGELOG.md`](../../CHANGELOG.md) — record of past releases and rollbacks.
- [#211](https://github.com/alexey-pelykh/ttctl/issues/211) — the rc.1
  rehearsal release this runbook will be dry-run against.
