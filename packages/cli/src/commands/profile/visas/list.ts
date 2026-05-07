// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { loadAuthToken, profile, resolveAuthTokenPath } from "@ttctl/core";

import { resolveConfigForCli } from "../../../lib/config-context.js";
import { emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { handleConfigError, handleVisasError } from "./shared.js";

/**
 * Action handler for `ttctl profile visas list`. Reads the user's
 * travel-visa records and emits via the cross-CLI output helper from #71.
 */
export async function runProfileVisasList(format: OutputFormat): Promise<void> {
  const tokenPath = handleConfigError("visas list", () => {
    const { config, path: configPath } = resolveConfigForCli();
    return resolveAuthTokenPath({ config, configPath });
  });
  const token = await loadAuthToken(tokenPath);
  if (token === null) {
    process.stderr.write(
      "visas list failed (UNAUTHENTICATED): No auth token found. Run `ttctl auth signin` to sign in.\n",
    );
    process.exit(1);
  }

  let visas: profile.visas.TravelVisa[];
  try {
    visas = await profile.visas.list(token);
  } catch (err) {
    handleVisasError("visas list", err);
    return;
  }

  emitResult(visas, format, {
    text: formatVisasText,
    table: formatVisasTable,
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

/** Emit the post-mutation visa list with a success header. */
export function emitVisaListResult(
  visas: profile.visas.TravelVisa[],
  format: OutputFormat,
  successMessage: string,
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(visas)}\n`);
    return;
  }
  if (format === "table") {
    process.stdout.write(`${successMessage}\n${formatVisasTable(visas)}\n`);
    return;
  }
  process.stdout.write(`${successMessage}\n${formatVisasText(visas)}\n`);
}
