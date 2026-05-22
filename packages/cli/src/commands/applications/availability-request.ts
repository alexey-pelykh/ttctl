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
 *       Fixed rate: <verbose | $<decimal>/h>     // omitted if fixedRate null
 *       Created:    <createdAt>
 *       Updated:    <updatedAt>
 *       Answered:   <answeredAt>                 // omitted if null (pending)
 *
 *     Comment                                    // omitted if comment null/empty
 *       <recruiter note, paragraph-preserved>
 *
 *     Job                                        // omitted if job is null
 *       Job id: <id>
 *       Title:  <title>
 *       URL:    <url>
 *       Client: <fullName>
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
  if (item.createdAt !== null) lines.push(`  Created:    ${item.createdAt}`);
  if (item.updatedAt !== null) lines.push(`  Updated:    ${item.updatedAt}`);
  if (item.answeredAt !== null) lines.push(`  Answered:   ${item.answeredAt}`);

  if (item.comment !== null && item.comment !== "") {
    lines.push("");
    lines.push("Comment");
    for (const para of item.comment.split(/\n+/)) {
      if (para.trim().length > 0) lines.push(`  ${para}`);
    }
  }

  if (item.job !== null) {
    lines.push("");
    lines.push("Job");
    lines.push(`  Job id: ${item.job.id}`);
    if (item.job.title !== null && item.job.title !== "") lines.push(`  Title:  ${item.job.title}`);
    if (item.job.url !== null && item.job.url !== "") lines.push(`  URL:    ${item.job.url}`);
    if (item.job.client?.fullName != null && item.job.client.fullName !== "") {
      lines.push(`  Client: ${item.job.client.fullName}`);
    }
  }

  return lines.join("\n");
}
