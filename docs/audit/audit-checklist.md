# Audit Checklist

Maintainer-facing conventions for audit cycles run against this repository's open issues. Consolidates the substance of closed issues #254 – #257 (audit-meta findings from the 2026-05-14 cycle) into a single reference, per the 2026-05-15 council convergent verdict that prevented those four issues from becoming a multi-wave audit-meta cluster.

## When opening an audit cycle

- **Refresh dated tables and methodology checklists FIRST.** Issues with dated status tables or methodology-encoding ACs (coordinator epics, AC-table issues) age silently as the work they describe ships. Re-snapshot against current state BEFORE treating issue bodies as factual. Canonical examples: #18 (MCP coverage epic with status table), #90 / #91 (INFERRED-wrapper methodology checklists). Refresh trigger is **closure of any sub-issue** referenced in the table, OR weekly during active wave-N execution.
- **Cross-reference open issues against newly-published ADRs and research notes.** When a doc materially supersedes assumptions in any open issue, sweep affected bodies in the same cycle. Auth-model migrations (e.g., pre-#107 cookie-jar references in wave-2 deferred issues) are the canonical trigger; the same pattern applies to any ADR or research note that invalidates an embedded assumption.

## When authoring audit findings

- **Verify the premise empirically before sweeping multiple issues.** A finding that asserts "X is wrong in N issues" must be backed by direct inspection of each cited issue's current state. Multi-issue sweeps with inverted premises (e.g., RC-AI-4 in the 2026-05-14 cycle) cost more to correct than they would have to verify upfront.
- **When checking cross-org GitHub state, scope queries to ALL relevant orgs.** This project uses both `alexey-pelykh/*` and `ttctl/*` GitHub orgs with different roles (personal-brand HQ vs project HQ). `gh search repos --owner alexey-pelykh` does NOT cover the `ttctl` org — verify against both.
- **Prefer pattern-grep over absolute line refs when the cited code is in active churn.** Use `file.ts — grep for 'createTravelVisa'` instead of `file.ts:123-145` when the underlying area has been touched ≥1 PR in the last 30 days. Absolute line refs are acceptable for stable code or for issues created post-burn-down.

## Snapshot annotation

For issues containing dated status tables or methodology checklists, include the literal line:

```
_Snapshot date: YYYY-MM-DD_
```

within the body, near the dated content. Re-snapshot on closure of any sub-issue referenced in the table, or weekly during active wave-N execution.

## Audit-loop discipline

After each audit cycle, count audit-process-meta items in the open backlog against substantive product items. If the ratio of meta to substantive approaches 1:1 BEFORE a release ships, the audit machinery has become the work. **Suspend further audit-process-meta capture, ship the release, then resume capture against post-release backlog.** The 2026-05-14 cycle hit this threshold (6 audit-meta issues out of 24 open, with v0.1.0 not yet shipped); the 2026-05-15 council convergent verdict was to close 4 of the 6 and consolidate their substance here rather than continue accumulating.

## Operator env-var overrides

Env vars that disable or alter normal CLI/MCP behavior. Maintainer must
ensure these are documented in both the README and here when added,
because audit reviewers consulting this checklist need a complete map
of "what user-visible behaviors can be turned off."

| Env var                             | Effect                                                                                                                                                                             | Documented in                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `TTCTL_DISABLE_KILL_SWITCH=1`       | Disable the remote known-broken manifest check (#312). CLI startup hook + MCP `buildServer` skip the fetch entirely; no warning, no refusal even if the running version is listed. | `README.md` § "Remote kill-switch", `docs/operations/wire-breakage-runbook.md` § "Reference: kill-switch override and disable" |
| `TTCTL_DEBUG_CONFIG=1`              | Emit structured JSON debug records on stderr for config persist/clear write path.                                                                                                  | `README.md` § "Debug logs for `auth signin` / `auth signout`"                                                                  |
| `TTCTL_DEBUG_MCP=1`                 | Emit structured JSON debug records on stderr for MCP server tool-invoke + auth-resolve + transport-error events.                                                                   | `CLAUDE.md` § "MCP-side diagnostic logging"                                                                                    |
| `TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY=1` | Bypass the MCP file-upload path sandbox (extension allowlist still enforced).                                                                                                      | `CLAUDE.md` § "MCP file-upload defense-in-depth gates"                                                                         |
| `TTCTL_E2E=1`                       | Gate E2E suite — required to exercise live API tests.                                                                                                                              | `CLAUDE.md` § "Schema/contract validation rule"                                                                                |
| `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`     | Update committed wire-shape snapshots during E2E runs.                                                                                                                             | `packages/e2e/src/wire-snapshots/README.md`                                                                                    |

All env-var captures follow the `=== "1"` discriminator (any other
value, including empty string, `0`, `true`, keeps the default behavior).
Capture is at module load for V8 const-folding.

## See also

- `docs/briefs/2026-05-14-audit-issues.md` — the brief that originated #252 – #257
- `docs/audit/2026-05-output-format-formatter-audit.md` — example of a dimension-scoped audit output kept as a longitudinal record
