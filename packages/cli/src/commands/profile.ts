// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Cf403Error, ProfileError, discoverCookieJarPath, getProfile, loadCookieJar, updateProfile } from "@ttctl/core";
import type { ProfileShowQuery, ProfileUpdate, UpdateProfileResult } from "@ttctl/core";
import { Command, Option } from "commander";

/**
 * Output format for `ttctl profile show`. The default `text` is a
 * human-readable summary trimmed to fit an 80-column terminal. `json` returns
 * the raw typed payload (no formatting). `table` is the same fields as `text`
 * but laid out as a `key\tvalue` table for shell pipe consumption (cut, awk).
 */
export type ProfileOutputFormat = "text" | "json" | "table";

const OUTPUT_FORMATS: ProfileOutputFormat[] = ["text", "json", "table"];

/**
 * Build the `ttctl profile` command tree. Currently exposes two subcommands:
 * `show` (read-side) and `update` (write-side). Future subcommands
 * (`skills add`, etc.) attach here.
 */
export function buildProfileCommand(): Command {
  const profile = new Command("profile").description("View and update your Toptal Talent profile");

  profile
    .command("show")
    .description("Print a summary of the signed-in user's Toptal Talent profile")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies ProfileOutputFormat),
    )
    .action(async (options: { output: ProfileOutputFormat }) => {
      await runProfileShow(options.output);
    });

  profile
    .command("update")
    .description("Update editable fields on the signed-in user's profile (currently bio + headline)")
    .option("--bio <text>", "long-form bio / about-me text")
    .option("--headline <text>", "short tagline / quote shown above your profile")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies ProfileOutputFormat),
    )
    .action(async (options: { bio?: string; headline?: string; output: ProfileOutputFormat }) => {
      await runProfileUpdate(options);
    });

  return profile;
}

/**
 * Action handler for `ttctl profile show`. Loads the persisted cookie jar
 * from its discovered location, fetches the profile via `getProfile`, and
 * prints the chosen format to stdout. Maps domain errors to actionable
 * stderr messages and a non-zero exit code.
 */
export async function runProfileShow(format: ProfileOutputFormat): Promise<void> {
  const jarPath = discoverCookieJarPath();
  const jar = await loadCookieJar(jarPath);

  let payload: ProfileShowQuery;
  try {
    payload = await getProfile(jar);
  } catch (err) {
    handleProfileError(err);
    return;
  }

  const output = formatProfile(payload, format);
  process.stdout.write(`${output}\n`);
}

/**
 * Map `getProfile` errors to actionable stderr messages and a non-zero exit.
 *
 * `Cf403Error.message` is already a multi-line walkthrough — print it
 * verbatim. `ProfileError.UNAUTHENTICATED` already contains the
 * `ttctl auth signin` hint. Other `ProfileError` codes get a generic prefix.
 */
function handleProfileError(err: unknown): never {
  if (err instanceof Cf403Error) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  if (err instanceof ProfileError) {
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
 * truncated strings end with `…`.
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
  const profile = role.profile;
  const skills = profile.skillSets.nodes
    .filter((n): n is NonNullable<typeof n> => n !== null)
    .filter((n) => n.public)
    .slice(0, 5)
    .map((n) => n.skill.name);
  const allocatedHours = role.allocatedHours.toString();
  const hiredHours = role.hiredHours.toString();
  const availability = `${hiredHours}/${allocatedHours}h`;

  if (format === "table") {
    const rows: [string, string][] = [
      ["name", role.fullName],
      ["email", role.email],
      ["city", profile.city || "(unset)"],
      ["allocated_hours", allocatedHours],
      ["hired_hours", hiredHours],
      ["availability", availability],
      ["skills", skills.join(",")],
    ];
    return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
  }

  // text — 80-column friendly
  const lines: string[] = [truncate(role.fullName, 80), truncate(`  ${role.email}`, 80)];
  if (profile.city !== "") {
    lines.push(truncate(`  ${profile.city}`, 80));
  }
  lines.push(truncate(`  Availability: ${availability} (hired/allocated)`, 80));
  if (skills.length > 0) {
    lines.push(truncate(`  Skills: ${skills.join(", ")}`, 80));
  }
  return lines.join("\n");
}

function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return `${s.slice(0, width - 1)}…`;
}

/**
 * Action handler for `ttctl profile update`. Validates that at least one of
 * `--bio` / `--headline` was supplied (per the issue's AC), loads the
 * persisted cookie jar, dispatches the mutation via `updateProfile`, then
 * prints either a human-readable confirmation or the raw payload depending
 * on the `--output` format.
 *
 * Domain errors are routed through `handleProfileError`, which already knows
 * how to surface `Cf403Error` walkthroughs and `ProfileError` codes — adding
 * `USER_ERROR` and `VALIDATION_ERROR` to its repertoire required no changes
 * since it falls through to a generic `${err.code}: ${err.message}` line.
 */
export async function runProfileUpdate(options: {
  bio?: string;
  headline?: string;
  output: ProfileOutputFormat;
}): Promise<void> {
  if (options.bio === undefined && options.headline === undefined) {
    process.stderr.write(
      'profile update requires at least one of --bio or --headline.\nExample: ttctl profile update --headline "Senior backend engineer"\n',
    );
    process.exit(1);
  }

  const changes: ProfileUpdate = {};
  if (options.bio !== undefined) changes.bio = options.bio;
  if (options.headline !== undefined) changes.headline = options.headline;

  const jarPath = discoverCookieJarPath();
  const jar = await loadCookieJar(jarPath);

  let result: UpdateProfileResult;
  try {
    result = await updateProfile(jar, changes);
  } catch (err) {
    handleProfileError(err);
    return;
  }

  const output = formatUpdateResult(result, options.output);
  process.stdout.write(`${output}\n`);
}

/**
 * Format the typed update result for the chosen output mode. Pure function —
 * no I/O — so directly unit-testable. The text branch reads as a
 * confirmation: "Profile updated" + the newly-stored values for any field
 * the server returned. JSON returns the raw structured payload; table
 * emits one `key\tvalue` row per returned field for shell-pipe consumption.
 */
export function formatUpdateResult(result: UpdateProfileResult, format: ProfileOutputFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const { profile, notice } = result;

  if (format === "table") {
    const rows: [string, string][] = [
      ["status", "updated"],
      ["bio", profile.about ?? ""],
      ["headline", profile.quote ?? ""],
    ];
    if (notice !== null) rows.push(["notice", notice]);
    return rows.map(([k, v]) => `${k}\t${v}`).join("\n");
  }

  // text — confirmation + echoed values
  const lines: string[] = ["Profile updated."];
  if (profile.about !== null) {
    lines.push(truncate(`  bio: ${profile.about}`, 80));
  }
  if (profile.quote !== null) {
    lines.push(truncate(`  headline: ${profile.quote}`, 80));
  }
  if (notice !== null) {
    lines.push(truncate(`  ${notice}`, 80));
  }
  return lines.join("\n");
}
