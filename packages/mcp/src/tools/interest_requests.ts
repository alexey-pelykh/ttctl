// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { applications } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import type { ToolErrorResponse } from "../errors.js";
import { buildMcpDryRunPreview, dryRunResponse, jsonResponse, type ToolRegistrationContext } from "./_shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Recognized duration suffixes for the `olderThan` staleness filter. The
 * input is parsed client-side — the wire has no server-side staleness
 * argument on the underlying `JobActivityItems` operation, so the tool
 * fetches the full pending list and filters by computed days-pending.
 *
 * - `d` — days  (e.g. `7d`, `14d`)
 * - `w` — weeks (e.g. `2w`)
 * - `h` — hours (e.g. `48h`)
 *
 * Bare integer is interpreted as days (e.g. `14` ⇒ `14d`).
 */
const OLDER_THAN_PATTERN = /^(\d+)\s*(d|w|h)?$/i;

const HOURS_PER_UNIT: Record<string, number> = {
  h: 1,
  d: 24,
  w: 24 * 7,
};

function parseOlderThanHours(input: string): number | null {
  const match = OLDER_THAN_PATTERN.exec(input.trim());
  if (match === null) return null;
  const quantityStr = match[1];
  if (quantityStr === undefined) return null;
  const quantity = Number.parseInt(quantityStr, 10);
  if (!Number.isFinite(quantity) || quantity < 0) return null;
  const unit = (match[2] ?? "d").toLowerCase();
  const perUnit = HOURS_PER_UNIT[unit];
  if (perUnit === undefined) return null;
  return quantity * perUnit;
}

/**
 * Project an activity-item row into the trim "Interest Request" shape the
 * tool surfaces. Computes `daysPending` from `lastUpdatedAt`; rounds down
 * to integer days. Returns the same `id` so callers can drill into
 * `ttctl_applications_show` for the full detail view.
 *
 * **`fixedRate` (#410)**: surfaces the recruiter-pinned Fixed rate the
 * Toptal portal renders next to the IR. Lifted from the row's
 * `availabilityRequest.metadata.offeredHourlyRate` via the core
 * `applications.list()` projection. `null` when the AR carries no
 * Fixed-rate offer (defensive — every recruiter-initiated IR observed
 * in the wild has carried one).
 *
 * @internal Exported for unit tests.
 */
export interface InterestRequestRow {
  /** Activity-item id; pass to `ttctl_applications_show` for detail. */
  id: string;
  /**
   * **AvailabilityRequest id** (#411). The handle the write-side IR
   * mutations (`ttctl_interest_requests_accept` /
   * `ttctl_interest_requests_reject`) require. Distinct from `id`
   * above, which is the activity-item id used by `_show`. `null` when
   * the activity row carries no AR (theoretically possible if a row
   * is classified into `ON_RECRUITER_REVIEW` without an underlying AR,
   * though every observed IR in the wild has carried one).
   */
  availabilityRequestId: string | null;
  /** Server-rendered status label (e.g. "Job Interest Request"). */
  statusVerbose: string;
  /** Underlying job title (may be null if the wire elided it). */
  jobTitle: string | null;
  /** Client company name (may be null). */
  clientName: string | null;
  /** Toptal portal URL for the job (may be null). */
  jobUrl: string | null;
  /** ISO timestamp of the last server-side activity update. */
  lastUpdatedAt: string;
  /** Whole days between `lastUpdatedAt` and `now`; null if unparseable. */
  daysPending: number | null;
  /**
   * Recruiter-pinned Fixed rate (#410), in the standard Money shape.
   * `null` when no Fixed-rate offer is present on the row. Use
   * `fixedRate.decimal` for numeric comparison, `fixedRate.verbose` for
   * pretty rendering (server-formatted, e.g. `"$77.00/hr"`).
   */
  fixedRate: applications.FixedRate | null;
}

/**
 * @internal Exported for unit tests.
 */
export function projectRow(
  row: {
    id: string;
    lastUpdatedAt: string;
    statusV2: { verbose: string };
    job: { title: string | null; url: string | null; client: { fullName: string | null } | null };
    availabilityRequest: { id: string } | null;
    fixedRate: applications.FixedRate | null;
  },
  now: number,
): InterestRequestRow {
  const updatedAtMs = Date.parse(row.lastUpdatedAt);
  const daysPending = Number.isFinite(updatedAtMs)
    ? Math.max(0, Math.floor((now - updatedAtMs) / (24 * 60 * 60 * 1000)))
    : null;
  return {
    id: row.id,
    availabilityRequestId: row.availabilityRequest?.id ?? null,
    statusVerbose: row.statusV2.verbose,
    jobTitle: row.job.title,
    clientName: row.job.client?.fullName ?? null,
    jobUrl: row.job.url,
    lastUpdatedAt: row.lastUpdatedAt,
    daysPending,
    fixedRate: row.fixedRate,
  };
}

