// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { PROFILE_BASIC_FIELDS, cliToServer, serverToCli } from "../translations.js";

describe("PROFILE_BASIC_FIELDS", () => {
  it("maps `quote` -> `headline` (the documented CLI rename)", () => {
    expect(PROFILE_BASIC_FIELDS.quote).toBe("headline");
  });

  it("maps `about` -> `bio` (the documented CLI rename)", () => {
    expect(PROFILE_BASIC_FIELDS.about).toBe("bio");
  });

  it("declares a 1:1 mapping (each CLI flag is the alias of exactly one server field)", () => {
    const cliFlags = Object.values(PROFILE_BASIC_FIELDS);
    const unique = new Set(cliFlags);
    expect(unique.size).toBe(cliFlags.length);
  });
});

describe("serverToCli", () => {
  it("renames mapped keys server -> CLI", () => {
    const result = serverToCli({ quote: "Senior backend engineer" }, PROFILE_BASIC_FIELDS);
    expect(result).toEqual({ headline: "Senior backend engineer" });
  });

  it("renames multiple mapped keys in a single call", () => {
    const result = serverToCli(
      { quote: "Senior backend engineer", about: "10 years of experience…" },
      PROFILE_BASIC_FIELDS,
    );
    expect(result).toEqual({
      headline: "Senior backend engineer",
      bio: "10 years of experience…",
    });
  });

  it("passes unmapped keys through unchanged (translation table need not list every field)", () => {
    const result = serverToCli({ id: "p1", quote: "tagline", city: "Berlin" }, PROFILE_BASIC_FIELDS);
    expect(result).toEqual({
      id: "p1",
      headline: "tagline",
      city: "Berlin",
    });
  });

  it("preserves values verbatim (key-rename only — does not transform values)", () => {
    const nested = { foo: "bar", arr: [1, 2, 3] };
    const result = serverToCli({ quote: nested as unknown as string }, PROFILE_BASIC_FIELDS);
    expect(result.headline).toBe(nested);
  });

  it("returns a fresh object (does not mutate the input)", () => {
    const input = { quote: "tagline" };
    const result = serverToCli(input, PROFILE_BASIC_FIELDS);
    expect(result).not.toBe(input);
    expect(input).toEqual({ quote: "tagline" });
  });

  it("returns an empty object for an empty input", () => {
    expect(serverToCli({}, PROFILE_BASIC_FIELDS)).toEqual({});
  });

  it("works with an ad-hoc (un-registered) table", () => {
    const adHoc = { foo: "x", bar: "y" } as const;
    const result = serverToCli({ foo: 1, bar: 2, baz: 3 }, adHoc);
    expect(result).toEqual({ x: 1, y: 2, baz: 3 });
  });
});

describe("cliToServer", () => {
  it("renames mapped keys CLI -> server", () => {
    const result = cliToServer({ headline: "Senior backend engineer" }, PROFILE_BASIC_FIELDS);
    expect(result).toEqual({ quote: "Senior backend engineer" });
  });

  it("renames multiple mapped keys in a single call", () => {
    const result = cliToServer({ headline: "tagline", bio: "long-form bio…" }, PROFILE_BASIC_FIELDS);
    expect(result).toEqual({ quote: "tagline", about: "long-form bio…" });
  });

  it("passes unmapped keys through unchanged", () => {
    const result = cliToServer({ headline: "tagline", id: "p1" }, PROFILE_BASIC_FIELDS);
    expect(result).toEqual({ quote: "tagline", id: "p1" });
  });

  it("returns a fresh object (does not mutate the input)", () => {
    const input = { headline: "tagline" };
    const result = cliToServer(input, PROFILE_BASIC_FIELDS);
    expect(result).not.toBe(input);
    expect(input).toEqual({ headline: "tagline" });
  });

  it("works with an ad-hoc (un-registered) table — falls back to on-the-fly inversion", () => {
    const adHoc = { foo: "x", bar: "y" } as const;
    const result = cliToServer({ x: 1, y: 2, baz: 3 }, adHoc);
    expect(result).toEqual({ foo: 1, bar: 2, baz: 3 });
  });

  it("is the inverse of serverToCli for keys covered by the table (round-trip)", () => {
    const original = { quote: "tagline", about: "bio text", city: "Berlin" };
    const cliShaped = serverToCli(original, PROFILE_BASIC_FIELDS);
    const roundTripped = cliToServer(cliShaped, PROFILE_BASIC_FIELDS);
    expect(roundTripped).toEqual(original);
  });
});
