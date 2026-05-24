// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit, emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit, truncate } from "./_shared.js";

const COMMAND_LABEL = "profile external update";
const OPERATION = "profile.external.update";

/**
 * Action handler for `ttctl profile external update`.
 *
 * The issue spec listed `--portfolio-url` as one of the flags; that field
 * is not in the underlying `UpdateExternalProfilesInput` schema (the
 * portfolio URL is a server-determined read via `getPublicProfileUrl`).
 * The flags exposed here match the schema's settable external-profile
 * URLs: linkedin / github / website / behance / dribbble. `--twitter` is
 * accepted but NOT settable here — the live server rejects `twitter` on
 * `ExternalProfilesInput` (the entire batch fails transactionally when
 * twitter is co-supplied with valid fields). Supplying `--twitter` short-
 * circuits to an actionable `VALIDATION_ERROR` redirect pointing at
 * `ttctl profile basic update --twitter` (#526 reopen — better than
 * commander's bare "unknown option" or a silent drop), surfaced BEFORE
 * auth I/O and reusing `profile.external.TWITTER_NOT_EXTERNAL_MESSAGE` so
 * the wording matches the core guard and the MCP tool. The read-side
 * (`ttctl profile external show`) continues to surface `twitter` because
 * the `Profile` entity still exposes it.
 */
export async function runProfileExternalUpdate(options: {
  linkedin?: string;
  github?: string;
  website?: string;
  behance?: string;
  dribbble?: string;
  twitter?: string;
  output: OutputFormat;
}): Promise<void> {
  // #526: twitter is not settable here. Surface the actionable redirect
  // (the shared `TWITTER_NOT_EXTERNAL_MESSAGE` wording, so CLI / MCP / core
  // stay in lockstep) BEFORE auth I/O — matching the empty-input guard's
  // pre-auth ordering, and so a not-signed-in user learns where twitter
  // lives without first being asked to authenticate. The core
  // `profile.external.update` guard remains the authoritative gate for
  // programmatic callers.
  if (options.twitter !== undefined) {
    emitErrorAndExit({
      operation: OPERATION,
      format: options.output,
      errors: [{ code: "VALIDATION_ERROR", message: profile.external.TWITTER_NOT_EXTERNAL_MESSAGE }],
      prettySummary: `${COMMAND_LABEL} failed (VALIDATION_ERROR): ${profile.external.TWITTER_NOT_EXTERNAL_MESSAGE}`,
    });
  }

  const changes: profile.external.ExternalProfilesUpdate = {};
  if (options.linkedin !== undefined) changes.linkedin = options.linkedin;
  if (options.github !== undefined) changes.github = options.github;
  if (options.website !== undefined) changes.website = options.website;
  if (options.behance !== undefined) changes.behance = options.behance;
  if (options.dribbble !== undefined) changes.dribbble = options.dribbble;

  if (Object.keys(changes).length === 0) {
    emitErrorAndExit({
      operation: OPERATION,
      format: options.output,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: `${COMMAND_LABEL} requires at least one of --linkedin, --github, --website, --behance, --dribbble.`,
          hint: "ttctl profile external update --linkedin https://linkedin.com/in/your-handle",
        },
      ],
      prettySummary:
        `${COMMAND_LABEL} requires at least one of --linkedin, --github, --website, --behance, --dribbble.\n` +
        "Example: ttctl profile external update --linkedin https://linkedin.com/in/your-handle",
    });
  }

  const token = await loadAuthTokenOrExit(COMMAND_LABEL, options.output);

  let result: profile.external.UpdateExternalProfilesResult;
  try {
    result = await profile.external.update(token, changes);
  } catch (err) {
    handleError(err, options.output);
    return;
  }

  emitUpdateSuccess({
    operation: OPERATION,
    format: options.output,
    updated: result,
    prettySummary: "External profiles updated.",
    prettyEntity: formatUpdatePrettyEntity,
    notice: result.notice ?? undefined,
  });
}

function handleError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: OPERATION,
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.external.ProfileError) {
    emitErrorAndExit({
      operation: OPERATION,
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${COMMAND_LABEL} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: OPERATION,
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${COMMAND_LABEL} failed: ${message}`,
  });
}

/**
 * Pretty entity preview for the external-update envelope. Renders the
 * non-null URL sextet (linkedin / github / website / twitter / behance /
 * dribbble), each truncated at 80 columns. The notice (when present)
 * flows through the envelope's `notice` field, NOT this body —
 * `emitUpdateSuccess` appends it as a trailing indented line in pretty
 * mode.
 *
 * `twitter` is still rendered when the server echoes a non-null value
 * even though it is no longer settable via this command (see #526):
 * the user may have set it via the web portal previously, and surfacing
 * the persisted value lets them confirm post-update state without a
 * separate `external show` call. Ordering matches the `external show`
 * formatter for cross-command consistency.
 *
 * Pure — directly unit-testable.
 */
export function formatUpdatePrettyEntity(result: profile.external.UpdateExternalProfilesResult): string {
  const { profile: updated } = result;
  const lines: string[] = [];
  if (updated.linkedin !== null) lines.push(truncate(`linkedin: ${updated.linkedin}`, 80));
  if (updated.github !== null) lines.push(truncate(`github: ${updated.github}`, 80));
  if (updated.website !== null) lines.push(truncate(`website: ${updated.website}`, 80));
  if (updated.twitter !== null) lines.push(truncate(`twitter: ${updated.twitter}`, 80));
  if (updated.behance !== null) lines.push(truncate(`behance: ${updated.behance}`, 80));
  if (updated.dribbble !== null) lines.push(truncate(`dribbble: ${updated.dribbble}`, 80));
  return lines.join("\n");
}
