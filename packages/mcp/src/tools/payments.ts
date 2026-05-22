// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { payments } from "@ttctl/core";
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
 * Pagination input fields for `ttctl_payments_payouts_list` (#373).
 * Constraints mirror the CLI's `parsePaginationFlag` (positive integer
 * ≥ 1) and the jobs MCP tools shipped in #369/#376; the wire's
 * per-page upper bound is server-enforced. The service-layer defaults
 * (`page: 1, perPage: 20` via `payments.DEFAULT_PAGE` /
 * `payments.DEFAULT_PER_PAGE`) kick in when either field is omitted, so
 * existing MCP callers see no behavioral change.
 */
const PAGE_FIELD = z.number().int().min(1).optional().describe("1-indexed page number (≥ 1). Default: 1.");

const PER_PAGE_FIELD = z.number().int().min(1).optional().describe("Items per page (≥ 1; server-capped). Default: 20.");

/**
 * Offset-style pagination metadata surfaced alongside `items` /
 * `summary` on `ttctl_payments_payouts_list` (#373). Mirrors the
 * `JobsPageInfo` shape the four `ttctl_jobs_*` read tools surface
 * (#369/#376) and the CLI's `EnvelopePageInfo`, so LLM clients can
 * detect "more pages available" via `hasNextPage` and iterate.
 */
interface PayoutsPageInfo {
  currentPage: number;
  perPage: number;
  totalPages: number;
  hasNextPage: boolean;
}

function buildPayoutsPageInfo(result: payments.PayoutsListResult): PayoutsPageInfo {
  const totalPages = Math.max(1, Math.ceil(result.totalCount / result.perPage));
  return {
    currentPage: result.page,
    perPage: result.perPage,
    totalPages,
    hasNextPage: result.page < totalPages,
  };
}

/**
 * Register the `ttctl_payments_*` MCP tools (#149, #447, #448). 9
 * tools — `summary` at the top level plus 8 across 3 sub-namespaces:
 *
 *   - `ttctl_payments_summary`        (#448, aggregate `GetTalentPaymentSummary`)
 *   - `ttctl_payments_payouts_list`
 *   - `ttctl_payments_payouts_show`
 *   - `ttctl_payments_methods_list`
 *   - `ttctl_payments_methods_show`
 *   - `ttctl_payments_rate_current`  (#447, lightweight `GetTalentRate`)
 *   - `ttctl_payments_rate_show`
 *   - `ttctl_payments_rate_questions`
 *   - `ttctl_payments_rate_change`
 *
 * Each tool maps 1:1 to a CLI leaf. The `<id>` argument is the
 * `TalentPayment.id` for payouts, `PaymentOption.id` for methods.
 *
 * **Scope refinements** (per #149 comment 4441685270, post-investigation):
 *   - Original `rate-change list` (no list endpoint exists) → replaced
 *     with `rate_show` (unified projection) + `rate_questions`
 *     (form discovery).
 *   - Original `rate-change request` (2 of 5 mutation inputs) →
 *     replaced with full `rate_change` (kind, rate, optional
 *     engagement, comment, answers[]).
 *
 * **Dry-run path** (issue #165): every tool accepts `dryRun?: boolean`.
 * Read-only tools build the preview at the MCP layer via
 * `buildMcpDryRunPreview`; `rate_change` passes through to the
 * core's `dryRun` option (mutation supports it natively).
 *
 * **Per CLAUDE.md schema/contract validation rule**: every payment
 * operation is hand-authored (no codegen types) → mandatory live E2E
 * coverage before merge. See `packages/e2e/src/3*-payments-*.e2e.test.ts`.
 */
