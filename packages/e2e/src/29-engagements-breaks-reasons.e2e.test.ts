// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl engagements breaks reasons list` (#156).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * `PlatformConfiguration` (the operation backing this leaf) is NOT in
 * `codegen.config.ts` documents, so hand-authoring the operation IS
 * the inference act. The live API is the only authority on the wire
 * format; unit tests with a mocked transport accept whatever shape
 * the code sends and cannot detect a contract mismatch.
 *
 * Coverage:
 *   - The catalog returns at least one entry (the platform always
 *     exposes some break reasons; an empty catalog would indicate a
 *     schema regression).
 *   - Each entry has `identifier: string` and `nameForRole: string`
 *     (the strict projection on the wire — extra fields would be
 *     harmless but their absence would break the contract).
 *   - The list is sorted by `identifier` ascending (AC1).
 *   - The list envelope is `{version: "1.0", items: [...]}` (AC3).
 *   - The canonical identifier `other` is present (the catch-all
 *     reason used by `21-engagements-breaks.e2e.test.ts` round-trip).
 *
 * **Read-only** — no account state changes; no `add` / `remove` paths
 * exercised. Safe to run any time `TTCTL_E2E=1` is set.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("engagements breaks reasons list (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns the catalog with the v1.0 list envelope and required projection", async () => {
    const result = await cli.run(["engagements", "breaks", "reasons", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      version?: string;
      items?: Array<{ identifier?: unknown; nameForRole?: unknown }>;
    };

    // Envelope: AC3 — list envelope on json.
    expect(payload.version).toBe("1.0");
    expect(Array.isArray(payload.items)).toBe(true);
    if (!Array.isArray(payload.items)) return;

    // Catalog non-empty (defensive — the platform always exposes break
    // reasons).
    expect(payload.items.length).toBeGreaterThan(0);

    // Each entry has the strict projection on the wire.
    for (const item of payload.items) {
      expect(typeof item.identifier).toBe("string");
      expect(typeof item.nameForRole).toBe("string");
      expect((item.identifier as string).length).toBeGreaterThan(0);
      expect((item.nameForRole as string).length).toBeGreaterThan(0);
    }

    // AC1 — sorted by identifier ascending (case-insensitive).
    const identifiers = payload.items.map((i) => i.identifier as string);
    const sorted = [...identifiers].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    expect(identifiers).toEqual(sorted);

    // The catch-all `other` identifier is the one
    // `21-engagements-breaks.e2e.test.ts` uses for its add/remove
    // round-trip; if it ever disappears the round-trip would silently
    // break. Asserting presence here is a cross-test contract.
    expect(identifiers).toContain("other");
  });

  it.skipIf(!e2eEnabled)("--output=yaml emits the same envelope shape on stdout", async () => {
    const result = await cli.run(["engagements", "breaks", "reasons", "list", "-o", "yaml"]);
    expect(result.exitCode).toBe(0);
    // YAML envelope has a `version:` line and an `items:` block; a
    // minimal stringy assertion is enough — the strict projection has
    // already been validated above via JSON.
    expect(result.stdout).toMatch(/^version:\s*['"]?1\.0['"]?\s*$/m);
    expect(result.stdout).toContain("items:");
    expect(result.stdout).toContain("identifier:");
    expect(result.stdout).toContain("nameForRole:");
    expect(result.stdout).toContain("other");
  });

  it.skipIf(!e2eEnabled)("--json shortcut routes through the same envelope as -o json", async () => {
    // `--json` is a global flag — placed BEFORE the leaf path per
    // commander's option-precedes-positional convention.
    const result = await cli.run(["--json", "engagements", "breaks", "reasons", "list"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { version?: string; items?: unknown[] };
    expect(payload.version).toBe("1.0");
    expect(Array.isArray(payload.items)).toBe(true);
  });
});
