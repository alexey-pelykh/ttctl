// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as yamlParse } from "yaml";

import { OUTPUT_FORMATS, PRETTY_FALLBACK_HINT, emitResult, formatResult, formatYaml } from "../output.js";
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
  it("enumerates the three valid formats in declared order (AC #126: --output={pretty,json,yaml})", () => {
    expect(OUTPUT_FORMATS).toEqual(["pretty", "json", "yaml"]);
  });

  it("element types are assignable to OutputFormat", () => {
    // Compile-time check: OUTPUT_FORMATS is `readonly OutputFormat[]`.
    const sample: OutputFormat = OUTPUT_FORMATS[0] ?? "pretty";
    expect(["pretty", "json", "yaml"]).toContain(sample);
  });

  it("does NOT include the dropped pre-#126 names `text` or `table`", () => {
    expect(OUTPUT_FORMATS).not.toContain("text");
    expect(OUTPUT_FORMATS).not.toContain("table");
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

  it("ignores the pretty/table formatters when format is json", () => {
    const result = formatResult(SAMPLE, "json", {
      pretty: () => "PRETTY_OUTPUT",
      table: () => "TABLE_OUTPUT",
    });
    expect(result.output).toBe(JSON.stringify(SAMPLE));
    expect(result.output).not.toContain("PRETTY_OUTPUT");
    expect(result.output).not.toContain("TABLE_OUTPUT");
  });

  it("does not surface a warning for the json branch", () => {
    const result = formatResult(SAMPLE, "json");
    expect("warning" in result).toBe(false);
  });
});

describe("formatResult — pretty branch (show-shape data)", () => {
  it("uses the caller-provided pretty formatter when present (show shape: object)", () => {
    const result = formatResult(SAMPLE, "pretty", {
      pretty: (d) => `name=${d.name},count=${d.count.toString()}`,
    });
    expect(result.output).toBe("name=Ada,count=3");
    expect("warning" in result).toBe(false);
  });

  it("falls through to pretty-printed JSON.stringify(data, null, 2) when no formatters supplied", () => {
    const result = formatResult(SAMPLE, "pretty");
    expect(result.output).toBe(JSON.stringify(SAMPLE, null, 2));
    expect(result.output).toContain('  "name": "Ada"');
  });

  it("surfaces the pretty-fallback warning when no pretty/table formatter is provided", () => {
    const result = formatResult(SAMPLE, "pretty");
    expect("warning" in result).toBe(true);
    if ("warning" in result) {
      expect(result.warning).toBe(PRETTY_FALLBACK_HINT);
    }
  });

  it("does NOT surface the pretty-fallback warning when the caller provides a pretty formatter", () => {
    const result = formatResult(SAMPLE, "pretty", { pretty: () => "explicit" });
    expect("warning" in result).toBe(false);
  });

  it("show-shape with both formatters prefers `pretty` (curated layout for show verbs)", () => {
    const result = formatResult(SAMPLE, "pretty", {
      pretty: (d) => `pretty:${d.name}`,
      table: (d) => `table:${d.name}`,
    });
    // The shape dispatch picks `pretty` for show-shape data (single object).
    expect(result.output).toBe("pretty:Ada");
  });

  it("show-shape with only `table` formatter falls back to it (no pretty available)", () => {
    const result = formatResult(SAMPLE, "pretty", {
      table: (d) => `[table:${d.name}]`,
    });
    expect(result.output).toBe("[table:Ada]");
    expect("warning" in result).toBe(false);
  });
});

describe("formatResult — pretty branch (list-shape data)", () => {
  it("list-shape with both formatters prefers `table` (column layout for list verbs)", () => {
    const data = [SAMPLE, SAMPLE];
    const result = formatResult(data, "pretty", {
      pretty: (d) => `pretty:${d.length.toString()}`,
      table: (d) => `table:${d.length.toString()}`,
    });
    // The shape dispatch picks `table` for list-shape data (array).
    expect(result.output).toBe("table:2");
  });

  it("list-shape with only `pretty` formatter falls back to it (no table available)", () => {
    const data = [SAMPLE];
    const result = formatResult(data, "pretty", {
      pretty: (d) => `pretty:${d.length.toString()}`,
    });
    expect(result.output).toBe("pretty:1");
    expect("warning" in result).toBe(false);
  });

  it("envelope-shape `{items: [...]}` is treated as list-shape", () => {
    const data = { items: [SAMPLE, SAMPLE] };
    const result = formatResult(data, "pretty", {
      pretty: () => "PRETTY_BRANCH",
      table: () => "TABLE_BRANCH",
    });
    expect(result.output).toBe("TABLE_BRANCH");
  });
});

