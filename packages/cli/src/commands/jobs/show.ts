// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications, jobs } from "@ttctl/core";

import { handleApplicationsError } from "../applications/shared.js";
import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatDate, formatFixedRate, formatRate, handleJobsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Options for {@link runJobsShow}. `withQuestions` (issue #437) opts
 * the user-facing detail view into a parallel `applications.applyQuestions`
 * fetch so the matcher + expertise question inventory inlines under a
 * `questions` field — discoverability convenience for authoring an
 * answers-file payload without a second command. Default `false`
 * preserves pre-#437 behavior verbatim.
 */
export interface JobsShowOptions {
  withQuestions?: boolean;
}

/**
 * Compact JSON / YAML envelope projection of the matcher + expertise
 * questions when `--with-questions` is supplied. Short field names
 * (`matcher` / `expertise`) under a `questions` namespace per the issue's
 * behavioral scenarios — distinct from the service-layer's
 * `ApplicationQuestions` shape (`matcherQuestions` / `expertiseQuestions`)
 * where the longer names disambiguate when those arrays are referenced
 * standalone.
 */
export interface JobsShowQuestionsProjection {
  matcher: applications.ApplicationQuestion[];
  expertise: applications.ApplicationQuestion[];
}

/**
 * Combined detail-view projection emitted when `--with-questions` is
 * supplied (issue #437). The bare {@link jobs.JobDetail} flows through
 * unchanged; a top-level `questions` field carries the matcher +
 * expertise inventory. JSON / YAML consumers project further as needed.
 */
export type JobsShowDetailWithQuestions = jobs.JobDetail & { questions: JobsShowQuestionsProjection };

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
 *
 * Issue #437: when `opts.withQuestions === true`, additionally invokes
 * `applications.applyQuestions(token, id)` in parallel with the existing
 * `jobs.show()` fetch (Promise.all so both round-trips overlap), then
 * merges the four-field {@link applications.ApplicationQuestion}
 * inventories under a top-level `questions` field. Pretty output gains
 * the Matcher Questions / Expertise Questions sections (rendered even
 * when the inventory is empty — the section header surfaces the zero
 * count so the user reads "Toptal returned an empty inventory" not "the
 * CLI silently dropped the section"). When `withQuestions` is omitted
 * or false, behavior is identical to the pre-#437 surface — no
 * `JobApplicationQuestions` wire query is sent.
 */
export async function runJobsShow(id: string, output: OutputFormat, opts: JobsShowOptions = {}): Promise<void> {
  const token = await loadAuthTokenOrExit("jobs show", output);

  const withQuestions = opts.withQuestions === true;
  let item: jobs.JobDetail;
  let questions: applications.ApplicationQuestions | null = null;
  try {
    if (withQuestions) {
      // Promise.all so the two wire calls overlap. Rejection from
      // either side short-circuits the other; the error-routing dispatch
      // below picks the matching domain handler so the user sees the
      // correct `(<CODE>)` envelope (jobs vs applications).
      [item, questions] = await Promise.all([jobs.show(token, id), applications.applyQuestions(token, id)]);
    } else {
      item = await jobs.show(token, id);
    }
  } catch (err) {
    if (err instanceof applications.ApplicationsError) {
      handleApplicationsError("jobs show", err, output);
    }
    handleJobsError("jobs show", err, output);
  }

  if (questions === null) {
    emitResult(item, output, {
      pretty: (data) => formatJobDetail(data),
    });
    return;
  }
  const combined: JobsShowDetailWithQuestions = {
    ...item,
    questions: {
      matcher: questions.matcherQuestions,
      expertise: questions.expertiseQuestions,
    },
  };
  emitResult(combined, output, {
    pretty: (data) => `${formatJobDetail(data)}\n${formatQuestionsSections(data.questions)}`,
  });
}

/**
 * Render the matcher + expertise question inventories as two
 * sectioned multi-line blocks. Sections fire unconditionally when
 * `--with-questions` is supplied — the count in the header (e.g.
 * "Matcher Questions (0)") makes empty inventories self-evident
 * instead of silently omitted. Pure — directly unit-testable.
 *
 * Each question renders as `  • <identifier>: <prompt>` so the
 * identifier (the wire `id` used as the `questionId` key when
 * building answers-file payloads) is visually disambiguated from
 * the human prompt that follows the colon. Empty prompts (defensive
 * — the service projects expertise-question subjects with `?? ""`
 * when neither inline fragment matched) render as
 * `  • <identifier>:` with no trailing prompt text.
 */
export function formatQuestionsSections(questions: JobsShowQuestionsProjection): string {
  const lines: string[] = [];
  lines.push(`Matcher Questions (${questions.matcher.length.toString()})`);
  for (const q of questions.matcher) {
    lines.push(formatQuestionEntry(q));
  }
  lines.push("");
  lines.push(`Expertise Questions (${questions.expertise.length.toString()})`);
  for (const q of questions.expertise) {
    lines.push(formatQuestionEntry(q));
  }
  return lines.join("\n");
}

function formatQuestionEntry(q: applications.ApplicationQuestion): string {
  const tail = q.prompt === "" ? "" : ` ${q.prompt}`;
  return `  • ${q.identifier}:${tail}`;
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
  if (job.fixedRate !== null) lines.push(`  Fixed rate: ${formatFixedRate(job.fixedRate)}`);
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

  // Counterparty identity (#545): client-side hiring managers + Toptal-side
  // recruiter points-of-contact. Grouped right after the Client block.
  lines.push(...formatContactsSection(job.contacts));
  lines.push(...formatPointsOfContactSection(job.pointsOfContact));

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

/**
 * Resolve a contact/recruiter time zone to a display string — prefer the
 * human-readable `name`, fall back to the IANA `location`, then `value`.
 * Returns `null` when none is present. (#545) Duplicated from
 * `engagements show` per the per-command render convention.
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
 * (#545). Returns `[]` when the contact list is empty. Mirrors the
 * `engagements show` Contacts section verbatim.
 */
function formatContactsSection(contacts: jobs.CompanyRepresentative[]): string[] {
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
 * the Points of Contact section (#545).
 */
function formatRecruiterLines(label: string, r: jobs.Recruiter): string[] {
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
function formatPointsOfContactSection(poc: jobs.PointsOfContact | null): string[] {
  if (poc === null || (poc.current === null && poc.handoff === null)) return [];
  const lines: string[] = ["", "Points of Contact"];
  if (poc.current !== null) lines.push(...formatRecruiterLines("Current recruiter", poc.current));
  if (poc.handoff !== null) lines.push(...formatRecruiterLines("Handoff recruiter", poc.handoff));
  if (poc.kind != null && poc.kind !== "") lines.push(`  Kind: ${poc.kind}`);
  return lines;
}
