// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { TtctlError, profile } from "@ttctl/core";
import type { ProfileShowQuery } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import { renderMultiParagraph, unsetOr } from "../../../lib/format-helpers.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";

/**
 * Composite payload rendered by the `basic show` formatters: the
 * mobile-gateway `ProfileShowQuery` (identity, role, viewer profile,
 * skills) plus the talent-profile `BasicInfo` projection (`bio`,
 * `headline`, `languages`) added in #127.
 *
 * The talent-profile-side fields are NOT on the wire `Profile` type
 * surfaced by `mobile-gateway` (per the comment block in
 * `services/profile/basic/index.ts`); the read surface dispatches a
 * second call against `talent_profile/graphql` to fetch them. The
 * formatter consumes the merged shape so the `pretty` rendering can
 * surface every editable field (#129 closes the audit-confirmed
 * field-dropping defects from #124).
 *
 * `basicInfo` is `null` when the second call failed in a way that
 * shouldn't fail the whole show command (network blip on the secondary
 * surface); the formatter degrades gracefully — bio/headline/languages
 * render as `(unset)` rather than throwing. Hard failures (auth-revoked,
 * 403) propagate verbatim via the action handler's error path.
 */
export interface BasicShowPayload {
  profile: ProfileShowQuery;
  basicInfo: profile.basic.BasicInfo | null;
}

/**
 * Action handler for `ttctl profile basic show` (also reachable as the
 * short-form `ttctl profile show`). Loads the persisted auth token, fetches
 * the profile via `profile.basic.show()` from `@ttctl/core`, and emits the
 * payload through the shared `emitResult` helper. Maps domain errors to
 * actionable stderr messages and a non-zero exit code.
 *
 * Two-call read surface (post-#129): in addition to the mobile-gateway
 * `ProfileShow` query, the handler dispatches `getBasicInfo()` against
 * `talent_profile/graphql` to fetch `bio` / `headline` / `languages`
 * (the audit-confirmed query-root-cause fields from #124, fixed in #127).
 * The two payloads merge into {@link BasicShowPayload} for the
 * formatter / JSON / YAML branches.
 *
 * Errors from the secondary `getBasicInfo()` call are non-fatal: the
 * handler swallows transport-level / GraphQL failures and renders
 * `basicInfo: null`, so a glitch on the secondary surface doesn't blank
 * the whole show. Auth-revoked + Cloudflare-403 still propagate (those
 * indicate the user's session is no longer valid; the primary call would
 * have hit them too).
 *
 * No-token case: surface as `UNAUTHENTICATED` with the same hint as a
 * gateway 401, so the user-visible message ("run `ttctl auth signin`") is
 * uniform across "never signed in" and "signed in but expired".
 */
export async function runProfileBasicShow(format: OutputFormat, full = false): Promise<void> {
  const token = await loadAuthTokenOrExit("profile show", format);

  // Full-projection path (#469): fetch the FULL portal `GetViewer` projection
  // instead of the trimmed `ProfileShow` default. JSON/YAML emit the whole
  // rich object; `pretty` renders a curated extended summary. The heavy
  // legal-doc bodies + operational scopes only ride the wire on demand.
  if (full) {
    let rich: profile.RichViewer;
    try {
      rich = await profile.showRich(token);
    } catch (err) {
      handleProfileShowError(err, format);
      return;
    }
    emitResult(rich, format, { pretty: formatRichViewerPretty });
    return;
  }

  let profilePayload: ProfileShowQuery;
  try {
    profilePayload = await profile.basic.show(token);
  } catch (err) {
    handleProfileShowError(err, format);
    return;
  }

  let basicInfo: profile.basic.BasicInfo | null = null;
  try {
    basicInfo = await profile.basic.getBasicInfo(token);
  } catch (err) {
    // Auth-revoked / Cloudflare-403 are session-level failures — let them
    // surface so the user knows to re-authenticate. The primary `show()`
    // would have hit the same issue, so we shouldn't be here unless the
    // talent-profile surface specifically is rejecting; either way, the
    // user needs to act on it.
    if (err instanceof TtctlError) {
      handleProfileShowError(err, format);
      return;
    }
    // Anything else (NETWORK_ERROR, GRAPHQL_ERROR on the talent-profile
    // surface) is non-fatal: the primary payload landed, so render the
    // partial result with `(unset)` placeholders for the talent-profile
    // fields. A diagnostic on stderr keeps the failure visible without
    // breaking the user's `--output json` pipe.
    process.stderr.write(
      `note: failed to fetch talent_profile basic info; rendering without bio/headline/languages: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  emitResult({ profile: profilePayload, basicInfo }, format, {
    pretty: formatProfilePretty,
    table: formatProfileTable,
  });
}

/**
 * Map `profile.basic.show()` errors to actionable stderr messages and a
 * non-zero exit.
 *
 * `TtctlError` subclasses (`Cf403Error`, `Cf403PersistentError`,
 * `AuthRevokedError`, `SchedulerBearerExpired`) render in the uniform
 * `Error: ... / Recovery: ... / (Code: ...)` format defined in #77.
 * Domain `ProfileError` codes (NO_VIEWER, GRAPHQL_ERROR, USER_ERROR, …)
 * keep the existing "(CODE): message" rendering. Anything else gets a
 * generic prefix.
 */
function handleProfileShowError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: "profile.basic.show",
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.basic.ProfileError) {
    emitErrorAndExit({
      operation: "profile.basic.show",
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `profile show failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: "profile.basic.show",
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `profile show failed: ${message}`,
  });
}

