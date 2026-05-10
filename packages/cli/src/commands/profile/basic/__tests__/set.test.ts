// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { profile } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { formatUpdatePrettyEntity } from "../set.js";

/**
 * Pure-formatter unit tests for `profile basic update`. Post-#128 the
 * action handler emits the v0.4 envelope via `emitUpdateSuccess` rather
 * than a pure `formatUpdateResult` helper — the wire-shape assertions
 * for the envelope itself live in `lib/__tests__/envelopes.test.ts`.
 * The pretty body kept here (`formatUpdatePrettyEntity`) is the
 * indented-bio / indented-headline subset that goes under the
 * `✓ Updated: …` header line.
 */

const UPDATED: profile.basic.UpdateProfileResult = {
  profile: {
    id: "p1",
    about: "a brand new bio",
    quote: "shorter, sharper, smarter",
  },
  notice: null,
};

describe("formatUpdatePrettyEntity", () => {
  it("echoes back the new bio and headline using the user-facing flag names", () => {
    const out = formatUpdatePrettyEntity(UPDATED);
    expect(out).toContain("bio: a brand new bio");
    expect(out).toContain("headline: shorter, sharper, smarter");
  });

  it("omits unchanged-side lines when the server does not return them", () => {
    const partial: profile.basic.UpdateProfileResult = {
      profile: { id: "p1", about: "only bio", quote: null },
      notice: null,
    };
    const out = formatUpdatePrettyEntity(partial);
    expect(out).toContain("bio: only bio");
    expect(out).not.toContain("headline:");
  });

  it("trims every line to 80 columns (long-bio truncation must end with ellipsis)", () => {
    const longBio = "x".repeat(200);
    const wide: profile.basic.UpdateProfileResult = {
      profile: { id: "p1", about: longBio, quote: null },
      notice: null,
    };
    const out = formatUpdatePrettyEntity(wide);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    const bioLine = out.split("\n").find((l) => l.includes("bio:"));
    expect(bioLine?.endsWith("…")).toBe(true);
  });

  it("does not include a leading confirmation line — that's the envelope's `✓ Updated:` header's job", () => {
    const out = formatUpdatePrettyEntity(UPDATED);
    expect(out).not.toContain("Profile updated.");
    expect(out).not.toContain("✓");
  });
});
