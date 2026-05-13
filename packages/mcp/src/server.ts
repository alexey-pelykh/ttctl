// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveConfig } from "@ttctl/core";

import { createToolAuthResolver } from "./auth.js";
import {
  type McpDiagnosticLogger,
  setMcpDiagnosticLogger,
  wrapToolHandler,
} from "./diagnostic.js";
import { createTokenLoader } from "./tools/_shared.js";
import { createTokenResolver } from "./tools/profile/shared.js";
import { registerAllTools } from "./tools/index.js";

/**
 * Options accepted by `buildServer` and `runMcpStdio`.
 *
 * - `configPath` — explicit config-file path captured by the CLI's
 *   `--config <path>` flag (or any future SSE/HTTP transport entry).
 *   When undefined, `resolveConfig` falls through to the
 *   `TTCTL_CONFIG_FILE` env var, then to `~/.ttctl.yaml` (the canonical
 *   3-step chain documented in CLAUDE.md § Config File Resolution).
 * - `logger` — optional MCP diagnostic logger override (issue #224).
 *   When supplied to `runMcpStdio`, the logger is installed BEFORE
 *   `buildServer` runs, so every tool-registration instrumentation +
 *   every per-call emission routes through the injected logger.
 *   Production callers omit this field; tests inject a capturing
 *   logger to assert emission shape without manipulating
 *   `process.env`. When `runMcpStdio` is called with no `logger`, the
 *   module-default env-gated stderr emitter (`TTCTL_DEBUG_MCP=1`) is
 *   used. `buildServer` itself does NOT install the logger — it
 *   only consumes the currently-installed one when wrapping tool
 *   handlers — so callers that bypass `runMcpStdio` (e.g. tests
 *   building a server directly) must call
 *   `setMcpDiagnosticLogger` themselves if they want custom emission.
 */
export interface BuildServerOptions {
  configPath?: string;
  logger?: McpDiagnosticLogger;
}

/**
 * Build the TTCtl MCP server. Tools are wired in via `registerAllTools` —
 * a single registration site that pulls in every per-tool module so each
 * tool file stays focused on its own input shape.
 *
 * Trust model: process-level — any process that can spawn `ttctl mcp` gets
 * full access to the user's Toptal Talent session. See SECURITY.md.
 *
 * Tools are registered in `tools/index.ts`. Today's surface: 4
 * `profile.basic` + 7 `profile.skills` (#73) + 5 `profile.industries` +
 * 5 `profile.education` + 5 `profile.certifications` +
 * 6 `profile.employment` (#74) = 32 tools. MCP tool names use ONLY the
 * canonical sub-domain names per project policy (#72) — CLI aliases like
 * `certs` and `experience` are CLI-only and never appear in the MCP catalog.
 *
 * Path capture (#113): `resolveConfig` is invoked ONCE here at server-
 * construction time. The resolved absolute path is captured into closures
 * for each per-tool auth resolver (`resolveToolAuth`, `loadTokenForTool`,
 * `resolveTokenForTool`) so subsequent tool invocations read AND write
 * the path that was canonical at startup. Mid-session env-var shifts
 * (e.g., parent shell re-exporting `TTCTL_CONFIG_FILE`) are intentionally
 * ignored — long-running MCP sessions need read/write symmetry.
 *
 * Diagnostic instrumentation (#224): every tool registered through this
 * server has its callback wrapped with `wrapToolHandler` so the active
 * MCP diagnostic logger sees `mcp_tool_invoke_start` BEFORE the callback
 * runs, `mcp_tool_invoke_end` AFTER it resolves (or throws), and
 * `mcp_transport_error` when the throw is a transport-class error
 * (`Cf403Error`, `Cf403PersistentError`, `SchedulerBearerExpired`). The
 * wrap is applied transparently by monkey-patching `server.registerTool`
 * BEFORE `registerAllTools` runs, so per-tool files (~30+ registrars)
 * are not aware of the instrumentation — the wiring lives in this one
 * place.
 *
 * Fail-fast: any `ConfigError` thrown by the startup-time `resolveConfig`
 * (e.g., `NO_CREDS` when no candidate file exists) propagates verbatim —
 * the server does NOT start in a half-initialized state.
 */
