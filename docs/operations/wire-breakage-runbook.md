<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# Wire-breakage runbook

> **Audience**: maintainer (operational).
> **Originating finding**: 2026-05-15 `/council` verdict on the
> 2026-05-15 `/audit-scope` cycle. Tracked as #312. Paired with the
> remote version-killed manifest mechanism (this repo's
> `status/known-broken.json` and the kill-switch wire-up in core/cli/mcp).

TTCtl is reverse-engineered from Toptal's APK + GraphQL extraction. The
wire format on any of the three surfaces (`mobile-gateway`,
`talent-profile`, `scheduler`) can change at any time, without warning
or compensation. This runbook is the canonical procedure for detecting
and responding to a wire break.

Sibling operational doc: [`release-rollback.md`](./release-rollback.md)
for the post-publish unpublish window and rollback procedure.

## Detection sources (ordered by signal strength)

Strongest first; weaker sources can give earlier warning but require
more verification before action.

| #   | Source                                              | Detection latency            | Signal strength                                                | Surface                                                        |
| --- | --------------------------------------------------- | ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | **T1 wire-shape snapshot diff failure**             | Per-PR (`TTCTL_E2E=1` runs)  | High — structural mismatch verified against committed snapshot | All ops with snapshots                                         |
| 2   | **T2 codegen-Zod `WIRE_SHAPE_ERROR` envelope rate** | Production (live user calls) | High — runtime parse failure on a typed schema                 | Ops in the trusted catalog (codegen produced)                  |
| 3   | **User-submitted issue reports**                    | Variable (hours to weeks)    | Medium — narrative, often single-incident                      | Any surface                                                    |
| 4   | **Maintainer's own `TTCTL_E2E=1` runs**             | Manual cadence               | High — full live API exercised against synthesized schema      | Whatever the E2E suite covers (see `packages/e2e/src/`)        |
| 5   | **CI Schema/Contract Rule Disposition gate**        | Per-PR                       | Medium — gate-level, enforces declaration but not behavior     | Auth + profile-services + new GraphQL ops (file-path triggers) |

