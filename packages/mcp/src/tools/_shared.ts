// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, TtctlError, buildDryRunPreview, resolveConfig } from "@ttctl/core";
import type { DryRunPreview, ToptalSurface } from "@ttctl/core";

import type { AuthResult } from "../auth.js";
import { emitMcpAuthResolve } from "../diagnostic.js";
import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import type { ToolErrorResponse } from "../errors.js";

/**
 * Shared MCP-tool helpers — auth-token loading, response shaping, error
 * mapping. Kept in one module so each `profile_basic_*` / `profile_skills_*`
 * tool file stays small and focused on its own input shape.
 *
 * **Auth**: tools load the token per-call rather than caching it at server
 * startup. The MCP server is a long-lived process; the user may re-run
 * `ttctl auth signin` while the server is up, and the next tool call should
 * pick up the new token without restarting the server.
 *
 * Post-#113: the per-call read targets the config path captured at
 * `buildServer()` time, NOT a fresh per-invocation `resolveConfig()` call.
 * Tools receive the bound `loadTokenForTool` closure via the registration
 * context, not as a free import. Env-var shifts mid-session do not
 * retarget reads or writes — the captured path is canonical for the
 * session's lifetime.
 *
 * **Error contract**: domain failures (`ProfileError`, `SkillsError`) and
 * typed `TtctlError` subclasses both render as MCP `isError: true` tool
 * responses. Untyped throws bubble up to the SDK's default error path.
 */

/**
 * MCP tool-success response shape. Mirrors the SDK's `CallToolResult`
 * happy-path: a text-content array carrying the rendered payload.
 *
 * The `[key: string]: unknown` index signature keeps the type
 * structurally compatible with the SDK's `CallToolResult` (whose own type
 * carries the same signature for forward-compatibility with new optional
 * fields). The `structuredContent` field is intentionally omitted from
 * this type — it's only required when a tool declares an `outputSchema`,
 * and TTCtl's tools surface their structured payload through the `text`
 * content slot (LLM clients can `JSON.parse(content[0].text)`).
 */
export interface ToolSuccessResponse {
  content: [{ type: "text"; text: string }];
  [key: string]: unknown;
}

/**
 * Render a JSON-shaped payload as a tool-success response. Stringifies
 * with two-space indentation so LLM clients see an easy-to-read response.
 */
export function jsonResponse(payload: unknown): ToolSuccessResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Render a plain string as a tool-success response (e.g., for tools that
 * return a confirmation rather than structured data).
 */
export function textResponse(text: string): ToolSuccessResponse {
  return { content: [{ type: "text", text }] };
}

/**
 * Uniform MCP dry-run response envelope (issue #165). Every tool's
 * `dryRun: true` branch renders through this so MCP clients can treat
 * `dryRun` as a universal "preview" affordance without per-tool envelope
 * knowledge. The shape is `{ ok: true, dryRun: true, preview }` where
 * `preview` is the canonical {@link DryRunPreview} carrying surface,
 * transport, endpoint, operationName, variables, and (bearer-redacted)
 * headers. The same envelope is emitted whether the preview was
 * constructed at the MCP layer (via {@link buildMcpDryRunPreview}) or
 * received from a core service whose `dryRun` option is supported
 * (`profile.basic.set`, `jobs.*`, `engagements.breaks.*`,
 * `availability.*Set`).
 */
export function dryRunResponse(preview: DryRunPreview): ToolSuccessResponse {
  return jsonResponse({ ok: true, dryRun: true, preview });
}

/**
 * Sibling envelope for multi-mutation tools (issue #165). Some tools fire
 * MORE than one wire operation per invocation — `profile.skills.update`
 * fires one mutation per supplied field (rating, experience, publicity).
 * Single-preview envelope would lie: a caller previewing
 * `update({id, rating, experience})` with the singular envelope would see
 * one mutation while the apply path would actually fire two.
 *
 * The plural form preserves honesty without diverging from the dry-run
 * contract: same `{ ok: true, dryRun: true, ... }` shape, but the `preview`
 * key is replaced by `previews` (array). Tools using this helper MUST
 * document the plural form on the tool description so MCP clients can
 * branch on shape. The cross-cutting dry-run smoke test (#165 AC)
 * accepts EITHER `preview` (single) OR `previews` (array).
 */
