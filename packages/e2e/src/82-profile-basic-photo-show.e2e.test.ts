// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E read coverage for `profile.basic.photoShow` (GET_PHOTO) — #654.
 *
 * Read-only against the live talent-profile surface — no id param; reads
 * the signed-in user's photo. T1 disposition: GET_PHOTO has no generated
 * operation type, so `assertWireShapeStable` is the wire-drift defense.
 */

// e2e-covers: GET_PHOTO

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

describe("profile basic photo show (live talent-profile, #654)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)("returns the PhotoUrl projection and matches the wire snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const photo = await profile.basic.photoShow(token);

    // Values may legitimately be null (no photo set); the keys must be present.
    for (const key of ["default", "original", "small", "cropped", "isResolutionSatisfied"]) {
      expect(key in photo).toBe(true);
    }
    expect(typeof photo.isResolutionSatisfied).toBe("boolean");

    expect(() =>
      assertWireShapeStable({
        operationName: "GET_PHOTO",
        surface: "talent-profile",
        transport: "impersonated",
        response: photo,
      }),
    ).not.toThrow();
  });
});
