// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as yamlParse } from "yaml";

import {
  ENVELOPE_VERSION,
  PRETTY_SUCCESS_PREFIX,
  buildAddEnvelope,
  buildErrorEnvelope,
  buildRemoveEnvelope,
  buildUpdateEnvelope,
  defaultPrettyErrorSummary,
  emitAddSuccess,
  emitErrorAndExit,
  emitRemoveSuccess,
  emitUpdateSuccess,
  formatAddJson,
  formatAddPretty,
  formatAddYaml,
  formatErrorJson,
  formatErrorPretty,
  formatErrorYaml,
  formatRemoveJson,
  formatRemovePretty,
  formatRemoveYaml,
  formatUpdateJson,
  formatUpdatePretty,
  formatUpdateYaml,
  wrapListEnvelope,
} from "../envelopes.js";

interface SkillEntity {
  id: string;
  name: string;
  rating: number | null;
}

const SKILL: SkillEntity = { id: "sk_abc123", name: "TypeScript", rating: 4 };

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

afterEach(() => {
  vi.restoreAllMocks();
});

// =======================================================================
// ENVELOPE_VERSION constant
// =======================================================================

describe("ENVELOPE_VERSION", () => {
  it('is the literal "1.0" (AC: version field is "1.0" in v0.4)', () => {
    expect(ENVELOPE_VERSION).toBe("1.0");
  });
});

// =======================================================================
// buildAddEnvelope — wire shape for `add` success
// =======================================================================

describe("buildAddEnvelope", () => {
  it("emits {ok: true, version, operation, created} (AC: success-add envelope)", () => {
    const env = buildAddEnvelope({ operation: "profile.skills.add", created: SKILL });
    expect(env).toEqual({
      ok: true,
      version: "1.0",
      operation: "profile.skills.add",
      created: SKILL,
    });
  });

  it("includes optional notice when supplied", () => {
    const env = buildAddEnvelope({ operation: "profile.skills.add", created: SKILL, notice: "no-op" });
    expect(env.notice).toBe("no-op");
  });

  it("omits notice key entirely when not supplied (no `undefined` on the wire)", () => {
    const env = buildAddEnvelope({ operation: "profile.skills.add", created: SKILL });
    expect("notice" in env).toBe(false);
  });

  it("ok and version are literal types (compile-time AC)", () => {
    const env = buildAddEnvelope({ operation: "x", created: SKILL });
    // Literal narrowing — these compile only because the types are
    // `true` and `"1.0"`, not `boolean` and `string`.
    const ok: true = env.ok;
    const v: "1.0" = env.version;
    expect(ok).toBe(true);
    expect(v).toBe("1.0");
  });
});

// =======================================================================
// buildUpdateEnvelope
// =======================================================================

describe("buildUpdateEnvelope", () => {
  it("emits {ok: true, version, operation, updated} (AC: success-update envelope)", () => {
    const env = buildUpdateEnvelope({ operation: "profile.skills.update", updated: SKILL });
    expect(env).toEqual({
      ok: true,
      version: "1.0",
      operation: "profile.skills.update",
      updated: SKILL,
    });
  });

  it("includes changes[] array when supplied", () => {
    const env = buildUpdateEnvelope({
      operation: "profile.skills.update",
      updated: SKILL,
      changes: [{ field: "rating", from: 3, to: 4 }],
    });
    expect(env.changes).toEqual([{ field: "rating", from: 3, to: 4 }]);
  });

  it("omits changes when not supplied (reserved field stays absent)", () => {
    const env = buildUpdateEnvelope({ operation: "profile.skills.update", updated: SKILL });
    expect("changes" in env).toBe(false);
  });
});

// =======================================================================
// buildRemoveEnvelope
// =======================================================================

describe("buildRemoveEnvelope", () => {
  it("emits {ok: true, version, operation, removed: {id}} (AC: success-remove envelope)", () => {
    const env = buildRemoveEnvelope({ operation: "profile.skills.remove", id: "sk_abc123" });
    expect(env).toEqual({
      ok: true,
      version: "1.0",
      operation: "profile.skills.remove",
      removed: { id: "sk_abc123" },
    });
  });
});

