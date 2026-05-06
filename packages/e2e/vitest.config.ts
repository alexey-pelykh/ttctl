// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

/**
 * Default Vitest config for the `@ttctl/e2e` package.
 *
 * This config drives `pnpm test` (unit tests of harness modules) — pure-
 * function tests that exercise the lockfile, redaction, jar-path resolution,
 * and banner singleton WITHOUT any live Toptal session. It deliberately
 * EXCLUDES `*.e2e.test.ts` files; those are picked up only by the sibling
 * `vitest.e2e.config.ts`, which is gated by `TTCTL_E2E=1`.
 *
 * Two-config split rationale: harness unit tests must always run (CI, dev
 * loop, Windows matrix) without setting `TTCTL_E2E`. E2E tests must NEVER
 * run unless explicitly opted into. A single env-aware config conflates the
 * two — `pnpm test:e2e` without the env gate would silently fall through to
 * unit tests, which is the opposite of "skip silently" per AC.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    testTimeout: 15_000,
  },
});
