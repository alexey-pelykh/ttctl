// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E read coverage for `profile.skills.list`
 * (getSkillSetsWithConnectionsWithConnectionsCount) and `profile.skills.show`
 * (GetSkillSetWithConnections) — #658.
 *
 * Both reads were previously exercised only incidentally as setup in tests
 * 45/80. This promotes them to dedicated happy-path assertions + wire-shape
 * snapshots, so a regression surfaces here rather than inside an unrelated
 * employment/connection test. Read-only against the live talent-profile
 * surface. T1 disposition.
 */

// e2e-covers: getSkillSetsWithConnectionsWithConnectionsCount, GetSkillSetWithConnections

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

const SKILL_SET_KEYS = ["id", "experience", "rating", "public", "position", "skill", "connectionsCount"];

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

describe("profile skills list + show (live talent-profile, #658)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)("list returns ProfileSkillSet[] and matches the wire snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const profileId = await resolveProfileId(token);
    const sets = await profile.skills.list(token, profileId);

    expect(Array.isArray(sets)).toBe(true);
    const first = sets[0];
    if (first === undefined) {
      process.stdout.write(
        "[86-profile-skills-read] Account has no skill sets; list element assertions skipped (snapshot array<unknown>).\n",
      );
    } else {
      for (const key of SKILL_SET_KEYS) {
        expect(key in first).toBe(true);
      }
      expect(typeof first.id).toBe("string");
      expect(typeof first.connectionsCount).toBe("number");
    }

    expect(() =>
      assertWireShapeStable({
        operationName: "getSkillSetsWithConnectionsWithConnectionsCount",
        surface: "talent-profile",
        transport: "impersonated",
        response: sets,
      }),
    ).not.toThrow();
  });

  it.skipIf(!e2eEnabled)(
    "show returns the ProfileSkillSet projection for a discovered id and matches the wire snapshot",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const profileId = await resolveProfileId(token);
      const sets = await profile.skills.list(token, profileId);
      const first = sets[0];
      if (first === undefined) {
        process.stdout.write("[86-profile-skills-read] Account has no skill sets; show + snapshot skipped.\n");
        return;
      }

      const one = await profile.skills.show(token, first.id);
      expect(one.id).toBe(first.id);
      for (const key of SKILL_SET_KEYS) {
        expect(key in one).toBe(true);
      }

      expect(() =>
        assertWireShapeStable({
          operationName: "GetSkillSetWithConnections",
          surface: "talent-profile",
          transport: "impersonated",
          response: one,
        }),
      ).not.toThrow();
    },
  );
});
