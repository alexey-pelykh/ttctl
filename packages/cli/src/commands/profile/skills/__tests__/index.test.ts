// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import type { profile } from "@ttctl/core";

import {
  buildProfileSkillsCommand,
  formatSkillSetTable,
  formatSkillSetText,
  formatSkillsListTable,
  formatSkillsListText,
  parseExperience,
} from "../index.js";

const SKILL_OK: profile.skills.ProfileSkillSet = {
  id: "ss1",
  experience: 60,
  rating: "EXPERT",
  public: true,
  position: 1,
  skill: { id: "sk-ts", name: "TypeScript" },
  connectionsCount: 3,
};

const SKILL_PARTIAL: profile.skills.ProfileSkillSet = {
  id: "ss2",
  experience: null,
  rating: null,
  public: false,
  position: 2,
  skill: { id: "sk-py", name: "Python" },
  connectionsCount: 0,
};

// -----------------------------------------------------------------------
// parseExperience (pure function)
// -----------------------------------------------------------------------

describe("parseExperience", () => {
  it("parses a bare integer as months", () => {
    expect(parseExperience("60")).toBe(60);
    expect(parseExperience("  120  ")).toBe(120);
  });

  it("parses Ny as N*12 months", () => {
    expect(parseExperience("5y")).toBe(60);
    expect(parseExperience("1Y")).toBe(12);
  });

  it("parses Nm as N months (case-insensitive)", () => {
    expect(parseExperience("36m")).toBe(36);
    expect(parseExperience("0M")).toBe(0);
  });

  it("returns null for unrecognised formats", () => {
    expect(parseExperience("forever")).toBeNull();
    expect(parseExperience("5 years")).toBeNull();
    expect(parseExperience("5w")).toBeNull();
    expect(parseExperience("")).toBeNull();
  });
});

// -----------------------------------------------------------------------
// formatSkillSetText / formatSkillSetTable
// -----------------------------------------------------------------------

describe("formatSkillSetText", () => {
  it("leads with the skill name and indents details", () => {
    const out = formatSkillSetText(SKILL_OK);
    expect(out.split("\n")[0]).toBe("TypeScript");
    expect(out).toContain("  id: ss1");
    expect(out).toContain("  rating: EXPERT");
    expect(out).toContain("  experience: 60 months");
    expect(out).toContain("  visibility: public");
    expect(out).toContain("  connections: 3");
  });

  it("omits unset rating/experience lines (no '(unset)' string in text mode)", () => {
    const out = formatSkillSetText(SKILL_PARTIAL);
    expect(out).toContain("  visibility: private");
    expect(out).not.toContain("  rating:");
    expect(out).not.toContain("  experience:");
  });
});

describe("formatSkillSetTable", () => {
  it("renders all six rows including (unset) sentinels", () => {
    const out = formatSkillSetTable(SKILL_PARTIAL);
    expect(out).toContain("Python");
    expect(out).toContain("(unset)");
    expect(out).toContain("private");
  });
});

// -----------------------------------------------------------------------
// formatSkillsListText / formatSkillsListTable
// -----------------------------------------------------------------------

describe("formatSkillsListText", () => {
  it("emits one tab-separated line per skill", () => {
    const out = formatSkillsListText([SKILL_OK, SKILL_PARTIAL]);
    expect(out.split("\n")).toHaveLength(2);
    expect(out.split("\n")[0]).toBe("TypeScript\tEXPERT\tpublic\tss1");
    expect(out.split("\n")[1]).toBe("Python\t?\tprivate\tss2");
  });

  it("returns an empty-state string when the list is empty", () => {
    expect(formatSkillsListText([])).toBe("(no skills on profile)");
  });
});

describe("formatSkillsListTable", () => {
  it("renders a header + one row per skill", () => {
    const out = formatSkillsListTable([SKILL_OK, SKILL_PARTIAL]);
    expect(out).toContain("Name");
    expect(out).toContain("TypeScript");
    expect(out).toContain("Python");
    expect(out).toContain("(unset)");
  });

  it("renders an empty table when the list is empty", () => {
    const out = formatSkillsListTable([]);
    // cli-table3 with only a header still renders the heading row.
    expect(out).toContain("Name");
    expect(out).toContain("Rating");
  });
});

// -----------------------------------------------------------------------
// buildProfileSkillsCommand
// -----------------------------------------------------------------------

describe("buildProfileSkillsCommand", () => {
  const cmd = buildProfileSkillsCommand();
  const subNames = cmd.commands.map((c) => c.name());

  it("registers exactly the seven leaves the issue specifies", () => {
    expect(subNames.sort()).toEqual(["add", "autocomplete", "list", "readiness", "remove", "show", "update"]);
  });

  it("declares `rm` as an alias on the `remove` leaf (per issue #72 convention)", () => {
    const remove = cmd.commands.find((c) => c.name() === "remove");
    expect(remove?.aliases()).toContain("rm");
  });

  it("update leaf accepts --rating, --experience, --public, --private flags", () => {
    const update = cmd.commands.find((c) => c.name() === "update");
    const flags = update?.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(["--rating", "--experience", "--public", "--private"]));
  });

  it("show / list / autocomplete / readiness expose -o/--output with text/json/table/yaml choices", () => {
    for (const name of ["show", "list", "autocomplete", "readiness"]) {
      const sub = cmd.commands.find((c) => c.name() === name);
      const output = sub?.options.find((o) => o.long === "--output");
      expect(output, `${name} should declare --output`).toBeDefined();
      expect(output?.argChoices).toEqual(["text", "json", "table", "yaml"]);
    }
  });

  it("autocomplete leaf accepts --limit with a default of '10'", () => {
    const auto = cmd.commands.find((c) => c.name() === "autocomplete");
    const limit = auto?.options.find((o) => o.long === "--limit");
    expect(limit?.defaultValue).toBe("10");
  });
});
