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

Requires **Node.js ≥ 24**, ESM only.

## API Surface

- `runMcpStdio(opts?)` — start the MCP server on stdio (used by `ttctl mcp`).
- `buildServer(opts?)` — construct the underlying `McpServer` without binding a transport. For SSE/HTTP transports or tests.
- `BuildServerOptions` — `{ configPath?: string; logger?: McpDiagnosticLogger }`. `configPath` is captured ONCE at construction; subsequent tool invocations read AND write that exact path regardless of mid-session `TTCTL_CONFIG_FILE` shifts (see [path-capture-on-startup](https://github.com/alexey-pelykh/ttctl/blob/main/CLAUDE.md#mcp-session-lifetime-and-config-path), issue #113).
- **Error mapping** — `ttctlErrorToToolResponse`, `ttctlErrorToToolResponseOrNull`, `ToolErrorResponse`.
- **Diagnostics** (issue #224) — `setMcpDiagnosticLogger`, `getMcpDiagnosticLogger`, `resetMcpDiagnosticLogger`, `wrapToolHandler`, `redactToolArgs`, `emitMcpDebug`, `emitMcpAuthResolve`, `isTransportError`, `extractTransportStatus`, `extractTransportSurface`.

### Tool catalog

The server registers 88 tools (at time of writing) spanning the full Toptal Talent surface that TTCtl exposes — read AND mutation paths:

- **`profile.*`** (56 tools) — `basic`, `skills`, `industries`, `education`, `certifications`, `employment`, `portfolio`, `visas`, `resume`, `external`, `reviews`
- **`applications`** (3 tools) — list / show / stats
- **`engagements`** (8 tools) — list / show / stats / breaks (list / reasons / set / clear / show)
- **`availability`** (5 tools) — show + writes
- **`jobs`** (13 tools) — browse + saved / viewed / not-interested signals + subscription
- **`timesheet`** (3 tools) — list / show / submit
- **`contracts`** — talent-level contracts surface
- **`payments`** — payouts / methods / rate-change-request

Tools use canonical sub-domain names — CLI aliases (`certs`, `experience`) are CLI-only and do NOT appear in the MCP catalog. The full registry is wired in [`tools/index.ts`](https://github.com/alexey-pelykh/ttctl/blob/main/packages/mcp/src/tools/index.ts).

### Trust model

Process-level: any process that can spawn `ttctl mcp` gets full access to the user's Toptal Talent session via the configured config file. The 88-tool catalog includes destructive surfaces (`timesheet submit`, profile mutations, job-interest signals, rate-change requests, etc.) — the blast radius is the user's full profile and platform-side activity, not just reads. Don't grant MCP access to untrusted AI agents — see the project [`SECURITY.md`](https://github.com/alexey-pelykh/ttctl/blob/main/SECURITY.md).

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
