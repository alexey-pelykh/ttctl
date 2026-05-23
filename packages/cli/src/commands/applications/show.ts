// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatFixedRate, handleApplicationsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl applications show <id>`. Reads a single
 * activity item by id and emits via the cross-CLI output helper.
 *
 * Pretty rendering is a multi-line key:value layout grouped into
 * sections (Status, Job, Application, Engagement). Sections with no
 * data (e.g. no `engagement` for a row that hasn't reached engagement
 * yet) are omitted — pretty's job is to be readable, not exhaustive.
 *
 * `json` / `yaml` always emit the full server payload — machine
 * consumers may project as needed.
 */
export async function runApplicationsShow(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("applications show", output);

  let item: applications.JobActivityItemDetail;
  try {
    item = await applications.show(token, id);
  } catch (err) {
    handleApplicationsError("applications show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatApplicationDetail(data),
  });
}

/**
 * Render the activity-item detail as a sectioned multi-line block.
 * Pure — directly unit-testable.
 *
 * Layout:
 *
 *     Activity <id>
 *       Status: <verbose> (<value>)
 *       Group:  <verbose> (<value>)
 *       Updated: <ISO>
 *
 *     Job
 *       <title>
 *       <url>
 *       Client: <fullName>
 *       Commitment: <slug>
 *       Work type: <slug>
 *       Specialization: <title>
 *       Hours: <expectedHours>
 *       Length: <enumValue>
 *       Description:
 *         <descriptionMd, with paragraph breaks preserved>
 *
 *     Application                  // omitted if jobApplication is null
 *       Id: <id>
 *       Requested rate: <decimal>
 *
 *     Fixed rate                   // omitted if fixedRate is null (#410)
 *       <verbose | $<decimal>/h>
 *
 *     Engagement                   // omitted if engagement is null
 *       Id: <id>
 *       Started: <startDate>
 *       Ended: <endDate>           // omitted if null
 *       Commitment: <slug>
 *       Hours: <expectedHours>
 */
