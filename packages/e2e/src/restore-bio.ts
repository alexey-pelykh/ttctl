// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveRestoreDir } from "./harness/index.js";

/**
 * Bio-restore breadcrumb (#21 B2). Persisted to disk BEFORE any profile
 * mutation so that a process crash mid-test leaves a recovery file the
 * operator can use to manually restore the original bio.
 *
 * Shape persisted to `<repo-root>/.tmp/e2e-restore/{runId}.json`:
 *
 *     { "runId": "...", "capturedAt": "2026-05-06T12:00:00.000Z", "bio": "..." }
 *
 * The file is removed only after a successful restore + byte-for-byte
 * verification (#21 B3). On any failure earlier in the chain, it persists
 * for manual recovery (`pnpm exec ttctl profile update --bio "$(jq -r .bio
 * .tmp/e2e-restore/<runId>.json)"`).
 */
export interface RestoreBreadcrumb {
  /** UUID generated at the start of a suite run; pairs the file name and contents. */
  runId: string;
  /** ISO-8601 timestamp at which the bio was captured. Diagnostic only. */
  capturedAt: string;
  /** Original bio prose, captured before mutation. Restoration writes this back verbatim. */
  bio: string;
}

/**
 * Generate a stable run-id for one suite invocation. Used as the breadcrumb
 * file name. `randomUUID` (crypto-strength) makes accidental collisions
 * across overlapping local runs effectively impossible — important because
 * a leftover breadcrumb from a crashed run must remain attributable to its
 * own run, not get clobbered by a later run.
 */
export function generateRunId(): string {
  return randomUUID();
}

/**
 * Apply the minimum whitespace mutation (#21 B4): a single trailing space.
 *
 * **Assumption** (documented per caller context): the Toptal profile API
 * round-trips trailing whitespace verbatim — the value written via
 * `profile update --bio <text>` is the value returned by the next
 * `profile show -o json`, byte-for-byte.
 *
 * This assumption is NOT verified at the unit-test layer (no live API).
 * Verification is the operator's responsibility on the first live run:
 * if the post-mutate `bio === mutated` assertion in the round-trip test
 * fails, Toptal is normalizing trailing whitespace and the operator must
 * pick an alternative mutation strategy (e.g., double-space inside the
 * bio, or a single trailing punctuation toggle).
 *
 * Constraints (#21 B4):
 * - Diff size MUST be ≤2 characters: a single appended space yields exactly 1.
 * - No test-identifying text: the bio remains 100% the operator's prose
 *   plus a single space — invisible in most rendered profile views and
 *   carrying no recognizable marker.
 *
 * Pure function — easy to unit test against the constraints above without
 * any live calls.
 */
export function applyMinimalWhitespaceEdit(bio: string): string {
  return bio + " ";
}

/**
 * Persist the original bio to disk BEFORE any mutation (#21 B2). Returns
 * the absolute path to the breadcrumb file so the caller can `delete` it
 * after restore + verify succeed.
 *
 * The file is written at mode 0o600 (owner-only) — bio prose may contain
 * personal information the operator does not want world-readable on a
 * shared machine. Mirrors the harness lockfile permissions.
 *
 * The directory is created at mode 0o700 if missing. `resolveRestoreDir`
 * (from the harness) owns the path; this helper owns the file format.
 */
export async function captureBioToDisk(repoRoot: string, runId: string, bio: string): Promise<string> {
  const dir = resolveRestoreDir(repoRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${runId}.json`);
  const breadcrumb: RestoreBreadcrumb = {
    runId,
    capturedAt: new Date().toISOString(),
    bio,
  };
  // Trailing newline matches the lockfile convention — friendlier to
  // shell tools (`cat`, `jq`) that print without adding their own.
  await writeFile(file, JSON.stringify(breadcrumb, null, 2) + "\n", { mode: 0o600 });
  return file;
}

/**
 * Read and validate a breadcrumb file. Throws on missing file, malformed
 * JSON, or shape mismatch. Used during the round-trip test to confirm the
 * persisted file is recoverable BEFORE proceeding to mutation; also
 * available to operators implementing manual recovery scripts.
 *
 * The validation is conservative — any field with the wrong type rejects
 * the breadcrumb. False positives are recoverable (operator inspects the
 * file); false negatives (a malformed file silently treated as valid)
 * would leak through to a confused restore attempt.
 */
export async function readBreadcrumb(file: string): Promise<RestoreBreadcrumb> {
  const raw = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`restore-bio: malformed breadcrumb at ${file}: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`restore-bio: breadcrumb at ${file} is not an object`);
  }
  const candidate = parsed as Partial<RestoreBreadcrumb>;
  if (typeof candidate.runId !== "string" || candidate.runId === "") {
    throw new Error(`restore-bio: breadcrumb at ${file} missing or invalid 'runId'`);
  }
  if (typeof candidate.capturedAt !== "string" || candidate.capturedAt === "") {
    throw new Error(`restore-bio: breadcrumb at ${file} missing or invalid 'capturedAt'`);
  }
  if (typeof candidate.bio !== "string") {
    throw new Error(`restore-bio: breadcrumb at ${file} missing or invalid 'bio'`);
  }
  return { runId: candidate.runId, capturedAt: candidate.capturedAt, bio: candidate.bio };
}

/**
 * Idempotent breadcrumb deletion. Called by the round-trip test only after
 * BOTH restore AND byte-for-byte verification succeed (#21 B3 success
 * path). On any earlier failure, the breadcrumb is intentionally left on
 * disk so the operator can manually restore the bio.
 *
 * `force: true` means missing-file is not an error — defensive against the
 * case where a crash between capture and delete produced an inconsistent
 * state and the file happens to have been removed manually.
 */
export async function deleteBreadcrumb(file: string): Promise<void> {
  await rm(file, { force: true });
}
