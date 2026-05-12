// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { timesheet } from "@ttctl/core";
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
 * Placeholder cycle id used in the `timesheet_submit` dry-run preview
 * when the caller omits `id` (auto-resolve at apply time). Apply path
 * resolves the real id via {@link timesheet.resolveCurrentCycle};
 * dry-run skips that prefetch and stamps this sentinel value into the
 * preview's `variables.id` so the wire-shape is honest about the
 * pending resolution.
 */
const SUBMIT_AUTO_RESOLVE_PLACEHOLDER = "<auto-resolved-at-apply-time>";

/**
 * Register the `ttctl_timesheet_*` MCP tools per the #13 spec. Tool
 * names use the `ttctl_` prefix and the canonical CLI path joined
 * with `_`:
 *
 *   - `ttctl_timesheet_list`
 *   - `ttctl_timesheet_show`
 *   - `ttctl_timesheet_submit`
 *
 * Each tool maps 1:1 to a CLI leaf — schemas describe the same set of
 * fields. Identity model:
 *
 *   - `BillingCycle.id`     — the "timesheet id" returned by
 *                              `timesheet_list` and consumed by
 *                              `timesheet_show` / `timesheet_submit`.
 *   - `JobActivityItem.id`  — the "engagement id" exposed by
 *                              `engagements_list`. Passed via
 *                              `engagement` to scope.
 *
 * Submit is destructive — its tool description explicitly warns
 * humans, and per #13 the CLI gates on `--confirm` / TTY interactive
 * confirm. The MCP side has no analogous gate (LLM clients are
 * expected to confirm with the human before invoking write tools)
 * but the description and rationale are surfaced verbatim.
 */