// =======================================================================
// buildErrorEnvelope
// =======================================================================

describe("buildErrorEnvelope", () => {
  it("emits {ok: false, version, operation, errors[]} (AC: error envelope)", () => {
    const env = buildErrorEnvelope({
      operation: "profile.skills.add",
      errors: [{ code: "VALIDATION_ERROR", message: "Rating must be 1-5" }],
    });
    expect(env).toEqual({
      ok: false,
      version: "1.0",
      operation: "profile.skills.add",
      errors: [{ code: "VALIDATION_ERROR", message: "Rating must be 1-5" }],
    });
  });

  it("preserves field/hint/documentationUrl when supplied", () => {
    const env = buildErrorEnvelope({
      operation: "profile.skills.add",
      errors: [
        {
          code: "VALIDATION_ERROR",
          field: "rating",
          message: "Rating must be 1-5",
          hint: "Use --rating 4",
          documentationUrl: "https://ttctl.org/docs/errors/VALIDATION_ERROR",
        },
      ],
    });
    expect(env.errors[0]?.field).toBe("rating");
    expect(env.errors[0]?.hint).toBe("Use --rating 4");
    expect(env.errors[0]?.documentationUrl).toBe("https://ttctl.org/docs/errors/VALIDATION_ERROR");
  });

  it("errors[] is plural even for a single error (AC: avoids 1-vs-N branching)", () => {
    const env = buildErrorEnvelope({
      operation: "x",
      errors: [{ code: "X", message: "y" }],
    });
    expect(Array.isArray(env.errors)).toBe(true);
    expect(env.errors).toHaveLength(1);
  });

  it("supports multiple errors", () => {
    const env = buildErrorEnvelope({
      operation: "x",
      errors: [
        { code: "A", message: "a" },
        { code: "B", message: "b" },
      ],
    });
    expect(env.errors).toHaveLength(2);
  });
});

// =======================================================================
// wrapListEnvelope — top-level list shape
// =======================================================================

describe("wrapListEnvelope", () => {
  it("wraps an array as {version, items} (AC: list envelope carries version field)", () => {
    const wrapped = wrapListEnvelope([{ id: "1" }, { id: "2" }]);
    expect(wrapped).toEqual({ version: "1.0", items: [{ id: "1" }, { id: "2" }] });
  });

  it("preserves an empty array as {version, items: []} (compatible with #122 isEmptyCollection)", () => {
    const wrapped = wrapListEnvelope([]);
    expect(wrapped).toEqual({ version: "1.0", items: [] });
  });

  it("does NOT include pageInfo by default (reserved for future)", () => {
    const wrapped = wrapListEnvelope([{ id: "1" }]);
    expect("pageInfo" in wrapped).toBe(false);
  });

  it("emits version BEFORE items in iteration order (AC: version is first key)", () => {
    const wrapped = wrapListEnvelope([{ id: "1" }]);
    expect(Object.keys(wrapped)).toEqual(["version", "items"]);
  });
});

// =======================================================================
// Pretty rendering
// =======================================================================

describe("formatAddPretty", () => {
  it("emits `✓ Added: <summary>` line with no entity preview by default", () => {
    const out = formatAddPretty({ prettySummary: "skill TypeScript (sk_abc123)", entity: SKILL });
    expect(out).toBe("✓ Added: skill TypeScript (sk_abc123)");
  });

  it("includes indented entity preview when prettyEntity is provided", () => {
    const out = formatAddPretty({
      prettySummary: "TypeScript (sk_abc123)",
      prettyEntity: (s: SkillEntity) => `id: ${s.id}\nrating: ${s.rating?.toString() ?? "(unset)"}`,
      entity: SKILL,
    });
    expect(out).toBe("✓ Added: TypeScript (sk_abc123)\n  id: sk_abc123\n  rating: 4");
  });

  it("appends notice line when supplied", () => {
    const out = formatAddPretty({
      prettySummary: "TypeScript",
      entity: SKILL,
      notice: "skill was already known — re-attached",
    });
    expect(out).toContain("notice: skill was already known — re-attached");
  });

  it("uses heavy check (✓) prefix per PRETTY_SUCCESS_PREFIX constant", () => {
    expect(PRETTY_SUCCESS_PREFIX).toBe("✓");
    const out = formatAddPretty({ prettySummary: "x", entity: SKILL });
    expect(out.startsWith("✓ Added: ")).toBe(true);
  });
});

