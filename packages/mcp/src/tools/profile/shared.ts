// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  ConfigError,
  DateInputError,
  TtctlError,
  loadAuthToken,
  profile,
  resolveAuthTokenPath,
  resolveConfig,
} from "@ttctl/core";
import { z } from "zod";

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
 */
export interface ToolSuccessResponse {
  [x: string]: unknown;
  content: [{ type: "text"; text: string }];
}

/**
 * Render a JSON-serialized success response. Tools return structured data
 * as JSON in the `text` content field — MCP-aware LLM clients can parse
 * it; non-aware clients see human-readable JSON.
 */
export function jsonSuccess(payload: unknown): ToolSuccessResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Render a plain-text success response (useful for verbs like `remove` /
 * `highlight` whose output is a confirmation, not structured data).
 */
export function textSuccess(text: string): ToolSuccessResponse {
  return { content: [{ type: "text", text }] };
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
 */
export type AuthResolution = { token: string } | { error: ToolErrorResponse };

export async function resolveTokenForTool(commandLabel: string): Promise<AuthResolution> {
  let tokenPath: string;
  try {
    const { config, path: configPath } = resolveConfig();
    tokenPath = resolveAuthTokenPath({ config, configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      return {
        error: {
          isError: true,
          content: [{ type: "text", text: `${commandLabel} failed (CONFIG_ERROR): ${err.message}` }],
        },
      };
    }
    throw err;
  }
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
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
  return { token };
}
