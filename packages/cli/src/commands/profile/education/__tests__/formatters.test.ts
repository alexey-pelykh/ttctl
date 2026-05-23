// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { profile } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { formatEducationListTable, formatEducationListText } from "../index.js";

/**
 * Pure-formatter unit tests for the `education list` pretty + table
 * renderers (#341). Covers happy path (multi-row) and empty list — both
 * shapes that the CLI list sub-command emits via `emitResult` after
 * wrapping the result in a `wrapListEnvelope`.
 */

const ROW_A: profile.education.Education = {
  id: "V1-Education-1",
  institution: "MIT",
  degree: "BSc",
  fieldOfStudy: "Computer Science",
  location: "Cambridge, MA",
  title: null,
  yearFrom: 2010,
  yearTo: 2014,
  highlight: true,
  skills: [
    { id: "V1-Skill-1", name: "Python" },
    { id: "V1-Skill-2", name: "C" },
  ],
};

const ROW_B: profile.education.Education = {
  id: "V1-Education-2",
  institution: "Stanford",
  degree: "MSc",
  fieldOfStudy: null,
  location: null,
  title: null,
  yearFrom: 2015,
  yearTo: null,
  highlight: false,
  skills: [],
};

describe("formatEducationListText (#341, #556)", () => {
  it("renders one tab-separated line per row with skills column, ending with the id", () => {
    const out = formatEducationListText([ROW_A, ROW_B]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("BSc\tMIT\t2010–2014\tPython, C\tV1-Education-1");
    expect(lines[1]).toBe("MSc\tStanford\t2015–present\t—\tV1-Education-2");
  });

  it("renders an empty-list sentinel when the list is empty", () => {
    expect(formatEducationListText([])).toBe("(no education entries on profile)");
  });
});

describe("formatEducationListTable (#341, #556)", () => {
  it("emits a cli-table3 table with one data row per entry plus skills and highlight columns", () => {
    const out = formatEducationListTable([ROW_A, ROW_B]);
    expect(out).toContain("Degree");
    expect(out).toContain("Institution");
    expect(out).toContain("Skills");
    expect(out).toContain("Highlight");
    expect(out).toContain("BSc");
    expect(out).toContain("MIT");
    expect(out).toContain("2010–2014");
    expect(out).toContain("Python");
    expect(out).toContain("yes");
    expect(out).toContain("MSc");
    expect(out).toContain("Stanford");
    expect(out).toContain("2015–present");
    expect(out).toContain("—");
    expect(out).toContain("no");
  });
});
