// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { defineConfig } from "vitest/config";

/**
 * E2E-specific Vitest config for `@ttctl/e2e`. Drives `pnpm test:e2e`.
 *
 * Behavior is env-gated:
 *
 *   - When `TTCTL_E2E === "1"`: collects `**\/*.e2e.test.ts`, runs them
 *     SEQUENTIALLY (one file at a time, one test at a time) so we issue
 *     exactly one live signin per suite run and never overlap requests
 *     against the maintainer's account.
 *   - Otherwise: collects nothing. Combined with `--passWithNoTests`
 *     (set in `package.json`'s `test:e2e` script), the run exits 0 with no
 *     output. CI matrix runs this path on every push; the gate is the env
 *     var, not the config file's presence.
 *
 * Sequencing model:
 *
 *   - `fileParallelism: false` — files run one at a time (no parallel
 *     workers). Required because the run-level lockfile prevents multiple
 *     vitest workers from racing on the same isolated cookie jar.
 *   - `sequence.concurrent: false` — tests within a file run sequentially
 *     (vitest's default; restated for clarity).
 *   - `pool: "forks"` + `singleFork: true` — fresh Node process per file
 *     boundary, but only ONE such process at a time. Avoids inter-test
 *     state leakage from module-level singletons (banner flag, harness
 *     context cache).
 *
 * Pool choice: `forks` over `threads` so child processes spawned by the
 * harness (`spawn(node, ['cli.js', ...])`) don't share Node workers with
 * the test runner — keeps subprocess output clean.
 */
const isE2E = process.env["TTCTL_E2E"] === "1";

export default defineConfig({
  test: {
    include: isE2E ? ["src/**/*.e2e.test.ts"] : [],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    // Vitest 4 hoists pool-specific options to the top level (see
    // https://vitest.dev/guide/migration#pool-rework). `forks.singleFork`
    // ensures only one Node process runs at a time, even when vitest
    // would otherwise spin up workers per file. Combined with
    // `fileParallelism: false`, this gives single-process sequential
    // execution — exactly one signin, exactly one teardown, zero overlap.
    pool: "forks",
    forks: {
      singleFork: true,
    },
  },
});
