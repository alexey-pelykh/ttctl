// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, TtctlError, loadAuthToken, profile, resolveAuthTokenPath, resolveConfig } from "@ttctl/core";
import type { ProfileShowQuery } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";

/**
 * Output format for `ttctl profile show`. The default `text` is a
 * human-readable summary trimmed to fit an 80-column terminal. `json` returns
 * the raw typed payload (no formatting). `table` is the same fields as `text`
 * but laid out as a `key\tvalue` table for shell pipe consumption (cut, awk).
 */
export type ProfileOutputFormat = "text" | "json" | "table";

export const OUTPUT_FORMATS: ProfileOutputFormat[] = ["text", "json", "table"];

/**
 * Resolve the auth-token path from the user's `.ttctl.yaml` (honors the
 * optional `auth-token-path` field; falls back to platform defaults). A
 * `ConfigError` is surfaced verbatim and routed to stderr — the underlying
 * message already contains the actionable hint ("See README for setup").
 *
 * Used by both `profile basic show` and `profile basic update` to keep the
 * config-loading boilerplate in one place.
 */
function resolveAuthTokenPathOrExit(commandLabel: "profile show" | "profile update"): string {
  try {
    const { config, path: configPath } = resolveConfig();
    return resolveAuthTokenPath({ config, configPath });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${commandLabel} failed (CONFIG_ERROR): ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Action handler for `ttctl profile basic show` (also reachable as the
 * short-form `ttctl profile show`). Loads the persisted auth token, fetches
 * the profile via `profile.basic.show()` from `@ttctl/core`, and prints the
 * chosen format to stdout. Maps domain errors to actionable stderr messages
 * and a non-zero exit code.
 *
 * No-token case: surface as `UNAUTHENTICATED` with the same hint as a
 * gateway 401, so the user-visible message ("run `ttctl auth signin`") is
 * uniform across "never signed in" and "signed in but expired".
 */
export async function runProfileBasicShow(format: ProfileOutputFormat): Promise<void> {
  const tokenPath = resolveAuthTokenPathOrExit("profile show");
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "profile show failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  let payload: ProfileShowQuery;
  try {
    payload = await profile.basic.show(token);
  } catch (err) {
    handleProfileShowError(err);
    return;
  }

  const output = formatProfile(payload, format);
  process.stdout.write(`${output}\n`);
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

/**
 * Format the typed profile payload according to the requested output mode.
 *
 * Pure function — no I/O — so it's directly unit-testable. The text branch
 * trims to 80 columns at most so the default terminal width is honored;
 * truncated strings end with `…`. The text/table branches surface a curated
 * subset of the rich `ProfileShowQuery` payload (identity + role + selected
 * derived fields); `json` returns the entire typed payload verbatim so power
 * users can pipe it through `jq` / `yq` for fields the curated views omit.
 */
export function formatProfile(payload: ProfileShowQuery, format: ProfileOutputFormat): string {
  if (format === "json") {
    return JSON.stringify(payload, null, 2);
  }

  const viewer = payload.viewer;
  if (viewer === null) {
    return format === "table" ? "name\t(no viewer)" : "(no viewer bound to this session)";
  }

  const role = viewer.viewerRole;
  const profileSubObject = role.profile;
  const skills = profileSubObject.skillSets.nodes
    .filter((n): n is NonNullable<typeof n> => n !== null)
    .filter((n) => n.public)
    .slice(0, 5)
    .map((n) => n.skill.name);
  const specializations = role.specializations
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .slice(0, 3)
    .map((s) => s.title);
  const allocatedHours = role.allocatedHours.toString();
  const hiredHours = role.hiredHours.toString();
  const hoursRatio = `${hiredHours}/${allocatedHours}h`;
  const availability = role.availability;
  const verticalName = role.vertical.name;
  const hourlyRate = role.hourlyRate.verbose;
  const timeZoneId = role.timeZone.value;

  if (format === "table") {
    const rows: [string, string][] = [
      ["name", role.fullName],
      ["email", role.email],
      ["phone", role.phoneNumber],
      ["city", profileSubObject.city || "(unset)"],
      ["vertical", verticalName],
      ["specializations", specializations.join(",")],
      ["availability", availability],
      ["allocated_hours", allocatedHours],
      ["hired_hours", hiredHours],
      ["hours", hoursRatio],
      ["hourly_rate", hourlyRate],
      ["time_zone", timeZoneId],
      ["public_resume_url", role.publicResumeUrl],
      ["skills", skills.join(",")],
    ];
    return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
  }

  // text — 80-column friendly
  const lines: string[] = [truncate(role.fullName, 80), truncate(`  ${role.email}`, 80)];
  if (role.phoneNumber !== "") {
    lines.push(truncate(`  ${role.phoneNumber}`, 80));
  }
  if (profileSubObject.city !== "") {
    lines.push(truncate(`  ${profileSubObject.city}`, 80));
  }
  lines.push(truncate(`  Vertical: ${verticalName}`, 80));
  if (specializations.length > 0) {
    lines.push(truncate(`  Specializations: ${specializations.join(", ")}`, 80));
  }
  lines.push(truncate(`  Availability: ${availability} (${hoursRatio})`, 80));
  lines.push(truncate(`  Rate: ${hourlyRate}/hr`, 80));
  lines.push(truncate(`  TimeZone: ${timeZoneId}`, 80));
  if (skills.length > 0) {
    lines.push(truncate(`  Skills: ${skills.join(", ")}`, 80));
  }
  return lines.join("\n");
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return `${s.slice(0, width - 1)}…`;
}

// Helper re-exports for the sibling `set.ts` to share the auth-token
// resolution and ellipsis truncation without duplicating either. Internal to
// this folder; not part of the package's public surface.
export { resolveAuthTokenPathOrExit, truncate };
