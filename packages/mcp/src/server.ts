// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveConfig } from "@ttctl/core";

import { createToolAuthResolver } from "./auth.js";
import { createTokenLoader } from "./tools/_shared.js";
import { createTokenResolver } from "./tools/profile/shared.js";
import { registerAllTools } from "./tools/index.js";

/**
 * Options accepted by `buildServer` and `runMcpStdio`. The single knob
 * here is `configPath` — the explicit config-file path captured by the
 * CLI's `--config <path>` flag (or any future SSE/HTTP transport entry).
 *
 * When `configPath` is undefined, `resolveConfig` falls through to the
 * `TTCTL_CONFIG_FILE` env var, then to `~/.ttctl.yaml` (the canonical
 * 3-step chain documented in CLAUDE.md § Config File Resolution).
 */
export interface BuildServerOptions {
  configPath?: string;
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
 */
export async function runMcpStdio(opts: BuildServerOptions = {}): Promise<void> {
  const server = buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
