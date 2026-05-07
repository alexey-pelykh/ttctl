// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit, resolveAuthTokenPathOrExit } from "./_shared.js";

const COMMAND_LABEL = "profile reviews list";

/**
 * Action handler for `ttctl profile reviews list`.
 *
 * Lists pending section reviews for the signed-in user. Each row carries
 * the `reviewId` (needed by `approve-section`) and an `items` array, where
 * each item carries its own `id` (needed by `approve-item`) and the
 * underlying `itemId` (the entity being reviewed).
 */
export async function runProfileReviewsList(format: OutputFormat): Promise<void> {
  const tokenPath = resolveAuthTokenPathOrExit(COMMAND_LABEL);
  const token = await loadAuthTokenOrExit(COMMAND_LABEL, tokenPath);

  let result: profile.reviews.SectionReview[];
  try {
    result = await profile.reviews.list(token);
  } catch (err) {
    handleError(err);
    return;
  }

  emitResult(result, format, {
    text: formatReviewsText,
    table: formatReviewsTable,
  });
}

function handleError(err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.reviews.ProfileError) {
    process.stderr.write(`${COMMAND_LABEL} failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${COMMAND_LABEL} failed: ${message}\n`);
  process.exit(1);
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
