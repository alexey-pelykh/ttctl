// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Structural unit tests for the vitest globalSetup module.
 *
 * The globalSetup itself runs in vitest's parent process and performs a
 * live signin against Toptal — that path is exercised end-to-end only
 * during `pnpm test:e2e` with `TTCTL_E2E=1` and a configured account.
 * Under `pnpm test` (the unit-test config), we cannot reach the live API,
 * so these tests verify the module's STRUCTURE without invoking the live
 * path:
 *
 *   - exports a default async function (vitest's globalSetup contract)
 *   - is a no-op when `TTCTL_E2E !== "1"` (returns a callable teardown
 *     that does nothing)
 *
 * The transport-audit comment in `globalSetup.ts` (AC #5 of #105) is a
 * static-source artifact; we don't assert it here because a code search
 * is the appropriate verification, not a runtime test.
 */

import { describe, expect, it } from "vitest";

import setup from "../globalSetup.js";

describe("globalSetup module structure", () => {
  it("exports a default async function (vitest globalSetup contract)", () => {
    expect(typeof setup).toBe("function");
  });

  it("returns a teardown function when TTCTL_E2E !== '1' (no-op path)", async () => {
    const original = process.env["TTCTL_E2E"];
    delete process.env["TTCTL_E2E"];
    try {
      const teardown = await setup();
      expect(typeof teardown).toBe("function");
      // The no-op teardown must not throw.
      await expect(teardown()).resolves.toBeUndefined();
    } finally {
      if (original !== undefined) process.env["TTCTL_E2E"] = original;
    }
  });

  it("returns a teardown function for any non-'1' TTCTL_E2E value (env-gate is strict)", async () => {
    const original = process.env["TTCTL_E2E"];
    for (const value of ["0", "true", "TRUE", "yes", " 1 ", ""]) {
      process.env["TTCTL_E2E"] = value;
      try {
        const teardown = await setup();
        expect(typeof teardown).toBe("function");
        await expect(teardown()).resolves.toBeUndefined();
      } finally {
        if (original === undefined) delete process.env["TTCTL_E2E"];
        else process.env["TTCTL_E2E"] = original;
      }
    }
  });
});
