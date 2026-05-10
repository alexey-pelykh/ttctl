// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { EMPTY_STATE_CTAS, emptyStateProse, isEmptyCollection } from "../empty-state-cta.js";

describe("isEmptyCollection — array shape", () => {
  it("returns true for the canonical empty top-level array", () => {
    expect(isEmptyCollection([])).toBe(true);
  });

  it("returns false for non-empty arrays of any size", () => {
    expect(isEmptyCollection([1])).toBe(false);
    expect(isEmptyCollection([null])).toBe(false);
    expect(isEmptyCollection([undefined])).toBe(false);
    expect(isEmptyCollection(["a", "b", "c"])).toBe(false);
  });
});

describe("isEmptyCollection — envelope shape (forward-compat for {items, pageInfo?})", () => {
  it("returns true for {items: []} (the future list envelope reserved by #121)", () => {
    expect(isEmptyCollection({ items: [] })).toBe(true);
  });

  it("returns true even when the envelope carries other fields alongside an empty items[]", () => {
    expect(isEmptyCollection({ items: [], pageInfo: { hasNextPage: false } })).toBe(true);
  });

  it("returns false for {items: [...]} with at least one element", () => {
    expect(isEmptyCollection({ items: [1] })).toBe(false);
    expect(isEmptyCollection({ items: [null] })).toBe(false);
  });

  it("returns false when `items` is present but not an array", () => {
    // Defensive: protects against mistaking `{items: 0}` or
    // `{items: null}` for an empty collection envelope.
    expect(isEmptyCollection({ items: null })).toBe(false);
    expect(isEmptyCollection({ items: 0 })).toBe(false);
    expect(isEmptyCollection({ items: "" })).toBe(false);
    expect(isEmptyCollection({ items: {} })).toBe(false);
  });
});

describe("isEmptyCollection — non-collection inputs (must NOT trigger wrapper)", () => {
  it("returns false for plain objects without an `items` field", () => {
    expect(isEmptyCollection({})).toBe(false);
    expect(isEmptyCollection({ name: "Ada" })).toBe(false);
    expect(isEmptyCollection({ count: 0 })).toBe(false);
  });

  it("returns false for objects whose property happens to be an empty array but isn't named `items`", () => {
    // Guards against accidentally interpreting `show` payloads with an
    // empty `tags`/`media`/`languages` array as an empty list.
    expect(isEmptyCollection({ tags: [] })).toBe(false);
    expect(isEmptyCollection({ media: [], itemList: [] })).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isEmptyCollection(null)).toBe(false);
    expect(isEmptyCollection(undefined)).toBe(false);
  });

  it("returns false for scalars (string / number / boolean)", () => {
    expect(isEmptyCollection("")).toBe(false);
    expect(isEmptyCollection(0)).toBe(false);
    expect(isEmptyCollection(false)).toBe(false);
    expect(isEmptyCollection("[]")).toBe(false);
  });
});

describe("emptyStateProse — registered commands", () => {
  it.each([
    ["profile.skills.list", "No skills found. Add one with: ttctl profile skills add <name>"],
    ["profile.portfolio.list", "No portfolio items found. Add one with: ttctl profile portfolio add"],
    ["profile.industries.list", "No industries found. Add one with: ttctl profile industries add <name>"],
    ["profile.visas.list", "No travel visas found. Add one with: ttctl profile visas add"],
  ])("renders entity-specific prose with addHint for %s", (command, expected) => {
    expect(emptyStateProse(command)).toBe(expected);
  });

  it("renders prose without an addHint when the registry entry omits it (e.g., reviews are server-driven)", () => {
    expect(emptyStateProse("profile.reviews.list")).toBe("No pending section reviews found.");
  });
});

describe("emptyStateProse — generic fallback", () => {
  it("falls back to a generic line for unregistered command paths", () => {
    expect(emptyStateProse("profile.unknown.list")).toBe("No items found.");
    expect(emptyStateProse("")).toBe("No items found.");
  });
});

describe("EMPTY_STATE_CTAS — registry hygiene", () => {
  it("uses dot-separated canonical paths as keys (no leading/trailing whitespace)", () => {
    for (const key of Object.keys(EMPTY_STATE_CTAS)) {
      expect(key).toBe(key.trim());
      expect(key).not.toContain(" ");
      // ≥2 segments: top-level groups (e.g. `applications.list` from #15)
      // need the noun + verb only; nested sub-domains (e.g.
      // `profile.skills.list`) extend to 3+. The minimum is the
      // smallest canonical path the registry supports.
      expect(key.split(".").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("entityPlural is non-empty for every registered command", () => {
    for (const cta of Object.values(EMPTY_STATE_CTAS)) {
      expect(cta.entityPlural.length).toBeGreaterThan(0);
    }
  });
});