/**
 * Register `ttctl_interest_requests_list` (#371) — a dedicated MCP affordance
 * for the UI-level "Interest Request" concept (recruiter-initiated
 * availability checks on the Toptal portal). LLM agents asking
 * "show me my interest requests" can resolve directly to this tool
 * without having to know the canonical API status-group spelling.
 *
 * The tool wraps `applications.list(token, { statusGroups: ["ON_RECRUITER_REVIEW"] })`
 * and projects each row into a trimmed triage shape: title, client,
 * lastUpdatedAt, computed daysPending, jobUrl, statusVerbose. The optional
 * `olderThan` filter narrows the result client-side by days-pending — the
 * wire has no server-side staleness argument on the underlying
 * `JobActivityItems` operation, so the filter is applied after the fetch
 * (acceptable because `ON_RECRUITER_REVIEW` is a small per-user cohort).
 *
 * **Why dedicated over a description hint** (issue #371 § Proposed Solution):
 * The tool name is the LLM discovery surface; `ttctl_applications_list`
 * does not lexically include "interest requests" and the
 * `ON_RECRUITER_REVIEW` enum value does not either. A dedicated tool
 * resolves the discovery gap directly. Terminology-mapping hints on
 * `ttctl_applications_list` are tracked separately in sibling issue #370.
 *
 * **No new wire op**: this tool calls the existing
 * `applications.list` core function, which calls the existing
 * `JobActivityItems` operation. Per the schema/contract rule, no new
 * E2E is required — the operation is already covered by
 * `15-applications-list.e2e.test.ts`.
 *
 * Dry-run path (issue #165): emits the singular `{ preview }` envelope
 * carrying the same `JobActivityItems` variables the apply path would
 * send (`onlyStatusGroupFilter: ["ON_RECRUITER_REVIEW"]`).
 */
export function registerInterestRequestsTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_interest_requests_list",
    {
      title: "List pending Interest Requests",
      description: [
        "List the signed-in user's pending Toptal Interest Requests —",
        'the UI label for recruiter-initiated availability checks ("respond" / "decline" decision flow).',
        "",
        "On the wire these are activity-list rows in the `ON_RECRUITER_REVIEW` status group;",
        "this tool wraps `ttctl_applications_list --statusGroups ON_RECRUITER_REVIEW` and",
        "projects each row into a trimmed triage shape: id, statusVerbose, jobTitle, clientName,",
        "jobUrl, lastUpdatedAt, daysPending.",
        "",
        "Optional filter:",
        "  - `olderThan`: staleness threshold. Accepts `<N>d` (days), `<N>w` (weeks),",
        "    `<N>h` (hours), or a bare integer (interpreted as days). Examples: `14d`, `2w`, `48h`, `14`.",
        "    Rows with `daysPending` >= the parsed threshold are returned; useful for surfacing",
        "    requests at expiry-risk (Toptal Interest Requests auto-expire on the recruiter side).",
        "",
        "Returns the raw array of rows; pair with `ttctl_applications_show <id>` for full detail.",
        "",
        "Example user prompts:",
        '  - "Show me my pending Toptal Interest Requests."',
        '  - "Which Interest Requests are older than two weeks?" (uses `olderThan: 2w`)',
        '  - "Any new Interest Requests today?" (no filter; sort by daysPending ascending in the client)',
      ].join("\n"),
      inputSchema: {
        olderThan: z
          .string()
          .optional()
          .describe(
            "Staleness threshold expressed as `<N>d` (days), `<N>w` (weeks), `<N>h` (hours), or bare integer days. Returns rows with daysPending >= the parsed threshold.",
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;

      let olderThanHours: number | null = null;
      if (args.olderThan !== undefined) {
        olderThanHours = parseOlderThanHours(args.olderThan);
        if (olderThanHours === null) {
          return invalidOlderThanResponse(args.olderThan);
        }
      }

      if (args.dryRun === true) {
        // Dry-run mirrors the apply path's wire call: a single
        // JobActivityItems request restricted to ON_RECRUITER_REVIEW.
        // The client-side `olderThan` filter is NOT part of the wire
        // payload — it's applied after the fetch — so the preview's
        // `variables` block stays faithful to what the gateway sees.
        return dryRunResponse(
          buildMcpDryRunPreview(
            "JobActivityItems",
            "mobile-gateway",
            { onlyStatusGroupFilter: ["ON_RECRUITER_REVIEW"] },
            auth.token,
          ),
        );
      }

      try {
        // #377: applications.list now returns a JobActivityListPage
        // envelope. This tool is a filtered convenience surface (it
        // does not paginate at the MCP layer — see #372 / R1 framing);
        // unwrap `.items` and keep the existing client-side projection.
        const { items: rows } = await applications.list(auth.token, { statusGroups: ["ON_RECRUITER_REVIEW"] });
        const now = Date.now();
        const projected = rows.map((row) => projectRow(row, now));
        const filtered =
          olderThanHours === null
            ? projected
            : projected.filter((row) => row.daysPending !== null && row.daysPending * 24 >= olderThanHours);
        return jsonResponse(filtered);
      } catch (err) {
        return mapInterestRequestsError(err);
      }
    },
  );

  // #411 — IR write surface. Three tools mirroring the talent-side
  // ergonomic spec of #411: accept (→ confirm wire mutation), reject
  // (→ reject wire mutation), reject-reasons (→ platform-config
  // inventory). All three accept the **AvailabilityRequest id** as the
  // handle (NOT the activity-item id); chain from
  // `ttctl_interest_requests_list` rows via `availabilityRequestId`.
  registerInterestRequestsAcceptTool(server, ctx);
  registerInterestRequestsRejectTool(server, ctx);
  registerInterestRequestsRejectReasonsTool(server, ctx);
}

function registerInterestRequestsAcceptTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_interest_requests_accept",
    {
      title: "Accept an Interest Request",
      description: [
        "Accept (confirm) a Toptal Interest Request — the wire mutation",
        "`ConfirmAvailabilityRequest` (mobile-gateway). Mirror of the",
        '"View Job Interest Request → Respond" button on the Toptal portal.',
        "",
        "**DESTRUCTIVE** — accepting an IR transitions the AvailabilityRequest",
        "from PENDING to CONFIRMED, creating a `JobApplication` for the underlying",
        "job. There is no withdraw operation on the wire. Always preview with",
        "`dryRun: true` first if uncertain.",
        "",
        "**Input id**: the `availabilityRequestId` from `ttctl_interest_requests_list`",
        "rows (NOT the `id` field, which is the activity-item id used by `_show`).",
        "Both ids are surfaced on the list output; pick `availabilityRequestId`.",
        "",
        "**Fields**:",
        "  - `id` (required): AvailabilityRequest id.",
        "  - `message` (optional): talent free-text accompanying the response.",
        "    Maps to the wire's `talentComment` field. Renders next to the",
        '    "Respond" button in the recruiter\'s portal view.',
        "  - `rate` (optional): requested hourly rate, decimal string (e.g.",
        '    `"80.00"`). Auto-filled from the AR\'s recruiter-pinned Fixed rate',
        "    when omitted. REQUIRED for FLEXIBLE / MARKETPLACE_FLEXIBLE ARs",
        "    (no recruiter-pinned rate to default to).",
        "  - `kind` (optional): AR kind (FIXED / FLEXIBLE / MARKETPLACE_FLEXIBLE).",
        "    Auto-detected from the AR's metadata `__typename` when omitted.",
        "",
        "Example user prompts:",
        '  - "Accept Interest Request <id>." (uses recruiter-pinned rate by default)',
        '  - "Accept IR <id> with the message \\"Available starting next Monday\\"."',
        '  - "Accept Interest Request <id> at $90/hr." (override the Fixed rate)',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("AvailabilityRequest id (NOT the activity-item id)"),
        message: z.string().optional().describe("Optional talent free-text. Wire field: talentComment."),
        rate: z
          .string()
          .optional()
          .describe(
            "Optional decimal hourly rate (e.g. '80.00'). Auto-filled from the AR's Fixed rate when omitted; required for FLEXIBLE / MARKETPLACE_FLEXIBLE ARs.",
          ),
        kind: z
          .enum([...applications.AVAILABILITY_REQUEST_KINDS])
          .optional()
          .describe("AR kind (auto-detected from metadata when omitted)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;

      const input: applications.ConfirmInput = {};
      if (args.message !== undefined) input.comment = args.message;
      if (args.rate !== undefined) input.requestedHourlyRate = args.rate;
      if (args.kind !== undefined) input.kind = args.kind;

      try {
        const outcome = await applications.confirm(auth.token, args.id, input, {
          dryRun: args.dryRun === true,
        });
        if (outcome.kind === "preview") {
          return dryRunResponse(outcome.preview);
        }
        return jsonResponse(outcome.result);
      } catch (err) {
        return mapInterestRequestsError(err);
      }
    },
  );
}

function registerInterestRequestsRejectTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_interest_requests_reject",
    {
      title: "Reject an Interest Request",
      description: [
        "Reject (decline) a Toptal Interest Request — the wire mutation",
        "`RejectAvailabilityRequest` (mobile-gateway). Mirror of the",
        '"View Job Interest Request → Decline" form on the Toptal portal.',
        "",
        "**DESTRUCTIVE** — rejecting an IR transitions the AvailabilityRequest",
        "to REJECTED (terminal, archived). No undo. Always preview with",
        "`dryRun: true` first if uncertain.",
        "",
        "**Input id**: the `availabilityRequestId` from `ttctl_interest_requests_list`",
        "rows (NOT the `id` field, which is the activity-item id used by `_show`).",
        "",
        "**Fields**:",
        "  - `id` (required): AvailabilityRequest id.",
        "  - `reason` (required): one of the `key` values from",
        "    `ttctl_interest_requests_reject_reasons`. The wire rejects unknown",
        "    keys with a top-level GraphQL error.",
        "  - `comment` (optional): accompanying free-text. Required when the",
        "    chosen reason has `isMandatory: true` on the inventory.",
        "",
        "Example user prompts:",
        '  - "Decline Interest Request <id> with reason rate_too_low."',
        '  - "Reject IR <id> as scope_mismatch, note: \\"Not aligned with my Python expertise.\\""',
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("AvailabilityRequest id (NOT the activity-item id)"),
        reason: z
          .string()
          .describe("Decline reason key (see ttctl_interest_requests_reject_reasons for the inventory)"),
        comment: z.string().optional().describe("Optional accompanying free-text (required for mandatory reasons)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;

      const input: applications.RejectInput = { reason: args.reason };
      if (args.comment !== undefined) input.comment = args.comment;

      try {
        const outcome = await applications.reject(auth.token, args.id, input, {
          dryRun: args.dryRun === true,
        });
        if (outcome.kind === "preview") {
          return dryRunResponse(outcome.preview);
        }
        return jsonResponse(outcome.result);
      } catch (err) {
        return mapInterestRequestsError(err);
      }
    },
  );
}

function registerInterestRequestsRejectReasonsTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_interest_requests_reject_reasons",
    {
      title: "List Interest Request decline-reason inventory",
      description: [
        "List the Interest Request decline-reason inventory — the `key` /",
        "`value` / `isMandatory` rows the portal's Decline form uses. Pass one",
        "of the surfaced `key` values to `ttctl_interest_requests_reject`.",
        "",
        "Returns `{ fixed: [...], flexible: [...] }` — the portal renders only",
        "the slice matching the AR's `kind`, so clients should likewise pick",
        "the slice that matches the AR being declined.",
        "",
        "Read-only, idempotent. Server-localised (the `value` text matches the",
        "session's locale).",
        "",
        "Example user prompts:",
        '  - "What reasons can I decline Interest Requests with?"',
        '  - "Show me the reject-reason inventory for Fixed-kind IRs."',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;

      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("AvailabilityRequestRejectReasons", "mobile-gateway", {}, auth.token),
        );
      }

      try {
        const reasons = await applications.rejectReasons(auth.token);
        return jsonResponse(reasons);
      } catch (err) {
        return mapInterestRequestsError(err);
      }
    },
  );
}

function invalidOlderThanResponse(supplied: string): ToolErrorResponse {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          `Error: ttctl_interest_requests_list failed (VALIDATION): \`olderThan\` value "${supplied}" is not a recognized duration.`,
          "",
          "Recovery: Use `<N>d` (days), `<N>w` (weeks), `<N>h` (hours), or a bare integer (days). Examples: `14d`, `2w`, `48h`, `14`.",
          "",
          "(Code: VALIDATION)",
        ].join("\n"),
      },
    ],
  };
}

function mapInterestRequestsError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof applications.ApplicationsError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `Error: ${err.message}`,
            "",
            "Recovery: Retry; if the failure persists, file an issue.",
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
          `Error: interest_requests request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}