describe("formatUpdatePretty", () => {
  it('emits "✓ Updated: …" header (AC: pretty rendering of update)', () => {
    const out = formatUpdatePretty({ prettySummary: "TypeScript (sk_abc123)", entity: SKILL });
    expect(out).toBe("✓ Updated: TypeScript (sk_abc123)");
  });

  it("indents entity preview when supplied", () => {
    const out = formatUpdatePretty({
      prettySummary: "TypeScript",
      prettyEntity: (s: SkillEntity) => `rating: ${s.rating?.toString() ?? "(unset)"}`,
      entity: SKILL,
    });
    expect(out).toBe("✓ Updated: TypeScript\n  rating: 4");
  });
});

describe("formatRemovePretty", () => {
  it('emits "✓ Removed: <id>" by default (AC: pretty rendering of remove)', () => {
    const out = formatRemovePretty({ id: "sk_abc123" });
    expect(out).toBe("✓ Removed: sk_abc123");
  });

  it("uses prettySummary when supplied (richer than bare id)", () => {
    const out = formatRemovePretty({ id: "sk_abc123", prettySummary: "sk_abc123 (TypeScript)" });
    expect(out).toBe("✓ Removed: sk_abc123 (TypeScript)");
  });

  it("appends notice when supplied", () => {
    const out = formatRemovePretty({ id: "sk_abc123", notice: "tombstoned for retention" });
    expect(out).toContain("notice: tombstoned for retention");
  });
});

describe("formatErrorPretty", () => {
  it("emits Error: <message> + (Code: …) block", () => {
    const env = buildErrorEnvelope({
      operation: "profile.skills.add",
      errors: [{ code: "VALIDATION_ERROR", message: "Rating must be 1-5" }],
    });
    expect(formatErrorPretty(env)).toBe("Error: Rating must be 1-5\n  (Code: VALIDATION_ERROR)");
  });

  it("includes (Field: …) when field is present", () => {
    const env = buildErrorEnvelope({
      operation: "x",
      errors: [{ code: "VALIDATION_ERROR", field: "rating", message: "Out of range" }],
    });
    expect(formatErrorPretty(env)).toContain("(Field: rating)");
  });

  it("includes Hint: line when hint is present", () => {
    const env = buildErrorEnvelope({
      operation: "x",
      errors: [{ code: "VALIDATION_ERROR", message: "Out of range", hint: "Use --rating 4" }],
    });
    expect(formatErrorPretty(env)).toContain("Hint: Use --rating 4");
  });

  it("renders multiple errors separated by a blank line", () => {
    const env = buildErrorEnvelope({
      operation: "x",
      errors: [
        { code: "A", message: "first" },
        { code: "B", message: "second" },
      ],
    });
    const out = formatErrorPretty(env);
    expect(out).toContain("Error: first");
    expect(out).toContain("Error: second");
    expect(out).toContain("\n\n");
  });
});

describe("defaultPrettyErrorSummary", () => {
  it("returns Error: <first.message> by default", () => {
    const env = buildErrorEnvelope({
      operation: "x",
      errors: [{ code: "X", message: "Rating must be 1-5" }],
    });
    expect(defaultPrettyErrorSummary(env)).toBe("Error: Rating must be 1-5");
  });

  it("falls back to placeholder when errors[] is empty", () => {
    const env = buildErrorEnvelope({ operation: "x", errors: [] });
    expect(defaultPrettyErrorSummary(env)).toBe("Error: (no error details supplied)");
  });
});

// =======================================================================
// JSON / YAML stringification
// =======================================================================

describe("formatAddJson", () => {
  it("returns single-line JSON (AC: JSON output is single-line)", () => {
    const env = buildAddEnvelope({ operation: "profile.skills.add", created: SKILL });
    const out = formatAddJson(env);
    expect(out).toBe(
      '{"ok":true,"version":"1.0","operation":"profile.skills.add","created":{"id":"sk_abc123","name":"TypeScript","rating":4}}',
    );
    expect(out).not.toContain("\n");
  });
});