type ViewerRole = NonNullable<ProfileShowQuery["viewer"]>["viewerRole"];
type ViewerProfile = ViewerRole["profile"];

function collectPublicSkills(viewerProfile: ViewerProfile): string[] {
  return viewerProfile.skillSets.nodes
    .filter((n): n is NonNullable<typeof n> => n !== null)
    .filter((n) => n.public)
    .slice(0, 5)
    .map((n) => n.skill.name);
}

function collectSpecializations(role: ViewerRole): string[] {
  return role.specializations
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .slice(0, 3)
    .map((s) => s.title);
}

function formatHoursRatio(role: ViewerRole): string {
  return `${role.hiredHours.toString()}/${role.allocatedHours.toString()}h`;
}

/**
 * CTA-styled `(unset)` placeholder for the bio field — the audit-defined
 * convention is to nudge the user toward the corresponding `update`
 * command rather than leaving a bare `(unset)` on a field that's the
 * primary value-add of the profile. Other fields get the bare placeholder.
 */
const BIO_UNSET_HINT = `(unset — set with: ttctl profile basic update --bio "<text>")`;

/**
 * Render the headline as a single line. Headlines are short by API
 * contract (the talent-profile UI caps `Profile.quote` at ~120 chars);
 * we don't truncate further — `pretty` doesn't truncate.
 */
function formatHeadlineLine(headline: string | null | undefined, indent: string): string {
  return `${indent}Headline: ${unsetOr(headline)}`;
}

/**
 * Render the bio as either a CTA-style unset line or a multi-paragraph
 * block. The block format puts `Bio:` on its own line and indents the
 * body two further spaces so paragraph breaks (`\n\n` in source) survive
 * as actual blank lines — required by the AC ("no `\n\n` literal escape
 * leak").
 */
function formatBioBlock(bio: string | null | undefined, indent: string): string {
  if (bio === null || bio === undefined || bio === "") {
    return `${indent}Bio: ${BIO_UNSET_HINT}`;
  }
  return renderMultiParagraph("Bio", bio, indent);
}

/**
 * Render the languages list. ≤3 entries fit on a comma-separated line;
 * >3 entries wrap onto a sub-list (one entry per line, indented one
 * level deeper) for legibility.
 */
function formatLanguagesLine(languages: profile.basic.ProfileLanguage[], indent: string): string {
  if (languages.length === 0) {
    return `${indent}Languages: ${unsetOr(null)}`;
  }
  const names = languages.map((l) => l.name);
  if (names.length <= 3) {
    return `${indent}Languages: ${names.join(", ")}`;
  }
  const sub = names.map((n) => `${indent}  - ${n}`).join("\n");
  return `${indent}Languages:\n${sub}`;
}

/**
 * Format the merged `basic show` payload as the post-#129 `pretty`
 * summary. Pure function — no I/O — directly unit-testable.
 *
 * Field ordering reflects the audit's recommendation: identity (name,
 * email, phone, city) first, then user-narrative fields (headline, bio,
 * languages — the audit-confirmed previously-dropped fields from
 * #127), then role metadata (vertical, specializations, availability,
 * rate, time zone, public skills), then server-side metadata (photo URL).
 *
 * Null convention: fields the user CAN set but hasn't render as
 * `(unset)` (per the audit's standardisation rec); the bio gets the
 * CTA-style hint to nudge the user toward `update --bio`. Skip-if-null
 * is reserved for fields that aren't user-editable from this CLI
 * (`phoneNumber` empty, no public skills, …).
 *
 * Pretty does NOT truncate to 80 columns (per the issue AC: "For long
 * URLs / IDs: don't truncate (this is `pretty`, not `table`)"); the
 * terminal wraps if the user's window is narrow. The `table` format
 * keeps width discipline (`cli-table3` `wordWrap: true`).
 */