describe("formatResult — default format", () => {
  it("defaults to pretty when format is unspecified (AC #126: default to pretty)", () => {
    const result = formatResult(SAMPLE, undefined, {
      pretty: () => "DEFAULT_PRETTY",
    });
    expect(result.output).toBe("DEFAULT_PRETTY");
  });

  it("defaults to pretty and falls through to JSON when no formatter is provided either", () => {
    const result = formatResult(SAMPLE);
    expect(result.output).toBe(JSON.stringify(SAMPLE, null, 2));
    expect("warning" in result).toBe(true);
  });
});

describe("formatResult — empty-state wrapper (#122)", () => {
  it("emits single-line `[]` for json when input is an empty top-level array AND empty option is provided", () => {
    const result = formatResult([] as Sample[], "json", { empty: { command: "profile.skills.list" } });
    expect(result.output).toBe("[]");
    expect("warning" in result).toBe(false);
  });

  it("emits single-line `[]` for json when input is the future {items: []} envelope", () => {
    const result = formatResult({ items: [] } as { items: Sample[] }, "json", {
      empty: { command: "profile.skills.list" },
    });
    expect(result.output).toBe("[]");
  });

  it("emits prose+CTA for pretty when input is empty and the command is registered", () => {
    const result = formatResult([] as Sample[], "pretty", { empty: { command: "profile.skills.list" } });
    expect(result.output).toBe("No skills found. Add one with: ttctl profile skills add <name>");
    expect("warning" in result).toBe(false);
  });

  it("falls back to the generic 'No items found.' line for unregistered command paths", () => {
    const result = formatResult([] as Sample[], "pretty", { empty: { command: "profile.unknown.list" } });
    expect(result.output).toBe("No items found.");
  });

  it("does NOT fire the wrapper when `empty` option is absent (existing behavior preserved)", () => {
    // Caller provides a pretty formatter; wrapper would short-circuit if
    // it fired, but without `empty:` the formatter MUST run.
    // List-shape data (empty array) without empty wrapper still picks the
    // table formatter first per shape dispatch — provide only pretty here
    // to force the show-style fallback.
    const result = formatResult([] as Sample[], "pretty", { pretty: () => "EXPLICIT_FORMATTER" });
    expect(result.output).toBe("EXPLICIT_FORMATTER");
  });

  it("does NOT fire the wrapper for non-empty arrays (delegates to the table formatter via shape dispatch)", () => {
    const result = formatResult([SAMPLE], "pretty", {
      table: (data) => `count=${data.length.toString()}`,
      empty: { command: "profile.skills.list" },
    });
    expect(result.output).toBe("count=1");
  });

  it("does NOT fire the wrapper for show-shape payloads (single object, no `items` field)", () => {
    // SAMPLE is `{name, count, tags}` — not an empty collection. The
    // wrapper must let the regular pretty formatter run.
    const result = formatResult(SAMPLE, "pretty", {
      pretty: (data) => `name=${data.name}`,
      empty: { command: "profile.skills.list" },
    });
    expect(result.output).toBe("name=Ada");
  });

  it("the wrapper short-circuits BEFORE calling the per-format pretty formatter", () => {
    const prettySpy = vi.fn(() => "FORMATTER_CALLED");
    const result = formatResult([] as Sample[], "pretty", {
      pretty: prettySpy,
      empty: { command: "profile.skills.list" },
    });
    expect(prettySpy).not.toHaveBeenCalled();
    expect(result.output).not.toBe("FORMATTER_CALLED");
  });

  it("the wrapper short-circuits BEFORE calling the per-format table formatter", () => {
    const tableSpy = vi.fn(() => "TABLE_FORMATTER_CALLED");
    const result = formatResult([] as Sample[], "pretty", {
      table: tableSpy,
      empty: { command: "profile.skills.list" },
    });
    expect(tableSpy).not.toHaveBeenCalled();
    expect(result.output).not.toBe("TABLE_FORMATTER_CALLED");
  });
});