describe("formatAddYaml", () => {
  it("returns block-style YAML that round-trips through `yaml.parse` to the envelope shape", () => {
    const env = buildAddEnvelope({ operation: "profile.skills.add", created: SKILL });
    const out = formatAddYaml(env);
    const parsed = yamlParse(out) as unknown;
    expect(parsed).toEqual({
      ok: true,
      version: "1.0",
      operation: "profile.skills.add",
      created: SKILL,
    });
  });
});

describe("formatUpdateJson", () => {
  it("returns single-line JSON envelope with updated payload", () => {
    const env = buildUpdateEnvelope({ operation: "profile.skills.update", updated: SKILL });
    const out = formatUpdateJson(env);
    expect(out).toContain('"updated":');
    expect(out).toContain('"version":"1.0"');
    expect(out).not.toContain("\n");
  });
});

describe("formatRemoveJson", () => {
  it("returns single-line JSON envelope with removed.id", () => {
    const env = buildRemoveEnvelope({ operation: "profile.skills.remove", id: "sk_abc123" });
    expect(formatRemoveJson(env)).toBe(
      '{"ok":true,"version":"1.0","operation":"profile.skills.remove","removed":{"id":"sk_abc123"}}',
    );
  });
});

describe("formatErrorJson", () => {
  it("returns single-line JSON envelope with errors[]", () => {
    const env = buildErrorEnvelope({
      operation: "profile.skills.add",
      errors: [{ code: "VALIDATION_ERROR", message: "Rating must be 1-5" }],
    });
    expect(formatErrorJson(env)).toBe(
      '{"ok":false,"version":"1.0","operation":"profile.skills.add","errors":[{"code":"VALIDATION_ERROR","message":"Rating must be 1-5"}]}',
    );
  });
});

describe("formatRemoveYaml + formatUpdateYaml + formatErrorYaml", () => {
  it("all return YAML strings parseable by yaml.parse", () => {
    const removeEnv = buildRemoveEnvelope({ operation: "profile.skills.remove", id: "sk_abc123" });
    const updateEnv = buildUpdateEnvelope({ operation: "profile.skills.update", updated: SKILL });
    const errorEnv = buildErrorEnvelope({
      operation: "profile.skills.add",
      errors: [{ code: "VALIDATION_ERROR", message: "x" }],
    });
    expect(yamlParse(formatRemoveYaml(removeEnv))).toEqual(removeEnv);
    expect(yamlParse(formatUpdateYaml(updateEnv))).toEqual(updateEnv);
    expect(yamlParse(formatErrorYaml(errorEnv))).toEqual(errorEnv);
  });
});

// =======================================================================
// Side-effecting emitters — stdout / stderr routing
// =======================================================================

describe("emitAddSuccess", () => {
  it("writes JSON envelope on stdout when format=json", () => {
    const stdout = captureStdout();
    captureStderr();
    emitAddSuccess({
      operation: "profile.skills.add",
      format: "json",
      created: SKILL,
      prettySummary: "TypeScript (sk_abc123)",
    });
    expect(stdout.lines.join("")).toContain('"ok":true');
    expect(stdout.lines.join("")).toContain('"created":');
    expect(stdout.lines.join("")).toContain('"version":"1.0"');
    expect(stdout.lines.join("")).toMatch(/\n$/);
  });

  it("writes YAML envelope on stdout when format=yaml", () => {
    const stdout = captureStdout();
    emitAddSuccess({
      operation: "profile.skills.add",
      format: "yaml",
      created: SKILL,
      prettySummary: "TypeScript",
    });
    const out = stdout.lines.join("");
    expect(out).toContain("ok: true");
    expect(out).toContain("version:");
    expect(out).toContain("created:");
  });

  it("writes pretty rendering on stdout when format=pretty", () => {
    const stdout = captureStdout();
    emitAddSuccess({
      operation: "profile.skills.add",
      format: "pretty",
      created: SKILL,
      prettySummary: "TypeScript (sk_abc123)",
    });
    expect(stdout.lines.join("")).toContain("✓ Added: TypeScript (sk_abc123)");
  });
});