export function formatProfilePretty(payload: BasicShowPayload): string {
  const viewer = payload.profile.viewer;
  if (viewer === null) {
    return "(no viewer bound to this session)";
  }

  const role = viewer.viewerRole;
  const viewerProfile = role.profile;
  const skills = collectPublicSkills(viewerProfile);
  const specializations = collectSpecializations(role);
  const hoursRatio = formatHoursRatio(role);
  const indent = "  ";

  const lines: string[] = [role.fullName, `${indent}${role.email}`];
  if (role.phoneNumber !== "") {
    lines.push(`${indent}${role.phoneNumber}`);
  }
  if (viewerProfile.city !== "") {
    lines.push(`${indent}${viewerProfile.city}`);
  }

  // User-narrative fields (post-#127 talent-profile reads). Always emit
  // these — the (unset) placeholder is itself the user-visible signal
  // that the field exists and can be edited.
  lines.push(formatHeadlineLine(payload.basicInfo?.headline, indent));
  lines.push(formatBioBlock(payload.basicInfo?.bio, indent));
  lines.push(formatLanguagesLine(payload.basicInfo?.languages ?? [], indent));

  // Role metadata. `Vertical` and `Availability` are not user-editable
  // from this CLI; they render as-is (no `(unset)` for non-editable
  // fields per the audit's skip-if-null escape hatch).
  lines.push(`${indent}Vertical: ${role.vertical.name}`);
  if (specializations.length > 0) {
    lines.push(`${indent}Specializations: ${specializations.join(", ")}`);
  }
  lines.push(`${indent}Availability: ${role.availability} (${hoursRatio})`);
  lines.push(`${indent}Rate: ${role.hourlyRate.verbose}/hr`);
  lines.push(`${indent}TimeZone: ${role.timeZone.value}`);
  if (skills.length > 0) {
    lines.push(`${indent}Skills: ${skills.join(", ")}`);
  }

  // Server-side metadata last. `photo.large` may be empty when the user
  // hasn't uploaded a photo — render `(unset)` so the field is visible
  // (it's user-editable via `photo upload`).
  lines.push(`${indent}Photo: ${unsetOr(role.photo.large)}`);

  return lines.join("\n");
}

/**
 * Format the merged `basic show` payload as a `cli-table3`-rendered
 * key/value table. Pure function — no I/O — directly unit-testable. The
 * table sizes itself to `terminalWidth` (defaulting to
 * `process.stdout.columns || 80`) with `wordWrap` enabled.
 *
 * The table representation is internal-only post-#126 — the user-visible
 * `--output=pretty` shape-dispatches to `pretty` for show verbs and to
 * `table` for list verbs; `basic show` is a show verb. The table slot
 * remains for the rare narrow-terminal use case where the curated
 * key:value pretty layout overflows; the dispatcher's fallback path
 * uses it.
 *
 * `terminalWidth` is parameterised so tests can verify width adaptation
 * without monkey-patching `process.stdout.columns`.
 */
export function formatProfileTable(
  payload: BasicShowPayload,
  terminalWidth: number = process.stdout.columns || 80,
): string {
  const viewer = payload.profile.viewer;
  if (viewer === null) {
    const table = new Table({ head: ["Field", "Value"] });
    table.push(["name", "(no viewer)"]);
    return table.toString();
  }

  const role = viewer.viewerRole;
  const viewerProfile = role.profile;
  const skills = collectPublicSkills(viewerProfile);
  const specializations = collectSpecializations(role);
  const hoursRatio = formatHoursRatio(role);
  const info = payload.basicInfo;
  const languageNames = (info?.languages ?? []).map((l) => l.name);

  const rows: [string, string][] = [
    ["name", role.fullName],
    ["email", role.email],
    ["phone", role.phoneNumber],
    ["city", unsetOr(viewerProfile.city)],
    ["headline", unsetOr(info?.headline)],
    ["bio", unsetOr(info?.bio)],
    ["languages", languageNames.length > 0 ? languageNames.join(", ") : unsetOr(null)],
    ["vertical", role.vertical.name],
    ["specializations", specializations.join(",")],
    ["availability", role.availability],
    ["allocated_hours", role.allocatedHours.toString()],
    ["hired_hours", role.hiredHours.toString()],
    ["hours", hoursRatio],
    ["hourly_rate", role.hourlyRate.verbose],
    ["time_zone", role.timeZone.value],
    ["public_resume_url", role.publicResumeUrl],
    ["skills", skills.join(",")],
    ["photo_url", unsetOr(role.photo.large)],
  ];

  // Allocate the field column at 20 cols. cli-table3 reserves 2 chars of
  // each column for left+right cell padding, so the visible content area
  // is 18 chars — enough for the longest key ("public_resume_url" at 17
  // chars). The value column gets the rest minus ~5 for box drawing + the
  // outer padding. Floor at 20 so the table stays readable on very narrow
  // terminals.
  const fieldWidth = 20;
  const valueWidth = Math.max(20, terminalWidth - fieldWidth - 5);
  const table = new Table({
    head: ["Field", "Value"],
    colWidths: [fieldWidth, valueWidth],
    wordWrap: true,
  });
  for (const [k, v] of rows) {
    table.push([k, v]);
  }
  return table.toString();
}

