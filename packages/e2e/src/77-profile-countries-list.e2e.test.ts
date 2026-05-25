// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E live-wire coverage for #596 — `profile.countries.list` exposing the
 * `getCountries` catalog query (talent-profile surface, impersonated).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule.** `getCountries`
 * is hand-authored against the inferred wire (SDL types `countries: Unknown`;
 * `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`). It was sourced inline during #586
 * (test 71) but this is its first dedicated coverage + committed T1 snapshot.
 * The PR body declares `Schema/contract rule: triggered` and points here.
 *
 * Asserts: op succeeds; ~250+ rows; US present with ISO code; row shape is
 * `{ id, code, name }`; and `assertWireShapeStable` locks the structure.
 */

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

// e2e-covers: getCountries

describe("profile countries list (live talent-profile, #596)", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)("returns the Country catalog with a discoverable US id", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const countries = await profile.countries.list(token);

    // The catalog is global (~250 ISO countries); a handful would signal a
    // wire-shape regression (e.g. a connection wrapper swallowing rows).
    expect(countries.length).toBeGreaterThan(200);

    const us = countries.find((c) => c.code === "US");
    expect(us).toBeDefined();
    expect(typeof us?.id).toBe("string");
    expect(us?.name).toBeTruthy();

    const first = countries[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      expect(typeof first.id).toBe("string");
    }
  });

  it.skipIf(!e2eEnabled)("getCountries wire shape matches snapshot", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await profile.countries.list(token);
    expect(response.length).toBeGreaterThan(0);
    expect(() =>
      assertWireShapeStable({
        operationName: "getCountries",
        surface: "talent-profile",
        transport: "impersonated",
        response,
      }),
    ).not.toThrow();
  });
});