T1 and T2 are the two ongoing wire-validation tracks (per
[ADR-006](../../hq/engineering/adr/ADR-006-hybrid-wire-validation.md) /
#280); the per-op disposition lives in
[`docs/wire-validation-routing.md`](../wire-validation-routing.md).

### Detection chains specific to each source

**T1 snapshot failure** (sources 1 + 4): `vitest` exits non-zero with a
diff of the captured manifest against the live response. The snapshot
files live at `packages/e2e/src/wire-snapshots/<OpName>.snapshot.json`;
the assertion site is `assertWireShapeStable(...)` per
[`packages/e2e/src/wire-snapshots/README.md`](../../packages/e2e/src/wire-snapshots/README.md).

**T2 `WIRE_SHAPE_ERROR` envelope** (source 2): in production, the Zod
schema passed via `callGateway({schema: ...})` / `callTalentProfile({schema: ...})`
returns a `ZodError`-derived envelope with `code: "WIRE_SHAPE_ERROR"`
(format pinned in [`docs/wire-validation-error-format.md`](../wire-validation-error-format.md)).
Users see this surfaced through the CLI's error formatter; the diff is
included so operators can immediately tell which field drifted.

**User-submitted issue reports** (source 3): the GitHub issues tracker
at `alexey-pelykh/ttctl`. Wire-break reports typically appear as one of:

- "CLI gives me a cryptic GraphQL error after `auth signin`"
- "`ttctl profile show` returns empty / weird data"
- "Worked yesterday, broken today"

When triaging: ask for the surface (`ttctl --verbose` shows the URL)
and the redacted response envelope (`ttctl --debug` produces JSON
with secrets redacted by the `redact` module).

## Severity tiers and response cadence

The detection source rarely tells you the blast radius. After
detection, classify into one of three tiers:

| Tier                            | Scope                                                                                                             | Examples                                                                                                         | Response cadence                             | Manifest action                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1 — Surface-wide outage**    | An entire surface is unreachable / authenticates differently / returns wrong shapes globally                      | Toptal flips `mobile-gateway` to a new persisted-query hash store; Cloudflare on `talent-profile` adds Turnstile | < 24h to triage + emergency release          | `version_spec: "<X.Y.Z"` with `action: "refuse"` for the affected version range                                                                |
| **S2 — Per-operation breakage** | One or two specific operations break (renamed field, removed enum value, type change)                             | A single `update*` mutation rejects an input shape that used to work                                             | < 1 week to patch + release                  | `version_spec: "<=X.Y.Z"` with `action: "warn"` and a reason naming the operation                                                              |
| **S3 — Per-field drift**        | A field's wire type changes but the operation otherwise works; downstream rendering is wrong but not catastrophic | The `TimesheetRecord.duration` bug (PR #275: declared `number` seconds, actually `string` minutes)               | < 1 month; bundle with regular patch cadence | Usually NO manifest entry — patch the field-mapping and ship a regular release. Add an entry only if a render bug surfaces in a critical path. |

The S1/S2/S3 boundary is a judgment call. When uncertain, escalate
upward (treat S2 as S1 if there's any chance the impact is wider).

## Response steps

For each tier, the canonical playbook:

### S1 — Surface-wide outage

1. **Triage** (≤ 2h): reproduce against the live API from a clean
   sandbox session. Use `TTCTL_E2E=1` runs and `--debug` logging.
   Confirm the surface is broken globally (not a one-account issue —
   ask a second tester or check the GitHub issues for a second
   independent report).
2. **Patch** (≤ 12h): patch the offending wire path. If the wire shape
   changed, regenerate via `pnpm codegen` and update the schema/contract
   rule disposition + the affected T1/T2 snapshots.
3. **Emergency release** (≤ 24h): cut a patch release (e.g., `0.1.1`)
   per `release-rollback.md` § "Patch release" (or the v0.1.0+ release
   playbook if/when it lands). Include a verbatim release-notes section:
   "Critical: this release fixes a wire-break on Toptal's <surface>
   that broke <X> on every install of versions <Y> through <Z>."
4. **Publish manifest entry** (immediately upon release): edit
   `status/known-broken.json` to add an entry for the broken version
   range. Use `action: "refuse"` ONLY if the older version produces
   data corruption (mutations that silently no-op, fields rendered in
   wrong units); use `action: "warn"` otherwise.
5. **Communicate**:
   - GitHub Release notes (always; the release itself is the canonical
     communication channel for npm consumers).
   - Pin a `Wire break: <surface>` issue at the top of the issue
     tracker with the reproduction + workaround.
   - npm `deprecate` the affected versions: `npm deprecate
'ttctl@<X.Y.Z' "Wire-broken; upgrade to <new>"`. Stays in npm
     metadata; renders in `npm install` output.

### S2 — Per-operation breakage

1. **Triage** (≤ 1 day): same as S1, but scope is single-operation.
2. **Patch** (≤ 3 days): patch the affected service / wire path.
3. **Regular release** (≤ 1 week): cut a patch release. Release notes
   call out the affected operation.
4. **Manifest entry**: optional. Use `action: "warn"` with a clear
   reason naming the operation, so users hitting the bug on the old
   version see context. Many S2 cases can skip the manifest entry
   (the patch is more important than the warning).
5. **Communicate**: Release notes are usually sufficient.

### S3 — Per-field drift

1. **Triage** (≤ 1 week): confirm the field is the source of the
   issue. Field drift often surfaces as wrong-looking output rather
   than an outright error.
2. **Patch** (≤ 1 month): bundle with regular development cadence.
   Update field-mapping; add the field to a T1 snapshot or a T2 schema
   to prevent regression.
3. **Release**: bundle with the next planned patch / minor release.
4. **Manifest entry**: skip unless a critical render path is involved.

## Updating the kill-switch manifest

The manifest is served at
`https://raw.githubusercontent.com/alexey-pelykh/ttctl/main/status/known-broken.json`.
The file lives at `status/known-broken.json` in this repo. Updates
land via a normal commit to `main` (no separate CI / Pages build —
raw.githubusercontent.com serves the file directly from the commit on
push).

Add an entry by editing the JSON:

```json
{
  "schema_version": 1,
  "known_broken": [
    {
      "version_spec": "<0.2.0",
      "reason": "Toptal rotated mobile-gateway persisted-query hashes; sign-in no-ops silently",
      "action": "refuse",
      "as_of": "2026-MM-DD"
    }
  ]
}
```

| Field          | Notes                                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version_spec` | See `status/README.md` § "version_spec operator surface" for the supported syntax. Most common: `<X.Y.Z` for "kill everything before this patch", `=X.Y.Z` for a single bad release.  |
| `reason`       | Rendered verbatim in the user-facing WARNING / REFUSED banner. Keep terse; include the affected surface or operation when known.                                                      |
| `action`       | `warn` (continue) or `refuse` (CLI exits non-zero). MCP server-side always treats both as `warn` — refusing a long-lived MCP server interrupts mid-flight tool calls and is not safe. |
| `as_of`        | ISO date the entry was added. Helps users correlate the warning with public Toptal-side incidents.                                                                                    |

After committing to `main`:

1. **Verify the wire shape** before pushing — `node -e "JSON.parse(require('fs').readFileSync('status/known-broken.json'))"` is the cheapest check; a malformed manifest causes every install to silently `fetch-failed` (fail-silent contract), which is acceptable but obviously not the intent.
2. **Verify the matcher** if you used an unusual `version_spec` — run `pnpm --filter @ttctl/core test -- kill-switch` to exercise the matcher tests; consider adding a new test case for any new spec pattern.
3. **Push** to `main`. The change is live within seconds (raw.githubusercontent.com cache TTL is typically < 5 minutes).
4. **Smoke-test against a fresh install** in a non-CI environment: `npx ttctl@<broken-version> --help` should surface the WARNING (or REFUSED) banner on stderr.

## Communication channels

In order of operator effort × user reach:

| Channel                                    | Reach                                                             | Latency                     | Use for                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `status/known-broken.json` (this manifest) | Every fresh `ttctl` invocation worldwide                          | Seconds (next CLI run)      | S1 + critical S2 — warns/refuses installs of the affected versions                                |
| GitHub Release notes                       | Anyone subscribed to releases; resurfaced in `npm install` output | Minutes                     | Every wire-break (S1 / S2 / S3) — the release itself is the canonical record                      |
| GitHub Issues (pinned issue)               | Anyone visiting the issue tracker                                 | Hours                       | S1 + S2 — surface a reproduction and a workaround if one exists pre-fix                           |
| `npm deprecate`                            | Renders in `npm install` for the deprecated version               | Minutes (npm metadata sync) | S1 + critical S2 — the message stays in npm forever                                               |
| README banner                              | Anyone landing on the repo / npm page                             | Hours-days                  | S1 only — pin a "Known issue with <surface> as of <date>" line near the top, remove on resolution |

## C&D / legal posture

In the event of a cease-and-desist or other legal notice from Toptal:

1. **Acknowledge receipt** (within whatever response window the notice
   specifies — typically 7-30 days). Use a personal email, not the
   GitHub repo issues, for legal correspondence.
2. **Pause development** immediately. Do not commit further code to
   `main` until the legal posture is clear.
3. **Manifest action**: publish a `version_spec: "*"` entry with
   `action: "refuse"` and `reason: "Project archived; see README."`.
   This kills every existing CLI install (with a warning + exit) and
   buys time before users discover the issue separately.
4. **Repo posture**: archive the repo on GitHub (Settings → Archive).
   Archived repos remain readable but cannot be pushed to, which
   makes the legal status visible.
5. **npm posture**:
   - If the notice requires takedown: `npm unpublish ttctl --force`
     within the 72h unpublish window if the latest release is recent
     enough. Outside the window, `npm deprecate` every version with a
     clear notice and request npm support intervention for true
     removal.
   - The Smithery + MCP-registry submissions inherit from npm; once
     npm is taken down, these naturally break.
6. **README banner**: replace the README with a single paragraph
   stating the project is no longer maintained. Do NOT include the
   legal correspondence or accusations — keep it factual.
7. **Personal counsel**: this runbook is operational, not legal
   advice. Engage personal counsel before responding to any legal
   notice; a wrong response can convert a takedown request into a
   lawsuit.

The kill-switch manifest is intentionally NOT a defense against
legal action — it is a courtesy to users so they don't discover the
breakage by running into cryptic API errors. Toptal can request
takedown of the npm package and the GitHub repo independently of
whether the manifest exists.

## Reference: kill-switch override and disable

For users who need to disable the kill-switch check (testing, air-
gapped environments, debugging a false-positive manifest entry):

```sh
export TTCTL_DISABLE_KILL_SWITCH=1
```

Captured at module load — must be set BEFORE the CLI / MCP server
starts. Any other value (empty string, `0`, `true`) keeps the check
enabled (exact `1` discriminator, matches the established
`TTCTL_DEBUG_CONFIG` / `TTCTL_DEBUG_MCP` /
`TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY` conventions).

Documented in: `README.md`, `docs/audit/audit-checklist.md`,
`packages/core/src/kill-switch.ts:KILL_SWITCH_OVERRIDE_ENV_VAR`.
