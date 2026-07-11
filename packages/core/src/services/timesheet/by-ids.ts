// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { callGatewayShared } from "../_shared/transport.js";
import { TimesheetError } from "./index.js";
import type { TimesheetEngagementRef, TimesheetListItem, TimesheetMinimumCommitment } from "./index.js";

/** Upper bound on the id list accepted by {@link showMany} — anti-automation friction. */
export const MAX_SHOW_MANY_IDS = 20 as const;

// Relay batch sibling of the singular timesheet ops (`node(id:)` = `timesheet.show`,
// `viewer.billingCycles` = `timesheet.list`). Selects the SAME rich `timesheetListFields`
// selection as `TIMESHEETS_QUERY` in ./index.ts — deliberately richer than the captured
// mobile op, whose fragment omits `timesheetApproved`/`timesheetRequiresApproval`/`status`
// (all proven live on `BillingCycle` via `Timesheets`/`PendingTimesheets`). Keeping the
// selection aligned with the list path is what lets `showMany` return a full
// `TimesheetListItem`; the committed `TimesheetsByIDs.snapshot.json` guards the field set.
const TIMESHEETS_BY_IDS_QUERY = `query TimesheetsByIDs($ids: [ID!]!) { nodes(ids: $ids) { __typename ...timesheetListFields } }  fragment minimumCommitmentData on MinimumCommitment { __typename applicable minimumHours reasonNotApplicable }  fragment timesheetListFields on BillingCycle { __typename id startDate endDate hours minimumCommitment { __typename ...minimumCommitmentData } timesheetOverdue timesheetSubmissionOpenDatetime timesheetSubmissionDeadlineDatetime timesheetSubmitted timesheetApproved timesheetRequiresApproval status engagement { __typename id job { __typename id client { __typename id fullName } title } } }`;

// Mirrors the private `TimesheetListWireItem` shape in ./index.ts (the `nodes(ids:)`
// surface returns the same `timesheetListFields` selection). Re-declared rather than
// imported to keep ./index.ts's wire interfaces private; the projection below returns
// the shared `TimesheetListItem`, so any field added to it is compiler-caught here.
interface WireTimesheetNode {
  id: string;
  startDate: string;
  endDate: string;
  hours: string;
  minimumCommitment: TimesheetMinimumCommitment | null;
  timesheetOverdue: boolean;
  timesheetSubmissionOpenDatetime: string | null;
  timesheetSubmissionDeadlineDatetime: string | null;
  timesheetSubmitted: boolean;
  timesheetApproved: boolean;
  timesheetRequiresApproval: boolean;
  status: string | null;
  engagement: TimesheetEngagementRef;
}

interface TimesheetsByIdsResponse {
  nodes: (WireTimesheetNode | null)[] | null;
}

function projectNode(wire: WireTimesheetNode): TimesheetListItem {
  return {
    id: wire.id,
    startDate: wire.startDate,
    endDate: wire.endDate,
    hours: wire.hours,
    minimumCommitment: wire.minimumCommitment,
    timesheetOverdue: wire.timesheetOverdue,
    timesheetSubmissionOpenDatetime: wire.timesheetSubmissionOpenDatetime,
    timesheetSubmissionDeadlineDatetime: wire.timesheetSubmissionDeadlineDatetime,
    timesheetSubmitted: wire.timesheetSubmitted,
    timesheetApproved: wire.timesheetApproved,
    timesheetRequiresApproval: wire.timesheetRequiresApproval,
    status: wire.status,
    engagement: wire.engagement,
  };
}

/**
 * Batch-fetch timesheets by `BillingCycle.id` — the bulk sibling of
 * `timesheet.show` (`TimesheetDetails` / `node(id:)`), wrapping
 * mobile-gateway `TimesheetsByIDs` (`nodes(ids:)`). Returns the found
 * timesheets in INPUT order: the result is re-ordered client-side by
 * matching each requested id against the returned `id`.
 *
 * Returns the same LIST-ROW shape as `timesheet.list` ({@link TimesheetListItem})
 * — week range, hours, submission + approval state, engagement+job
 * reference. NOT the per-day `timesheetRecords`, comment, or rate-card
 * that `timesheet.show` returns; the batch wire op selects list fields
 * only. For a single timesheet's full detail, use `timesheet.show`.
 *
 * Throws `TimesheetError("VALIDATION_ERROR")` for an empty list or more
 * than {@link MAX_SHOW_MANY_IDS} ids.
 *
 * Unresolvable-id handling is wire-determined and OPERATION-SPECIFIC
 * (verified live #460): unlike `payments.showMany` — where a decodable-but-
 * nonexistent id is silently dropped (partial fetch) — `TimesheetsByIDs`
 * rejects the WHOLE batch with a `GRAPHQL_ERROR` (HTTP 500) on ANY id that
 * does not resolve to a real `BillingCycle`. The service still drops `null`
 * nodes defensively should the wire ever return them, but callers passing
 * untrusted ids should expect a thrown `GRAPHQL_ERROR`, not a silent partial
 * result.
 */
export async function showMany(token: string, ids: string[]): Promise<TimesheetListItem[]> {
  if (ids.length === 0) {
    throw new TimesheetError("VALIDATION_ERROR", "showMany requires at least one timesheet id.");
  }
  if (ids.length > MAX_SHOW_MANY_IDS) {
    throw new TimesheetError(
      "VALIDATION_ERROR",
      `showMany accepts at most ${MAX_SHOW_MANY_IDS.toString()} ids (got ${ids.length.toString()}).`,
    );
  }
  const data = await callGatewayShared<TimesheetsByIdsResponse, TimesheetError>(
    "mobile-gateway",
    token,
    "TimesheetsByIDs",
    TIMESHEETS_BY_IDS_QUERY,
    { ids },
    TimesheetError,
  );
  const byId = new Map<string, TimesheetListItem>();
  for (const node of data.nodes ?? []) {
    if (node === null) continue;
    byId.set(node.id, projectNode(node));
  }
  const out: TimesheetListItem[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item !== undefined) out.push(item);
  }
  return out;
}
