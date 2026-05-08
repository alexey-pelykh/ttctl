// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, resolveConfig } from "@ttctl/core";

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
 * config + token boilerplate per tool.
 *
 * Post-#107: the token lives inline in the YAML config under `auth.token`
 * — no separate token file load. `resolveConfig()` does the YAML parse +
 * schema validation; `config.auth.token` is read directly.
 */
export type AuthResult = { ok: true; token: string } | { ok: false; response: ToolErrorResponse };

export function resolveToolAuth(): Promise<AuthResult> {
  let token: string | undefined;
  try {
    const { config } = resolveConfig();
    token = config.auth.token;
  } catch (err) {
    if (err instanceof ConfigError) {
      return Promise.resolve({
        ok: false,
        response: {
          isError: true,
          content: [
            {
              type: "text",
              text: [
                `Error: ${err.message}`,
                "",
                "Recovery: See README for the YAML config setup instructions.",
                "",
                `(Code: ${err.code})`,
              ].join("\n"),
            },
          ],
        },
      });
    }
    throw err;
  }
  if (token === undefined) {
    return Promise.resolve({
      ok: false,
      response: {
        isError: true,
        content: [
          {
            type: "text",
            text: [
              "Error: No auth token found in config.",
              "",
              "Recovery: Run `ttctl auth signin` to sign in before invoking ttctl tools.",
              "",
              "(Code: UNAUTHENTICATED)",
            ].join("\n"),
          },
        ],
      },
    });
  }
  return Promise.resolve({ ok: true, token });
}
