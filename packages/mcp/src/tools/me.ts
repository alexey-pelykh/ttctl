// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { me } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import type { ToolErrorResponse } from "../errors.js";
import { buildMcpDryRunPreview, dryRunResponse, type ToolRegistrationContext } from "./_shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the `ttctl_me_*` MCP tools. One read-only tool today:
 *
 *   - `ttctl_me_actions_list` — the viewer performed-actions audit log
 *
 * **Pagination** is ADR-007 (ttctl) row 5 — bare bidirectional cursor:
 * `before` / `after` are opaque cursor tokens (the wire's `String`
 * cursors, surfaced verbatim), `limit` caps the page size. The keys name
 * the wire args 1:1 (surface-honesty).
 *
 * **Dry-run path**: the tool accepts `dryRun?: boolean`. Read-only tools
 * build the preview at the MCP layer via `buildMcpDryRunPreview`.
 *
 * **Per CLAUDE.md schema/contract validation rule**: `GetPerformedActions`
 * is absent from the synthesized gateway SDL → INFERRED. Live E2E
 * coverage (`packages/e2e/src/92-me-actions-list.e2e.test.ts`, T1 wire
 * snapshot) is mandatory pre-merge.
 */
export function registerMeTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_me_actions_list",
    {
      title: "List the viewer's performed actions (audit log)",
      description: [
        "List the signed-in user's performed actions — the per-role audit log of",
        "viewer activity (status changes, applications submitted, and similar).",
        "",
        "Pagination (ADR-007 row 5, bidirectional cursor): `before` / `after` take",
        "opaque cursor tokens echoed from a prior page; `limit` caps the page size.",
        "Omit all three for the server's default first page. Returns a bare list",
        "(no totalCount); each action carries id, category, description",
        "(template + variables), occurredAt.",
        "",
        "Example user prompts:",
        '  - "What have I done recently on Toptal?"',
        '  - "Show my last 10 profile actions."',
        '  - "When did I last submit an application?"',
      ].join("\n"),
      inputSchema: {
        before: z.string().optional().describe("Opaque cursor — return actions before this point."),
        after: z.string().optional().describe("Opaque cursor — return actions after this point."),
        limit: z.number().int().positive().optional().describe("Maximum number of actions to return."),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;

      const variables = {
        before: args.before ?? null,
        after: args.after ?? null,
        limit: args.limit ?? null,
      };
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("GetPerformedActions", "mobile-gateway", variables, auth.token));
      }

      const opts: me.ListOptions = {};
      if (args.before !== undefined) opts.before = args.before;
      if (args.after !== undefined) opts.after = args.after;
      if (args.limit !== undefined) opts.limit = args.limit;
      try {
        const items = await me.actions.list(auth.token, opts);
        return successResponse(items);
      } catch (err) {
        return mapMeError(err);
      }
    },
  );
}

interface ToolSuccessResponse {
  [x: string]: unknown;
  content: [{ type: "text"; text: string }];
}

function successResponse(data: unknown): ToolSuccessResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function mapMeError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof me.MeError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `Error: ${err.message}`,
            "",
            "Recovery: Adjust the tool input or retry; see the code below.",
            "",
            `(Code: ${err.code})`,
          ].join("\n"),
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          `Error: me request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}
