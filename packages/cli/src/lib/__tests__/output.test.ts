// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it, vi } from "vitest";

import { OUTPUT_FORMATS, TEXT_FALLBACK_HINT, emitResult, formatResult } from "../output.js";
import type { OutputFormat } from "../output.js";

interface Sample {
  name: string;
  count: number;
  tags: string[];
}

const SAMPLE: Sample = { name: "Ada", count: 3, tags: ["a", "b"] };

function captureStdout(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

function captureStderr(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

describe("OUTPUT_FORMATS", () => {
  it("enumerates the three valid formats in declared order", () => {
    expect(OUTPUT_FORMATS).toEqual(["text", "json", "table"]);
  });

  it("element types are assignable to OutputFormat", () => {
    // Compile-time check: OUTPUT_FORMATS is `readonly OutputFormat[]`.
    const sample: OutputFormat = OUTPUT_FORMATS[0] ?? "text";
    expect(["text", "json", "table"]).toContain(sample);
  });
});

describe("formatResult — json branch", () => {
  it("returns single-line JSON with no extra whitespace (AC: JSON output is single-line)", () => {
    const result = formatResult(SAMPLE, "json");
    expect(result.output).toBe('{"name":"Ada","count":3,"tags":["a","b"]}');
  });

  it("never includes newlines or padding spaces in the json branch", () => {
    const result = formatResult(SAMPLE, "json");
    expect(result.output).not.toContain("\n");
    expect(result.output).not.toContain(": ");
    expect(result.output).not.toContain(", ");
  });

  it("ignores the text/table formatters when format is json", () => {
    const result = formatResult(SAMPLE, "json", {
      text: () => "TEXT_OUTPUT",
      table: () => "TABLE_OUTPUT",
    });
    expect(result.output).toBe(JSON.stringify(SAMPLE));
    expect(result.output).not.toContain("TEXT_OUTPUT");
    expect(result.output).not.toContain("TABLE_OUTPUT");
  });

  it("does not surface a warning for the json branch", () => {
    const result = formatResult(SAMPLE, "json");
    expect("warning" in result).toBe(false);
  });
});

describe("formatResult — text branch", () => {
  it("uses the caller-provided text formatter when present", () => {
    const result = formatResult(SAMPLE, "text", {
      text: (d) => `name=${d.name},count=${d.count.toString()}`,
    });
    expect(result.output).toBe("name=Ada,count=3");
    expect("warning" in result).toBe(false);
  });

  it("falls through to pretty-printed JSON.stringify(data, null, 2) when no text formatter (AC: fall-through to JSON.stringify when text formatter absent)", () => {
    const result = formatResult(SAMPLE, "text");
    expect(result.output).toBe(JSON.stringify(SAMPLE, null, 2));
    // Two-space indent characteristic.
    expect(result.output).toContain('  "name": "Ada"');
  });

  it("surfaces the text-fallback warning when no text formatter is provided", () => {
    const result = formatResult(SAMPLE, "text");
    expect("warning" in result).toBe(true);
    if ("warning" in result) {
      expect(result.warning).toBe(TEXT_FALLBACK_HINT);
    }
  });

  it("does NOT surface the text-fallback warning when the caller provides a text formatter", () => {
    const result = formatResult(SAMPLE, "text", { text: () => "explicit" });
    expect("warning" in result).toBe(false);
  });
});

describe("formatResult — table branch", () => {
  it("uses the caller-provided table formatter when present", () => {
    const result = formatResult(SAMPLE, "table", {
      table: (d) => `[table:${d.name}]`,
    });
    expect(result.output).toBe("[table:Ada]");
    expect("warning" in result).toBe(false);
  });

  it("falls through to the text branch when no table formatter is provided (AC: fall-through to text when table formatter absent)", () => {
    const result = formatResult(SAMPLE, "table", {
      text: (d) => `text-render:${d.name}`,
    });
    expect(result.output).toBe("text-render:Ada");
    expect("warning" in result).toBe(false);
  });

  it("table-without-table-or-text falls through to JSON.stringify(_, null, 2) and surfaces the text-fallback warning", () => {
    const result = formatResult(SAMPLE, "table");
    expect(result.output).toBe(JSON.stringify(SAMPLE, null, 2));
    expect("warning" in result).toBe(true);
    if ("warning" in result) {
      expect(result.warning).toBe(TEXT_FALLBACK_HINT);
    }
  });
});

describe("formatResult — default format", () => {
  it("defaults to text when format is unspecified (AC: default to text when format unspecified)", () => {
    const result = formatResult(SAMPLE, undefined, {
      text: () => "DEFAULT_TEXT",
    });
    expect(result.output).toBe("DEFAULT_TEXT");
  });

  it("defaults to text and falls through to JSON when no formatter is provided either", () => {
    const result = formatResult(SAMPLE);
    expect(result.output).toBe(JSON.stringify(SAMPLE, null, 2));
    expect("warning" in result).toBe(true);
  });
});

describe("emitResult", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the formatted output plus a trailing newline to stdout", () => {
    const stdout = captureStdout();
    captureStderr();
    emitResult(SAMPLE, "json");
    expect(stdout.lines.join("")).toBe(`${JSON.stringify(SAMPLE)}\n`);
  });

  it("writes the warning line to stderr BEFORE the stdout payload (text fall-through)", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    emitResult(SAMPLE, "text");
    expect(stderr.lines.join("")).toBe(`${TEXT_FALLBACK_HINT}\n`);
    expect(stdout.lines.join("")).toBe(`${JSON.stringify(SAMPLE, null, 2)}\n`);
  });

  it("emits no stderr line when the format/formatter combination doesn't warrant a warning", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    emitResult(SAMPLE, "text", { text: (d) => `T:${d.name}` });
    expect(stdout.lines.join("")).toBe("T:Ada\n");
    expect(stderr.lines.join("")).toBe("");
  });

  it("emits a stderr warning AND writes the JSON pretty-print to stdout for table-without-formatters", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    emitResult(SAMPLE, "table");
    expect(stderr.lines.join("")).toBe(`${TEXT_FALLBACK_HINT}\n`);
    expect(stdout.lines.join("")).toBe(`${JSON.stringify(SAMPLE, null, 2)}\n`);
  });

  it("emits no stderr warning when table fall-through reaches a caller-provided text formatter", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    emitResult(SAMPLE, "table", { text: (d) => `T:${d.name}` });
    expect(stderr.lines.join("")).toBe("");
    expect(stdout.lines.join("")).toBe("T:Ada\n");
  });

  it("defaults to text format when format is omitted", () => {
    const stdout = captureStdout();
    captureStderr();
    emitResult(SAMPLE, undefined, { text: () => "default-branch" });
    expect(stdout.lines.join("")).toBe("default-branch\n");
  });
});