export function dryRunMultiResponse(previews: DryRunPreview[]): ToolSuccessResponse {
  return jsonResponse({ ok: true, dryRun: true, previews });
}

/**
 * Build a {@link DryRunPreview} at the MCP layer for tools whose core
 * service does NOT carry its own `dryRun` option — i.e. read-only tools
 * across every group and the profile sub-domains beyond `profile.basic`
 * (`skills`, `industries`, `education`, `certifications`, `employment`,
 * `portfolio`, `visas`, `resume`, `external`, `reviews`). The MCP tool
 * supplies the operation's metadata + would-be variables; the helper
 * constructs the preview via the public {@link buildDryRunPreview}
 * primitive without invoking any transport (read or write).
 *
 * For mutating tools whose core supports `dryRun` (the four exceptions
 * listed above), prefer passing `{ dryRun: true }` through to the core
 * call and branching on the returned `{ kind: "preview", preview }`
 * outcome — that path reuses the canonical variable-construction
 * (including placeholder substitution for fields like `profileId` that
 * would otherwise be resolved via a sibling read) and avoids drift
 * between MCP-built variables and what core would actually send.
 *
 * The `token` is forwarded as `authToken` on the synthesised
 * {@link TransportRequest} so {@link buildDryRunPreview} sets the
 * `authorization` header to {@link DRY_RUN_REDACTED_AUTHORIZATION}
 * (i.e. `Token token=<redacted>`) without ever placing the live bearer
 * in the preview payload.
 */
export function buildMcpDryRunPreview(
  operationName: string,
  surface: ToptalSurface,
  variables: Record<string, unknown>,
  token: string,
): DryRunPreview {
  return buildDryRunPreview({
    surface,
    body: { operationName, variables },
    authToken: token,
  });
}

/**
 * Build a tool-error response for a missing / unreadable auth token. The
 * MCP equivalent of the CLI's `(UNAUTHENTICATED): No auth token found`
 * branch.
 */
export function unauthenticatedResponse(toolName: string): ToolErrorResponse {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error: ${toolName} failed (UNAUTHENTICATED): No auth token found.\n\nRecovery: Run \`ttctl auth signin\` to sign in.\n\n(Code: UNAUTHENTICATED)`,
      },
    ],
  };
}

/**
 * Build a tool-error response for a config-resolution or write-back
 * failure. The `ConfigError.code` discriminator (`NO_CREDS` / `PARSE` /
 * `VALIDATION` / `PERMISSION` / `LOCKED`) is surfaced verbatim as the
 * wire-format code so MCP clients can branch on it without string-matching
 * the prose message. `LOCKED` indicates another ttctl process holds the
 * config write-back lock — the MCP client should retry after a brief delay.
 */
export function configErrorResponse(toolName: string, err: ConfigError): ToolErrorResponse {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error: ${toolName} failed (${err.code}): ${err.message}\n\n(Code: ${err.code})`,
      },
    ],
  };
}

/**
 * Build a tool-error response for a domain error carrying a `code` +
 * `message`. Used for `ProfileError` and `SkillsError` — both expose the
 * same shape (`{code, message}`) but live in different modules.
 */
export function domainErrorResponse(toolName: string, err: { code: string; message: string }): ToolErrorResponse {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error: ${toolName} failed (${err.code}): ${err.message}\n\n(Code: ${err.code})`,
      },
    ],
  };
}

/**
 * Build a tool-error response for an unexpected exception (anything that
 * isn't a `TtctlError` or domain error). Surfaced so the LLM client gets
 * a structured response rather than the SDK's untyped error fallback.
 */
