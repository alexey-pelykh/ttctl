// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { payments } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { formatQuestionsBlock } from "../rate.js";

function question(kind: string, options: payments.RateQuestionOption[] = []): payments.RateQuestion {
  return { id: "q-1", kind, label: "Why?", options };
}

describe("formatQuestionsBlock", () => {
  it("labels a TEXT question free text even when it carries options", () => {
    const out = formatQuestionsBlock([question("TEXT", [{ label: "sentinel", commentRequired: false }])]);
    expect(out).toContain("(free text — server also returned options)");
    expect(out).not.toContain("sentinel");
  });

  it("labels a TEXT question free text when it carries no options", () => {
    expect(formatQuestionsBlock([question("TEXT")])).toContain("(free text)");
  });

  it("does not label a RADIO question free text when it carries no options", () => {
    const out = formatQuestionsBlock([question("RADIO")]);
    expect(out).not.toContain("(free text)");
    expect(out).toContain("(no options returned by the server)");
  });

  it("renders the option list for a RADIO question", () => {
    const out = formatQuestionsBlock([
      question("RADIO", [
        { label: "Yes", commentRequired: false },
        { label: "No", commentRequired: true },
      ]),
    ]);
    expect(out).toContain("Yes / No (comment required)");
    expect(out).not.toContain("(free text)");
  });

  it("flags an unrecognized kind instead of claiming free text", () => {
    const out = formatQuestionsBlock([question("DROPDOWN")]);
    expect(out).not.toContain("(free text)");
    expect(out).toContain("(unrecognized kind — no options returned by the server)");
  });

  it("marks an unrecognized kind that carries options rather than passing it off as a pick-one", () => {
    const out = formatQuestionsBlock([question("DROPDOWN", [{ label: "Yes", commentRequired: false }])]);
    expect(out).toContain("Yes (unrecognized kind)");
    expect(out).not.toContain("(free text)");
    // The terse marker omits the kind because the adjacent column carries it.
    expect(out).toContain("DROPDOWN");
  });

  it("returns the no-questions message for an empty list", () => {
    expect(formatQuestionsBlock([])).toBe("(no questions returned by the server)");
  });
});