/**
 * Curated `pretty` summary for `profile show --verbose` (#469). Surfaces
 * the rich-projection fields the trimmed default omits — legal-doc
 * acceptance, post-activation/market state, hire-me banner, rate insight —
 * on top of base identity/role. The complete `GetViewer` object (incl. the
 * inline legal-doc bodies and operational scopes) is available via
 * `--output json` / `yaml`; pretty stays a digest.
 */
export function formatRichViewerPretty(viewer: profile.RichViewer): string {
  const role = viewer.viewerRole;
  const indent = "  ";
  const lines: string[] = [role.fullName, `${indent}${role.email}`];
  if (role.phoneNumber !== "") lines.push(`${indent}${role.phoneNumber}`);

  lines.push(`${indent}Vertical: ${role.vertical.name}`);
  const specs = role.specializations.slice(0, 3).map((s) => s.title);
  if (specs.length > 0) lines.push(`${indent}Specializations: ${specs.join(", ")}`);
  lines.push(
    `${indent}Availability: ${role.availability} (${role.hiredHours.toString()}/${role.allocatedHours.toString()}h)`,
  );
  lines.push(`${indent}Rate: ${role.hourlyRate.verbose}/hr`);
  lines.push(`${indent}TimeZone: ${role.timeZone.value}`);
  lines.push(`${indent}Post-activation: ${role.postActivationStepsStatus}`);
  lines.push(`${indent}Specialization type: ${role.specializationType}`);
  if (role.blockedStatus.isBlocked) {
    lines.push(`${indent}Blocked: ${unsetOr(role.blockedStatus.reason, "yes")}`);
  }

  // Market condition (the talent's vertical demand signal).
  lines.push(
    `${indent}Market: ${role.vertical.marketCondition.condition} ` +
      `(global: ${role.vertical.globalMarketCondition.condition})`,
  );

  // Rate insight — competitiveness + recommended.
  const ri = role.rateInsight.hourly;
  lines.push(
    `${indent}Rate insight: ${ri.currentRateCompetitive ? "competitive" : "below market"}, ` +
      `recommended ${ri.recommendedRate}`,
  );

  // Hire-me banner state.
  lines.push(
    `${indent}Hire-me banner: ${viewer.hireMeBanner.enabled ? "enabled" : "disabled"} ` +
      `(verification: ${viewer.hireMeBanner.verificationStatus})`,
  );

  // Legal-document acceptance — Code of Conduct + Terms of Service.
  lines.push(`${indent}Code of Conduct: ${viewer.codeOfConduct.acceptedAt ? "accepted" : "not accepted"}`);
  lines.push(`${indent}Terms of Service: action ${viewer.termsOfService.requiredAction ?? "NONE"}`);

  // Pending-work counters (surveys, quizzes, notifications, job activity).
  lines.push(
    `${indent}Pending: ${viewer.pendingSurveys.length.toString()} surveys, ` +
      `${viewer.pendingQuizzes.length.toString()} quizzes, ` +
      `${viewer.pendingNotifications.length.toString()} notifications`,
  );
  lines.push(`${indent}Active job activity: ${viewer.jobActivityList.entities.length.toString()}`);

  lines.push(`${indent}Public résumé: ${unsetOr(role.publicResumeUrl)}`);
  return lines.join("\n");
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return `${s.slice(0, width - 1)}…`;
}

// Helper re-export for sibling `set.ts` / `photo-show.ts` / `photo-upload.ts`.
// Internal to this folder; not part of the package's public surface.
export { truncate };
