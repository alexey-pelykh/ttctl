// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E read coverage for `profile.portfolio.list` (getPortfolioItems) — #655.
 *
 * Test 36 exercises portfolio create/update/upload but never reads the list
 * back; this adds the dedicated read + wire-shape assertion. Read-only
 * against the live talent-profile surface. An empty account yields
 * `array<unknown>` (element assertions skip-noted). T1 disposition.
 */

// e2e-covers: getPortfolioItems

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

describe("profile portfolio list (live talent-profile, #655)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)("returns the PortfolioItem[] projection and matches the wire snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const items = await profile.portfolio.list(token);

    expect(Array.isArray(items)).toBe(true);

    const first = items[0];
    if (first === undefined) {
      process.stdout.write(
        "[83-profile-portfolio-list] Account has no portfolio items; element assertions skipped (snapshot captures array<unknown>).\n",
      );
    } else {
      for (const key of [
        "id",
        "title",
        "description",
        "link",
        "highlight",
        "coverImage",
        "accomplishment",
        "publicationPermit",
        "clientOrCompanyName",
        "websiteUrl",
        "toptalRelated",
        "showViaToptal",
        "kind",
        "skills",
        "industries",
        "details",
        "files",
        "kpis",
        "quotes",
        "engagement",
      ]) {
        expect(key in first).toBe(true);
      }
      expect(typeof first.id).toBe("string");
      expect(Array.isArray(first.skills)).toBe(true);
      expect(Array.isArray(first.industries)).toBe(true);
    }

    expect(() =>
      assertWireShapeStable({
        operationName: "getPortfolioItems",
        surface: "talent-profile",
        transport: "impersonated",
        response: items,
      }),
    ).not.toThrow();
  });
});
