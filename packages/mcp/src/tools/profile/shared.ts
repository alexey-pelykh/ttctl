// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, DateInputError, TtctlError, profile, resolveConfig } from "@ttctl/core";
import { z } from "zod";

import { emitMcpAuthResolve } from "../../diagnostic.js";
import { ttctlErrorToToolResponse } from "../../errors.js";
import type { ToolErrorResponse } from "../../errors.js";

/**
 * Zod schema for sub-domain `--from` / `--to` / `--issued` / `--expires` /
 * other date-flavored flags. Accepts ISO-8601 (`YYYY-MM-DD`) or year-only
 * (`YYYY`); semantic validation (real calendar dates, year range) happens
 * later inside `parseDateInput` from `@ttctl/core`. Hoisted here so the
 * four sub-domain tool files share a single source of truth.
 */
export const dateInput = z
  .string()
  .regex(/^(\d{4}|\d{4}-\d{2}-\d{2})$/, "expected ISO-8601 date (YYYY-MM-DD) or year (YYYY)");

/**
 * MCP tool-result success shape. Mirrors the SDK-side `CallToolResult`
 * (which is inferred from a `z.core.$loose` schema and therefore carries
 * an `[x: string]: unknown` index signature) — kept loose so the helper
 * return type composes cleanly with the SDK's `ToolCallback`.
 *
 * `structuredContent` is populated by {@link jsonSuccess} as advisory
 * pre-parsed metadata alongside the `text` slot. No tool declares an
 * `outputSchema` (removed in #379), so the SDK does not validate it.
 */
export interface ToolSuccessResponse {
  [x: string]: unknown;
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
}

/**
 * Render a JSON-serialized success response. Tools return structured data
 * as JSON in the `text` content field — MCP-aware LLM clients can parse
 * it; non-aware clients see human-readable JSON. The same payload is
 * mirrored into `structuredContent` as advisory pre-parsed metadata (no
 * tool declares an `outputSchema` post-#379, so it is not SDK-validated).
 *
 * `structuredContent` is populated only when `payload` is an object —
 * the MCP SDK's `structuredContent` slot expects an object shape, and
 * array / primitive payloads stay in the `text` slot only.
 */
export function jsonSuccess(payload: unknown): ToolSuccessResponse {
  const response: ToolSuccessResponse = {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    response.structuredContent = payload as Record<string, unknown>;
  }
  return response;
}

/**
 * Render a plain-text success response (useful for verbs like `remove` /
 * `highlight` whose output is a confirmation, not structured data). Use
 * {@link textWithStructuredSuccess} when an advisory structured
 * acknowledgment is also desired.
 */
export function textSuccess(text: string): ToolSuccessResponse {
  return { content: [{ type: "text", text }] };
}

/**
 * Render a confirmation line as the `text` content slot while also
 * publishing an advisory structured acknowledgment via
 * `structuredContent`. Used by `*_remove` tools where the human-readable
 * text stays for compatibility and the structured payload is a
 * pre-parsed convenience for clients. Not SDK-validated (no tool
 * declares an `outputSchema` post-#379).
 */
export function textWithStructuredSuccess(
  text: string,
  structuredContent: Record<string, unknown>,
): ToolSuccessResponse {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

/**
 * Map a domain error from any sub-domain into an MCP tool-error response.
 *
 * Routes through three branches:
 * - `TtctlError` subclasses → uniform Error/Recovery/Code blocks
 * - `profile.basic.ProfileError` → `(<CODE>): <message>` line
 * - anything else → generic `text: <message>`
 *
 * `commandLabel` (e.g. `"profile.education.add"`) prefixes the error
 * line for sub-domain disambiguation.
 */
export function presentToolError(commandLabel: string, err: unknown): ToolErrorResponse {
  if (err instanceof TtctlError) return ttctlErrorToToolResponse(err);
  if (err instanceof profile.basic.ProfileError) {
    return {
      isError: true,
      content: [{ type: "text", text: `${commandLabel} failed (${err.code}): ${err.message}` }],
    };
  }
  if (err instanceof DateInputError) {
    return {
      isError: true,
      content: [{ type: "text", text: `${commandLabel} failed (${err.code}): ${err.message}` }],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `${commandLabel} failed: ${message}` }],
  };
}

/**
 * Resolve the auth-token path from `.ttctl.yaml` for an MCP tool. On
 * `ConfigError`, returns the rendered tool-error response; on success,
 * returns `{ token }`. The two-shape return lets the caller branch with
 * `if ("error" in r) return r.error` instead of carrying try/catch.
 *
 * Post-#113: the resolver is a factory closure over the config path
 * captured at MCP server startup. Per-call reads always target that path;
 * env-var shifts during the session do NOT retarget the read.
 */
export type AuthResolution = { token: string } | { error: ToolErrorResponse };

export type CommandLabelTokenResolver = (commandLabel: string) => Promise<AuthResolution>;

export function createTokenResolver(configPath: string): CommandLabelTokenResolver {
  return async function resolveTokenForTool(commandLabel: string): Promise<AuthResolution> {
    let token: string | undefined;
    try {
      const { config } = resolveConfig({ path: configPath });
      token = config.auth.token;
    } catch (err) {
      if (err instanceof ConfigError) {
        emitMcpAuthResolve(configPath, "config_error", false);
        return {
          error: {
            isError: true,
            content: [{ type: "text", text: `${commandLabel} failed (${err.code}): ${err.message}` }],
          },
        };
      }
      throw err;
    }
    if (token === undefined) {
      emitMcpAuthResolve(configPath, "unauthenticated", false);
      return {
        error: {
          isError: true,
          content: [
            {
              type: "text",
              text: `${commandLabel} failed (UNAUTHENTICATED): No auth token found. Run \`ttctl auth signin\` to sign in.`,
            },
          ],
        },
      };
    }
    emitMcpAuthResolve(configPath, "ok", true);
    return Promise.resolve({ token });
  };
}
