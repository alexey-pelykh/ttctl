// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { timesheet } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleTimesheetError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl timesheet show <id>`. `<id>` is the
 * BillingCycle.id from `ttctl timesheet list`.
 *
 * Pretty rendering is a multi-line key:value layout grouped into
 * sections (Header, Engagement, Submission, Agreement, Records). Empty
 * sections are omitted. `json` / `yaml` always emit the full server
 * payload (including `timesheetUrl`, `actualAgreement`, the full
 * records array, etc.).
 */
export async function runTimesheetShow(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("timesheet show", output);

  let item: timesheet.TimesheetDetail;
  try {
    item = await timesheet.show(token, id);
  } catch (err) {
    handleTimesheetError("timesheet show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatTimesheetDetail(data),
  });
}

/**
 * Render the timesheet detail as a sectioned multi-line block. Pure —
 * directly unit-testable.
 */
export function formatTimesheetDetail(item: timesheet.TimesheetDetail): string {
  const lines: string[] = [];

  lines.push(`Timesheet ${item.id}`);
  lines.push(`  Week: ${item.startDate} → ${item.endDate}`);
  lines.push(`  Hours: ${item.hours}`);
  lines.push(`  Submitted: ${String(item.timesheetSubmitted)}`);
  lines.push(`  Overdue: ${String(item.timesheetOverdue)}`);
  if (item.timesheetSubmissionOpenDatetime !== null) {
    lines.push(`  Submission opens: ${item.timesheetSubmissionOpenDatetime}`);
  }
  if (item.timesheetSubmissionDeadlineDatetime !== null) {
    lines.push(`  Submission deadline: ${item.timesheetSubmissionDeadlineDatetime}`);
  }
  if (item.timesheetUrl !== null) {
    lines.push(`  URL: ${item.timesheetUrl}`);
  }

  lines.push("");
  lines.push("Engagement");
  if (item.engagement.job.title !== null) lines.push(`  ${item.engagement.job.title}`);
  if (item.engagement.job.client?.fullName != null) {
    lines.push(`  Client: ${item.engagement.job.client.fullName}`);
  }
  // Note: this is `Engagement.id` (TalentEngagement), NOT `JobActivityItem.id`.
  // The `--engagement <id>` flag on `timesheet list/submit` consumes the
  // `JobActivityItem.id` surfaced by `engagements list`, which is a
  // distinct identifier — we name the field verbosely here so users don't
  // copy-paste this id back into `--engagement` and get a NOT_FOUND.
  lines.push(`  TalentEngagement id: ${item.engagement.id}`);
  if (item.engagement.expectedHours !== null) {
    lines.push(`  Expected hours: ${item.engagement.expectedHours.toString()}`);
  }

  if (item.minimumCommitment !== null && item.minimumCommitment.applicable) {
    lines.push("");
    lines.push("Minimum commitment");
    if (item.minimumCommitment.minimumHours !== null) {
      lines.push(`  Minimum hours: ${item.minimumCommitment.minimumHours.toString()}`);
    }
  }

  if (item.actualAgreement !== null) {
    lines.push("");
    lines.push("Agreement");
    if (item.actualAgreement.applicationRate !== null) {
      lines.push(`  Application rate: ${item.actualAgreement.applicationRate}`);
    }
    if (item.actualAgreement.talentHourlyRate !== null) {
      lines.push(`  Hourly rate: ${item.actualAgreement.talentHourlyRate}`);
    }
    if (item.actualAgreement.marketplaceMargin !== null) {
      lines.push(`  Marketplace margin: ${item.actualAgreement.marketplaceMargin}`);
    }
  }

  if (item.timesheetComment !== null && item.timesheetComment !== "") {
    lines.push("");
    lines.push("Comment");
    for (const para of item.timesheetComment.split(/\n+/)) {
      if (para.trim().length > 0) lines.push(`  ${para}`);
    }
  }

  if (item.timesheetRecords.length > 0) {
    lines.push("");
    lines.push(`Records (${item.timesheetRecords.length.toString()})`);
    for (const rec of item.timesheetRecords) {
      const hours = (rec.duration / 3600).toFixed(2);
      const tag = rec.isDayOff ? " [day off]" : "";
      const note = rec.note != null && rec.note !== "" ? ` — ${rec.note}` : "";
      lines.push(`  ${rec.date}: ${hours}h${tag}${note}`);
    }
  }

  return lines.join("\n");
}
