<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# `status/` — TTCtl runtime infrastructure

This directory holds operational artifacts served at stable URLs from
the project repo's `main` branch via raw.githubusercontent.com. Every
file here is fetched at runtime by `ttctl` and/or `ttctl mcp` and must
preserve a stable wire shape.

## `known-broken.json` — Remote version-killed manifest (#312)

Fetched at startup by:

- **CLI**: `packages/cli/src/lib/kill-switch-hook.ts` (synchronous-await
  with 3s timeout, fired from the root Commander program's `preAction`
  hook). On match: emits a stderr WARNING. On match with
  `action: "refuse"`: additionally exits non-zero before the action
  runs.
- **MCP**: `packages/mcp/src/kill-switch-hook.ts` (fire-and-forget at
  `buildServer` time + `setInterval(..., 24h).unref()` recurring loop).
  Always warns; never refuses (refusing a long-lived MCP server has no
  safe semantics — mid-flight tool calls would be interrupted).

**Stable URL** (referenced verbatim in
`packages/core/src/kill-switch.ts:KILL_SWITCH_MANIFEST_URL`):

```
https://raw.githubusercontent.com/alexey-pelykh/ttctl/main/status/known-broken.json
```

**Wire shape** (`schema_version: 1`):

```json
{
  "schema_version": 1,
  "known_broken": [
    {
      "version_spec": "<0.1.0",
      "reason": "Toptal rotated mobile-gateway persisted-query hashes 2026-MM-DD",
      "action": "warn",
      "as_of": "2026-MM-DD"
    }
  ]
}
```

**`version_spec` operator surface** (see
`packages/core/src/kill-switch.ts:matchesVersion`):

| Operator | Example   | Matches                                 |
| -------- | --------- | --------------------------------------- |
| `*`      | `*`       | any running version (global kill)       |
| _(none)_ | `0.1.0`   | exact match                             |
| `=`      | `=0.1.0`  | exact match (equivalent to no operator) |
| `<`      | `<0.1.0`  | strictly less                           |
| `<=`     | `<=0.1.0` | less or equal                           |
| `>`      | `>0.1.0`  | strictly greater                        |
| `>=`     | `>=0.1.0` | greater or equal                        |

Pre-release tags (`-rc.1`) follow semver §11.4: a version with a
pre-release tag is LESS than the same version without. Compound
ranges (`>=0.1.0 <0.2.0`) are NOT supported — emit two entries
instead. The matcher is exercised exhaustively by
`packages/core/src/__tests__/kill-switch.test.ts`.

**Updating the manifest**: see
[`docs/operations/wire-breakage-runbook.md`](../docs/operations/wire-breakage-runbook.md)
§ "Updating the kill-switch manifest" for the canonical procedure.

**Privacy**: the fetch sends only the default Node `fetch` headers and
the URL — no version, no account identifier, no telemetry. Install-
count tracking is intentionally deferred (see the paired
post-launch signal-collection issue).

**Override**: users who want to disable the kill switch entirely can
set `TTCTL_DISABLE_KILL_SWITCH=1` in their environment.
