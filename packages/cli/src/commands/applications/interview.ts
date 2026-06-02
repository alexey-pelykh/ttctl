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
 * Interview / Method / Contacts / Client / Notes / Job. Sections with no data
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
 *     Client                       // omitted unless a client channel is populated
 *       Email:    <email>
 *       Phone:    <phoneNumber>
 *       Slack:    <communitySlackId>
 *       Skype:    <skype>
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
      if (c.topChatConversation !== null) {
        const tc = c.topChatConversation;
        lines.push(`    TopChat:  ${tc.id}`);
        if (tc.slackChannelId !== null && tc.slackChannelId !== "") {
          lines.push(`      Slack channel: ${tc.slackChannelId}`);
        }
        for (const u of tc.uploads) {
          const name = u.filename !== null && u.filename !== "" ? u.filename : u.id;
          const url = u.url !== null && u.url !== "" ? ` (${u.url})` : "";
          lines.push(`      File: ${name}${url}`);
        }
      }
    }
  }

  // Omitted unless a channel is populated — a bare client id is not human-useful.
  const clientFields = item.clientContactInfo?.contactFields ?? null;
  if (clientFields !== null) {
    const clientLines: string[] = [];
    if (clientFields.email !== null && clientFields.email !== "") clientLines.push(`  Email:    ${clientFields.email}`);
    if (clientFields.phoneNumber !== null && clientFields.phoneNumber !== "") {
      clientLines.push(`  Phone:    ${clientFields.phoneNumber}`);
    }
    if (clientFields.communitySlackId !== null && clientFields.communitySlackId !== "") {
      clientLines.push(`  Slack:    ${clientFields.communitySlackId}`);
    }
    if (clientFields.skype !== null && clientFields.skype !== "") clientLines.push(`  Skype:    ${clientFields.skype}`);
    if (clientLines.length > 0) {
      lines.push("");
      lines.push("Client");
      lines.push(...clientLines);
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

/**
 * Action handler for `ttctl applications interview notes show <jobId>` (#440).
 * Read-only fetch of the talent's prep notes for the interview attached
 * to a given job, via the portal-side `GetInterviewNotes` query.
 *
 * **Input is the JOB id, not the interview id** — the wire op takes
 * `$jobId: ID!` and traverses `viewer.job(id).activityItem.interview`.
 * Discover the job id via `ttctl applications interview show
 * <interviewId>` (the `Job → Job id` line surfaced by the #439
 * projection) or `ttctl applications show <activityId>`.
 *
 * Pretty rendering groups the notes by section header (the
 * `InterviewGuideSectionIdentifierEnum` member) and falls back to
 * unsectioned bullets for null-section notes. Empty-notes results
 * render a single-line `(no prep notes)` message rather than blank
 * output.
 *
 * `json` / `yaml` always emit the full
 * {@link applications.InterviewNotesProjection} — machine consumers
 * project as needed.
 */
export async function runApplicationsInterviewNotesShow(jobId: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("applications interview notes show", output);

  let item: applications.InterviewNotesProjection;
  try {
    item = await applications.interviews.notes.show(token, jobId);
  } catch (err) {
    handleApplicationsError("applications interview notes show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatInterviewNotes(data),
  });
}

/**
 * Render an {@link applications.InterviewNotesProjection} as a sectioned
 * multi-line block. Pure — directly unit-testable.
 *
 * Layout:
 *
 *     Interview notes for job <jobId>
 *       Interview id:   <interviewId>             // omitted if null
 *       Interview kind: <interviewKind>           // omitted if null
 *
 *     Notes
 *       [<section>] <note>                        // grouped by section
 *
 * When the job has no attached interview, prints:
 *
 *     Interview notes for job <jobId>
 *       (no interview attached to this job)
 *
 * When the interview has no prep notes, prints:
 *
 *     Interview notes for job <jobId>
 *       Interview id:   <interviewId>
 *       ...
 *       (no prep notes)
 */
export function formatInterviewNotes(item: applications.InterviewNotesProjection): string {
  const lines: string[] = [];

  lines.push(`Interview notes for job ${item.jobId}`);

  if (item.interviewId === null) {
    lines.push("  (no interview attached to this job)");
    return lines.join("\n");
  }

  lines.push(`  Interview id:   ${item.interviewId}`);
  if (item.interviewKind !== null) {
    lines.push(`  Interview kind: ${item.interviewKind}`);
  }

  if (item.notes.length === 0) {
    lines.push("");
    lines.push("  (no prep notes)");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Notes");
  for (const n of item.notes) {
    const section = n.section !== null && n.section !== "" ? `[${n.section}] ` : "";
    const note = n.note ?? "";
    lines.push(`  ${section}${note}`);
  }

  return lines.join("\n");
}

/**
 * Action handler for `ttctl applications interview guide show <interviewId>` (#470).
 * Read-only fetch of the interview-prep guide content (sections + tips)
 * for one interview, via the mobile-gateway `InterviewGuide` query.
 *
 * **Input is the INTERVIEW id**, not the guide id. The wire op takes
 * `$interviewId: ID!` and traverses `viewer.interview(id).guide`.
 * Discover via `ttctl applications interview show <interviewId>` or
 * `ttctl applications show <activityId>` (the `Interview: <id>` line).
 *
 * Pretty rendering groups tips under their section headers
 * (identifier + title + subtitle). Each tip renders as a labeled
 * sub-block with `Tip:` / `Content:` / `Template:` lines; the
 * `hardcodedContent` label is "Template" to disambiguate from
 * `content` (which is the talent/job-personalized body the guide
 * pipeline splices in). Empty-guide results render a single-line
 * `(no guide attached to this interview)` message rather than blank
 * output.
 *
 * `json` / `yaml` always emit the full
 * {@link applications.InterviewGuideProjection} — machine consumers
 * project as needed.
 */
export async function runApplicationsInterviewGuideShow(interviewId: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("applications interview guide show", output);

  let item: applications.InterviewGuideProjection;
  try {
    item = await applications.interviews.guide.show(token, interviewId);
  } catch (err) {
    handleApplicationsError("applications interview guide show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatInterviewGuide(data),
  });
}

/**
 * Render an {@link applications.InterviewGuideProjection} as a sectioned
 * multi-line block. Pure — directly unit-testable.
 *
 * Layout:
 *
 *     Interview guide for interview <interviewId>
 *       Guide id: <guideId>                         // omitted if null
 *
 *     [<identifier>] <title>                        // section header; falls back to identifier-only
 *       <subtitle>                                  // omitted if null/empty
 *
 *       • <tipIdentifier> — <tipTitle>             // tip header; falls back to identifier-only
 *           Content:
 *             <multi-line content, indented>
 *           Template:
 *             <multi-line hardcodedContent, indented>
 *
 * When no guide is attached, prints:
 *
 *     Interview guide for interview <interviewId>
 *       (no guide attached to this interview)
 */
export function formatInterviewGuide(item: applications.InterviewGuideProjection): string {
  const lines: string[] = [];

  lines.push(`Interview guide for interview ${item.interviewId}`);

  if (item.guideId === null) {
    lines.push("  (no guide attached to this interview)");
    return lines.join("\n");
  }

  lines.push(`  Guide id: ${item.guideId}`);

  if (item.sections.length === 0) {
    lines.push("");
    lines.push("  (guide has no sections)");
    return lines.join("\n");
  }

  for (const section of item.sections) {
    lines.push("");
    // Section header — falls back to identifier-only when title is null,
    // and to a literal "(unnamed section)" when both are null.
    const sectionHeader = sectionHeaderLine(section);
    lines.push(sectionHeader);
    if (section.subtitle !== null && section.subtitle !== "") {
      lines.push(`  ${section.subtitle}`);
    }

    if (section.tips.length === 0) {
      lines.push("  (no tips)");
      continue;
    }

    for (const tip of section.tips) {
      lines.push("");
      lines.push(`  ${tipHeaderLine(tip)}`);
      if (tip.content !== null && tip.content !== "") {
        lines.push(`      Content:`);
        for (const para of tip.content.split(/\n/)) {
          lines.push(`        ${para}`);
        }
      }
      if (tip.hardcodedContent !== null && tip.hardcodedContent !== "") {
        lines.push(`      Template:`);
        for (const para of tip.hardcodedContent.split(/\n/)) {
          lines.push(`        ${para}`);
        }
      }
    }
  }

  return lines.join("\n");
}

function sectionHeaderLine(section: applications.InterviewGuideSection): string {
  if (section.identifier !== null && section.title !== null && section.title !== "") {
    return `[${section.identifier}] ${section.title}`;
  }
  if (section.identifier !== null) {
    return `[${section.identifier}]`;
  }
  if (section.title !== null && section.title !== "") {
    return section.title;
  }
  return "(unnamed section)";
}

function tipHeaderLine(tip: applications.InterviewGuideTip): string {
  if (tip.identifier !== null && tip.title !== null && tip.title !== "") {
    return `• ${tip.identifier} — ${tip.title}`;
  }
  if (tip.identifier !== null) {
    return `• ${tip.identifier}`;
  }
  if (tip.title !== null && tip.title !== "") {
    return `• ${tip.title}`;
  }
  return "• (unnamed tip)";
}
