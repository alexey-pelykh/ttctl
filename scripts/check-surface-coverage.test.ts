// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { analyzeSurfaceCoverage, canonicalRef, classifyDisposition } from "./check-surface-coverage.js";

// Drives the gate's pure core against in-memory fixtures. Runs under root vitest
// (`pnpm test:coverage`), NOT `turbo run test` (per-package, never sees scripts/).

type Fixtures = Record<string, string>;

function readerFor(files: Fixtures): (relPath: string) => string[] | null {
  return (relPath) => (relPath in files ? (files[relPath] as string).split("\n") : null);
}

/** Map each discovered export's canonical ref → its disposition. */
function dispositionsOf(files: Fixtures): Map<string, string> {
  const { exports, coverage } = analyzeSurfaceCoverage(Object.keys(files), readerFor(files));
  const out = new Map<string, string>();
  for (const exp of exports) {
    const status = coverage.get(exp) ?? { cli: false, mcp: false, cliFile: null, mcpFile: null };
    out.set(canonicalRef(exp), classifyDisposition(exp, status));
  }
  return out;
}

const EMP_INDEX = [
  `export async function list(token: string) {`,
  `  return [];`,
  `}`,
  `// Separate file per AC; re-exported so the surface-coverage gate sees it.`,
  `export { reportingToAutocomplete } from "./reporting-to-autocomplete.js";`,
  `export type { ReportingToSuggestion } from "./reporting-to-autocomplete.js";`,
].join("\n");

const EMP_SIBLING = [
  `export interface ReportingToSuggestion {`,
  `  id: string;`,
  `}`,
  `export async function reportingToAutocomplete(token: string, search: string) {`,
  `  return [];`,
  `}`,
].join("\n");

const EMP_CLI = [
  `await profile.employment.reportingToAutocomplete(token, prefix, { limit });`,
  `await profile.employment.list(token);`,
].join("\n");

const EMP_MCP = [
  `await profile.employment.reportingToAutocomplete(auth.token, input.prefix, {});`,
  `await profile.employment.list(auth.token);`,
].join("\n");

const EMP_INDEX_PATH = "packages/core/src/services/profile/employment/index.ts";
const EMP_SIBLING_PATH = "packages/core/src/services/profile/employment/reporting-to-autocomplete.ts";
const EMP_CLI_PATH = "packages/cli/src/commands/profile/employment/index.ts";
const EMP_MCP_PATH = "packages/mcp/src/tools/profile/employment.ts";

describe("check-surface-coverage — sibling re-export following", () => {
  it("follows a re-exported async function to its sibling file (the reportingToAutocomplete shape)", () => {
    const d = dispositionsOf({
      [EMP_INDEX_PATH]: EMP_INDEX,
      [EMP_SIBLING_PATH]: EMP_SIBLING,
      [EMP_CLI_PATH]: EMP_CLI,
      [EMP_MCP_PATH]: EMP_MCP,
    });
    expect(d.get("profile.employment.reportingToAutocomplete")).toBe("BOTH");
    // In-index declarations are still parsed alongside the re-export.
    expect(d.get("profile.employment.list")).toBe("BOTH");
    // `export type { ... } from` is a type re-export, never an operation.
    expect(d.has("profile.employment.ReportingToSuggestion")).toBe(false);
  });

  it("follows a re-exported `const namespace = { async ... }` block", () => {
    const index = `export { gadgets } from "./gadgets.js";`;
    const sibling = [
      `export const gadgets = {`,
      `  async list(token: string) {`,
      `    return [];`,
      `  },`,
      `  async show(token: string, id: string) {`,
      `    return null;`,
      `  },`,
      `};`,
    ].join("\n");
    const d = dispositionsOf({
      "packages/core/src/services/profile/widgets/index.ts": index,
      "packages/core/src/services/profile/widgets/gadgets.ts": sibling,
      "packages/cli/src/commands/profile/widgets/index.ts": [
        `await profile.widgets.gadgets.list(token);`,
        `await profile.widgets.gadgets.show(token, id);`,
      ].join("\n"),
      "packages/mcp/src/tools/profile/widgets.ts": [
        `await profile.widgets.gadgets.list(auth.token);`,
        `await profile.widgets.gadgets.show(auth.token, id);`,
      ].join("\n"),
    });
    expect(d.get("profile.widgets.gadgets.list")).toBe("BOTH");
    expect(d.get("profile.widgets.gadgets.show")).toBe("BOTH");
  });

  it("flags a re-exported op as NEITHER when neither surface invokes it (pre-fix it was invisible)", () => {
    const base: Fixtures = {
      [EMP_INDEX_PATH]: `export { reportingToAutocomplete } from "./reporting-to-autocomplete.js";`,
      [EMP_SIBLING_PATH]: EMP_SIBLING,
    };

    // Surfaces invoke the op → BOTH.
    const covered = dispositionsOf({ ...base, [EMP_CLI_PATH]: EMP_CLI, [EMP_MCP_PATH]: EMP_MCP });
    expect(covered.get("profile.employment.reportingToAutocomplete")).toBe("BOTH");

    // Same surfaces present but NOT invoking the re-exported op → NEITHER. The op
    // is now VISIBLE to the Class A gate; pre-fix it never appeared at all, so an
    // accidental removal from both surfaces would have passed silently.
    const removed = dispositionsOf({
      ...base,
      [EMP_CLI_PATH]: `await profile.employment.somethingElse(token);`,
      [EMP_MCP_PATH]: `await profile.employment.somethingElse(auth.token);`,
    });
    expect(removed.get("profile.employment.reportingToAutocomplete")).toBe("NEITHER");
  });

  it("applies an `as` alias to the exposed namespace path", () => {
    const d = dispositionsOf({
      [EMP_INDEX_PATH]: `export { reportingToAutocomplete as suggestReportsTo } from "./reporting-to-autocomplete.js";`,
      [EMP_SIBLING_PATH]: EMP_SIBLING,
      [EMP_CLI_PATH]: `await profile.employment.suggestReportsTo(token, prefix);`,
      [EMP_MCP_PATH]: `await profile.employment.suggestReportsTo(auth.token, prefix);`,
    });
    expect(d.get("profile.employment.suggestReportsTo")).toBe("BOTH");
    expect(d.has("profile.employment.reportingToAutocomplete")).toBe(false);
  });

  it("degrades gracefully when the re-export target is unreadable", () => {
    const d = dispositionsOf({
      [EMP_INDEX_PATH]: `export { ghost } from "./missing.js";`,
    });
    expect(d.size).toBe(0);
  });
});
