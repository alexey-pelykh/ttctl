// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl surveys list` (#672).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * `PendingSurveys` op is hand-authored (trimmed from the captured document)
 * and sits in `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`; no generated type exists
 * and `Survey.kind` / `SurveyQuestion.note` are `Unknown`-typed in the
 * synthesized SDL. The wire shape is best-effort INFERRED until this file
 * passes against a live session.
 *
 * Coverage:
 *   - The list call itself (always exercisable — an empty list is a valid
 *     result, so this is the live-callable proof of the op regardless of
 *     account state).
 *   - Per-survey projection keys, when the account has ≥1 pending survey.
 *     Skipped via an explicit return otherwise.
 *   - Wire-shape snapshot assertion (T1 disposition). Snapshot committed at
 *     `wire-snapshots/PendingSurveys.snapshot.json`; captured against real
 *     wire data, so it skips when the account has no pending surveys.
 *
 * Read-only — no side effects.
 *
 * Disposition: **T1** (wire-shape snapshot). `PendingSurveys` is in the
 * codegen-exclusion list, so no T2 Zod schema is generated;
 * `assertWireShapeStable` is the continuous wire-drift defense.
 */

// e2e-covers: PendingSurveys

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, surveys } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Used by the snapshot test to call the service-layer fn directly — the
 * CLI path runs the same projection, but the service call sidesteps the
 * JSON envelope wrap so the snapshot is the projected `Survey[]` consumers
 * depend on.
 */
function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

interface SurveysListEnvelope {
  items: Array<Record<string, unknown>>;
}

describe("surveys list (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns a v1.0 list envelope (empty list is valid)", async () => {
    const result = await cli.run(["surveys", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as SurveysListEnvelope;
    expect(Array.isArray(payload.items)).toBe(true);
  });

  it.skipIf(!e2eEnabled)("projects the per-survey contract fields for each item", async () => {
    const result = await cli.run(["surveys", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as SurveysListEnvelope;
    if (payload.items.length === 0) {
      process.stdout.write("[88-surveys-list] No pending surveys; skipping projection-shape check.\n");
      return;
    }
    for (const survey of payload.items) {
      // `id` is non-null in the contract; the rest may legitimately be null
      // (wire sparseness) but the keys themselves must be present.
      expect(typeof survey["id"]).toBe("string");
      for (const key of ["kind", "title", "isMandatory", "alreadyAnswered", "questions"]) {
        expect(key in survey).toBe(true);
      }
      expect(Array.isArray(survey["questions"])).toBe(true);
    }
  });

  // Wire-shape snapshot assertion (T1 disposition). Captured against the
  // projected `Survey[]`. Skipped on accounts with no pending surveys — the
  // snapshot must reflect real wire data, not a degenerate empty array.
  it.skipIf(!e2eEnabled)("PendingSurveys wire shape matches snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await surveys.list(token);
    if (response.length === 0) {
      process.stdout.write("[88-surveys-list] No pending surveys; skipping wire-shape snapshot.\n");
      return;
    }
    expect(() =>
      assertWireShapeStable({
        operationName: "PendingSurveys",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });
});
