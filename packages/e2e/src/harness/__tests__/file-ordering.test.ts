// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Unit test for AC #3 of #105: the numeric-prefix ordering invariant for
 * E2E test files is enforceable.
 *
 * Two assertions:
 *
 *   1. `vitest.e2e.config.ts` pins `sequence.sequencer` to `BaseSequencer`
 *      explicitly. Removing this pin causes this test to FAIL — that is
 *      load-bearing, not decorative. Vitest's CURRENT default happens to
 *      be `BaseSequencer`, but a future minor could ship a different
 *      default (or accept a config tweak that changes it), and our
 *      ordering invariant would silently break — files would still pass-
 *      by-luck but the order pinning would be gone.
 *
 *   2. Every `*.e2e.test.ts` file in `packages/e2e/src/` matches the
 *      `NN-name.e2e.test.ts` shape, and prefixes are STRICTLY increasing
 *      when files are sorted alphabetically (which is what `BaseSequencer`
 *      does). This guarantees the intended logical order: signin → adversarial
 *      → signout, with room for future cases between them.
 *
 * This test runs under `pnpm test` (the harness unit-test config), NOT
 * under `pnpm test:e2e`, so it provides a fast pre-flight check on every
 * CI matrix entry without requiring `TTCTL_E2E=1`.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { BaseSequencer } from "vitest/node";

import e2eConfig from "../../../vitest.e2e.config.js";

const e2eSrcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("vitest.e2e.config.ts — sequencer pin (AC #3)", () => {
  it("pins sequence.sequencer to BaseSequencer (load-bearing for numeric-prefix ordering)", () => {
    // Direct config-object access — `defineConfig` returns the raw user-
    // config shape. Removing the explicit `sequencer: BaseSequencer` line
    // would leave this property undefined, failing the assertion even
    // though vitest's current internal default is `BaseSequencer`. The
    // pin makes the dependency explicit and survives default changes.
    const sequencer = e2eConfig.test?.sequence?.sequencer;
    expect(sequencer).toBe(BaseSequencer);
  });

  it("pins sequence.shuffle to false (no shuffling permitted; numeric prefixes are load-bearing)", () => {
    const shuffle = e2eConfig.test?.sequence?.shuffle;
    expect(shuffle).toBe(false);
  });

  it("wires globalSetup to ./src/harness/globalSetup.ts (single-shared-signin invariant)", () => {
    const globalSetup = e2eConfig.test?.globalSetup;
    expect(globalSetup).toEqual(["./src/harness/globalSetup.ts"]);
  });
});

describe("E2E file numeric-prefix ordering (AC #3)", () => {
  it("every *.e2e.test.ts file in packages/e2e/src/ matches NN-name.e2e.test.ts", () => {
    const files = readdirSync(e2eSrcDir).filter((name) => name.endsWith(".e2e.test.ts"));
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      expect(name, `file ${name} does not match NN-name.e2e.test.ts`).toMatch(/^\d+-[a-z0-9-]+\.e2e\.test\.ts$/);
    }
  });

  it("alphabetical-by-filename order (which BaseSequencer applies) yields strictly-increasing numeric prefixes", () => {
    const files = readdirSync(e2eSrcDir).filter((name) => name.endsWith(".e2e.test.ts"));
    const sorted = [...files].sort();

    const prefixes: number[] = [];
    for (const name of sorted) {
      const match = /^(\d+)-/.exec(name);
      expect(match, `file ${name} has no leading numeric prefix`).not.toBeNull();
      if (match === null) continue;
      const captured = match[1];
      expect(captured).toBeDefined();
      if (captured === undefined) continue;
      const prefix = Number.parseInt(captured, 10);
      expect(Number.isFinite(prefix)).toBe(true);
      prefixes.push(prefix);
    }

    expect(prefixes.length).toBeGreaterThan(0);

    // Strictly increasing — no duplicates, no out-of-order. This is the
    // load-bearing invariant: when BaseSequencer sorts the files
    // alphabetically (which is the same as the order we get from
    // `readdirSync` + `sort()` here), the resulting numeric prefixes
    // form a monotonic sequence, mapping logical order to alphabetical
    // order.
    for (let i = 1; i < prefixes.length; i += 1) {
      const current = prefixes[i];
      const previous = prefixes[i - 1];
      expect(current).toBeDefined();
      expect(previous).toBeDefined();
      if (current === undefined || previous === undefined) continue;
      expect(current).toBeGreaterThan(previous);
    }
  });
});
