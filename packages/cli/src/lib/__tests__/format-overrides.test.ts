// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { DEFAULT_STRATEGY, FORMAT_OVERRIDES, resolveStrategy } from "../format-overrides.js";
import type { FormatStrategy } from "../format-overrides.js";

describe("FORMAT_OVERRIDES registry", () => {
  it("registers `profile reviews list` with the multi-line strategy", () => {
    expect(FORMAT_OVERRIDES.get("profile reviews list")).toBe("multi-line" satisfies FormatStrategy);
  });

  it("does NOT register the candidate paths reserved for #129 (employment / portfolio list)", () => {
    // These two entries are planned but will only land after #129
    // rewrites the corresponding formatters. Confirming absence here
    // makes the deferred enrollment intentional and reviewable.
    expect(FORMAT_OVERRIDES.has("profile employment list")).toBe(false);
    expect(FORMAT_OVERRIDES.has("profile portfolio list")).toBe(false);
  });

  it("ships a single registered entry today (no scope creep)", () => {
    expect(FORMAT_OVERRIDES.size).toBe(1);
  });
});

describe("resolveStrategy()", () => {
  it("returns the registered strategy for `profile reviews list`", () => {
    expect(resolveStrategy("profile reviews list")).toBe("multi-line");
  });

  it("falls back to DEFAULT_STRATEGY for unknown command paths", () => {
    expect(resolveStrategy("profile basic show")).toBe(DEFAULT_STRATEGY);
    expect(resolveStrategy("profile education list")).toBe(DEFAULT_STRATEGY);
    expect(resolveStrategy("auth signin")).toBe(DEFAULT_STRATEGY);
    expect(resolveStrategy("totally made up command")).toBe(DEFAULT_STRATEGY);
  });

  it("DEFAULT_STRATEGY is `default`", () => {
    expect(DEFAULT_STRATEGY).toBe("default" satisfies FormatStrategy);
  });

  it("is case-sensitive — alias forms do NOT resolve via this layer", () => {
    // Aliases (e.g., `certs`, `rm`, `experience`) must collapse to
    // the canonical form upstream of this lookup. The registry
    // does not perform alias collapse itself.
    expect(resolveStrategy("Profile Reviews List")).toBe(DEFAULT_STRATEGY);
    expect(resolveStrategy("profile  reviews  list")).toBe(DEFAULT_STRATEGY);
  });

  it("accepts an injected override map for tests", () => {
    const injected = new Map<string, FormatStrategy>([
      ["profile basic show", "multi-line"],
      ["profile reviews list", "default"],
    ]);
    expect(resolveStrategy("profile basic show", injected)).toBe("multi-line");
    expect(resolveStrategy("profile reviews list", injected)).toBe("default");
    expect(resolveStrategy("profile education list", injected)).toBe(DEFAULT_STRATEGY);
  });
});
