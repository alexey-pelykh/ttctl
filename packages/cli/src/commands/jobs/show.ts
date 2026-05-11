// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { jobs } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatDate, formatRate, handleJobsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl jobs show <id>`. Fetches a single job's
 * detail view by id and emits via the cross-CLI output helper.
 *
 * Pretty rendering is a multi-line key:value layout grouped into
 * sections (Job, Client, Skills, Status, Time zone). Sections with no
 * data are omitted.
 *
 * `json` / `yaml` emit the full projection — machine consumers may
 * project further as needed.
 */
export async function runJobsShow(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs show", output);

  let item: jobs.JobDetail;
  try {
    item = await jobs.show(token, id);
  } catch (err) {
    handleJobsError("jobs show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatJobDetail(data),
  });
}

/**
 * Render the job detail as a sectioned multi-line block. Pure —
 * directly unit-testable.
 */
export function formatJobDetail(job: jobs.JobDetail): string {
  const lines: string[] = [];

  lines.push(`Job ${job.id}`);
  if (job.title !== null) lines.push(`  ${job.title}`);
  if (job.url !== null) lines.push(`  ${job.url}`);
  if (job.commitment?.slug != null) lines.push(`  Commitment: ${job.commitment.slug}`);
  if (job.workType?.slug != null) lines.push(`  Work type: ${job.workType.slug}`);
  if (job.specialization?.title != null) lines.push(`  Specialization: ${job.specialization.title}`);
  if (job.expectedHours !== null) lines.push(`  Hours: ${job.expectedHours.toString()}`);
  if (job.minimumHoursPerBillingCycle !== null) {
    lines.push(`  Min hours/cycle: ${job.minimumHoursPerBillingCycle.toString()}`);
  }
  if (job.maxRate !== null) lines.push(`  Max rate: ${formatRate(job.maxRate)}`);
  if (job.startDate !== null) lines.push(`  Starts: ${formatDate(job.startDate)}`);
  if (job.postedWhen !== null) lines.push(`  Posted: ${job.postedWhen}`);
  if (job.isCoaching === true) lines.push(`  Type: coaching`);
  if (job.isToptalProject === true) lines.push(`  Type: toptal-project`);

  const flagParts: string[] = [];
  if (job.saved === true) flagParts.push("saved");
  if (job.notInterested === true) flagParts.push("not-interested");
  if (job.viewed === true) flagParts.push("viewed");
  if (flagParts.length > 0) lines.push(`  Status: ${flagParts.join(", ")}`);

  if (job.client !== null) {
    lines.push("");
    lines.push("Client");
    if (job.client.fullName !== null) lines.push(`  ${job.client.fullName}`);
    if (job.client.industry !== null) lines.push(`  Industry: ${job.client.industry}`);
    if (job.client.city !== null || job.client.countryName !== null) {
      const loc = [job.client.city, job.client.countryName].filter((s): s is string => s !== null).join(", ");
      if (loc !== "") lines.push(`  Location: ${loc}`);
    }
    if (job.client.teamSize?.value != null) lines.push(`  Team size: ${job.client.teamSize.value}`);
    if (job.client.website !== null) lines.push(`  Website: ${job.client.website}`);
    if (job.client.linkedin !== null) lines.push(`  LinkedIn: ${job.client.linkedin}`);
    if (job.client.isEnterprise === true) lines.push(`  Enterprise: yes`);
  }

  if (job.jobTimeZone !== null) {
    const tz = job.jobTimeZone;
    if (tz.verbose !== null || tz.hoursOverlap !== null) {
      lines.push("");
      lines.push("Time zone");
      if (tz.verbose !== null) lines.push(`  ${tz.verbose}`);
      if (tz.workingTimeFrom !== null && tz.workingTimeTo !== null) {
        lines.push(`  Hours: ${tz.workingTimeFrom} – ${tz.workingTimeTo}`);
      }
      if (tz.hoursOverlap !== null) lines.push(`  Overlap: ${tz.hoursOverlap.toString()}h`);
    }
  }

  if (job.skills.length > 0) {
    lines.push("");
    lines.push("Skills");
    for (const sk of job.skills) {
      const optional = sk.isOptional === true ? " (optional)" : "";
      const rating = sk.rating !== null ? ` ★${sk.rating.toString()}` : "";
      lines.push(`  • ${sk.name}${rating}${optional}`);
    }
  }

  if (job.languages.length > 0) {
    const langs = job.languages
      .map((l) => l.name)
      .filter((n): n is string => n !== null)
      .join(", ");
    if (langs !== "") {
      lines.push("");
      lines.push(`Languages: ${langs}`);
    }
  }

  if (job.descriptionMd !== null && job.descriptionMd !== "") {
    lines.push("");
    lines.push("Description");
    for (const para of job.descriptionMd.split(/\n+/)) {
      if (para.trim().length > 0) lines.push(`  ${para}`);
    }
  }

  return lines.join("\n");
}