export function registerTimesheetTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_timesheet_list",
    {
      title: "List timesheet billing cycles",
      description: [
        "List the signed-in user's Toptal Talent timesheet billing cycles.",
        "A timesheet is a per-billing-cycle bucket of time entries that the",
        "talent submits for client billing.",
        "",
        "Default scope: viewer-wide pending timesheets (what currently needs",
        "submission). Pass `engagement` (jobActivityItem.id from",
        "`engagements_list`) to scope to one engagement (returns ALL cycles for",
        "that engagement, regardless of submission state).",
        "",
        "Example user prompts:",
        '  - "Show my pending Toptal timesheets."',
        '  - "What timesheets do I need to submit?"',
        '  - "List all timesheets for engagement act_xyz."',
      ].join("\n"),
      inputSchema: {
        engagement: z
          .string()
          .optional()
          .describe(
            "Scope to one engagement (jobActivityItem.id from `engagements_list`). Omit for viewer-wide pending.",
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      const opts: timesheet.ListOptions = {};
      if (args.engagement !== undefined) opts.engagement = args.engagement;
      if (args.dryRun === true) {
        // Apply path picks PendingTimesheets (no engagement) or
        // Timesheets($jobActivityItemId) (engagement scoped); mirror
        // that branch in the preview so callers see the exact wire
        // operation that would fire.
        if (opts.engagement === undefined) {
          return dryRunResponse(buildMcpDryRunPreview("PendingTimesheets", "mobile-gateway", {}, auth.token));
        }
        return dryRunResponse(
          buildMcpDryRunPreview("Timesheets", "mobile-gateway", { jobActivityItemId: opts.engagement }, auth.token),
        );
      }
      try {
        const items = await timesheet.list(auth.token, opts);
        return successResponse(items);
      } catch (err) {
        return mapTimesheetError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_timesheet_show",
    {
      title: "Show one timesheet by id",
      description: [
        "Fetch a single timesheet's full detail by BillingCycle.id (the id",
        "returned by `ttctl_timesheet_list`). Returns the cycle metadata",
        "(week range, hours, submission state), the engagement+job reference,",
        "the rate agreement snapshot, the comment (if any), and the per-day",
        "time entries (`timesheetRecords`).",
        "",
        "Example user prompts:",
        '  - "Show me the details of timesheet bc_abc123."',
        '  - "What did I log for the May 1-15 cycle on engagement act_xyz?"',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Timesheet id (BillingCycle.id from `timesheet_list`)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("TimesheetDetails", "mobile-gateway", { id: args.id }, auth.token));
      }
      try {
        const item = await timesheet.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapTimesheetError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_timesheet_submit",
    {
      title: "Submit a timesheet for billing (DESTRUCTIVE — one-way)",
      description: [
        "Submit a timesheet (BillingCycle.id) for billing. The submission is",
        "one-way at the wire level — once submitted, the timesheet enters",
        "Toptal's billing pipeline and cannot be retracted from this CLI.",
        "",
        "**This is a write operation**. Confirm with the user BEFORE invoking,",
        "including the cycle id, week range, and hours about to be submitted.",
        "",
        "`id` is optional: omitted, the tool resolves the single currently-pending",
        "cycle whose submission window contains 'now'. If zero or multiple",
        "cycles match, the tool returns a structured error so the LLM can",
        "disambiguate before retrying with an explicit id.",
        "",
        "Optional `engagement` (jobActivityItem.id) scopes the auto-resolve to",
        "one engagement — useful when the user has multiple parallel",
        "engagements with overlapping current cycles.",
        "",
        "**`dryRun` caveat**: when `id` is omitted AND `dryRun: true`, the preview",
        "stamps the literal placeholder string `<auto-resolved-at-apply-time>`",
        "into `variables.id` — the apply path's auto-resolve read is SKIPPED on",
        "dry-run (no wire call). Operation name, surface, header redaction, and",
        "variable shape are verbatim; only the cycle-id VALUE is deferred. Do NOT",
        "treat the placeholder as a real BillingCycle id.",
        "",
        "Example user prompts:",
        '  - "Submit my current Toptal timesheet."',
        '  - "Submit timesheet bc_abc123."',
        '  - "Submit my pending timesheet for engagement act_xyz."',
      ].join("\n"),
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe("Timesheet id (BillingCycle.id) to submit. Omit for current-pending auto-resolve."),
        engagement: z
          .string()
          .optional()
          .describe("Scope auto-resolve to one engagement (jobActivityItem.id). Ignored when `id` is supplied."),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        // Apply path optionally pre-fetches PendingTimesheets to auto-resolve
        // the cycle id when none is supplied. Dry-run SKIPS that prefetch
        // (per the same "no wire call" semantics engagements.breaks.add
        // applies for its engagement-id translation) and stamps a placeholder
        // string into the SubmitTimesheet preview's `variables.id`. The
        // wire SHAPE (operationName, surface, variables key names, redacted
        // headers) is verbatim; only the cycle-id VALUE is deferred to apply.
        const variables = { id: args.id ?? SUBMIT_AUTO_RESOLVE_PLACEHOLDER };
        return dryRunResponse(buildMcpDryRunPreview("SubmitTimesheet", "mobile-gateway", variables, auth.token));
      }
      try {
        let cycleId: string;
        if (args.id !== undefined) {
          cycleId = args.id;
        } else {
          const resolveOpts: timesheet.ResolveCurrentCycleOptions = {};
          if (args.engagement !== undefined) resolveOpts.engagement = args.engagement;
          const resolution = await timesheet.resolveCurrentCycle(auth.token, resolveOpts);
          if (resolution.kind === "none") {
            return errorResponse(
              "NO_CURRENT_CYCLE",
              "No billing cycle is currently in its submission window.",
              "Run `ttctl_timesheet_list` to see what's pending, or specify an id explicitly.",
            );
          }
          if (resolution.kind === "multiple") {
            const lines = resolution.candidates.map((c) => {
              const client = c.engagement.job.client?.fullName ?? "(no client)";
              const title = c.engagement.job.title ?? "(untitled)";
              return `  - ${c.id} (${client} — ${title}, ${c.startDate} → ${c.endDate})`;
            });
            return errorResponse(
              "MULTIPLE_CURRENT_CYCLES",
              `${resolution.candidates.length.toString()} cycles match the current submission window — specify one explicitly.`,
              `Candidates:\n${lines.join("\n")}`,
            );
          }
          cycleId = resolution.cycle.id;
        }
        const updated = await timesheet.submit(auth.token, cycleId);
        return successResponse(updated);
      } catch (err) {
        return mapTimesheetError(err);
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

function errorResponse(code: string, message: string, recovery: string): ToolErrorResponse {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [`Error: ${message}`, "", `Recovery: ${recovery}`, "", `(Code: ${code})`].join("\n"),
      },
    ],
  };
}

function mapTimesheetError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof timesheet.TimesheetError) {
    return errorResponse(err.code, err.message, recoveryForCode(err.code));
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(
    "UNKNOWN",
    `timesheet request failed: ${message}`,
    "Retry; if the failure persists, file an issue.",
  );
}

function recoveryForCode(code: timesheet.TimesheetErrorCode): string {
  switch (code) {
    case "NOT_FOUND":
      return "Verify the id (use `ttctl_timesheet_list` to discover billing-cycle ids).";
    case "NO_ENGAGEMENT":
      return "The activity item exists but isn't an engagement — only engagement-bearing rows have timesheets.";
    case "NO_CURRENT_CYCLE":
      return "No cycle is currently in its submission window. Run `ttctl_timesheet_list` to see what's pending.";
    case "MULTIPLE_CURRENT_CYCLES":
      return "Multiple cycles overlap — specify the cycle id explicitly via `id`.";
    case "MUTATION_ERROR":
      return "The server rejected the submission (often: missing required hours, deadline passed, or already submitted). Inspect the message above.";
    default:
      return "Adjust the tool input or retry; see the code below.";
  }
}
