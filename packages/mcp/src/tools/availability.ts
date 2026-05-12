// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { availability } from "@ttctl/core";
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
 * Register the `ttctl_availability_*` MCP tools per the #146 amended
 * spec. Tool names use the `ttctl_` prefix and the canonical CLI path
 * joined with `_`:
 *
 *   - `ttctl_availability_show`
 *   - `ttctl_availability_working_hours_show`
 *   - `ttctl_availability_working_hours_set`
 *   - `ttctl_availability_allocated_hours_show`
 *   - `ttctl_availability_allocated_hours_set`
 *
 * Each tool maps 1:1 to a CLI leaf — the schemas describe the same set
 * of fields.
 *
 * **Vocabulary note** (parallel to the CLI surface): per-engagement
 * "time off" is exposed via `ttctl_engagements_breaks_*` — there is no
 * `ttctl_availability_time_off_*` surface (the underlying API is
 * engagement-scoped and would only duplicate the engagements tools).
 * "Lead time" / "minimum scheduling notice" is for booking pages
 * (consultations), a separate surface not exposed in v1.
 *
 * Dry-run path (issue #165): every tool accepts `dryRun?: boolean`.
 * Read tools build the `GetAvailability` preview at the MCP layer
 * (same query underlies show + the two `*_show` filters, which apply
 * client-side narrowing). The two `*_set` tools passthrough-forward
 * `{ dryRun: true }` to the core (#164 already wired it through) and
 * reformat the `{ kind: "preview", preview }` outcome as the uniform
 * envelope.
 */
export function registerAvailabilityTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_availability_show",
    {
      title: "Show availability snapshot",
      description: [
        "Show the signed-in user's full availability snapshot — time zone,",
        "daily working-hours window, flexible shift range, and viewer-scoped",
        "allocated hours per week.",
        "",
        "Per-engagement time off (= engagement breaks) is NOT included; use",
        "`ttctl_engagements_breaks_list` for that.",
        "",
        "Example user prompts:",
        '  - "What is my current Toptal availability?"',
        '  - "Show me my working hours and time zone."',
        '  - "How many hours have I allocated for Toptal engagements?"',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("GetAvailability", "mobile-gateway", {}, auth.token));
      }
      try {
        const snap = await availability.show(auth.token);
        return successResponse(snap);
      } catch (err) {
        return mapAvailabilityError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_availability_working_hours_show",
    {
      title: "Show working-hours subset",
      description: [
        "Show just the working-hours subset of availability — time zone +",
        "daily window (workingTimeFrom/To) + flexible shift range",
        "(availableShiftRangeFrom/To). Drops the allocatedHours field.",
        "",
        "Example user prompts:",
        '  - "What are my Toptal working hours?"',
        '  - "Show me my time-zone configuration."',
        "",
        "Dry-run note: the apply path issues `GetAvailability` (same query as `availability_show`) and narrows the result client-side — the preview reflects the wire call accordingly.",
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("GetAvailability", "mobile-gateway", {}, auth.token));
      }
      try {
        const data = await availability.workingHours.show(auth.token);
        return successResponse(data);
      } catch (err) {
        return mapAvailabilityError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_availability_working_hours_set",
    {
      title: "Update working hours",
      description: [
        "Update working hours: any subset of (time zone, daily window,",
        "flexible shift range) via the UpdateWorkingHours mutation.",
        "",
        "All time fields are `HH:MM:SS` strings (e.g., `09:00:00`).",
        "`timeZone` is an IANA zone identifier (e.g., `Europe/Berlin`).",
        "",
        "At least one field MUST be provided — empty change sets are",
        "rejected pre-flight.",
        "",
        "**This is a write operation**: it modifies the user's availability",
        "settings on the live Toptal Talent platform. Confirm with the user",
        "before invoking.",
        "",
        "Example user prompts:",
        '  - "Set my Toptal working hours to 9 AM through 5 PM."',
        '  - "Change my time zone to Europe/Berlin."',
        '  - "Update my flexible shift range to 7 AM - 7 PM."',
      ].join("\n"),
      inputSchema: {
        timeZone: z
          .string()
          .optional()
          .describe("IANA time-zone identifier (e.g., `Europe/Berlin`, `America/New_York`)"),
        workingTimeFrom: z
          .string()
          .optional()
          .describe("Daily working-hours window start, `HH:MM:SS` (e.g., `09:00:00`)"),
        workingTimeTo: z.string().optional().describe("Daily working-hours window end, `HH:MM:SS` (e.g., `17:00:00`)"),
        availableShiftRangeFrom: z.string().optional().describe("Flexible shift-range start, `HH:MM:SS`"),
        availableShiftRangeTo: z.string().optional().describe("Flexible shift-range end, `HH:MM:SS`"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const input: availability.UpdateWorkingHoursInput = {};
        if (args.timeZone !== undefined) input.timeZone = args.timeZone;
        if (args.workingTimeFrom !== undefined) input.workingTimeFrom = args.workingTimeFrom;
        if (args.workingTimeTo !== undefined) input.workingTimeTo = args.workingTimeTo;
        if (args.availableShiftRangeFrom !== undefined) input.availableShiftRangeFrom = args.availableShiftRangeFrom;
        if (args.availableShiftRangeTo !== undefined) input.availableShiftRangeTo = args.availableShiftRangeTo;
        const outcome = await availability.workingHours.set(auth.token, input, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapAvailabilityError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_availability_allocated_hours_show",
    {
      title: "Show allocated hours",
      description: [
        "Show the signed-in user's viewer-scoped allocated hours per week.",
        "",
        "Example user prompts:",
        '  - "How many hours have I allocated for Toptal work?"',
        '  - "Show my Toptal availability in hours per week."',
        "",
        "Dry-run note: the apply path issues `GetAvailability` and narrows the result client-side — the preview reflects the wire call accordingly.",
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("GetAvailability", "mobile-gateway", {}, auth.token));
      }
      try {
        const data = await availability.allocatedHours.show(auth.token);
        return successResponse(data);
      } catch (err) {
        return mapAvailabilityError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_availability_allocated_hours_set",
    {
      title: "Set allocated hours",
      description: [
        "Set the viewer-scoped allocated hours per week (non-negative",
        "integer; the portal UI caps at 80 and the server validator",
        "enforces the same range).",
        "",
        "This is a VIEWER-scoped value — it applies across all of the",
        "viewer's active engagements, NOT per-engagement.",
        "",
        "**This is a write operation**: it modifies the user's availability",
        "settings on the live Toptal Talent platform. Confirm with the user",
        "before invoking.",
        "",
        "Example user prompts:",
        '  - "Set my allocated Toptal hours to 40 per week."',
        '  - "Update my Toptal allocated hours to 20."',
      ].join("\n"),
      inputSchema: {
        hours: z.number().int().nonnegative().describe("Non-negative integer hours per week (portal UI caps at 80)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const outcome = await availability.allocatedHours.set(auth.token, args.hours, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse(outcome.result);
      } catch (err) {
        return mapAvailabilityError(err);
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

function mapAvailabilityError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof availability.AvailabilityError) {
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
          `Error: availability request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}

function recoveryForCode(code: availability.AvailabilityErrorCode): string {
  switch (code) {
    case "NO_VIEWER_ROLE":
      return "Recovery: Sign in as a Toptal Talent (the availability surface is talent-side).";
    case "MUTATION_ERROR":
      return "Recovery: The mutation was rejected by the server (often: malformed time string, unknown time-zone identifier, or out-of-range allocated hours). Check the message above and adjust the input.";
    default:
      return "Recovery: Adjust the tool input or retry; see the code below.";
  }
}
