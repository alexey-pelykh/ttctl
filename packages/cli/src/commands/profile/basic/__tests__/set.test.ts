// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { formatUpdateResult } from "../set.js";

const UPDATED: profile.basic.UpdateProfileResult = {
  profile: {
    id: "p1",
    about: "a brand new bio",
    quote: "shorter, sharper, smarter",
  },
  notice: null,
};

describe("formatUpdateResult (pretty)", () => {
  it("leads with a `Profile updated.` confirmation line", () => {
    const out = formatUpdateResult(UPDATED, "pretty");
    expect(out.split("\n")[0]).toBe("Profile updated.");
  });

  it("echoes back the new bio and headline using the user-facing flag names", () => {
    const out = formatUpdateResult(UPDATED, "pretty");
    expect(out).toContain("bio: a brand new bio");
    expect(out).toContain("headline: shorter, sharper, smarter");
  });

  it("omits unchanged-side lines when the server does not return them", () => {
    const partial: profile.basic.UpdateProfileResult = {
      profile: { id: "p1", about: "only bio", quote: null },
      notice: null,
    };
    const out = formatUpdateResult(partial, "pretty");
    expect(out).toContain("bio: only bio");
    expect(out).not.toContain("headline:");
  });

  it("trims every line to 80 columns (long-bio truncation must end with ellipsis)", () => {
    const longBio = "x".repeat(200);
    const wide: profile.basic.UpdateProfileResult = {
      profile: { id: "p1", about: longBio, quote: null },
      notice: null,
    };
    const out = formatUpdateResult(wide, "pretty");
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    const bioLine = out.split("\n").find((l) => l.includes("bio:"));
    expect(bioLine?.endsWith("…")).toBe(true);
  });

  it("includes the server-returned notice on its own indented line when present", () => {
    const withNotice: profile.basic.UpdateProfileResult = {
      profile: { id: "p1", about: "x", quote: null },
      notice: "Profile review may be required for some changes",
    };
    const out = formatUpdateResult(withNotice, "pretty");
    expect(out).toContain("Profile review may be required");
  });
});

describe("formatUpdateResult (json)", () => {
  it("returns the raw typed payload as pretty-printed JSON", () => {
    const out = formatUpdateResult(UPDATED, "json");
    const parsed: unknown = JSON.parse(out);
    expect(parsed).toEqual(UPDATED);
  });

  it("does not apply human-readable formatting to the json branch", () => {
    const out = formatUpdateResult(UPDATED, "json");
    expect(out).not.toContain("Profile updated.");
  });
});

describe("formatUpdateResult (yaml)", () => {
  it("returns block-style YAML carrying the typed payload (post-#126 yaml branch)", () => {
    const out = formatUpdateResult(UPDATED, "yaml");
    expect(out).toContain("about: a brand new bio");
    expect(out).toContain("quote: shorter, sharper, smarter");
    expect(out).toContain("notice: null");
  });

  it("does not apply pretty/confirmation framing to the yaml branch", () => {
    const out = formatUpdateResult(UPDATED, "yaml");
    expect(out).not.toContain("Profile updated.");
  });
});
