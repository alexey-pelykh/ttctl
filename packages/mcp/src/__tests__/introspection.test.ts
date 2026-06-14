// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { listRegisteredMcpToolNames } from "../introspection.js";

describe("listRegisteredMcpToolNames", () => {
  const names = listRegisteredMcpToolNames();

  it("returns the full registered tool set, sorted and unique", () => {
    expect(names.length).toBeGreaterThan(100);
    expect([...names]).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("every name carries the canonical ttctl_ prefix", () => {
    expect(names.every((n) => /^ttctl_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(n))).toBe(true);
  });

  it("captures computed tool names a source scan would miss", () => {
    // `ttctl_profile_employment_skills_${op}` is registered via a template
    // literal — the reason this reads the runtime registry instead of scanning
    // the tool source for `"ttctl_…"` literals.
    expect(names).toContain("ttctl_profile_employment_skills_add");
    expect(names).toContain("ttctl_profile_employment_skills_remove");
    expect(names).toContain("ttctl_profile_basic_show");
  });
});
