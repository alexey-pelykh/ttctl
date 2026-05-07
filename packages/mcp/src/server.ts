// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerAllTools } from "./tools/index.js";

/**
 * Build the TTCtl MCP server. Tools are wired in via `registerAllTools` —
 * a single registration site that pulls in every per-tool module so each
 * tool file stays ~50 lines of focused configuration.
 *
 * Trust model: process-level — any process that can spawn `ttctl mcp` gets
 * full access to the user's Toptal Talent session. See SECURITY.md.
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
