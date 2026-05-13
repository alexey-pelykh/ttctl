// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl payments rate questions` (#149).
 *
 * Mandatory per CLAUDE.md § Schema/contract validation rule —
 * `RateChangeRequestQuestions` is hand-authored on the mobile-gateway
 * endpoint.
 *
 * Coverage:
 *   - `payments rate questions` returns the list envelope with the
 *     projected questions (id, kind, label, options[]).
 *
 * Read-only — no side effects.
 */

// e2e-covers: RateChangeRequestQuestions

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("payments rate questions (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("rate questions returns the form catalog", async () => {
    const result = await cli.run(["payments", "rate", "questions", "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const payload = JSON.parse(result.stdout) as { version?: string; items?: unknown };
    expect(payload.version).toBeDefined();
    expect(Array.isArray(payload.items)).toBe(true);

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      process.stderr.write("warning: rate-change form returned no questions — questions shape assertions skipped\n");
      return;
    }

    const first = payload.items[0] as Record<string, unknown>;
    expect("id" in first).toBe(true);
    expect("kind" in first).toBe(true);
    expect("label" in first).toBe(true);
    expect("options" in first).toBe(true);
    expect(Array.isArray(first["options"])).toBe(true);
  });
});
