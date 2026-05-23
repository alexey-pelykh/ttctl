// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { engagements } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatDate } from "./list.js";
import { handleEngagementsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Toptal's mobile-gateway `Money` type carries only `decimal` + `verbose`
 * — no currency code. Empirically Toptal pays talents in USD across the
 * platform, so the pretty formatter labels the earning with this
 * hardcoded default. JSON / YAML output remains the raw `{decimal}`
 * shape — currency is a presentation-only assumption, not a wire field.
 */
const DEFAULT_CURRENCY = "USD";

/**
 * Action handler for `ttctl engagements show <id>`. Reads a single
 * engagement detail by `jobActivityItem.id` (the row id from
 * `engagements list`).
 *
 * Pretty rendering is a multi-line key:value layout grouped into
 * sections (Status, Client/Job, Engagement, Agreement, Earnings,
 * Breaks). Sections with no data are omitted. `json` / `yaml` always
 * emit the full server payload.
 */
export async function runEngagementsShow(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("engagements show", output);

  let item: engagements.EngagementDetail;
  try {
    item = await engagements.show(token, id);
  } catch (err) {
    handleEngagementsError("engagements show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatEngagementDetail(data),
  });
}

/**
 * Render the engagement detail as a sectioned multi-line block. Pure —
 * directly unit-testable.
 */
export function formatEngagementDetail(item: engagements.EngagementDetail): string {
  const lines: string[] = [];

  lines.push(`Engagement ${item.id}`);
  if (item.engagementId !== null) {
    lines.push(`  Engagement-ID: ${item.engagementId}`);
  }
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
  if (item.job.startDate !== null) {
    lines.push(`  Starts: ${item.job.startDate}`);
  }
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

  // Counterparty identity (#545): client-side hiring managers + Toptal-side
  // recruiter points-of-contact. Grouped right after the Job/client block.
  lines.push(...formatContactsSection(item.job.contacts));
  lines.push(...formatPointsOfContactSection(item.job.pointsOfContact));

  lines.push("");
  lines.push("Engagement");
  if (item.startDate !== null) lines.push(`  Started: ${item.startDate}`);
  if (item.endDate !== null) lines.push(`  Ended: ${item.endDate}`);
  if (item.commitment?.slug != null) lines.push(`  Commitment: ${item.commitment.slug}`);
  if (item.expectedHours !== null) lines.push(`  Hours/week: ${item.expectedHours.toString()}`);
  if (item.billCycle?.verbose != null) lines.push(`  Bill cycle: ${item.billCycle.verbose}`);
  if (item.eligibleForPayment !== null) lines.push(`  Eligible for payment: ${String(item.eligibleForPayment)}`);
  if (item.eligibleToViewTimesheets !== null) {
    lines.push(`  Timesheets enabled: ${String(item.eligibleToViewTimesheets)}`);
  }
  if (item.eligibleToViewTimeOffs !== null) {
    lines.push(`  Time-offs enabled: ${String(item.eligibleToViewTimeOffs)}`);
  }
  if (item.proposedEnd?.endDate != null) {
    lines.push(`  Proposed end: ${item.proposedEnd.endDate} (${item.proposedEnd.status ?? "—"})`);
  }

  if (item.currentAgreement !== null) {
    lines.push("");
    lines.push("Agreement");
    if (item.currentAgreement.applicationRate !== null) {
      lines.push(`  Application rate: ${item.currentAgreement.applicationRate}`);
    }
    if (item.currentAgreement.talentHourlyRate !== null) {
      lines.push(`  Hourly rate: ${item.currentAgreement.talentHourlyRate}`);
    }
    if (item.currentAgreement.talentRate !== null) {
      lines.push(`  Talent rate: ${item.currentAgreement.talentRate}`);
    }
    if (item.currentAgreement.marketplaceMargin !== null) {
      lines.push(`  Marketplace margin: ${item.currentAgreement.marketplaceMargin}`);
    }
    if (item.currentAgreement.timePeriod !== null) {
      lines.push(`  Time period: ${item.currentAgreement.timePeriod}`);
    }
    if (item.currentAgreement.commitment?.slug != null) {
      lines.push(`  Commitment: ${item.currentAgreement.commitment.slug}`);
    }
  }

  if (item.earning?.paid != null) {
    lines.push("");
    lines.push("Earnings");
    const decimal = item.earning.paid.decimal;
    lines.push(`  Paid: ${decimal} ${DEFAULT_CURRENCY}`);
  }

  if (item.breaks.length > 0) {
    lines.push("");
    lines.push(`Breaks (${item.breaks.length.toString()})`);
    for (const br of item.breaks) {
      const range = `${formatDate(br.startDate)} → ${formatDate(br.endDate)}`;
      const comment = br.comment != null && br.comment !== "" ? ` — ${br.comment}` : "";
      lines.push(`  ${br.id}: ${range}${comment}`);
    }
  }

  return lines.join("\n");
}

/**
 * Resolve a contact/recruiter time zone to a display string — prefer the
 * human-readable `name` (e.g. `Pacific Time (US & Canada)`), fall back to
 * the IANA `location` (e.g. `America/New_York`), then `value`. Returns
 * `null` when none is present. (#545)
 */
function contactTimeZoneLabel(
  tz: { location: string | null; name: string | null; value: string | null } | null,
): string | null {
  if (tz === null) return null;
  const label = tz.name ?? tz.location ?? tz.value;
  return label != null && label !== "" ? label : null;
}

/**
 * Render the client-side hiring-manager contacts as an indented section
 * (#545). Returns `[]` (no section) when the contact list is empty — the
 * wire returns `[]` for jobs with no client-side contact bound. Mirrors
 * the `jobs show` Contacts section verbatim (per-command render convention).
 */
function formatContactsSection(contacts: engagements.CompanyRepresentative[]): string[] {
  if (contacts.length === 0) return [];
  const lines: string[] = ["", `Contacts (${contacts.length.toString()})`];
  for (const c of contacts) {
    const name = c.fullName ?? "(no name)";
    const position = c.position != null && c.position !== "" ? ` — ${c.position}` : "";
    lines.push(`  • ${name}${position}`);
    if (c.email != null && c.email !== "") lines.push(`    Email: ${c.email}`);
    if (c.phoneNumber != null && c.phoneNumber !== "") lines.push(`    Phone: ${c.phoneNumber}`);
    const tz = contactTimeZoneLabel(c.timeZone);
    if (tz !== null) lines.push(`    Time zone: ${tz}`);
  }
  return lines;
}

/**
 * Render one recruiter (current or handoff) as an indented sub-block under
 * the Points of Contact section (#545). `label` is the role ("Current
 * recruiter" / "Handoff recruiter").
 */
function formatRecruiterLines(label: string, r: engagements.Recruiter): string[] {
  const lines: string[] = [`  ${label}: ${r.fullName ?? "(no name)"}`];
  const cf = r.contactFields;
  if (cf !== null) {
    if (cf.email != null && cf.email !== "") lines.push(`    Email: ${cf.email}`);
    if (cf.phoneNumber != null && cf.phoneNumber !== "") lines.push(`    Phone: ${cf.phoneNumber}`);
    if (cf.skype != null && cf.skype !== "") lines.push(`    Skype: ${cf.skype}`);
    if (cf.communitySlackId != null && cf.communitySlackId !== "") lines.push(`    Slack: ${cf.communitySlackId}`);
  }
  const tz = contactTimeZoneLabel(r.timeZone);
  if (tz !== null) lines.push(`    Time zone: ${tz}`);
  return lines;
}

/**
 * Render the Toptal-side recruiter points-of-contact as an indented section
 * (#545). Returns `[]` when the struct is null or carries neither a current
 * nor a handoff recruiter.
 */
function formatPointsOfContactSection(poc: engagements.PointsOfContact | null): string[] {
  if (poc === null || (poc.current === null && poc.handoff === null)) return [];
  const lines: string[] = ["", "Points of Contact"];
  if (poc.current !== null) lines.push(...formatRecruiterLines("Current recruiter", poc.current));
  if (poc.handoff !== null) lines.push(...formatRecruiterLines("Handoff recruiter", poc.handoff));
  if (poc.kind != null && poc.kind !== "") lines.push(`  Kind: ${poc.kind}`);
  return lines;
}
