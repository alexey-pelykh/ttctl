// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { getCliDryRun } from "../../../lib/dry-run.js";
import { emitDryRunSuccess, emitErrorAndExit, emitUpdateSuccess } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import { FreeTextError, resolveFreeText } from "../../../lib/freetext.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";
import { truncate } from "./show.js";

/**
 * Action handler for `ttctl profile basic update` (also reachable as the
 * short-form `ttctl profile update`). Validates that at least one of
 * `--bio` / `--headline` / `--twitter` was supplied (per the issue's
 * AC), loads the persisted auth token, dispatches the mutation via
 * `profile.basic.set()`, then prints either a human-readable
 * confirmation or the raw payload depending on the `--output` format.
 *
 * Both `--bio` and `--headline` accept the four-mode free-text input
 * surface from `lib/freetext.ts` (#70):
 *   - inline text (`--bio "..."`)
 *   - stdin (`--bio -`)
 *   - file (`--bio @path/to/bio.md`)
 *   - editor (`--edit`, opens `$EDITOR` on the bio buffer)
 *
 * `--twitter` does NOT participate in the free-text surface — it's a
 * short value passed straight to `profile.basic.set`, which normalises a
 * URL or leading-`@` form down to the bare handle the live wire shape
 * stores (#526; e.g. `https://x.com/alexey_pelykh` → `alexey_pelykh`).
 * An empty string (`--twitter ""`) is the explicit "clear it" intent.
 *
 * Free-text resolution happens BEFORE auth/token I/O — input mistakes
 * (missing file, mode conflict) surface as `profile update failed (CODE)`
 * with an actionable code, never as a confusing post-network error.
 *
 * SMS consent is client-side only, not a server gate (#540): the web
 * profile editor's "agree to receive text messages" checkbox is
 * enforced client-side, so `UPDATE_BASIC_INFO` is not gated on it
 * server-side and `profile basic update` is never blocked by consent
 * state. See `profile.basic.set` JSDoc for the evidence.
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
  twitter?: string;
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
      emitErrorAndExit({
        operation: "profile.basic.update",
        format: options.output,
        errors: [{ code: err.code, message: err.message }],
        prettySummary: `profile update failed (${err.code}): ${err.message}`,
      });
    }
    throw err;
  }

  // Twitter is a short value — no stdin / @file / editor modes. Pass it
  // straight through (including the empty string, which is the documented
  // "clear it" intent per ProfileUpdate's contract); `profile.basic.set`
  // normalises a URL or leading-`@` form to the bare handle (#526).
  const twitter = options.twitter;

  if (bio === undefined && headline === undefined && twitter === undefined) {
    emitErrorAndExit({
      operation: "profile.basic.update",
      format: options.output,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "profile update requires at least one of --bio, --headline, --twitter, or --edit.",
          hint: 'ttctl profile update --headline "Senior backend engineer"',
        },
      ],
      prettySummary:
        'profile update requires at least one of --bio, --headline, --twitter, or --edit.\nExample: ttctl profile update --headline "Senior backend engineer"',
    });
  }

  const changes: profile.basic.ProfileUpdate = {};
  if (bio !== undefined) changes.bio = bio;
  if (headline !== undefined) changes.headline = headline;
  if (twitter !== undefined) changes.twitter = twitter;

  const token = await loadAuthTokenOrExit("profile update", options.output);

  // Route through the core's `dryRun` option (issue #52) when the
  // global `--dry-run` flag is set. The captured value is `false` for
  // normal apply-path invocations — `set()` returns `kind: "applied"`
  // and the existing `emitUpdateSuccess` path runs. With `dryRun: true`,
  // `set()` short-circuits BEFORE any transport call (read or write)
  // and returns `kind: "preview"` carrying a structured
  // `DryRunPreview` — emit it as a `dryRun: true` envelope and exit 0.
  const dryRun = getCliDryRun();

  let outcome: profile.basic.SetOutcome;
  try {
    outcome = await profile.basic.set(token, changes, { dryRun });
  } catch (err) {
    handleProfileUpdateError(err, options.output);
    return;
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "profile.basic.update",
      format: options.output,
      preview: outcome.preview,
    });
    return;
  }

  const { result } = outcome;
  emitUpdateSuccess({
    operation: "profile.basic.update",
    format: options.output,
    updated: result,
    prettySummary: "Profile updated.",
    prettyEntity: formatUpdatePrettyEntity,
    notice: result.notice ?? undefined,
  });
}

/**
 * Route `profile.basic.set()` errors through the envelope ABI (#128).
 * Mirrors `handleProfileShowError` from `show.ts` — kept separate so
 * the user-visible "profile update failed (CODE)" prefix is accurate
 * (vs. a "profile show failed" prefix that would be misleading).
 */
function handleProfileUpdateError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: "profile.basic.update",
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.basic.ProfileError) {
    emitErrorAndExit({
      operation: "profile.basic.update",
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `profile update failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: "profile.basic.update",
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `profile update failed: ${message}`,
  });
}

/**
 * Pretty entity preview for the basic-update envelope. Kept separate
 * from the JSON / YAML wire shape: the wire payload is the full
 * `UpdateProfileResult`; this helper only renders the human-readable
 * subset (bio + headline). The notice (when present) flows through
 * the envelope's `notice` field, NOT this body — `emitUpdateSuccess`
 * appends it as a trailing indented line in pretty mode.
 *
 * Lines are truncated at 80 columns (one trailing `…` ellipsis when
 * the source exceeds the limit) so the terminal output stays in a
 * single line per field even for verbose bios.
 *
 * Pure — directly unit-testable.
 */
export function formatUpdatePrettyEntity(result: profile.basic.UpdateProfileResult): string {
  const { profile: updatedProfile } = result;
  const lines: string[] = [];
  if (updatedProfile.about !== null) {
    lines.push(truncate(`bio: ${updatedProfile.about}`, 80));
  }
  if (updatedProfile.quote !== null) {
    lines.push(truncate(`headline: ${updatedProfile.quote}`, 80));
  }
  if (updatedProfile.twitter !== null) {
    lines.push(truncate(`twitter: ${updatedProfile.twitter}`, 80));
  }
  return lines.join("\n");
}