describe("formatYaml — direct helper", () => {
  // The four AC-listed scenarios for `formatYaml`. The shared profile
  // shape exercises multi-paragraph strings, ISO-8601 dates, numerics,
  // and nested lists — covering every helper-level guarantee in one
  // representative shape.
  interface ProfileSample {
    name: string;
    bio: string;
    rate_eur: number;
    updated_at: string;
    tags: string[];
  }
  const PROFILE: ProfileSample = {
    name: "Ada Lovelace",
    bio: "First paragraph: a sentence about programming.\n\nSecond paragraph: another sentence about analytical engines.",
    rate_eur: 4500,
    updated_at: "2026-05-10T05:45:00Z",
    tags: ["analytical-engine", "first-programmer"],
  };

  it('renders a multi-paragraph string field as a `|` literal block scalar (AC: bio: | literal block + paragraph break preserved, NOT bio: "...\\n\\n...")', () => {
    const out = formatYaml(PROFILE);
    // Literal block scalar opens with `|` on the value's first line, with
    // each subsequent line indented under the key.
    expect(out).toContain("bio: |");
    // The paragraph break (blank line between paragraphs) survives as an
    // actual blank line in the rendered scalar — NOT escaped as `\n\n`.
    expect(out).toContain("First paragraph: a sentence about programming.");
    expect(out).toContain("Second paragraph: another sentence about analytical engines.");
    // Negative assertion: the multi-paragraph value must NOT have been
    // serialized as a double-quoted scalar with escape sequences.
    expect(out).not.toContain('bio: "');
    expect(out).not.toContain("\\n\\n");
  });

  it("roundtrips: yaml.parse(formatYaml(profile)) yields a structure equivalent to the input (AC: roundtrip)", () => {
    const rendered = formatYaml(PROFILE);
    const parsed: unknown = yamlParse(rendered);
    expect(parsed).toEqual(PROFILE);
  });

  it("renders an ISO-8601 string field as a quoted (or plain) ISO string — never as `!!timestamp`/unquoted-with-tag (AC: date-as-quoted-ISO)", () => {
    const out = formatYaml(PROFILE);
    // The ISO 8601 string must surface verbatim. The yaml lib may emit
    // it quoted (single or double) or plain — what matters is the value
    // is preserved AND no `!!timestamp` tag prefix is applied.
    expect(out).toContain("2026-05-10T05:45:00Z");
    expect(out).not.toContain("!!timestamp");
    expect(out).not.toContain("!!date");
    // Roundtrip discipline: the parsed value MUST be the exact ISO
    // string, not a `Date` object created by date-tag auto-parse.
    const parsed = yamlParse(out) as ProfileSample;
    expect(parsed.updated_at).toBe("2026-05-10T05:45:00Z");
    expect(typeof parsed.updated_at).toBe("string");
  });

  it("renders a list of strings as block style (`- item`), never flow style (`[item]`) (AC: list-block-style)", () => {
    const out = formatYaml(PROFILE);
    // Block-style list markers for each entry.
    expect(out).toContain("- analytical-engine");
    expect(out).toContain("- first-programmer");
    // Negative assertion: no flow-style list anywhere in the output.
    expect(out).not.toMatch(/tags:\s*\[/);
  });

  it("renders numeric fields as their natural YAML scalar type (numbers, not strings)", () => {
    const out = formatYaml(PROFILE);
    // The number 4500 must surface unquoted; string '4500' would surface
    // quoted or with a leading space (`rate_eur: "4500"` / `rate_eur: '4500'`).
    expect(out).toMatch(/rate_eur: 4500\b/);
    // Roundtrip discipline: parsed value is `number`, not `string`.
    const parsed = yamlParse(out) as ProfileSample;
    expect(parsed.rate_eur).toBe(4500);
    expect(typeof parsed.rate_eur).toBe("number");
  });

  it("emits no flow-style maps (`{key: value}`) anywhere in the output", () => {
    // Use a nested-object shape to exercise the no-flow-map invariant.
    const nested = { outer: { inner: { leaf: 1 } } };
    const out = formatYaml(nested);
    expect(out).not.toMatch(/\{/);
    expect(out).not.toMatch(/\}/);
  });

  it("returns a string with no trailing newline (consistent with JSON.stringify) so emitResult adds exactly one", () => {
    // The yaml lib's stringify always appends a trailing newline; the
    // helper strips it so the formatter contract matches `JSON.stringify`'s.
    const out = formatYaml(SAMPLE);
    expect(out.endsWith("\n")).toBe(false);
  });
});

describe("formatResult — yaml branch", () => {
  it("uses `formatYaml` for the yaml format (AC: --output=yaml accepts yaml)", () => {
    const result = formatResult(SAMPLE, "yaml");
    expect(result.output).toBe(formatYaml(SAMPLE));
    // Verify the actual content surfaces in the expected block-style shape.
    expect(result.output).toContain("name: Ada");
    expect(result.output).toContain("count: 3");
    expect(result.output).toMatch(/tags:\n {2}- a\n {2}- b/);
  });

  it("ignores the pretty/table formatters when format is yaml", () => {
    const result = formatResult(SAMPLE, "yaml", {
      pretty: () => "PRETTY_OUTPUT",
      table: () => "TABLE_OUTPUT",
    });
    expect(result.output).toBe(formatYaml(SAMPLE));
    expect(result.output).not.toContain("PRETTY_OUTPUT");
    expect(result.output).not.toContain("TABLE_OUTPUT");
  });

  it("does not surface a warning for the yaml branch", () => {
    const result = formatResult(SAMPLE, "yaml");
    expect("warning" in result).toBe(false);
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

  it("writes the warning line to stderr BEFORE the stdout payload (pretty fall-through)", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    emitResult(SAMPLE, "pretty");
    expect(stderr.lines.join("")).toBe(`${PRETTY_FALLBACK_HINT}\n`);
    expect(stdout.lines.join("")).toBe(`${JSON.stringify(SAMPLE, null, 2)}\n`);
  });

  it("emits no stderr line when the format/formatter combination doesn't warrant a warning", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    emitResult(SAMPLE, "pretty", { pretty: (d) => `T:${d.name}` });
    expect(stdout.lines.join("")).toBe("T:Ada\n");
    expect(stderr.lines.join("")).toBe("");
  });

  it("defaults to pretty format when format is omitted", () => {
    const stdout = captureStdout();
    captureStderr();
    emitResult(SAMPLE, undefined, { pretty: () => "default-branch" });
    expect(stdout.lines.join("")).toBe("default-branch\n");
  });

  it("emits empty-state json with single trailing newline (no warning)", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    emitResult([] as Sample[], "json", { empty: { command: "profile.skills.list" } });
    expect(stdout.lines.join("")).toBe("[]\n");
    expect(stderr.lines.join("")).toBe("");
  });

  it("emits empty-state prose+CTA for pretty with single trailing newline (no warning)", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    emitResult([] as Sample[], "pretty", { empty: { command: "profile.skills.list" } });
    expect(stdout.lines.join("")).toBe("No skills found. Add one with: ttctl profile skills add <name>\n");
    expect(stderr.lines.join("")).toBe("");
  });

  it("writes the YAML rendering plus exactly one trailing newline to stdout (AC: trailing newline at end of output)", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    emitResult(SAMPLE, "yaml");
    const written = stdout.lines.join("");
    expect(written).toBe(`${formatYaml(SAMPLE)}\n`);
    // Exactly one trailing newline (not two — formatYaml strips the
    // yaml lib's own trailing `\n` so this contract holds).
    expect(written.endsWith("\n")).toBe(true);
    expect(written.endsWith("\n\n")).toBe(false);
    // No stderr noise on the yaml branch.
    expect(stderr.lines.join("")).toBe("");
  });
});