export function formatApplicationDetail(item: applications.JobActivityItemDetail): string {
  const lines: string[] = [];

  lines.push(`Activity ${item.id}`);
  lines.push(`  Status: ${item.statusV2.verbose} (${item.statusV2.value})`);
  lines.push(`  Group:  ${item.statusGroupV2.verbose} (${item.statusGroupV2.value})`);
  lines.push(`  Updated: ${item.lastUpdatedAt}`);

  lines.push("");
  lines.push("Job");
  if (item.job.title !== null) lines.push(`  ${item.job.title}`);
  if (item.job.url !== null) lines.push(`  ${item.job.url}`);
  if (item.job.client?.fullName != null) {
    lines.push(`  Client: ${item.job.client.fullName}`);
  }
  if (item.job.commitment?.slug != null) {
    lines.push(`  Commitment: ${item.job.commitment.slug}`);
  }
  if (item.job.workType?.slug != null) {
    lines.push(`  Work type: ${item.job.workType.slug}`);
  }
  if (item.job.specialization?.title != null) {
    lines.push(`  Specialization: ${item.job.specialization.title}`);
  }
  if (item.job.expectedHours !== null) {
    lines.push(`  Hours: ${item.job.expectedHours.toString()}`);
  }
  if (item.job.estimatedLength?.enumValue != null) {
    lines.push(`  Length: ${item.job.estimatedLength.enumValue}`);
  }
  if (item.job.startDate !== null) {
    lines.push(`  Starts: ${item.job.startDate}`);
  }
  if (item.job.postedWhen !== null) {
    lines.push(`  Posted: ${item.job.postedWhen}`);
  }
  // Surface the boolean job flags as compact one-liners — only when
  // true, since `false` is the implicit default and rendering it would
  // clutter the typical output.
  if (item.job.isCoaching === true) {
    lines.push(`  Type: coaching`);
  }
  if (item.job.isToptalProject === true) {
    lines.push(`  Type: toptal-project`);
  }
  if (item.job.descriptionMd !== null && item.job.descriptionMd !== "") {
    lines.push(`  Description:`);
    for (const para of item.job.descriptionMd.split(/\n+/)) {
      if (para.trim().length > 0) lines.push(`    ${para}`);
    }
  }

  if (item.jobApplication !== null) {
    lines.push("");
    lines.push("Application");
    lines.push(`  Id: ${item.jobApplication.id}`);
    if (item.jobApplication.requestedHourlyRate?.decimal != null) {
      lines.push(`  Requested rate: ${item.jobApplication.requestedHourlyRate.decimal}`);
    }
  }

  // Surface the recruiter-pinned Fixed rate (#410) alongside the talent-
  // proposed `requestedHourlyRate` above so the user can compare both
  // sides of the AR at a glance.
  if (item.fixedRate !== null) {
    lines.push("");
    lines.push("Fixed rate");
    lines.push(`  ${formatFixedRate(item.fixedRate)}`);
  }

  if (item.engagement !== null) {
    lines.push("");
    lines.push("Engagement");
    lines.push(`  Id: ${item.engagement.id}`);
    if (item.engagement.startDate !== null) {
      lines.push(`  Started: ${item.engagement.startDate}`);
    }
    if (item.engagement.endDate !== null) {
      lines.push(`  Ended: ${item.engagement.endDate}`);
    }
    if (item.engagement.commitment?.slug != null) {
      lines.push(`  Commitment: ${item.engagement.commitment.slug}`);
    }
    if (item.engagement.expectedHours !== null) {
      lines.push(`  Hours: ${item.engagement.expectedHours.toString()}`);
    }
  }

  // Surface availability-request detail (#539 — extended from prior
  // presence indicator) and the interview presence indicator. The
  // interview shape stays minimal: the schema marks `interview` as
  // `Unknown` so we can't safely select more than `id`.
  if (item.availabilityRequest !== null) {
    lines.push("");
    lines.push(`Availability request: ${item.availabilityRequest.id}`);
    if (item.availabilityRequest.recruiter !== null) {
      const name = formatEmbedRecruiterName(item.availabilityRequest.recruiter);
      if (name !== null) lines.push(`  Recruiter: ${name}`);
    }
    if (item.availabilityRequest.requestedHourlyRate !== null) {
      lines.push(`  Talent rate: ${formatFixedRate(item.availabilityRequest.requestedHourlyRate)}`);
    }
    if (item.availabilityRequest.talentComment !== null && item.availabilityRequest.talentComment !== "") {
      lines.push(`  Talent comment: ${item.availabilityRequest.talentComment}`);
    }
    if (item.availabilityRequest.rejectReason !== null && item.availabilityRequest.rejectReason !== "") {
      lines.push(`  Reject reason: ${item.availabilityRequest.rejectReason}`);
    }
  }
  // Platform-blessed "most relevant" AR pointer (#547) — a deep-link hint
  // (mirrors the `Interview: <id>` discovery hint below) the user can pass
  // to `applications availability-request show <ar-id>`. Most useful on
  // rows with multiple historical ARs, where it disambiguates the one that
  // matters from this row's own `availabilityRequest`.
  if (item.mostRelevantApplication !== null) {
    lines.push(`Most relevant application: ${item.mostRelevantApplication.id}`);
  }
  if (item.interview !== null) {
    lines.push(`Interview: ${item.interview.id}`);
  }

  return lines.join("\n");
}

/**
 * Render a {@link applications.RecruiterRef} from the embedded AR
 * sub-projection (#539) as a single display name. Prefers `fullName`
 * when populated; falls back to a `firstName lastName` join. Returns
 * `null` when no name field is populated.
 */
function formatEmbedRecruiterName(recruiter: applications.RecruiterRef): string | null {
  if (recruiter.fullName !== null && recruiter.fullName !== "") return recruiter.fullName;
  const parts: string[] = [];
  if (recruiter.firstName !== null && recruiter.firstName !== "") parts.push(recruiter.firstName);
  if (recruiter.lastName !== null && recruiter.lastName !== "") parts.push(recruiter.lastName);
  return parts.length > 0 ? parts.join(" ") : null;
}
