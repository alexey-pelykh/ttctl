// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitErrorAndExit, wrapListEnvelope } from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile reviews list";

/**
 * Action handler for `ttctl profile reviews list`.
 *
 * Lists pending section reviews for the signed-in user, wrapped in the
 * v0.4 list envelope (#128). Each row carries the `reviewId` (needed by
 * `approve-section`) and an `items` array, where each item carries its
 * own `id` (needed by `approve-item`) and the underlying `itemId` (the
 * entity being reviewed).
 */
export async function runProfileReviewsList(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, format);

  let result: profile.reviews.SectionReview[];
  try {
    result = await profile.reviews.list(token);
  } catch (err) {
    handleError(err, format);
    return;
  }

  emitResult(wrapListEnvelope(result), format, {
    pretty: (data) => formatReviewsText(data.items),
    table: (data) => formatReviewsTable(data.items),
    empty: { command: "profile.reviews.list" },
  });
}

function handleError(err: unknown, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: "profile.reviews.list",
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.reviews.ProfileError) {
    emitErrorAndExit({
      operation: "profile.reviews.list",
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${COMMAND_LABEL} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: "profile.reviews.list",
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${COMMAND_LABEL} failed: ${message}`,
  });
}

/** Pure formatter — directly unit-testable. */
export function formatReviewsText(data: profile.reviews.SectionReview[]): string {
  if (data.length === 0) return "No pending section reviews.";
  const lines: string[] = [`Pending section reviews (${data.length.toString()}):`];
  for (const row of data) {
    const sectionLabel = row.section ?? "(unknown section)";
    const requestedAt = row.requestedAt ?? "?";
    lines.push(`  - section: ${sectionLabel}  reviewId: ${row.id}  requestedAt: ${requestedAt}`);
    if (row.items.length > 0) {
      for (const item of row.items) {
        lines.push(`      item: id=${item.id}  itemId=${item.itemId}  requestedAt=${item.requestedAt ?? "?"}`);
      }
    }
  }
  return lines.join("\n");
}

/** Pure formatter — directly unit-testable. */
export function formatReviewsTable(data: profile.reviews.SectionReview[]): string {
  const header = ["section", "reviewId", "itemId", "sectionItemId", "requestedAt"];
  if (data.length === 0) return header.join("\t");
  const rows: string[][] = [header];
  for (const row of data) {
    if (row.items.length === 0) {
      rows.push([row.section ?? "", row.id, "", "", row.requestedAt ?? ""]);
      continue;
    }
    for (const item of row.items) {
      rows.push([row.section ?? "", row.id, item.itemId, item.id, item.requestedAt ?? ""]);
    }
  }
  return rows.map((cols) => cols.join("\t")).join("\n");
}
