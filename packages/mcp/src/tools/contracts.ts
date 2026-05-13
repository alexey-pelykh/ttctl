// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { contracts } from "@ttctl/core";
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
 * Register the `ttctl_contracts_*` MCP tools (#195). Two read-only tools:
 *
 *   - `ttctl_contracts_list` — list talent-level contracts
 *   - `ttctl_contracts_show` — show one contract by id
 *
 * The `<id>` argument is the `Contract.id` from `ttctl_contracts_list`.
 *
 * **Domain distinction**: this group surfaces talent-level legal
 * documents (Toptal Direct, Master Service Agreement) via
 * `viewer.contracts` on the portal surface. Engagement-attached
 * commercial agreements (rates, hours, period for one project) live
 * on a different surface — use `ttctl_engagements_show <engagement-id>`.
 *
 * **Dry-run path** (issue #165): both tools accept `dryRun?: boolean`.
 * Read-only tools build the preview at the MCP layer via
 * `buildMcpDryRunPreview` — `show` previews the same `GetContracts`
 * operation as `list` (the apply path fetches the list and filters
 * client-side; the dry-run reflects that wire call accurately).
 *
 * **Per CLAUDE.md schema/contract validation rule**: `GetContracts`
 * is hand-authored against the portal surface; every projected field
 * is `Unknown`-typed in the SDL → INFERRED. Live E2E coverage
 * (`packages/e2e/src/35-contracts.e2e.test.ts`) is mandatory pre-merge.
 */
export function registerContractsTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_contracts_list",
    {
      title: "List talent-level contracts",
      description: [
        "List the signed-in user's talent-level legal contracts.",
        "These are top-level documents like Toptal Direct, Master Service Agreement, etc.",
        "(reachable via `viewer.contracts` on the portal surface).",
        "",
        "For engagement-attached commercial agreements (rates, hours, period for a",
        "specific project), use `ttctl_engagements_show <engagement-id>` instead —",
        "those are a different domain on a different transport.",
        "",
        "Returns a list of contracts; each contract carries id, kind, provider,",
        "status, billingType, signedAt, sentAt, isActive, verificationDeadline, title.",
        "",
        "Example user prompts:",
        '  - "What Toptal contracts do I have?"',
        '  - "Show me my Toptal legal documents."',
        '  - "Is my Toptal Direct contract active?"',
      ].join("\n"),
      inputSchema: {
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("GetContracts", "talent-profile", {}, auth.token));
      }
      try {
        const items = await contracts.list(auth.token);
        return successResponse(items);
      } catch (err) {
        return mapContractsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_contracts_show",
    {
      title: "Show one talent-level contract by id",
      description: [
        "Fetch one talent-level contract by id (the row id from `ttctl_contracts_list`).",
        "Returns the full projection: id, kind, provider, status, billingType,",
        "signedAt, sentAt, isActive, verificationDeadline, title.",
        "",
        "The portal API does not expose a per-id contract lookup; this tool fetches",
        "the full contracts list and filters client-side. Latency-conscious callers",
        "querying multiple contracts should use `ttctl_contracts_list` once.",
        "",
        "Example user prompts:",
        '  - "Show me contract ct_abc123."',
        '  - "What is the status of my MSA with Toptal?"',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Contract id (the row id from `ttctl_contracts_list`)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        // The apply path fetches the same `GetContracts` operation as the
        // list tool, then filters client-side. The preview accurately
        // reflects the wire call (no per-id variable on the operation).
        return dryRunResponse(buildMcpDryRunPreview("GetContracts", "talent-profile", {}, auth.token));
      }
      try {
        const item = await contracts.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapContractsError(err);
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

function mapContractsError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof contracts.ContractsError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [`Error: ${err.message}`, "", recoveryForCode(err.code), "", `(Code: ${err.code})`].join("\n"),
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
          `Error: contracts request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}

function recoveryForCode(code: contracts.ContractsErrorCode): string {
  switch (code) {
    case "NOT_FOUND":
      return "Recovery: Verify the contract id (use `ttctl_contracts_list` to discover ids).";
    default:
      return "Recovery: Adjust the tool input or retry; see the code below.";
  }
}
