// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, loadAuthToken, resolveAuthTokenPath, resolveConfig } from "@ttctl/core";

import type { ToolErrorResponse } from "./errors.js";

/**
 * Resolve the persisted auth token for an MCP tool invocation. Returns
 * either:
 *   - `{ ok: true, token }` when a token is available, OR
 *   - `{ ok: false, response }` carrying a structured `ToolErrorResponse`
 *     the tool callback returns directly so the MCP host renders the
 *     `Error / Recovery / Code` blocks.
 *
 * Centralizing this here means each tool callback writes a single
 * `if (!auth.ok) return auth.response;` line instead of duplicating the
 * token-load + config-error boilerplate per tool.
 */
export type AuthResult = { ok: true; token: string } | { ok: false; response: ToolErrorResponse };

export async function resolveToolAuth(): Promise<AuthResult> {
  let tokenPath: string;
  try {
    const { config, path: configPath } = resolveConfig();
    tokenPath = resolveAuthTokenPath({ config, configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      return {
        ok: false,
        response: {
          isError: true,
          content: [
            {
              type: "text",
              text: [
                `Error: ${err.message}`,
                "",
                "Recovery: See README for the .ttctl.yaml setup instructions.",
                "",
                "(Code: CONFIG_ERROR)",
              ].join("\n"),
            },
          ],
        },
      };
    }
    throw err;
  }
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    return {
      ok: false,
      response: {
        isError: true,
        content: [
          {
            type: "text",
            text: [
              "Error: No auth token found.",
              "",
              "Recovery: Run `ttctl auth signin` to sign in before invoking ttctl tools.",
              "",
              "(Code: UNAUTHENTICATED)",
            ].join("\n"),
          },
        ],
      },
    };
  }
  return { ok: true, token };
}
