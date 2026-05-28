// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E read coverage for `profile.skills.readiness` (getSkillsReadiness) — #657.
 *
 * Read-only against the live talent-profile surface; readiness always
 * returns for the signed-in user. T1 disposition.
 */

// e2e-covers: getSkillsReadiness

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

describe("profile skills readiness (live talent-profile, #657)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)("returns the SkillsReadiness projection and matches the wire snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const profileId = await resolveProfileId(token);
    const readiness = await profile.skills.readiness(token, profileId);

    for (const key of [
      "isExpertProficiencyCountSatisfied",
      "isHighlightedItemsCountAndExperienceSatisfied",
      "isItemsCountSatisfied",
      "isProficiencyNotSetCountSatisfied",
      "isProgrammingLanguageSatisfied",
    ]) {
      expect(key in readiness).toBe(true);
    }
    for (const value of Object.values(readiness)) {
      expect(typeof value).toBe("boolean");
    }

    expect(() =>
      assertWireShapeStable({
        operationName: "getSkillsReadiness",
        surface: "talent-profile",
        transport: "impersonated",
        response: readiness,
      }),
    ).not.toThrow();
  });
});
