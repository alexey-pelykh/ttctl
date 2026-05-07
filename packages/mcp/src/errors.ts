// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError } from "@ttctl/core";

/**
 * MCP tool-error response shape. Mirrors the Model Context Protocol's
 * `CallToolResult` for error cases (`isError: true` + `content: [TextContent]`).
 *
 * Defined locally rather than re-exporting from `@modelcontextprotocol/sdk`
 * to keep the typing focused on what TTCtl emits — the upstream SDK type is
 * a wide union covering all content types we don't return. This shape is
 * the SUBSET we promise.
 *
 * The `[key: string]: unknown` index signature keeps the type structurally
 * compatible with the SDK's `CallToolResult` (whose own type carries the
 * same signature for forward-compatibility with new optional fields).
 * Without it, returning this shape from a `registerTool` callback fails
 * strict type-checking even though the runtime values are identical.
 */
export interface ToolErrorResponse {
  isError: true;
  content: [{ type: "text"; text: string }];
  [key: string]: unknown;
}

/**
 * Render a `TtctlError` as an MCP tool-error response (issue #77 § MCP
 * error presentation).
 *
 * The text payload follows the same Error/Recovery/Code blocks the CLI
 * surface emits, with the `code` echoed as a structured tag MCP-aware LLM
 * clients can detect programmatically without parsing prose. Multi-line
 * content stays in `text` since MCP's `TextContent` is a free-form string.
 */
export function ttctlErrorToToolResponse(err: TtctlError): ToolErrorResponse {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [`Error: ${err.message}`, "", `Recovery: ${err.recovery}`, "", `(Code: ${err.code})`].join("\n"),
      },
    ],
  };
}

/**
 * Convenience guard for tool implementations: if `err` is a `TtctlError`,
 * return the structured tool response; otherwise fall through (return
 * `null`) so the caller can apply its own non-typed-error handling.
 *
 * Tool implementations consume this as:
 *
 * ```ts
 * try {
 *   const value = await someService(...);
 *   return successResponse(value);
 * } catch (err) {
 *   const typed = ttctlErrorToToolResponseOrNull(err);
 *   if (typed !== null) return typed;
 *   throw err;  // or generic-error response
 * }
 * ```
 */
export function ttctlErrorToToolResponseOrNull(err: unknown): ToolErrorResponse | null {
  if (err instanceof TtctlError) {
    return ttctlErrorToToolResponse(err);
  }
  return null;
}
