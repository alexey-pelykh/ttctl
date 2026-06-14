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
 * Register the `ttctl_timesheet_*` MCP tools per the #13 spec, plus
 * the #374 pending-list pagination sibling. Tool names use the
 * `ttctl_` prefix and the canonical CLI path joined with `_`:
 *
 *   - `ttctl_timesheet_list`
 *   - `ttctl_timesheet_pending_list`   (#374)
 *   - `ttctl_timesheet_show`
 *   - `ttctl_timesheet_submit`
 *   - `ttctl_timesheet_update`         (#458)
 *
 * Each tool maps 1:1 to a CLI leaf — schemas describe the same set of
 * fields. Identity model:
 *
 *   - `BillingCycle.id`     — the "timesheet id" returned by
 *                              `timesheet_list` / `timesheet_pending_list`
 *                              and consumed by `timesheet_show` /
 *                              `timesheet_submit`.
 *   - `JobActivityItem.id`  — the "engagement id" exposed by
 *                              `engagements_list`. Passed via
 *                              `engagement` to scope.
 *
 * **`timesheet_pending_list` pagination divergence** (#374, per
 * ADR-007 row 3): the viewer-wide `PendingTimesheets` wire op
 * accepts ONLY a `pagination: { limit: Int }` input — no `offset`,
 * no cursor — so this tool exposes `limit` rather than the
 * offset-style `page` / `perPage` used by jobs / applications /
 * engagements / payouts. Surface-honest: MCP keys mirror wire arg
 * keys.
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
        "For viewer-wide pagination, prefer `ttctl_timesheet_pending_list`",
        "(#374) — it exposes the wire's `limit` input surface-honestly. This",
        "tool keeps its pre-#374 shape (no pagination args) for backward",
        "compatibility.",
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
          // #374: PendingTimesheets is now parameterised with $limit;
          // the dry-run preview surfaces the DEFAULT value the apply
          // path will pass when the caller omits `limit` (which this
          // pre-#374 tool always does — only the new
          // `ttctl_timesheet_pending_list` exposes `limit`).
          return dryRunResponse(
            buildMcpDryRunPreview(
              "PendingTimesheets",
              "mobile-gateway",
              { limit: timesheet.DEFAULT_PENDING_LIMIT },
              auth.token,
            ),
          );
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

  // `ttctl_timesheet_pending_list` (#374) — surface-honest viewer-wide
  // pending pagination. Schema mirrors the wire arg name exactly:
  // `{ limit? }` maps directly to `pagination: { limit: $limit }` on
  // `Viewer.billingCycles`. See ADR-007 row 3 ("limit-only wrapper").
  server.registerTool(
    "ttctl_timesheet_pending_list",
    {
      title: "List viewer-wide pending timesheets (limit-only pagination)",
      description: [
        "List the signed-in user's Toptal Talent viewer-wide pending billing",
        "cycles — the timesheets that currently need submission. Use this",
        "tool when the user wants to enumerate or paginate over their pending",
        "timesheets and `ttctl_timesheet_list` (no pagination args) returns",
        "a too-narrow window.",
        "",
        "**Pagination divergence** (#374, per ADR-007): unlike",
        "`ttctl_jobs_list` / `ttctl_applications_list` / `ttctl_engagements_list`",
        "/ `ttctl_payments_payouts_list` (offset-style with `page` /",
        "`perPage`), this tool exposes ONLY `limit` because the underlying",
        "wire field is `LimitPagination` (no `offset`, no cursor). MCP keys",
        "mirror wire arg names verbatim. Default `limit` when omitted is 50",
        "(the historical wire default).",
        "",
        "For the per-engagement variant (all cycles for one engagement,",
        "regardless of submission state) use `ttctl_timesheet_list` with",
        "the `engagement` arg — that wire op carries no pagination input.",
        "",
        "Example user prompts:",
        '  - "Show me 5 of my pending Toptal timesheets."',
        '  - "List my pending timesheets, limit 10."',
        '  - "What are the next few timesheets I need to submit?"',
      ].join("\n"),
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum number of pending cycles to return. Maps to `pagination: { limit: $limit }` on the wire. Default 50 when omitted.",
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      const opts: timesheet.ListOptions = {};
      if (args.limit !== undefined) opts.limit = args.limit;
      if (args.dryRun === true) {
        // Surface the actual wire variable (`limit`) the apply path
        // will send. When the caller omits `limit`, the apply path
        // defaults to {@link timesheet.DEFAULT_PENDING_LIMIT}; the
        // preview surfaces the same default so the dry-run reflects
        // the exact request shape.
        const limit = args.limit ?? timesheet.DEFAULT_PENDING_LIMIT;
        return dryRunResponse(buildMcpDryRunPreview("PendingTimesheets", "mobile-gateway", { limit }, auth.token));
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

  server.registerTool(
    "ttctl_timesheet_update",
    {
      title: "Edit a draft timesheet's comment / per-day records (WRITE)",
      description: [
        "Edit a draft timesheet (BillingCycle.id) — its comment and/or per-day",
        "time records. Use after the user wants to correct logged hours or fix",
        "a timesheet comment before submitting.",
        "",
        "**This is a write operation.** Confirm the change with the user first.",
        "",
        "**Full-replacement contract**: the wire op replaces the ENTIRE record",
        "set and comment, so this tool does read-modify-write — it fetches the",
        "current timesheet, merges your `records` overrides by date into the",
        "complete set, and resends everything. Days you don't mention are",
        "preserved, NOT cleared. Each `records` entry: `date` (YYYY-MM-DD),",
        "optional `duration` (MINUTES as a decimal string, wire-native — `'480'`",
        "= 8h; omit to keep the day's existing value), optional `note` (omit to",
        "keep, `''`/`null` to clear).",
        "",
        "**Consent**: `timesheetBillingConsentIssued: true` is mandatory — editing",
        "billing data on the user's behalf is gated (ADR-009 timesheet-billing).",
        "Without it the call is refused with `CONSENT_REQUIRED` before any wire",
        "call.",
        "",
        "Targets a draft (unsubmitted) cycle; the server may reject editing a",
        "submitted one.",
        "",
        "Example user prompts:",
        "  - \"Fix the comment on timesheet bc_abc123 to 'reviewed with client'.\"",
        '  - "Set 2026-06-01 to 8 hours on my current timesheet."',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Timesheet id (BillingCycle.id from `ttctl_timesheet_list`)"),
        comment: z.string().optional().describe("Set the timesheet comment (replaces the existing comment)."),
        records: z
          .array(
            z.object({
              date: z.string().describe("Day to override (YYYY-MM-DD)."),
              duration: z
                .string()
                .optional()
                .describe("Duration in MINUTES as a decimal string (wire-native; '480' = 8h). Omit to keep existing."),
              note: z.string().nullable().optional().describe("Per-day note. Omit to keep; '' or null to clear."),
            }),
          )
          .optional()
          .describe(
            "Per-day overrides, merged by date into the full record set (read-modify-write — unspecified days preserved).",
          ),
        timesheetBillingConsentIssued: z
          .boolean()
          .optional()
          .describe(
            "MUST be true. ADR-009 timesheet-billing consent — the call is refused unless this is true (or the server env sets TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1).",
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        // Mirror the apply path's read-modify-write: dry-run shows only the
        // caller's explicit overrides and issues no wire call (no read). The
        // full merge is described in the tool's `description`.
        const variables = {
          id: args.id,
          comment: args.comment ?? null,
          timesheetRecords: (args.records ?? []).map((r) => ({
            date: r.date,
            duration: r.duration ?? null,
            note: r.note ?? null,
          })),
        };
        return dryRunResponse(buildMcpDryRunPreview("UpdateTimesheet", "mobile-gateway", variables, auth.token));
      }
      try {
        const input: timesheet.UpdateTimesheetInput = {};
        if (args.comment !== undefined) input.comment = args.comment;
        if (args.records !== undefined) {
          input.records = args.records.map((r) => {
            const rec: timesheet.TimesheetRecordInput = { date: r.date };
            if (r.duration !== undefined) rec.duration = r.duration;
            if (r.note !== undefined) rec.note = r.note;
            return rec;
          });
        }
        if (args.timesheetBillingConsentIssued !== undefined) {
          input.timesheetBillingConsentIssued = args.timesheetBillingConsentIssued;
        }
        const outcome = await timesheet.update(auth.token, args.id, input);
        return successResponse(outcome.kind === "applied" ? outcome.result : outcome);
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
      return "The server rejected the mutation (often: missing required hours, deadline passed, or already submitted). Inspect the message above.";
    case "VALIDATION_ERROR":
      return "Supply at least one change — `comment`, or a `records` entry with `duration`/`note`.";
    default:
      return "Adjust the tool input or retry; see the code below.";
  }
}
