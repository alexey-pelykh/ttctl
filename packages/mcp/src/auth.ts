// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, resolveConfig } from "@ttctl/core";

import { emitMcpAuthResolve } from "./diagnostic.js";
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
 *
 * Post-#113: the resolver is a factory closure over the config path
 * captured at MCP server startup. Reads target the captured path, NOT a
 * fresh per-invocation `resolveConfig()` call. This guarantees read/write
 * symmetry across the MCP session lifetime — env-var shifts after startup
 * do not retarget either side.
 */
export type AuthResult = { ok: true; token: string } | { ok: false; response: ToolErrorResponse };

/**
 * Build a tool-auth resolver bound to the MCP session's canonical config
 * path. The factory is invoked ONCE at `buildServer()` time with the path
 * captured by the startup-time `resolveConfig()`; each per-tool invocation
 * calls the returned closure, which re-reads the file (to pick up token
 * rotations from a sibling `ttctl auth signin`) but ALWAYS targets the
 * captured path.
 */
export function createToolAuthResolver(configPath: string): () => Promise<AuthResult> {
  return function resolveToolAuth(): Promise<AuthResult> {
    let token: string | undefined;
    try {
      const { config } = resolveConfig({ path: configPath });
      token = config.auth.token;
    } catch (err) {
      if (err instanceof ConfigError) {
        emitMcpAuthResolve(configPath, "config_error", false);
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
      emitMcpAuthResolve(configPath, "unauthenticated", false);
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
    emitMcpAuthResolve(configPath, "ok", true);
    return Promise.resolve({ ok: true, token });
  };
}
