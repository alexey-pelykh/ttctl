// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { profile } from "@ttctl/core";

import { emitAddSuccess, emitRemoveSuccess, emitUpdateSuccess, wrapListEnvelope } from "../../../lib/envelopes.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { handleVisasError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Action handler for `ttctl profile visas list`. Reads the user's
 * travel-visa records and emits via the cross-CLI output helper from #71,
 * wrapped in the `{items, pageInfo?}` list envelope (#128) for json/yaml.
 */
export async function runProfileVisasList(format: OutputFormat): Promise<void> {
  const token = await loadAuthTokenOrExit("visas list", format);

  let visas: profile.visas.TravelVisa[];
  try {
    visas = await profile.visas.list(token);
  } catch (err) {
    handleVisasError("visas list", err, format);
    return;
  }

  emitResult(wrapListEnvelope(visas), format, {
    pretty: (data) => formatVisasText(data.items),
    table: (data) => formatVisasTable(data.items),
    empty: { command: "profile.visas.list" },
  });
}

/** Format the visas list as a human-readable summary. */
export function formatVisasText(visas: profile.visas.TravelVisa[]): string {
  if (visas.length === 0) return "(no travel visas)";
  const lines: string[] = [`${visas.length.toString()} travel visa${visas.length === 1 ? "" : "s"}:`];
  for (const v of visas) {
    const expiry = v.expiryDate !== null ? ` (expires ${v.expiryDate})` : "";
    lines.push(`  ${v.id} ${v.countryName} — ${v.visaType}${expiry}`);
  }
  return lines.join("\n");
}

/** Format the visas list as a `cli-table3`-rendered table. */
export function formatVisasTable(
  visas: profile.visas.TravelVisa[],
  terminalWidth: number = process.stdout.columns || 80,
): string {
  const idWidth = 14;
  const countryWidth = Math.max(15, Math.floor((terminalWidth - idWidth - 8) / 3));
  const typeWidth = Math.max(15, countryWidth);
  const expiryWidth = Math.max(12, terminalWidth - idWidth - countryWidth - typeWidth - 8);
  const table = new Table({
    head: ["id", "country", "type", "expires"],
    colWidths: [idWidth, countryWidth, typeWidth, expiryWidth],
    wordWrap: true,
  });
  for (const v of visas) {
    table.push([v.id, v.countryName, v.visaType, v.expiryDate ?? ""]);
  }
  return table.toString();
}

/**
 * Emit the post-mutation visa list, wrapped in the v0.4 envelope ABI
 * (#128). The visas core API returns the FULL post-mutation list rather
 * than the single mutated entity, so the envelope's `created` /
 * `updated` field carries the list (`TravelVisa[]`) rather than a
 * single `TravelVisa`. The pretty rendering keeps the existing
 * "success header + table" UX so users continue to see the post-state
 * at a glance.
 *
 * `verb` selects which envelope shape to emit:
 *
 * - `add` → `emitAddSuccess` with `created: TravelVisa[]`
 * - `update` → `emitUpdateSuccess` with `updated: TravelVisa[]`
 * - `remove` → `emitRemoveSuccess` with `removed: {id}` (the removed
 *   id is supplied by the caller; the post-state list is passed
 *   through `notice` for human pretty rendering, NOT for json/yaml —
 *   `removed` is a strict `{id}` shape per the AC)
 *
 * `id` is required for the `remove` verb; for `add`/`update` it may be
 * omitted (or supplied for inclusion in the pretty header).
 */
export function emitVisaListResult(
  visas: profile.visas.TravelVisa[],
  format: OutputFormat,
  verb: "add" | "update" | "remove",
  options: { id?: string; prettyHeader: string } = { prettyHeader: "" },
): void {
  if (verb === "remove") {
    const id = options.id;
    if (id === undefined) {
      throw new Error("emitVisaListResult: `id` is required for the `remove` verb");
    }
    emitRemoveSuccess({
      operation: "profile.visas.remove",
      format,
      id,
      prettySummary: options.prettyHeader,
    });
    if (format === "pretty" && visas.length > 0) {
      process.stdout.write(`${formatVisasTable(visas)}\n`);
    }
    return;
  }
  if (verb === "add") {
    emitAddSuccess({
      operation: "profile.visas.add",
      format,
      created: visas,
      prettySummary: options.prettyHeader,
      prettyEntity: () => formatVisasTable(visas),
    });
    return;
  }
  emitUpdateSuccess({
    operation: "profile.visas.update",
    format,
    updated: visas,
    prettySummary: options.prettyHeader,
    prettyEntity: () => formatVisasTable(visas),
  });
}

// Re-export the success-emitter helpers so call sites within visas/* can
// reach them via the same module they import `emitVisaListResult` from.
export { emitAddSuccess, emitRemoveSuccess, emitUpdateSuccess, wrapListEnvelope };