export function genericErrorResponse(toolName: string, err: unknown): ToolErrorResponse {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error: ${toolName} failed: ${message}\n\n(Code: UNKNOWN)`,
      },
    ],
  };
}

/**
 * Shared auth-token loader. Returns either the token (string) or a
 * tool-error response that the caller should return verbatim.
 *
 * Routes via `ttctlErrorToToolResponseOrNull` first so any `TtctlError`
 * thrown by the resolver chain (rare but possible) gets the uniform
 * Error/Recovery/Code rendering.
 *
 * The loader is a factory closure over the MCP session's canonical config
 * path captured at startup (#113). Per-call reads always target that path;
 * env-var shifts during the session do NOT retarget the read.
 */
export type TokenLoader = (toolName: string) => Promise<{ token: string } | ToolErrorResponse>;

export function createTokenLoader(configPath: string): TokenLoader {
  return async function loadTokenForTool(toolName: string): Promise<{ token: string } | ToolErrorResponse> {
    let token: string | undefined;
    try {
      const { config } = resolveConfig({ path: configPath });
      token = config.auth.token;
    } catch (err) {
      if (err instanceof ConfigError) {
        emitMcpAuthResolve(configPath, "config_error", false);
        return configErrorResponse(toolName, err);
      }
      if (err instanceof TtctlError) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) {
          emitMcpAuthResolve(configPath, "config_error", false);
          return typed;
        }
      }
      throw err;
    }
    if (token === undefined) {
      emitMcpAuthResolve(configPath, "unauthenticated", false);
      return unauthenticatedResponse(toolName);
    }
    emitMcpAuthResolve(configPath, "ok", true);
    return Promise.resolve({ token });
  };
}

/**
 * Type guard: true when `value` is one of our tool responses (success or
 * error). Used by tool handlers to decide whether to short-circuit on a
 * failed token load.
 */
export function isToolErrorResponse(value: unknown): value is ToolErrorResponse {
  return typeof value === "object" && value !== null && "isError" in value && value.isError === true;
}

/**
 * Resolver-shape used by `tools/profile/shared.ts` (`commandLabel`-flavored
 * auth resolution returning `{token} | {error}`). Defined here so the
 * `ToolRegistrationContext` can carry it without `_shared.ts` having to
 * import from `tools/profile/`.
 */
export type TokenResolver = (commandLabel: string) => Promise<{ token: string } | { error: ToolErrorResponse }>;

/**
 * Dependency-injection context threaded through `registerAllTools` (#113).
 *
 * `buildServer({configPath})` calls `resolveConfig` ONCE at startup and
 * uses the resulting absolute path to construct each resolver. The
 * context is then handed to `registerAllTools`, which forwards it to each
 * per-tool registrar so per-tool callbacks invoke `ctx.resolveToolAuth()`
 * / `ctx.loadTokenForTool(toolName)` / `ctx.resolveTokenForTool(label)`
 * instead of free-importing module-scoped functions that would re-resolve
 * config (and re-read env) on each call.
 *
 * Three resolver shapes co-exist because the existing tool surface uses
 * three different conventions:
 *
 * - `resolveToolAuth` — discriminated-union `AuthResult`
 *   (`{ok: true, token} | {ok: false, response}`) consumed by
 *   `tools/profile/portfolio|resume|visas.ts`.
 * - `loadTokenForTool(toolName)` — toolName-aware error path that
 *   includes the tool name in the rendered `Error: <toolName> failed
 *   (...)` text. Used by every per-file `profile_*_*.ts` tool.
 * - `resolveTokenForTool(commandLabel)` — `commandLabel`-prefixed errors
 *   (`{token} | {error}` shape) used by sub-domain registrars in
 *   `tools/profile/certifications|education|employment|industries.ts`.
 *
 * All three target the captured configPath; mid-session env shifts do
 * NOT retarget reads or writes for any of the three.
 */
export interface ToolRegistrationContext {
  resolveToolAuth: () => Promise<AuthResult>;
  loadTokenForTool: TokenLoader;
  resolveTokenForTool: TokenResolver;
}
