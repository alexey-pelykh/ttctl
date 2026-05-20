// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications } from "@ttctl/core";

import { emitResult } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleApplicationsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl applications reject-reasons` (#411).
 *
 * Reads the IR decline-reason inventory from
 * `PlatformConfiguration.availabilityRequestRejectReasonsV3`. Pass one
 * of the surfaced `key` values to `ttctl applications reject <id>
 * --reason <key>`.
 *
 * Read-only, idempotent — safe to call repeatedly.
 */
export async function runApplicationsRejectReasons(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("applications reject-reasons", output);

  let reasons: applications.AvailabilityRequestRejectReasons;
  try {
    reasons = await applications.rejectReasons(token);
  } catch (err) {
    handleApplicationsError("applications reject-reasons", err, output);
  }

  emitResult(reasons, output, {
    pretty: (data) => formatRejectReasons(data),
  });
}

/**
 * Render the reject-reason inventory as a sectioned multi-line block.
 * Pure — directly unit-testable.
 *
 * Layout:
 *
 *     Fixed-kind reasons
 *       key                            value                                 (mandatory)
 *       <key>                          <label>                                ✱
 *
 *     Flexible-kind reasons
 *       key                            value
 *       <key>                          <label>
 *
 * The `✱` marker on a row indicates `isMandatory: true` — a free-text
 * comment is required when declining with that reason.
 */
export function formatRejectReasons(reasons: applications.AvailabilityRequestRejectReasons): string {
  const lines: string[] = [];

  const renderSection = (title: string, rows: applications.AvailabilityRequestRejectReason[]): void => {
    lines.push(title);
    if (rows.length === 0) {
      lines.push("  (none)");
      return;
    }
    const keyWidth = Math.max(3, ...rows.map((r) => r.key.length));
    lines.push(`  ${"key".padEnd(keyWidth)}  value  (mandatory)`);
    for (const row of rows) {
      const marker = row.isMandatory ? "  ✱" : "   ";
      lines.push(`  ${row.key.padEnd(keyWidth)}  ${row.value}${marker}`);
    }
  };

  renderSection("Fixed-kind reasons", reasons.fixed);
  lines.push("");
  renderSection("Flexible-kind reasons", reasons.flexible);

  return lines.join("\n");
}
