// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { TtctlError, profile } from "@ttctl/core";
import type { ProfileShowQuery } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";

/**
 * Action handler for `ttctl profile basic show` (also reachable as the
 * short-form `ttctl profile show`). Loads the persisted auth token, fetches
 * the profile via `profile.basic.show()` from `@ttctl/core`, and emits the
 * payload through the shared `emitResult` helper. Maps domain errors to
 * actionable stderr messages and a non-zero exit code.
 *
 * Wired to the cross-CLI output helper (`packages/cli/src/lib/output.ts`)
 * as the proof-of-integration for #71: every other `show` / `list` leaf
 * adopts the same helper + formatter pattern.
 *
 * No-token case: surface as `UNAUTHENTICATED` with the same hint as a
 * gateway 401, so the user-visible message ("run `ttctl auth signin`") is
 * uniform across "never signed in" and "signed in but expired".
 */
export async function runProfileBasicShow(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile show");

  let payload: ProfileShowQuery;
  try {
    payload = await profile.basic.show(token);
  } catch (err) {
    handleProfileShowError(err);
    return;
  }

  emitResult(payload, format, {
    text: formatProfileText,
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
function handleProfileShowError(err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.basic.ProfileError) {
    process.stderr.write(`profile show failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`profile show failed: ${message}\n`);
  process.exit(1);
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
 * Format the typed profile payload as the text-mode summary. Pure function —
 * no I/O — directly unit-testable. Trims to 80 columns at most so the
 * default terminal width is honored; truncated strings end with `…`.
 *
 * Returns a curated subset of the rich `ProfileShowQuery` payload (identity
 * + role + selected derived fields). For the full payload, callers should
 * use `--output json`.
 */
export function formatProfileText(payload: ProfileShowQuery): string {
  const viewer = payload.viewer;
  if (viewer === null) {
    return "(no viewer bound to this session)";
  }

  const role = viewer.viewerRole;
  const viewerProfile = role.profile;
  const skills = collectPublicSkills(viewerProfile);
  const specializations = collectSpecializations(role);
  const hoursRatio = formatHoursRatio(role);

  const lines: string[] = [truncate(role.fullName, 80), truncate(`  ${role.email}`, 80)];
  if (role.phoneNumber !== "") {
    lines.push(truncate(`  ${role.phoneNumber}`, 80));
  }
  if (viewerProfile.city !== "") {
    lines.push(truncate(`  ${viewerProfile.city}`, 80));
  }
  lines.push(truncate(`  Vertical: ${role.vertical.name}`, 80));
  if (specializations.length > 0) {
    lines.push(truncate(`  Specializations: ${specializations.join(", ")}`, 80));
  }
  lines.push(truncate(`  Availability: ${role.availability} (${hoursRatio})`, 80));
  lines.push(truncate(`  Rate: ${role.hourlyRate.verbose}/hr`, 80));
  lines.push(truncate(`  TimeZone: ${role.timeZone.value}`, 80));
  if (skills.length > 0) {
    lines.push(truncate(`  Skills: ${skills.join(", ")}`, 80));
  }
  return lines.join("\n");
}

/**
 * Format the typed profile payload as a `cli-table3`-rendered key/value
 * table. Pure function — no I/O — directly unit-testable. The table sizes
 * itself to `terminalWidth` (defaulting to `process.stdout.columns || 80`)
 * with `wordWrap` enabled; long values wrap inside the value column rather
 * than overflowing the terminal.
 *
 * The same curated field selection as `formatProfileText` (identity + role
 * + selected derived fields). Use `--output json` for the full payload.
 *
 * `terminalWidth` is parameterised so tests can verify width adaptation
 * without monkey-patching `process.stdout.columns`.
 */
export function formatProfileTable(
  payload: ProfileShowQuery,
  terminalWidth: number = process.stdout.columns || 80,
): string {
  const viewer = payload.viewer;
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

  const rows: [string, string][] = [
    ["name", role.fullName],
    ["email", role.email],
    ["phone", role.phoneNumber],
    ["city", viewerProfile.city || "(unset)"],
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

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return `${s.slice(0, width - 1)}…`;
}

// Helper re-export for sibling `set.ts` / `photo-show.ts` / `photo-upload.ts`.
// Internal to this folder; not part of the package's public surface.
export { truncate };
