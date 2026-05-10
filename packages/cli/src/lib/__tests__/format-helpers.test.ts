// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { UNSET_PLACEHOLDER, indentLines, renderMultiParagraph, unsetOr } from "../format-helpers.js";

describe("unsetOr", () => {
  it("returns the value verbatim when present", () => {
    expect(unsetOr("hello")).toBe("hello");
  });

  it("returns the placeholder for null", () => {
    expect(unsetOr(null)).toBe(UNSET_PLACEHOLDER);
  });

  it("returns the placeholder for undefined", () => {
    expect(unsetOr(undefined)).toBe(UNSET_PLACEHOLDER);
  });

  it('returns the placeholder for an empty string (server contract: cleared field surfaces as `""`)', () => {
    expect(unsetOr("")).toBe(UNSET_PLACEHOLDER);
  });

  it("returns the supplied custom fallback when value is empty", () => {
    expect(unsetOr(null, "(none)")).toBe("(none)");
    expect(unsetOr("", "(missing)")).toBe("(missing)");
  });

  it("preserves whitespace-only values (the server treats them as set)", () => {
    expect(unsetOr(" ")).toBe(" ");
  });
});

describe("indentLines", () => {
  it("indents every line by the supplied indent string", () => {
    expect(indentLines("a\nb\nc", "  ")).toBe("  a\n  b\n  c");
  });

  it("leaves empty lines empty (preserves paragraph breaks)", () => {
    expect(indentLines("para1\n\npara2", "  ")).toBe("  para1\n\n  para2");
  });

  it("defaults to two-space indent", () => {
    expect(indentLines("hello")).toBe("  hello");
  });

  it("handles single-line input", () => {
    expect(indentLines("just one", ">>")).toBe(">>just one");
  });

  it("handles empty input", () => {
    expect(indentLines("", "  ")).toBe("");
  });
});

describe("renderMultiParagraph", () => {
  it("emits the prefix on its own line followed by indented body", () => {
    expect(renderMultiParagraph("Bio", "Hello.", "  ")).toBe("  Bio:\n    Hello.");
  });

  it("preserves paragraph breaks as actual blank lines", () => {
    const body = "Paragraph one.\n\nParagraph two.";
    const out = renderMultiParagraph("Bio", body, "  ");
    expect(out).toBe("  Bio:\n    Paragraph one.\n\n    Paragraph two.");
    expect(out).not.toContain("\\n\\n");
  });

  it("nests indent under outer indent", () => {
    expect(renderMultiParagraph("Description", "Text.", "    ")).toBe("    Description:\n      Text.");
  });

  it("defaults outer indent to two spaces", () => {
    expect(renderMultiParagraph("Bio", "Text.")).toBe("  Bio:\n    Text.");
  });

  it("handles single-line bodies (no paragraph breaks)", () => {
    expect(renderMultiParagraph("Headline", "Mathematician")).toBe("  Headline:\n    Mathematician");
  });
});