export function registerPaymentsTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_payments_payouts_list",
    {
      title: "List historical payouts",
      description: [
        "List the signed-in user's historical Toptal payouts.",
        "A payout is a `TalentPayment` record carrying the billing-cycle amount,",
        "status (PAID / DUE / OUTSTANDING / OVERDUE / ON_HOLD / DISPUTED), and",
        "memorandum adjustments.",
        "",
        "Optional `fromDate` / `toDate` (YYYY-MM-DD, inclusive) filter by",
        "`createdOn`.",
        "",
        "Paginated (#373): pass `page` (1-indexed, default 1) and `perPage`",
        "(default 20) to page beyond the first 20 records. The response is",
        "`{ items, summary, pageInfo }` where `pageInfo` carries",
        "`currentPage` / `perPage` / `totalPages` / `hasNextPage` — iterate",
        "by incrementing `page` while `pageInfo.hasNextPage` is true.",
        "",
        "Example user prompts:",
        '  - "Show me my recent Toptal payouts."',
        '  - "List payouts from January 2026."',
        '  - "Show me page 2 of my payouts."',
      ].join("\n"),
      inputSchema: {
        fromDate: z.string().optional().describe("Filter lower bound (YYYY-MM-DD, inclusive)"),
        toDate: z.string().optional().describe("Filter upper bound (YYYY-MM-DD, inclusive)"),
        page: PAGE_FIELD,
        perPage: PER_PAGE_FIELD,
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      const opts: payments.ListPayoutsOptions = {};
      if (args.fromDate !== undefined) opts.fromDate = args.fromDate;
      if (args.toDate !== undefined) opts.toDate = args.toDate;
      if (args.page !== undefined) opts.page = args.page;
      if (args.perPage !== undefined) opts.perPage = args.perPage;
      if (args.dryRun === true) {
        const hasFilter = opts.fromDate !== undefined || opts.toDate !== undefined;
        // Resolve pagination defaults the same way `payments.payouts.list`
        // does so the dry-run preview's wire variables match the apply
        // path EXACTLY (mirrors #369/#376 jobs dry-run behavior).
        const page = opts.page ?? payments.DEFAULT_PAGE;
        const perPage = opts.perPage ?? payments.DEFAULT_PER_PAGE;
        const variables: Record<string, unknown> = {
          filters: hasFilter ? { createdOn: { from: opts.fromDate ?? null, to: opts.toDate ?? null } } : null,
          offset: (page - 1) * perPage,
          limit: perPage,
        };
        return dryRunResponse(buildMcpDryRunPreview("Payments", "mobile-gateway", variables, auth.token));
      }
      try {
        const result = await payments.payouts.list(auth.token, opts);
        // `{ items, summary, pageInfo }` — `summary` preserved from the
        // pre-#373 payload (payouts-specific aggregate); `pageInfo` added
        // so LLM callers can detect `hasNextPage` and iterate. Bare
        // `result.items` consumers keep working (payload addition, not a
        // shape replacement) — same backward-compat contract as #376.
        return successResponse({
          items: result.items,
          summary: result.summary,
          pageInfo: buildPayoutsPageInfo(result),
        });
      } catch (err) {
        return mapPaymentsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_payments_payouts_show",
    {
      title: "Show one payout",
      description: [
        "Fetch one payout's full detail by `TalentPayment.id` (the row id from",
        "`ttctl_payments_payouts_list`).",
        "",
        "Example user prompts:",
        '  - "Show payout pmt_xyz."',
        '  - "What is the amount of my Toptal payout pmt_abc?"',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Payout id (TalentPayment.id from `payments_payouts_list`)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("Payment", "mobile-gateway", { id: args.id }, auth.token));
      }
      try {
        const item = await payments.payouts.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapPaymentsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_payments_summary",
    {
      title: "Show aggregate payment totals",
      description: [
        "Show the talent's aggregate Toptal payment totals — six",
        "server-computed sums spanning the entire payment history:",
        "`totalPaid`, `totalDue`, `totalOutstanding`, `totalOverdue`,",
        "`totalOnHold`, `totalDisputed` (each a decimal string).",
        "",
        "Lightweight at-a-glance financial overview via the single",
        "`GetTalentPaymentSummary` query. Sibling to",
        "`ttctl_payments_payouts_list`, which returns the individual payout",
        "rows (paginated) plus the same aggregate for the queried window —",
        "reach for `summary` when the answer is just the totals.",
        "",
        "Read-only — no side effects.",
        "",
        "Example user prompts:",
        '  - "What are my total Toptal earnings?"',
        '  - "How much is Toptal due to pay me right now?"',
        '  - "Give me a summary of my Toptal payments."',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("GetTalentPaymentSummary", "mobile-gateway", {}, auth.token));
      }
      try {
        const result = await payments.summary(auth.token);
        return successResponse(result);
      } catch (err) {
        return mapPaymentsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_payments_methods_list",
    {
      title: "List configured payment methods",
      description: [
        "List the talent's configured Toptal payment methods (Payoneer / wire /",
        "Toptal Payments / etc.). The preferred method is marked",
        "`preferredOption: true`.",
        "",
        "Read-only — adding / removing / changing preferred method is out of scope",
        "for v1 (the Toptal admin flow lives in the web portal).",
        "",
        "Example user prompts:",
        '  - "What payment methods are configured on my Toptal account?"',
        '  - "Which is my preferred Toptal payment method?"',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("PaymentOptions", "mobile-gateway", {}, auth.token));
      }
      try {
        const items = await payments.methods.list(auth.token);
        return successResponse(items);
      } catch (err) {
        return mapPaymentsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_payments_methods_show",
    {
      title: "Show one payment method",
      description: [
        "Fetch one payment method's detail by id. No per-id wire op exists; the",
        "tool fetches the full list and filters locally.",
        "",
        "Dry-run note: the underlying preview is for `PaymentOptions` (the list",
        "query), since the per-method filter is a client-side operation.",
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("Payment method id (PaymentOption.id from `payments_methods_list`)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("PaymentOptions", "mobile-gateway", {}, auth.token));
      }
      try {
        const item = await payments.methods.show(auth.token, args.id);
        return successResponse(item);
      } catch (err) {
        return mapPaymentsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_payments_rate_current",
    {
      title: "Show current hourly rate (lightweight)",
      description: [
        "Show the talent's current default hourly rate via the single",
        "lightweight `GetTalentRate` query (#447). Returns the",
        'server-formatted verbose display string (e.g. "USD 95.00 hourly")',
        "plus the active `viewerRole.roleId`.",
        "",
        "Sibling to `ttctl_payments_rate_show` (unified projection with",
        "market insight + validation + change history): one query, three",
        "nested fields, no composition. Use this when the answer is just",
        '"what\'s my rate".',
        "",
        "Example user prompts:",
        '  - "What is my current Toptal hourly rate?"',
        '  - "How much do I make per hour?"',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("GetTalentRate", "mobile-gateway", {}, auth.token));
      }
      try {
        const rateCurrent = await payments.rate.current(auth.token);
        return successResponse(rateCurrent);
      } catch (err) {
        return mapPaymentsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_payments_rate_show",
    {
      title: "Show current rate + rate-change status",
      description: [
        "Show the talent's current default hourly rate, market insight",
        "(competitiveness, recommended rate), validation rules (min rate, rate",
        "step), and the most-recent or in-flight rate-change request.",
        "",
        "Unified projection — issues 2 parallel queries (`LastRateChangeRequest`",
        "+ `RateChangeFormDetails`) and composes the result.",
        "",
        "Example user prompts:",
        '  - "What is my current Toptal rate?"',
        '  - "Show me the status of my rate-change request."',
        '  - "What is the minimum hourly rate I can request?"',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        // 2 parallel queries — surface both previews.
        const previews = [
          buildMcpDryRunPreview("LastRateChangeRequest", "mobile-gateway", {}, auth.token),
          buildMcpDryRunPreview("RateChangeFormDetails", "mobile-gateway", {}, auth.token),
        ];
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true, dryRun: true, previews }, null, 2) }],
        };
      }
      try {
        const proj = await payments.rate.show(auth.token);
        return successResponse(proj);
      } catch (err) {
        return mapPaymentsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_payments_rate_questions",
    {
      title: "List rate-change form questions",
      description: [
        "List the form questions the user must answer when submitting a",
        "rate-change request. Discovery sub-command — call this BEFORE",
        "`ttctl_payments_rate_change` to learn the required `answers[]` shape.",
        "",
        "Each question returns `{id, kind: 'RADIO'|'TEXT', label, options[]}`.",
        "`RADIO` kind: pick `value` from `options[].label`. `TEXT` kind: free-text.",
        "An option may set `commentRequired: true` — when chosen, pass an",
        "accompanying answer comment.",
        "",
        "Example user prompts:",
        '  - "What questions do I need to answer for a Toptal rate change?"',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("RateChangeRequestQuestions", "mobile-gateway", {}, auth.token));
      }
      try {
        const items = await payments.rate.questions(auth.token);
        return successResponse(items);
      } catch (err) {
        return mapPaymentsError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_payments_rate_change",
    {
      title: "Submit a rate-change request",
      description: [
        "Submit a rate-change request on the talent's Toptal account.",
        "",
        "Required:",
        "  - `kind`: one of `current-engagement`, `future-engagements`,",
        "    `consultation`.",
        "  - `desiredRate`: target hourly rate as a decimal string (e.g.",
        '    `"95.0"`).',
        "  - `answers`: array of `{questionId, value, comment?}` — fetch the",
        "    catalog via `ttctl_payments_rate_questions` and answer each.",
        "",
        "Conditional:",
        "  - `engagementId`: REQUIRED for `kind: current-engagement`; rejected",
        "    for the other two kinds (those are account-wide).",
        "",
        "Optional:",
        "  - `talentComment`: free-text comment attached to the request.",
        "",
        "**This is a write operation**: it submits a rate-change request to",
        "Toptal's compliance flow. The request enters a PENDING / CLAIMED",
        "lifecycle; the server reviews and may approve, modify, or reject.",
        "Confirm with the user before invoking.",
        "",
        "Example user prompts:",
        '  - "Submit a rate-change request to $95/hr on engagement act_xyz."',
        '  - "Raise my default Toptal rate to $100/hr."',
      ].join("\n"),
      inputSchema: {
        kind: z
          .enum([...payments.RATE_CHANGE_KINDS])
          .describe("Rate-change kind: current-engagement / future-engagements / consultation"),
        desiredRate: z.string().describe('Target hourly rate as a decimal string (e.g. "95.0")'),
        engagementId: z
          .string()
          .optional()
          .describe("Engagement id (required for kind=current-engagement; rejected otherwise)"),
        talentComment: z.string().optional().describe("Optional free-text comment attached to the request"),
        answers: z
          .array(
            z.object({
              questionId: z.string(),
              value: z.string(),
              comment: z.string().optional(),
            }),
          )
          .describe(
            "Answers to the form questions returned by `ttctl_payments_rate_questions`. Each entry: {questionId, value, comment?}.",
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const opts: payments.RateChangeOptions = {
          kind: args.kind,
          desiredRate: args.desiredRate,
          answers: args.answers.map((a) => {
            const entry: payments.RateChangeAnswerInput = { questionId: a.questionId, value: a.value };
            if (a.comment !== undefined) entry.comment = a.comment;
            return entry;
          }),
        };
        if (args.engagementId !== undefined) opts.engagementId = args.engagementId;
        if (args.talentComment !== undefined) opts.talentComment = args.talentComment;
        const outcome = await payments.rate.change(auth.token, opts, { dryRun: args.dryRun ?? false });
        if (outcome.kind === "preview") return dryRunResponse(outcome.preview);
        return successResponse({
          result: outcome.result,
          notice: outcome.notice,
        });
      } catch (err) {
        return mapPaymentsError(err);
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

function mapPaymentsError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof payments.PaymentsError) {
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
          `Error: payments request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}

function recoveryForCode(code: payments.PaymentsErrorCode): string {
  switch (code) {
    case "NOT_FOUND":
      return "Recovery: Verify the id (use `ttctl_payments_payouts_list` or `ttctl_payments_methods_list` to discover ids).";
    case "MISSING_INPUT":
      return "Recovery: Adjust the input per the description and re-run.";
    case "MUTATION_ERROR":
      return "Recovery: The mutation was rejected by the server (often: rate below minRate, missing answers, ineligibility). Check the message above; try `ttctl_payments_rate_questions` for the form catalog.";
    default:
      return "Recovery: Adjust the tool input or retry; see the code below.";
  }
}