export function buildServer(opts: BuildServerOptions = {}): McpServer {
  // resolveConfig honors `path` when provided, else falls through to the
  // env→home chain. We always read the canonical absolute path off the
  // returned `path` field; that's what the resolvers close over.
  const resolved = opts.configPath !== undefined ? resolveConfig({ path: opts.configPath }) : resolveConfig();
  const capturedPath = resolved.path;

  const server = new McpServer({
    name: "ttctl",
    version: "0.0.0",
  });

  // Monkey-patch `server.registerTool` BEFORE `registerAllTools` runs so
  // every per-tool registrar's callback is transparently wrapped with the
  // diagnostic-instrumentation contract. The patch:
  //   1. Captures `originalRegisterTool` bound to the McpServer instance
  //      so the SDK's internal `_registeredTools` bookkeeping fires normally.
  //   2. Replaces `server.registerTool` with a wrapper that passes through
  //      name + config verbatim and wraps the callback with
  //      `wrapToolHandler(name, cb)`. The wrapper's return is the same
  //      `RegisteredTool` handle as the original — `.enable()` /
  //      `.disable()` / `.update()` work unchanged on the registered tool.
  //   3. Uses an `unknown` cast on the patch because `registerTool`'s
  //      generic signature (with `ZodRawShapeCompat | AnySchema` + the
  //      output schema variant) is hostile to a single typed override.
  //      The wrapper preserves runtime behavior; type safety at the
  //      callsites (each registrar) is unaffected.
  // The signature of McpServer.registerTool is an overload set that
  // resolves to `never` under `Parameters<...>`, so we type the patch
  // as a permissive `(...args: unknown[]) => unknown` and lean on the
  // outer cast to restore the McpServer's view. Runtime semantics are
  // unchanged — name is always args[0]: string, config args[1]: object,
  // cb args[2]: function — and the original registerTool reapplies the
  // overload-correct type check on its side.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalRegisterTool = server.registerTool.bind(server) as (...args: any[]) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patchedRegisterTool = (...args: any[]): unknown => {
    const name = args[0] as string;
    const config = args[1] as unknown;
    const cb = args[2] as Parameters<typeof wrapToolHandler>[1];
    const wrappedCb = wrapToolHandler(name, cb);
    return originalRegisterTool(name, config, wrappedCb);
  };
  (server as unknown as { registerTool: typeof patchedRegisterTool }).registerTool = patchedRegisterTool;

  registerAllTools(server, {
    resolveToolAuth: createToolAuthResolver(capturedPath),
    loadTokenForTool: createTokenLoader(capturedPath),
    resolveTokenForTool: createTokenResolver(capturedPath),
  });

  return server;
}

/**
 * Run the MCP server over stdio (the canonical transport for Claude Desktop /
 * Claude Code / Cursor / Windsurf).
 *
 * Accepts the same `configPath` knob as `buildServer`. Threading the path
 * through here keeps the umbrella `ttctl mcp [--config <path>]` entry
 * surface as the single point of CLI-flag parsing, with no per-tool
 * config knowledge needed inside the server module.
 *
 * Diagnostic logger wiring (issue #224): when `opts.logger` is supplied,
 * `setMcpDiagnosticLogger(opts.logger)` is called BEFORE `buildServer`
 * so the tool-registration wrapping in `buildServer` already routes
 * through the injected logger. When omitted, the module-scoped default
 * (env-gated stderr emitter for `TTCTL_DEBUG_MCP=1`) remains active.
 * Tests calling `runMcpStdio` with a fake logger thus get full
 * tool-start / tool-end / transport-error visibility without needing
 * to manipulate `process.env`.
 */
export async function runMcpStdio(opts: BuildServerOptions = {}): Promise<void> {
  if (opts.logger !== undefined) {
    setMcpDiagnosticLogger(opts.logger);
  }
  const server = buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
