// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAllTools } from "./tools/index.js";
import type { ToolRegistrationContext } from "./tools/_shared.js";

/**
 * A {@link ToolRegistrationContext} whose auth resolvers are never invoked.
 * `registerAllTools` only WIRES tool definitions (names, schemas, handlers)
 * onto the server — the resolvers fire at tool-CALL time, which introspection
 * never reaches. The stubs reject if that assumption ever breaks, so a future
 * registrar that touches the context at registration time fails loudly rather
 * than silently binding a bogus token.
 */
function introspectionStubContext(): ToolRegistrationContext {
  const unreachable = (label: string) => (): Promise<never> =>
    Promise.reject(new Error(`introspection stub: ${label} must not run during tool registration`));
  return {
    resolveToolAuth: unreachable("resolveToolAuth"),
    loadTokenForTool: unreachable("loadTokenForTool"),
    resolveTokenForTool: unreachable("resolveTokenForTool"),
  };
}

/**
 * The set of MCP tool names TTCtl registers, as seen by a live `McpServer`.
 *
 * This is the AUTHORITATIVE tool-name source for the CLI↔MCP parity contract
 * test: it constructs an in-memory server, runs the real `registerAllTools`,
 * and reads the SDK's tool registry. Reading the runtime registry (rather than
 * scanning the tool source for `"ttctl_…"` literals) is what makes it robust
 * to computed names — e.g. the `ttctl_profile_employment_skills_${op}` template
 * registrations a source scan cannot resolve.
 *
 * `_registeredTools` is `private` in the SDK `.d.ts` but a plain
 * `Record<string, RegisteredTool>` at runtime, stable across SDK versions (the
 * same access path the registration unit test relies on).
 */
export function listRegisteredMcpToolNames(): string[] {
  const server = new McpServer({ name: "ttctl-introspection", version: "0.0.0" });
  registerAllTools(server, introspectionStubContext());
  const internal = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internal._registeredTools).sort();
}