describe("emitUpdateSuccess", () => {
  it('uses "✓ Updated:" prefix in pretty mode', () => {
    const stdout = captureStdout();
    emitUpdateSuccess({
      operation: "profile.skills.update",
      format: "pretty",
      updated: SKILL,
      prettySummary: "TypeScript (sk_abc123)",
    });
    expect(stdout.lines.join("")).toContain("✓ Updated: TypeScript (sk_abc123)");
  });
});

describe("emitRemoveSuccess", () => {
  it('uses "✓ Removed:" prefix with id by default in pretty mode', () => {
    const stdout = captureStdout();
    emitRemoveSuccess({ operation: "profile.skills.remove", format: "pretty", id: "sk_abc123" });
    expect(stdout.lines.join("")).toContain("✓ Removed: sk_abc123");
  });

  it("emits removed.id under removed key in JSON envelope", () => {
    const stdout = captureStdout();
    emitRemoveSuccess({ operation: "profile.skills.remove", format: "json", id: "sk_abc123" });
    expect(stdout.lines.join("")).toContain('"removed":{"id":"sk_abc123"}');
  });
});

// =======================================================================
// emitErrorAndExit — routing + exit code
// =======================================================================

describe("emitErrorAndExit", () => {
  function expectExit(code: number, fn: () => never): void {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((c?: string | number | null | undefined) => {
      throw new Error(`__EXIT_${c?.toString() ?? "0"}__`);
    }) as unknown as (code?: number) => never);
    try {
      fn();
    } catch (err) {
      expect((err as Error).message).toBe(`__EXIT_${code.toString()}__`);
      exitSpy.mockRestore();
      return;
    }
    exitSpy.mockRestore();
    throw new Error("emitErrorAndExit did not call process.exit");
  }

  it("routes JSON errors to STDOUT, exits with code 1 (AC: json errors → STDOUT)", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    expectExit(1, () =>
      emitErrorAndExit({
        operation: "profile.skills.add",
        format: "json",
        errors: [{ code: "VALIDATION_ERROR", field: "rating", message: "Rating must be 1-5" }],
      }),
    );
    expect(stdout.lines.join("")).toContain('"ok":false');
    expect(stdout.lines.join("")).toContain('"errors":[');
    expect(stderr.lines.join("")).toBe("");
  });

  it("routes YAML errors to STDOUT, exits with code 1 (AC: yaml errors → STDOUT)", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    expectExit(1, () =>
      emitErrorAndExit({
        operation: "profile.skills.add",
        format: "yaml",
        errors: [{ code: "VALIDATION_ERROR", message: "Out of range" }],
      }),
    );
    expect(stdout.lines.join("")).toContain("ok: false");
    expect(stderr.lines.join("")).toBe("");
  });

  it("routes pretty errors to STDERR with one-line summary first (AC: pretty errors → STDERR + summary)", () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    expectExit(1, () =>
      emitErrorAndExit({
        operation: "profile.skills.add",
        format: "pretty",
        errors: [{ code: "VALIDATION_ERROR", message: "Rating must be 1-5" }],
      }),
    );
    expect(stdout.lines.join("")).toBe("");
    const stderrJoined = stderr.lines.join("");
    expect(stderrJoined).toContain("Error: Rating must be 1-5");
    expect(stderrJoined).toContain("(Code: VALIDATION_ERROR)");
  });

  it("uses caller-supplied prettySummary when provided", () => {
    const stderr = captureStderr();
    expectExit(1, () =>
      emitErrorAndExit({
        operation: "profile.skills.add",
        format: "pretty",
        errors: [{ code: "X", message: "long technical message" }],
        prettySummary: "Error: short user-facing line.",
      }),
    );
    expect(stderr.lines.join("")).toContain("Error: short user-facing line.");
  });

  it("supports custom exit code (e.g., 2 for transport-level errors)", () => {
    captureStdout();
    expectExit(2, () =>
      emitErrorAndExit({
        operation: "profile.skills.list",
        format: "json",
        errors: [{ code: "CF_403_PERSISTENT", message: "Cloudflare blocked the request" }],
        exitCode: 2,
      }),
    );
  });
});
