// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleApplicationsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl applications interview show <id>` (#439).
 * Read-only fetch of one interview by id. The id comes from
 * `ttctl applications show <activityId>` output (the `Interview: <id>`
 * line surfaced when the activity row has an associated interview).
 *
 * Pretty rendering is a sectioned multi-line block grouped into
 * Interview / Method / Contacts / Notes / Job. Sections with no data
 * (e.g. no contacts when the interviewer side hasn't populated them
 * yet) are omitted.
 *
 * `json` / `yaml` always emit the full {@link applications.InterviewDetail}
 * projection — machine consumers project as needed.
 */
export async function runApplicationsInterviewShow(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("applications interview show", output);

  let item: applications.InterviewDetail;
  try {
    item = await applications.interviews.show(token, id);
  } catch (err) {
    handleApplicationsError("applications interview show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatInterviewDetail(data),
  });
}

/**
 * Render an {@link applications.InterviewDetail} as a sectioned
 * multi-line block. Pure — directly unit-testable.
 *
 * Layout:
 *
 *     Interview <id>
 *       Status: <statusValue>
 *       Kind:   <kindValue>
 *       Type:   <interviewType>
 *       Time:   <interviewTime>
 *       Updated: <updatedAt>
 *
 *     Scheduling
 *       Initiator: <initiator>
 *       Proposed slots:
 *         - <slot1>
 *         - <slot2>
 *       Comment: <schedulingComment>
 *
 *     Method                       // omitted if method is null
 *       Type:       <typeV2>
 *       Resource:   <resource>
 *       Conference: <conferenceUrl>
 *
 *     Information                  // omitted if information is null
 *       <recruiter brief, paragraph-preserved>
 *
 *     Contacts                     // omitted if no contacts
 *       <main> <fullName> <position>
 *         Email:    <email>
 *         Phone:    <phoneNumber>
 *         TimeZone: <location> (<value>)
 *
 *     Notes                        // omitted if no notes
 *       [<section>] <note>
 *
 *     Job                          // omitted if job is null
 *       Job id:      <id>
 *       Activity id: <activityItemId>
 *
 *     Prep guide                   // omitted if guideId is null
 *       ID: <guideId>
 */
export function formatInterviewDetail(item: applications.InterviewDetail): string {
  const lines: string[] = [];

  lines.push(`Interview ${item.id}`);
  if (item.status !== null) lines.push(`  Status: ${item.status}`);
  if (item.kind !== null) lines.push(`  Kind:   ${item.kind}`);
  if (item.interviewType !== null) lines.push(`  Type:   ${item.interviewType}`);
  if (item.interviewTime !== null) lines.push(`  Time:   ${item.interviewTime}`);
  if (item.updatedAt !== null) lines.push(`  Updated: ${item.updatedAt}`);

  // Scheduling block — always rendered (the slot list is core to the
  // "what is this interview" question). Per-line null guards keep the
  // block concise when the wire returns sparse data.
  const hasSchedulingDetail =
    item.initiator !== null ||
    item.scheduledAtTimes.length > 0 ||
    (item.schedulingComment !== null && item.schedulingComment !== "");
  if (hasSchedulingDetail) {
    lines.push("");
    lines.push("Scheduling");
    if (item.initiator !== null) lines.push(`  Initiator: ${item.initiator}`);
    if (item.scheduledAtTimes.length > 0) {
      lines.push(`  Proposed slots:`);
      for (const slot of item.scheduledAtTimes) {
        lines.push(`    - ${slot}`);
      }
    }
    if (item.schedulingComment !== null && item.schedulingComment !== "") {
      lines.push(`  Comment: ${item.schedulingComment}`);
    }
  }

  if (item.method !== null) {
    lines.push("");
    lines.push("Method");
    if (item.method.typeV2 !== null) lines.push(`  Type:       ${item.method.typeV2}`);
    if (item.method.resource !== null && item.method.resource !== "") {
      lines.push(`  Resource:   ${item.method.resource}`);
    }
    if (item.method.conferenceUrl !== null && item.method.conferenceUrl !== "") {
      lines.push(`  Conference: ${item.method.conferenceUrl}`);
    }
  }

  if (item.information !== null && item.information !== "") {
    lines.push("");
    lines.push("Information");
    for (const para of item.information.split(/\n+/)) {
      if (para.trim().length > 0) lines.push(`  ${para}`);
    }
  }

  if (item.contacts.length > 0) {
    lines.push("");
    lines.push("Contacts");
    for (const c of item.contacts) {
      const headerBits: string[] = [];
      if (c.main === true) headerBits.push("(main)");
      if (c.fullName !== null && c.fullName !== "") headerBits.push(c.fullName);
      if (c.position !== null && c.position !== "") headerBits.push(`— ${c.position}`);
      // Fall back to the id when neither main flag nor fullName is
      // populated — every contact has at least an id on the wire.
      lines.push(`  ${headerBits.length > 0 ? headerBits.join(" ") : c.id}`);
      if (c.email !== null && c.email !== "") lines.push(`    Email:    ${c.email}`);
      if (c.phoneNumber !== null && c.phoneNumber !== "") lines.push(`    Phone:    ${c.phoneNumber}`);
      if (c.timeZone !== null) {
        const tzBits: string[] = [];
        if (c.timeZone.location !== null && c.timeZone.location !== "") tzBits.push(c.timeZone.location);
        if (c.timeZone.value !== null && c.timeZone.value !== "") tzBits.push(`(${c.timeZone.value})`);
        if (tzBits.length > 0) lines.push(`    TimeZone: ${tzBits.join(" ")}`);
      }
    }
  }

  if (item.talentNotes.length > 0) {
    lines.push("");
    lines.push("Notes");
    for (const n of item.talentNotes) {
      const section = n.section !== null && n.section !== "" ? `[${n.section}] ` : "";
      const note = n.note ?? "";
      lines.push(`  ${section}${note}`);
    }
  }

  if (item.job !== null) {
    lines.push("");
    lines.push("Job");
    lines.push(`  Job id:      ${item.job.id}`);
    if (item.job.activityItemId !== null) {
      lines.push(`  Activity id: ${item.job.activityItemId}`);
    }
  }

  if (item.guideId !== null) {
    lines.push("");
    lines.push("Prep guide");
    lines.push(`  ID: ${item.guideId}`);
  }

  return lines.join("\n");
}
