// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { FreeTextError, resolveFreeText } from "../../../lib/freetext.js";
import { formatYaml } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";
import { truncate } from "./show.js";

/**
 * Action handler for `ttctl profile basic update` (also reachable as the
 * short-form `ttctl profile update`). Validates that at least one of
 * `--bio` / `--headline` was supplied (per the issue's AC), loads the
 * persisted auth token, dispatches the mutation via `profile.basic.set()`,
 * then prints either a human-readable confirmation or the raw payload
 * depending on the `--output` format.
 *
 * Both `--bio` and `--headline` accept the four-mode free-text input
 * surface from `lib/freetext.ts` (#70):
 *   - inline text (`--bio "..."`)
 *   - stdin (`--bio -`)
 *   - file (`--bio @path/to/bio.md`)
 *   - editor (`--edit`, opens `$EDITOR` on the bio buffer)
 *
 * Free-text resolution happens BEFORE auth/token I/O — input mistakes
 * (missing file, mode conflict) surface as `profile update failed (CODE)`
 * with an actionable code, never as a confusing post-network error.
 *
 * Note on naming: the user-facing CLI verb is `update` (per #69 AC and the
 * #68 epic verb economy `add / remove / update / show / list`); the core
 * function it dispatches to is `profile.basic.set()` (per #69's explicit
 * `updateProfile` → `set` rename to match the core verb economy
 * `add / rm / set / show / list`). The CLI verb mismatch with the core
 * function name is intentional: the CLI surface speaks the user-visible
 * verb economy, the core surface speaks the implementation verb economy.
 *
 * Domain errors are routed through `handleProfileUpdateError`, which knows
 * how to surface `Cf403Error` walkthroughs and `ProfileError` codes.
 */
export async function runProfileBasicUpdate(options: {
  bio?: string;
  headline?: string;
  edit?: boolean;
  output: OutputFormat;
}): Promise<void> {
  let bio: string | undefined;
  let headline: string | undefined;
  try {
    bio = await resolveFreeText(options.bio, {
      flagName: "bio",
      enableEditor: options.edit ?? false,
    });
    headline = await resolveFreeText(options.headline, { flagName: "headline" });
  } catch (err) {
    if (err instanceof FreeTextError) {
      process.stderr.write(`profile update failed (${err.code}): ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  if (bio === undefined && headline === undefined) {
    process.stderr.write(
      'profile update requires at least one of --bio, --headline, or --edit.\nExample: ttctl profile update --headline "Senior backend engineer"\n',
    );
    process.exit(1);
  }

  const changes: profile.basic.ProfileUpdate = {};
  if (bio !== undefined) changes.bio = bio;
  if (headline !== undefined) changes.headline = headline;

  const token = await loadAuthTokenOrExit("profile update");

  let result: profile.basic.UpdateProfileResult;
  try {
    result = await profile.basic.set(token, changes);
  } catch (err) {
    handleProfileUpdateError(err);
    return;
  }

  const output = formatUpdateResult(result, options.output);
  process.stdout.write(`${output}\n`);
}

/**
 * Map `profile.basic.set()` errors to actionable stderr messages and a
 * non-zero exit. Mirrors `handleProfileShowError` from `show.ts` — kept
 * separate so the user-visible "profile update failed (CODE)" prefix is
 * accurate (vs. a "profile show failed" prefix that would be misleading).
 *
 * `TtctlError` subclasses (`Cf403Error`, `Cf403PersistentError`,
 * `AuthRevokedError`, `SchedulerBearerExpired`) render in the uniform
 * `Error: ... / Recovery: ... / (Code: ...)` format defined in #77.
 * Domain `ProfileError` codes keep the existing "(CODE): message" rendering;
 * anything else gets a generic prefix.
 */
function handleProfileUpdateError(err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.basic.ProfileError) {
    process.stderr.write(`profile update failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`profile update failed: ${message}\n`);
  process.exit(1);
}

/**
 * Format the typed update result for the chosen output mode. Pure
 * function — no I/O — so directly unit-testable. The `pretty` branch
 * reads as a confirmation: "Profile updated" + the newly-stored values
 * for any field the server returned. JSON returns the raw structured
 * payload single-line; YAML emits the same shape as block-style YAML.
 */
export function formatUpdateResult(result: profile.basic.UpdateProfileResult, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (format === "yaml") {
    return formatYaml(result);
  }

  // pretty — show-shape command, curated confirmation + echoed values
  const { profile: updatedProfile, notice } = result;
  const lines: string[] = ["Profile updated."];
  if (updatedProfile.about !== null) {
    lines.push(truncate(`  bio: ${updatedProfile.about}`, 80));
  }
  if (updatedProfile.quote !== null) {
    lines.push(truncate(`  headline: ${updatedProfile.quote}`, 80));
  }
  if (notice !== null) {
    lines.push(truncate(`  ${notice}`, 80));
  }
  return lines.join("\n");
}
