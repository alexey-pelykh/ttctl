// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E read coverage for `profile.employment.reportingToAutocomplete`
 * (GET_REPORTING_TO_AUTOCOMPLETE) — #468.
 *
 * Read-only catalog search against the live talent-profile surface, keyed
 * on the auto-resolved profileId + a common name prefix. Results are
 * account-scoped, so a zero-result run skip-notes the snapshot rather
 * than capturing an empty `array<unknown>`. T1 disposition.
 */

// e2e-covers: GET_REPORTING_TO_AUTOCOMPLETE

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

// Try a few — catalog may be empty for any single prefix on a given test account.
const SNAPSHOT_CANDIDATES = ["Joh", "Smith", "Garcia", "Lee"];

describe("profile employment reporting-to-autocomplete (live talent-profile)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "returns ReportingToSuggestion[] for a common prefix and matches the wire-shape snapshot",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);

      let suggestions: profile.employment.ReportingToSuggestion[] = [];
      for (const candidate of SNAPSHOT_CANDIDATES) {
        const out = await profile.employment.reportingToAutocomplete(token, candidate, { limit: 10 });
        if (out.length > 0) {
          suggestions = out;
          break;
        }
      }

      if (suggestions.length === 0) {
        process.stdout.write(
          `[87-profile-employment-reporting-to-autocomplete] No matches for [${SNAPSHOT_CANDIDATES.join(", ")}]; element assertions + snapshot skipped.\n`,
        );
        return;
      }

      for (const s of suggestions) {
        expect(typeof s.id).toBe("string");
        expect(s.id.length).toBeGreaterThan(0);
        expect(typeof s.name).toBe("string");
        expect(s.name.length).toBeGreaterThan(0);
      }

      expect(() =>
        assertWireShapeStable({
          operationName: "GET_REPORTING_TO_AUTOCOMPLETE",
          surface: "talent-profile",
          transport: "impersonated",
          response: suggestions,
        }),
      ).not.toThrow();
    },
    60_000,
  );
});
