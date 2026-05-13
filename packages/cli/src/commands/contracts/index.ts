// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { Command, Option } from "commander";

import { TtctlError, contracts } from "@ttctl/core";

import { presentTtctlError } from "../../errors.js";
import { wrapListEnvelope, emitErrorAndExit } from "../../lib/envelopes.js";
import type { EnvelopeError } from "../../lib/envelopes.js";
import { emitResult } from "../../lib/output.js";
import { OUTPUT_FORMATS } from "../../lib/output.js";
import type { OutputFormat } from "../../lib/output.js";
import { loadAuthTokenOrExit } from "../profile/shared.js";

/**
 * Build the `ttctl contracts` command tree (#195). Two read-only leaves:
 *
 * | Leaf                          | Description                                |
 * |-------------------------------|--------------------------------------------|
 * | `list`                        | List talent-level contracts                |
 * | `show <id>`                   | Show one contract by id                    |
 *
 * `<id>` is the `Contract.id` from the `list` output.
 *
 * **Domain distinction**: this group surfaces *talent-level legal
 * documents* (Toptal Direct, Master Service Agreement) reachable via
 * `viewer.contracts` on the portal surface. Engagement-attached
 * commercial agreements (rates, hours, period for one project) live on
 * a different surface — use `ttctl engagements show <engagement-id>`.
 *
 * **Out of scope for v1** (per issue #195):
 *
 *   - Contract negotiation / mutation (read-only group).
 *   - Document download (no API surface exposes a PDF URL today).
 */
export function buildContractsCommand(): Command {
  const cmd = new Command("contracts").description(
    "Manage talent-level contracts (Toptal Direct, MSA, etc.).\n\n" +
      "For engagement-attached agreements (rates, hours, period for a specific project), see: `ttctl engagements show <id>`",
  );

  cmd
    .command("list")
    .description("List talent-level contracts (Toptal Direct, MSA, etc.)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runContractsList(options.output);
    });

  cmd
    .command("show")
    .description(
      "Show one contract by id.\n\n" +
        "Printed fields: id, kind, provider, status, billingType, signedAt, sentAt, isActive, verificationDeadline, title.",
    )
    .argument("<id>", "contract id (the row id from `contracts list`)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runContractsShow(id, options.output);
    });

  return cmd;
}

/**
 * Action handler for `ttctl contracts list`. Returns the contracts in
 * the v1.0 list envelope on `--json` / `--yaml`; renders a
 * `cli-table3` table on `--output=pretty`. An empty list is a
 * legitimate return value.
 */
export async function runContractsList(output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("contracts list", output);

  let items: contracts.Contract[];
  try {
    items = await contracts.list(token);
  } catch (err) {
    handleContractsError("contracts list", err, output);
  }

  emitResult(wrapListEnvelope(items), output, {
    pretty: (data) => formatContractsTable(data.items),
    table: (data) => formatContractsTable(data.items),
    empty: { command: "contracts.list" },
  });
}

/**
 * Action handler for `ttctl contracts show <id>`. Returns the bare
 * `Contract` detail shape on `--json` / `--yaml`; renders a
 * multi-line key:value layout on `--output=pretty`.
 */
export async function runContractsShow(id: string, output: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("contracts show", output);

  let item: contracts.Contract;
  try {
    item = await contracts.show(token, id);
  } catch (err) {
    handleContractsError("contracts show", err, output);
  }

  emitResult(item, output, {
    pretty: (data) => formatContractDetail(data),
  });
}

/**
 * Render the contracts list as a `cli-table3` table. Columns: id,
 * kind, provider, status, signedAt, active. `title` is intentionally
 * NOT a column (often long and redundant with kind/provider) — it
 * surfaces in `show <id>` and in `--json`/`--yaml`.
 */
export function formatContractsTable(
  items: contracts.Contract[],
  terminalWidth: number = process.stdout.columns || 100,
): string {
  if (items.length === 0) {
    const empty = new Table({ head: ["id", "kind", "provider", "status", "signed", "active"] });
    return empty.toString();
  }
  const idWidth = 22;
  const kindWidth = 22;
  const statusWidth = 12;
  const signedWidth = 12;
  const activeWidth = 8;
  // 6 columns × 2 padding + 7 borders ≈ 19
  const remaining = Math.max(15, terminalWidth - idWidth - kindWidth - statusWidth - signedWidth - activeWidth - 19);
  const providerWidth = Math.max(12, remaining);
  const table = new Table({
    head: ["id", "kind", "provider", "status", "signed", "active"],
    colWidths: [idWidth, kindWidth, providerWidth, statusWidth, signedWidth, activeWidth],
    colAligns: ["left", "left", "left", "left", "left", "center"],
    wordWrap: true,
  });
  for (const c of items) {
    table.push([
      c.id,
      c.kind ?? "—",
      c.provider ?? "—",
      c.status ?? "—",
      formatDate(c.signedAt),
      activeMarker(c.isActive),
    ]);
  }
  return table.toString();
}

/**
 * Render a single contract as a sectioned multi-line block. Pure
 * — directly unit-testable.
 */
export function formatContractDetail(c: contracts.Contract): string {
  const lines: string[] = [];
  lines.push(`Contract ${c.id}`);
  if (c.title !== null) lines.push(`  Title: ${c.title}`);
  if (c.kind !== null) lines.push(`  Kind: ${c.kind}`);
  if (c.provider !== null) lines.push(`  Provider: ${c.provider}`);
  if (c.status !== null) lines.push(`  Status: ${c.status}`);
  if (c.billingType !== null) lines.push(`  Billing type: ${c.billingType}`);
  if (c.isActive !== null) lines.push(`  Active: ${c.isActive ? "yes" : "no"}`);
  if (c.sentAt !== null) lines.push(`  Sent at: ${c.sentAt}`);
  if (c.signedAt !== null) lines.push(`  Signed at: ${c.signedAt}`);
  if (c.verificationDeadline !== null) lines.push(`  Verification deadline: ${c.verificationDeadline}`);
  return lines.join("\n");
}

/**
 * Trim an ISO 8601 timestamp to its `YYYY-MM-DD` prefix for table
 * rendering. Returns the input unchanged when it doesn't start with a
 * date.
 */
export function formatDate(value: string | null): string {
  if (value === null || value === "") return "—";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return value;
}

/**
 * Map `isActive` to a compact table-cell marker: `★` for active,
 * empty for inactive, `?` for null (forward-compat).
 */
export function activeMarker(isActive: boolean | null): string {
  if (isActive === null) return "?";
  return isActive ? "★" : "";
}

/**
 * Route service errors through the envelope ABI (#128). Mirrors
 * `handleEngagementsError` / `handlePaymentsError`.
 */
export function handleContractsError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: commandLabel.replace(/ /g, "."),
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof contracts.ContractsError) {
    const envelopeError: EnvelopeError = { code: err.code, message: err.message };
    const hint = hintForContractsCode(err.code);
    if (hint !== undefined) envelopeError.hint = hint;
    emitErrorAndExit({
      operation: commandLabel.replace(/ /g, "."),
      format,
      errors: [envelopeError],
      prettySummary: `${commandLabel} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: commandLabel.replace(/ /g, "."),
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${commandLabel} failed: ${message}`,
  });
}

function hintForContractsCode(code: contracts.ContractsErrorCode): string | undefined {
  switch (code) {
    case "NOT_FOUND":
      return "Verify the contract id (use `ttctl contracts list` to discover ids).";
    default:
      return undefined;
  }
}
