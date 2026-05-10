// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { formatYaml } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit, truncate } from "./_shared.js";

const COMMAND_LABEL = "profile external update";

/**
 * Action handler for `ttctl profile external update`.
 *
 * The issue spec listed `--portfolio-url` as one of the flags; that field
 * is not in the underlying `UpdateExternalProfilesInput` schema (the
 * portfolio URL is a server-determined read via `getPublicProfileUrl`).
 * The flags exposed here match the schema's settable external-profile
 * URLs: linkedin / github / website / twitter / behance / dribbble.
 */
export async function runProfileExternalUpdate(options: {
  linkedin?: string;
  github?: string;
  website?: string;
  twitter?: string;
  behance?: string;
  dribbble?: string;
  output: OutputFormat;
}): Promise<void> {
  const changes: profile.external.ExternalProfilesUpdate = {};
  if (options.linkedin !== undefined) changes.linkedin = options.linkedin;
  if (options.github !== undefined) changes.github = options.github;
  if (options.website !== undefined) changes.website = options.website;
  if (options.twitter !== undefined) changes.twitter = options.twitter;
  if (options.behance !== undefined) changes.behance = options.behance;
  if (options.dribbble !== undefined) changes.dribbble = options.dribbble;

  if (Object.keys(changes).length === 0) {
    process.stderr.write(
      `${COMMAND_LABEL} requires at least one of --linkedin, --github, --website, --twitter, --behance, --dribbble.\n` +
        `Example: ttctl profile external update --linkedin https://linkedin.com/in/your-handle\n`,
    );
    process.exit(1);
  }

  const token = await loadAuthTokenOrExit(COMMAND_LABEL);

  let result: profile.external.UpdateExternalProfilesResult;
  try {
    result = await profile.external.update(token, changes);
  } catch (err) {
    handleError(err);
    return;
  }

  process.stdout.write(`${formatUpdateResult(result, options.output)}\n`);
}

function handleError(err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.external.ProfileError) {
    process.stderr.write(`${COMMAND_LABEL} failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${COMMAND_LABEL} failed: ${message}\n`);
  process.exit(1);
}

/**
 * Format the typed update result for the chosen output mode. Pure
 * function — no I/O — directly unit-testable.
 */
export function formatUpdateResult(
  result: profile.external.UpdateExternalProfilesResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (format === "yaml") {
    return formatYaml(result);
  }

  // pretty — show-shape command, curated confirmation + echoed values
  const { profile: updated, notice } = result;
  const lines: string[] = ["External profiles updated."];
  if (updated.linkedin !== null) lines.push(truncate(`  linkedin: ${updated.linkedin}`, 80));
  if (updated.github !== null) lines.push(truncate(`  github: ${updated.github}`, 80));
  if (updated.website !== null) lines.push(truncate(`  website: ${updated.website}`, 80));
  if (updated.behance !== null) lines.push(truncate(`  behance: ${updated.behance}`, 80));
  if (updated.dribbble !== null) lines.push(truncate(`  dribbble: ${updated.dribbble}`, 80));
  if (notice !== null) lines.push(truncate(`  ${notice}`, 80));
  return lines.join("\n");
}
