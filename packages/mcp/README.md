# @ttctl/mcp

[![npm](https://img.shields.io/npm/v/%40ttctl%2Fmcp?logo=npm)](https://www.npmjs.com/package/@ttctl/mcp)
[![License](https://img.shields.io/npm/l/%40ttctl%2Fmcp)](https://github.com/alexey-pelykh/ttctl/blob/main/LICENSE)

[Model Context Protocol](https://modelcontextprotocol.io) server exposing your Toptal Talent profile to AI assistants. Powers `ttctl mcp` in the [TTCtl](https://github.com/alexey-pelykh/ttctl) umbrella binary.

> **Unofficial.** TTCtl is NOT affiliated with, endorsed by, or supported by Toptal LLC. See the [project README](https://github.com/alexey-pelykh/ttctl#readme) for the full use policy and disclaimer.

## Audience

End users should install the [`ttctl`](https://www.npmjs.com/package/ttctl) umbrella package and configure their MCP client to spawn `ttctl mcp` — see the project README's [MCP Integration](https://github.com/alexey-pelykh/ttctl#mcp-integration) section for Claude Desktop, Claude Code, and Cursor configurations.

This package is published separately for **embedders** who want to host the MCP server inside their own process, or wire a non-stdio transport (SSE/HTTP) around `buildServer()`.

## Install

```sh
npm install @ttctl/mcp
```

Requires **Node.js ≥ 22.19.0**, ESM only.

## API Surface

- `runMcpStdio(opts?)` — start the MCP server on stdio (used by `ttctl mcp`).
- `buildServer(opts?)` — construct the underlying `McpServer` without binding a transport. For SSE/HTTP transports or tests.
- `BuildServerOptions` — `{ configPath?: string; logger?: McpDiagnosticLogger }`. `configPath` is captured ONCE at construction; subsequent tool invocations read AND write that exact path regardless of mid-session `TTCTL_CONFIG_FILE` shifts (see [path-capture-on-startup](https://github.com/alexey-pelykh/ttctl/blob/main/CLAUDE.md#mcp-session-lifetime-and-config-path), issue #113).
- **Error mapping** — `ttctlErrorToToolResponse`, `ttctlErrorToToolResponseOrNull`, `ToolErrorResponse`.
- **Diagnostics** (issue #224) — `setMcpDiagnosticLogger`, `getMcpDiagnosticLogger`, `resetMcpDiagnosticLogger`, `wrapToolHandler`, `redactToolArgs`, `emitMcpDebug`, `emitMcpAuthResolve`, `isTransportError`, `extractTransportStatus`, `extractTransportSurface`.

### Tool catalog

The server registers 130 tools spanning the full Toptal Talent surface that TTCtl exposes — read AND mutation paths (per-domain counts below sum to the total):

- **`profile.*`** (69 tools) — `basic`, `skills`, `industries`, `education`, `certifications`, `employment`, `portfolio`, `visas`, `resume`, `external`, `reviews`, `specializations`, `countries`
- **`jobs`** (18 tools) — browse (list / show) + saved / viewed / not-interested signals + search subscription + apply funnel
- **`payments`** (9 tools) — summary + payouts (list / show) + methods (list / show) + rate (current / show / questions / change)
- **`engagements`** (8 tools) — list / show / stats + breaks (list / add / remove / reschedule / reasons)
- **`applications`** (7 tools) — list / show / stats + interview detail (show / notes / guide) + availability-request detail
- **`availability`** (5 tools) — show + working-hours (show / set) + allocated-hours (show / set)
- **`timesheet`** (5 tools) — list / pending-list / show / submit / update
- **`interest_requests`** (4 tools) — list + accept / reject / reject-reasons (the `ON_RECRUITER_REVIEW` write surface)
- **`surveys`** (3 tools) — list (pending) / submit (answers) / feedback (free-text)
- **`contracts`** (2 tools) — list / show (talent-level contracts surface)

Tools use canonical sub-domain names — CLI aliases (`certs`, `experience`) are CLI-only and do NOT appear in the MCP catalog. The full registry is wired in [`tools/index.ts`](https://github.com/alexey-pelykh/ttctl/blob/main/packages/mcp/src/tools/index.ts); the authoritative tool count and per-name set are asserted by the registration tests ([`src/tools/__tests__/registration.test.ts`](https://github.com/alexey-pelykh/ttctl/blob/main/packages/mcp/src/tools/__tests__/registration.test.ts), [`src/__tests__/tools.test.ts`](https://github.com/alexey-pelykh/ttctl/blob/main/packages/mcp/src/__tests__/tools.test.ts)) — re-derive from there when the surface changes.

### Glossary — Toptal portal label → MCP / API enum

Tool descriptions reference wire-canonical names (`AVAILABILITY_REQUEST_PENDING`, `eligibleJobs`, …); the Toptal portal surfaces the same concepts with user-facing labels. This table is the cross-reference.

#### Activity items (`ttctl_applications_*`)

The Toptal portal sidebar groups activity rows by **status group**; each row also carries a finer-grained **status**. The MCP `ttctl_applications_list --statusGroups` flag takes the status-group enum. Group assignment is server-side — the `statusV2.value` examples below are representative (✓ = observed in research captures; others inferred from portal observation and enum semantics).

| Portal label                             | `statusGroups` enum   | Representative `statusV2.value`                                                                               |
| ---------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------- |
| Interest Requests / Job Interest Request | `ON_RECRUITER_REVIEW` | ✓ `AVAILABILITY_REQUEST_PENDING` (verbose: "Job Interest Request")                                            |
| On Client Review                         | `ON_CLIENT_REVIEW`    | `PROFILE_SENT_TO_CLIENT`, `APPLIED`, `INTERVIEW_*`                                                            |
| Active Engagement                        | `ACTIVE_ENGAGEMENT`   | ✓ `ACTIVE`; also `ON_TRIAL`, `ON_BREAK`, `PENDING_START`                                                      |
| Closed Engagement                        | `CLOSED_ENGAGEMENT`   | `COMPLETED`, `REJECTED_AFTER_TRIAL`                                                                           |
| Archive / Archived                       | `ARCHIVED`            | ✓ `AVAILABILITY_REQUEST_EXPIRED`, ✓ `AVAILABILITY_REQUEST_REJECTED`, ✓ `JOB_CANCELED`, ✓ `POSITION_FULFILLED` |

Each response row's `statusV2.verbose` is the exact label the portal renders ("Job Interest Request", "Active", "Archived", …); `statusV2.value` is the wire enum.

#### Jobs (`ttctl_jobs_*`)

| Portal concept             | MCP tool                                        | Notes                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job board "N of M" counter | `ttctl_jobs_list` returns the N (eligible) pool | M − N = already-applied + position-fulfilled + not-interested + apply-blocked (skill / specialization mismatch, missing ID verification, insufficient hours, legacy-client restriction, etc. — see `JobOperationsApplyErrorsEnum` for the apply-error taxonomy); the M − N remainder is not exposed by this tool. |
| Saved jobs                 | `ttctl_jobs_saved`                              | Server-side `saved=true` filter on `eligibleJobs`.                                                                                                                                                                                                                                                                |
| Not-interested jobs        | `ttctl_jobs_not_interested_list`                | Server-side `notInterested=true` filter.                                                                                                                                                                                                                                                                          |
| Viewed jobs                | `ttctl_jobs_viewed`                             | Best-effort: wire has no `viewed` filter; client-side filter over a paginated `eligibleJobs` fetch (see the tool's R1 caveat).                                                                                                                                                                                    |
| Job-search subscription    | `ttctl_jobs_search_*`                           | Single subscription per user (wire cardinality R2).                                                                                                                                                                                                                                                               |

### Trust model

Process-level: any process that can spawn `ttctl mcp` gets full access to the user's Toptal Talent session via the configured config file. The 130-tool catalog includes destructive surfaces (`timesheet submit`, `timesheet update`, profile mutations, job-interest signals, rate-change requests, etc.) — the blast radius is the user's full profile and platform-side activity, not just reads. Don't grant MCP access to untrusted AI agents — see the project [`SECURITY.md`](https://github.com/alexey-pelykh/ttctl/blob/main/SECURITY.md).

### Debug instrumentation

Set `TTCTL_DEBUG_MCP=1` to emit one JSON object per line on **stderr** for: tool invocation (`mcp_tool_invoke_start` / `mcp_tool_invoke_end`), auth resolution (`mcp_auth_resolve`), and transport errors (`mcp_transport_error`). Bearer tokens are NEVER in any allowlisted shape (type-system enforcement + runtime substring assertion). The stdout JSON-RPC channel is untouched.

```sh
TTCTL_DEBUG_MCP=1 ttctl mcp 2> mcp-debug.log
jq -c 'select(.event == "mcp_tool_invoke_end") | {tool, duration_ms, status}' mcp-debug.log
```

## Example

Embed the stdio server with an explicit config path:

```ts
import { runMcpStdio } from "@ttctl/mcp";

await runMcpStdio({
  configPath: process.env["TTCTL_CONFIG_FILE"] ?? `${process.env["HOME"]}/.ttctl.yaml`,
});
```

Or build the server, install a custom logger, and bind your own transport:

```ts
import { buildServer, setMcpDiagnosticLogger } from "@ttctl/mcp";

setMcpDiagnosticLogger((record) => myAuditSink.write(record));
const server = buildServer({ configPath: "/etc/ttctl/config.yaml" });
// ...bind server to your chosen MCP transport (SSE, HTTP, custom)
```

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/ttctl/blob/main/LICENSE). Importing `@ttctl/mcp` into your own code means the combined work is covered by AGPL-3.0; if you operate a public MCP server backed by this package, AGPL § 13 source-disclosure to remote users applies. See the project README's [License](https://github.com/alexey-pelykh/ttctl#license) section.
