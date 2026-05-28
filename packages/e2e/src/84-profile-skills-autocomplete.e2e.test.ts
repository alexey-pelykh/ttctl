// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E read coverage for `profile.skills.autocomplete`
 * (GET_SKILLS_FOR_AUTOCOMPLETE) — #656.
 *
 * Read-only catalog search against the live talent-profile surface, keyed
 * on a resolved profileId + a common term. Results are vertical-scoped, so
 * a zero-result run skip-notes the snapshot rather than capturing an empty
 * `array<unknown>`. T1 disposition.
 */

// e2e-covers: GET_SKILLS_FOR_AUTOCOMPLETE

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

async function resolveProfileId(token: string): Promise<string> {
  const basic = await profile.basic.show(token);
  const profileId = (basic as unknown as { viewer?: { viewerRole?: { profile?: { id?: string } } } }).viewer?.viewerRole
    ?.profile?.id;
  if (profileId === undefined) {
    throw new Error("Cannot extract profileId from basic.show response — test fixture needs adjustment.");
  }
  return profileId;
}

describe("profile skills autocomplete (live talent-profile, #656)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)("returns SkillSuggestion[] for a common term and matches the wire snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const profileId = await resolveProfileId(token);
    const suggestions = await profile.skills.autocomplete(token, profileId, "java");

    expect(Array.isArray(suggestions)).toBe(true);

    const first = suggestions[0];
    if (first === undefined) {
      process.stdout.write(
        "[84-profile-skills-autocomplete] No suggestions for 'java' (vertical-scoped catalog); element assertions + snapshot skipped.\n",
      );
      return;
    }
    expect(typeof first.id).toBe("string");
    expect(typeof first.name).toBe("string");

    expect(() =>
      assertWireShapeStable({
        operationName: "GET_SKILLS_FOR_AUTOCOMPLETE",
        surface: "talent-profile",
        transport: "impersonated",
        response: suggestions,
      }),
    ).not.toThrow();
  });
});
