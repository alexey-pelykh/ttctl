// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { Command, Option } from "commander";

import { me } from "@ttctl/core";

import { wrapListEnvelope } from "../../lib/envelopes.js";
import { handleDomainError } from "../../lib/error-routing.js";
import { emitResult, OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { parsePaginationFlag } from "../../lib/pagination.js";
import { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Build the `ttctl me` command tree. Viewer-scoped reads that aren't
 * profile-content or engagement domain. One sub-domain today:
 *
 * | Leaf                                                | Description                |
 * |-----------------------------------------------------|----------------------------|
 * | `actions list [--before <c>] [--after <c>] [--limit N]` | Viewer performed-actions audit log |
 *
 * **Pagination** is ADR-007 (ttctl) row 5 — bare bidirectional cursor:
 * `--before` / `--after` take opaque cursor tokens (the wire's `String`
 * cursors, surfaced verbatim — no client-side translation), `--limit`
 * caps the page size. These name the wire args 1:1 (surface-honesty).
 */
export function buildMeCommand(): Command {
  const cmd = new Command("me").description("Viewer-scoped reads (your own audit log, etc.).");

  const actions = cmd.command("actions").description("Your performed-actions audit log (read-only).");

  actions
    .command("list")
    .description(
      "List your performed actions — the per-role audit log (status changes, applications submitted, etc.).\n\n" +
        "Pagination (ADR-007 row 5, bidirectional cursor): --before / --after take opaque cursor tokens; --limit caps the page size.",
    )
    .addOption(new Option("--before <cursor>", "opaque cursor — return actions before this point"))
    .addOption(new Option("--after <cursor>", "opaque cursor — return actions after this point"))
    .addOption(
      new Option("--limit <number>", "max actions to return").argParser((raw) => parsePaginationFlag("--limit", raw)),
    )
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { before?: string; after?: string; limit?: number; output: OutputFormat }) => {
      await runMeActionsList(options);
    });

  return cmd;
}

/**
 * Action handler for `ttctl me actions list`. Returns the actions in
 * the v1.0 list envelope on `--json` / `--yaml`; renders a `cli-table3`
 * table on `--output=pretty`. An empty list is a legitimate return.
 */
export async function runMeActionsList(options: {
  before?: string;
  after?: string;
  limit?: number;
  output: OutputFormat;
}): Promise<void> {
  const token = await loadAuthTokenOrExit("me actions list", options.output);

  const opts: me.ListOptions = {};
  if (options.before !== undefined) opts.before = options.before;
  if (options.after !== undefined) opts.after = options.after;
  if (options.limit !== undefined) opts.limit = options.limit;

  let items: me.PerformedAction[];
  try {
    items = await me.actions.list(token, opts);
  } catch (err) {
    handleMeError("me actions list", err, options.output);
  }

  emitResult(wrapListEnvelope(items), options.output, {
    pretty: (data) => formatActionsTable(data.items),
    table: (data) => formatActionsTable(data.items),
    empty: { command: "me.actions.list" },
  });
}

/**
 * Render the actions list as a `cli-table3` table. Columns: occurred,
 * category, description. The description column shows the raw `template`
 * (its `variables` substitutions surface in `--json` / `--yaml`) — TTCtl
 * does not invent a substitution syntax it hasn't verified on the wire.
 */
export function formatActionsTable(
  items: me.PerformedAction[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    return new Table({ head: ["occurred", "category", "description"] }).toString();
  }
  const occurredWidth = 22;
  const categoryWidth = 24;
  // 3 columns × 2 padding + 4 borders ≈ 10
  const descWidth = Math.max(20, terminalWidth - occurredWidth - categoryWidth - 10);
  const table = new Table({
    head: ["occurred", "category", "description"],
    colWidths: [occurredWidth, categoryWidth, descWidth],
    colAligns: ["left", "left", "left"],
    wordWrap: true,
  });
  for (const a of items) {
    table.push([formatTimestamp(a.occurredAt), a.category ?? "—", a.description?.template ?? "—"]);
  }
  return table.toString();
}

/** Trim an ISO 8601 timestamp to `YYYY-MM-DD HH:MM`; pass through non-ISO input. */
export function formatTimestamp(value: string | null): string {
  if (value === null || value === "") return "—";
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]} ${match[2]}` : value;
}

/**
 * Thin wrapper around the shared CLI error router closed over
 * `me.MeError`. The router applies the envelope ABI branching uniformly.
 */
export function handleMeError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  handleDomainError(commandLabel, err, me.MeError, format);
}
