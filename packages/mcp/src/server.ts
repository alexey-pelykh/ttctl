// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerAllTools } from "./tools/index.js";

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
 */
export function buildServer(): McpServer {
  const server = new McpServer({
    name: "ttctl",
    version: "0.0.0",
  });
  registerAllTools(server);

  return server;
}

/**
 * Run the MCP server over stdio (the canonical transport for Claude Desktop /
 * Claude Code / Cursor / Windsurf).
 */
export async function runMcpStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
