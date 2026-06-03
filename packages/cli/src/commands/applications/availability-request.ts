// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatFixedRate, handleApplicationsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl applications availability-request show <id>`
 * (#442). Read-only fetch of one availability request by id. The id is
 * the `AvailabilityRequest.id` from `ttctl applications show
 * <activityId>` output (the `Availability request: <id>` line surfaced
 * when the activity row has an associated AR) — the same id the
 * `applications confirm` / `reject` write-side commands take.
 *
 * Pretty rendering is a sectioned multi-line block grouped into
 * Availability request / Comment / Job. Sections with no data (e.g. no
 * recruiter comment) are omitted.
 *
 * `json` / `yaml` always emit the full
 * {@link applications.AvailabilityRequestDetail} projection — machine
 * consumers project as needed.
 */
export async function runApplicationsAvailabilityRequestShow(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("applications availability-request show", output);

  let item: applications.AvailabilityRequestDetail;
  try {
    item = await applications.availabilityRequests.show(token, id);
  } catch (err) {
    handleApplicationsError("applications availability-request show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatAvailabilityRequestDetail(data),
  });
}

/**
 * Render an {@link applications.AvailabilityRequestDetail} as a
 * sectioned multi-line block. Pure — directly unit-testable.
 *
 * Layout:
 *
 *     Availability request <id>
 *       Status:     <status>
 *       Kind:       <kind>
 *       Fixed rate: <verbose | $<decimal>/h>      // omitted if fixedRate null
 *       Talent rate: <verbose | $<decimal>/h>     // omitted if requestedHourlyRate null (#539)
 *       Created:    <createdAt>
 *       Updated:    <updatedAt>
 *       Answered:   <answeredAt>                  // omitted if null (pending)
 *
 *     Recruiter                                   // #539; omitted if recruiter is null
 *       Name:  <fullName | firstName lastName>
 *
 *     Comment                                     // recruiter note; omitted if null/empty
 *       <recruiter note, paragraph-preserved>
 *
 *     Talent comment                              // #539; omitted if null/empty
 *       <talent's free-text response, paragraph-preserved>
 *
 *     Reject reason: <key>                        // #539; omitted if null
 *
 *     Job                                         // omitted if job is null
 *       Title:  <title>                           // omitted if title is null/empty
 *       Job id: <id>
 *       URL:    <url>
 *       Client: <fullName>
 *
 *     Matcher questions                           // #585; omitted if none
 *       [<identifier>] <prompt>  (required|optional, dropdown|free-text)
 *         Options:   <opt> | <opt> | …            // dropdown only
 *         Suggested: <suggestedAnswer>            // omitted if null
 *
 * Per-line null guards keep the header concise when the wire returns a
 * sparse availability request.
 */
export function formatAvailabilityRequestDetail(item: applications.AvailabilityRequestDetail): string {
  const lines: string[] = [];

  lines.push(`Availability request ${item.id}`);
  if (item.status !== null) lines.push(`  Status:     ${item.status}`);
  if (item.kind !== null) lines.push(`  Kind:       ${item.kind}`);
  if (item.fixedRate !== null) lines.push(`  Fixed rate: ${formatFixedRate(item.fixedRate)}`);
  if (item.requestedHourlyRate !== null) {
    lines.push(`  Talent rate: ${formatFixedRate(item.requestedHourlyRate)}`);
  }
  if (item.createdAt !== null) lines.push(`  Created:    ${item.createdAt}`);
  if (item.updatedAt !== null) lines.push(`  Updated:    ${item.updatedAt}`);
  if (item.answeredAt !== null) lines.push(`  Answered:   ${item.answeredAt}`);

  if (item.recruiter !== null) {
    const name = formatRecruiterName(item.recruiter);
    if (name !== null) {
      lines.push("");
      lines.push("Recruiter");
      lines.push(`  Name:  ${name}`);
    }
  }

  if (item.comment !== null && item.comment !== "") {
    lines.push("");
    lines.push("Comment");
    for (const para of item.comment.split(/\n+/)) {
      if (para.trim().length > 0) lines.push(`  ${para}`);
    }
  }

  if (item.talentComment !== null && item.talentComment !== "") {
    lines.push("");
    lines.push("Talent comment");
    for (const para of item.talentComment.split(/\n+/)) {
      if (para.trim().length > 0) lines.push(`  ${para}`);
    }
  }

  if (item.rejectReason !== null && item.rejectReason !== "") {
    lines.push("");
    lines.push(`Reject reason: ${item.rejectReason}`);
  }

  if (item.job !== null) {
    lines.push("");
    lines.push("Job");
    if (item.job.title !== null && item.job.title !== "") lines.push(`  Title:  ${item.job.title}`);
    lines.push(`  Job id: ${item.job.id}`);
    if (item.job.url !== null && item.job.url !== "") lines.push(`  URL:    ${item.job.url}`);
    if (item.job.client?.fullName != null && item.job.client.fullName !== "") {
      lines.push(`  Client: ${item.job.client.fullName}`);
    }
  }

  // #585 — matcher questions to answer when accepting this IR. Surfaces
  // identifier + prompt + the choice metadata (options / suggestedAnswer /
  // inputType) so the operator can build a `--matcher-answer` payload (or
  // an MCP `matcherAnswers` array) without dropping to raw GraphQL.
  if (item.matcherQuestions.length > 0) {
    lines.push("");
    lines.push("Matcher questions");
    for (const q of item.matcherQuestions) {
      const required = q.isMandatory ? "required" : "optional";
      lines.push(`  [${q.identifier}] ${q.prompt}  (${required}, ${q.inputType})`);
      if (q.options.length > 0) lines.push(`    Options:   ${q.options.join(" | ")}`);
      if (q.suggestedAnswer !== null && q.suggestedAnswer !== "") {
        lines.push(`    Suggested: ${q.suggestedAnswer}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Render a {@link applications.RecruiterRef} as a single display name.
 * Prefers `fullName` when present; falls back to a `firstName lastName`
 * join (allowing single-part names) when fullName is absent. Returns
 * `null` when no name field is populated — the caller suppresses the
 * Recruiter section in that case.
 */
function formatRecruiterName(recruiter: applications.RecruiterRef): string | null {
  if (recruiter.fullName !== null && recruiter.fullName !== "") return recruiter.fullName;
  const parts: string[] = [];
  if (recruiter.firstName !== null && recruiter.firstName !== "") parts.push(recruiter.firstName);
  if (recruiter.lastName !== null && recruiter.lastName !== "") parts.push(recruiter.lastName);
  return parts.length > 0 ? parts.join(" ") : null;
}
