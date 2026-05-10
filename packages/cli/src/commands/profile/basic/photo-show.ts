// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";

/**
 * Action handler for `ttctl profile basic photo show`. Loads the persisted
 * auth token and dispatches `profile.basic.photoShow()` to fetch the URLs
 * of the user's profile photo (default / original / small variants plus
 * the server's recommended crop rectangle). Routes the typed payload
 * through `emitResult` (#71) so users can switch between text / JSON /
 * table output.
 *
 * Domain errors are surfaced via `handlePhotoShowError`, which knows how
 * to render `Cf403Error` walkthroughs and `ProfileError` codes.
 */
export async function runProfileBasicPhotoShow(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("profile photo show", format);

  let photo: profile.basic.PhotoUrl;
  try {
    photo = await profile.basic.photoShow(token);
  } catch (err) {
    handlePhotoShowError(err, format);
    return;
  }

  emitResult(photo, format, {
    pretty: formatPhotoText,
    table: formatPhotoTable,
  });
}

function handlePhotoShowError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: "profile.basic.photo.show",
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.basic.ProfileError) {
    emitErrorAndExit({
      operation: "profile.basic.photo.show",
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `profile photo show failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: "profile.basic.photo.show",
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `profile photo show failed: ${message}`,
  });
}

/**
 * Format the typed photo payload as a multi-line summary. Pure function —
 * no I/O — directly unit-testable. Each variant URL gets its own line;
 * the cropped rectangle and resolution-readiness flag are summarised at
 * the bottom for quick visual inspection.
 */
export function formatPhotoText(payload: profile.basic.PhotoUrl): string {
  const lines: string[] = [];
  if (payload.default !== null) lines.push(`default:  ${payload.default}`);
  if (payload.original !== null) lines.push(`original: ${payload.original}`);
  if (payload.small !== null) lines.push(`small:    ${payload.small}`);
  if (lines.length === 0) {
    lines.push("(no photo set)");
  }
  if (payload.cropped !== null) {
    const c = payload.cropped;
    lines.push(`cropped:  x=${c.x.toString()} y=${c.y.toString()} ${c.width.toString()}×${c.height.toString()}`);
  }
  lines.push(`resolution: ${payload.isResolutionSatisfied ? "OK" : "below requirements"}`);
  return lines.join("\n");
}

/**
 * Format the typed photo payload as a `cli-table3`-rendered key/value
 * table. Same field selection as `formatPhotoText`. Width adapts to the
 * terminal but never narrower than enough for a wrapped URL.
 */
export function formatPhotoTable(
  payload: profile.basic.PhotoUrl,
  terminalWidth: number = process.stdout.columns || 80,
): string {
  // 18 cols leaves room for "resolution_ok" (13 chars) plus cli-table3
  // padding (2 chars per side), the longest key in the table.
  const fieldWidth = 18;
  const valueWidth = Math.max(40, terminalWidth - fieldWidth - 5);
  const table = new Table({
    head: ["Field", "Value"],
    colWidths: [fieldWidth, valueWidth],
    wordWrap: true,
  });
  table.push(["default", payload.default ?? "(unset)"]);
  table.push(["original", payload.original ?? "(unset)"]);
  table.push(["small", payload.small ?? "(unset)"]);
  if (payload.cropped !== null) {
    const c = payload.cropped;
    table.push(["cropped", `x=${c.x.toString()} y=${c.y.toString()} ${c.width.toString()}×${c.height.toString()}`]);
  }
  table.push(["resolution_ok", payload.isResolutionSatisfied ? "true" : "false"]);
  return table.toString();
}
