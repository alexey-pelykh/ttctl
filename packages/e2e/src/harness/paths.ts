// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Walk upward from `start` until a directory containing one of the
 * repo-root sentinels is found (`pnpm-workspace.yaml` first, then `.git`).
 * Throws if none is found before hitting the filesystem root — this would
 * mean the harness was invoked outside the ttctl monorepo, which is a
 * user-error condition.
 *
 * Sentinel order matters: `pnpm-workspace.yaml` is the authoritative
 * monorepo root. `.git` is a fallback for shallow clones / git worktrees
 * where the workspace file might be at a sibling location, but in this
 * project the two coincide.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let current = resolve(start);
  // `for (;;)` rather than `while (true)` — the latter trips eslint's
  // `no-unnecessary-condition` because the static type of `true` makes the
  // condition trivially constant. The loop is deliberately infinite; exit
  // is via the `return` or `throw` below.
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `findRepoRoot: walked from ${start} up to filesystem root without finding pnpm-workspace.yaml or .git. ` +
          `The E2E harness must run inside the ttctl monorepo.`,
      );
    }
    current = parent;
  }
}

/**
 * Path to the isolated cookie jar used by the E2E harness.
 *
 * Always under `<repo-root>/.tmp/e2e/session.cookies`. NEVER touches the
 * user's working session at `~/.ttctl/session.cookies` — see
 * `packages/e2e/README.md` for the live-account-safety rationale.
 *
 * The CLI subprocess reads this same path via the `TTCTL_COOKIE_JAR_PATH`
 * env var that the harness exports (handled by `discoverCookieJarPath` in
 * `@ttctl/core`).
 */
export function resolveIsolatedJarPath(repoRoot: string): string {
  return join(repoRoot, ".tmp", "e2e", "session.cookies");
}

/**
 * Path to the run-level lockfile that prevents concurrent E2E invocations
 * on the same machine. Lives next to the isolated jar so a single
 * `rm -rf .tmp/e2e/` cleanly removes both.
 */
export function resolveLockfilePath(repoRoot: string): string {
  return join(repoRoot, ".tmp", "e2e", ".lock");
}

/**
 * Path to the directory holding bio-restoration breadcrumbs (used by the
 * profile-update round-trip test in #21). Created lazily by test cases
 * that need it; the harness does not own its lifecycle.
 */
export function resolveRestoreDir(repoRoot: string): string {
  return join(repoRoot, ".tmp", "e2e-restore");
}
