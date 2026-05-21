// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolveAbsolutePath } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { z } from "zod";

import {
  _resetStdinClaimForTesting,
  JsonInputError,
  type JsonInputErrorCode,
  parseAsRecovered,
  readJsonInput,
} from "../json-input.js";

beforeEach(() => {
  _resetStdinClaimForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- Stdin mode ----------

describe("readJsonInput: stdin mode", () => {
  it("reads the injected stream to EOF and returns the parsed JSON value", async () => {
    const stream = Readable.from('{"matcherAnswers":[{"questionId":"MQ-1","answer":"a"}]}');
    const out = await readJsonInput("-", { flagName: "answers-file", stdin: stream });
    expect(out).toEqual({ matcherAnswers: [{ questionId: "MQ-1", answer: "a" }] });
  });

  it("throws PARSE_ERROR when stdin contains invalid JSON", async () => {
    const stream = Readable.from("not-json {");
    await expect(readJsonInput("-", { flagName: "answers-file", stdin: stream })).rejects.toMatchObject({
      name: "JsonInputError",
      code: "PARSE_ERROR" satisfies JsonInputErrorCode,
      message: expect.stringContaining("<stdin>") as string,
    });
  });

  it("throws PARSE_ERROR when stdin is empty (empty input is not valid JSON)", async () => {
    const stream = Readable.from("");
    await expect(readJsonInput("-", { flagName: "answers-file", stdin: stream })).rejects.toMatchObject({
      name: "JsonInputError",
      code: "PARSE_ERROR" satisfies JsonInputErrorCode,
    });
  });

  it("throws STDIN_DOUBLE_CLAIM when a second flag also requests stdin in the same process", async () => {
    const first = Readable.from('{"matcherAnswers":[]}');
    await readJsonInput("-", { flagName: "answers-file", stdin: first });

    const second = Readable.from("{}");
    await expect(readJsonInput("-", { flagName: "pitch-file", stdin: second })).rejects.toMatchObject({
      name: "JsonInputError",
      code: "STDIN_DOUBLE_CLAIM" satisfies JsonInputErrorCode,
      message: expect.stringContaining("pitch-file") as string,
    });
  });

  it("throws STDIN_UNAVAILABLE when the stream is a TTY (interactive shell, not a pipe)", async () => {
    const ttyStream = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
    ttyStream.isTTY = true;
    await expect(readJsonInput("-", { flagName: "answers-file", stdin: ttyStream })).rejects.toMatchObject({
      name: "JsonInputError",
      code: "STDIN_UNAVAILABLE" satisfies JsonInputErrorCode,
    });
  });

  it("concatenates multiple stdin chunks before parsing (large payload arriving in pieces)", async () => {
    const stream = new Readable({ read() {} });
    stream.push(Buffer.from('{"matcher', "utf-8"));
    stream.push(Buffer.from('Answers":[', "utf-8"));
    stream.push(Buffer.from('{"questionId":"MQ-1","answer":"a"}]}', "utf-8"));
    stream.push(null);
    const out = await readJsonInput("-", { flagName: "answers-file", stdin: stream });
    expect(out).toEqual({ matcherAnswers: [{ questionId: "MQ-1", answer: "a" }] });
  });
});

// ---------- File mode ----------

describe("readJsonInput: file mode (bare path)", () => {
  it("reads and parses the file content via the injected reader", async () => {
    const fakeReader = vi.fn().mockResolvedValue('{"pitchInput":{"summary":"yes"}}');
    const out = await readJsonInput("answers.json", {
      flagName: "answers-file",
      readFile: fakeReader,
    });
    expect(fakeReader).toHaveBeenCalledWith("answers.json");
    expect(out).toEqual({ pitchInput: { summary: "yes" } });
  });

  it("surfaces FILE_NOT_FOUND with the ABSOLUTE path (AC: stderr contains the absolute path)", async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const fakeReader = vi.fn().mockRejectedValue(enoent);
    const rawPath = "missing.json";
    const expectedAbsolute = resolveAbsolutePath(rawPath);

    await expect(readJsonInput(rawPath, { flagName: "answers-file", readFile: fakeReader })).rejects.toMatchObject({
      name: "JsonInputError",
      code: "FILE_NOT_FOUND" satisfies JsonInputErrorCode,
      message: expect.stringContaining(expectedAbsolute) as string,
    });
  });

  it("renders the platform-absolute form of the user-supplied path in the FILE_NOT_FOUND message (POSIX: /nonexistent.json verbatim; Windows: drive-prefixed)", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const fakeReader = vi.fn().mockRejectedValue(enoent);
    // The AC's "stderr contains the absolute path" intent is platform-specific.
    // On POSIX, `/nonexistent.json` IS already absolute and surfaces verbatim;
    // on Windows, `path.resolve("/nonexistent.json")` rewrites to drive-prefixed
    // form (e.g. `D:\nonexistent.json`). Compute the expected via the same
    // resolver the implementation uses so the assertion is platform-aware.
    const rawPath = "/nonexistent.json";
    const expectedAbsolute = resolveAbsolutePath(rawPath);
    await expect(readJsonInput(rawPath, { flagName: "answers-file", readFile: fakeReader })).rejects.toMatchObject({
      code: "FILE_NOT_FOUND" satisfies JsonInputErrorCode,
      message: expect.stringContaining(expectedAbsolute) as string,
    });
  });

  it("classifies non-ENOENT failures as FILE_READ_ERROR (not FILE_NOT_FOUND)", async () => {
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const fakeReader = vi.fn().mockRejectedValue(eacces);
    await expect(
      readJsonInput("locked.json", { flagName: "answers-file", readFile: fakeReader }),
    ).rejects.toMatchObject({
      name: "JsonInputError",
      code: "FILE_READ_ERROR" satisfies JsonInputErrorCode,
    });
  });

  it("throws PARSE_ERROR with a line/column recovery hint when the file content is malformed", async () => {
    const malformed = '{\n  "matcherAnswers": [\n    { broken,\n  ]\n}';
    const fakeReader = vi.fn().mockResolvedValue(malformed);
    await expect(
      readJsonInput("answers.json", { flagName: "answers-file", readFile: fakeReader }),
    ).rejects.toMatchObject({
      name: "JsonInputError",
      code: "PARSE_ERROR" satisfies JsonInputErrorCode,
      message: expect.stringMatching(/line \d+, column \d+/) as string,
    });
  });

  it("really reads from the local filesystem when no reader is injected (smoke test)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ttctl-json-input-test-"));
    try {
      const filePath = join(dir, "answers.json");
      const payload = { matcherAnswers: [{ questionId: "MQ-9", answer: "real on-disk" }] };
      await writeFile(filePath, JSON.stringify(payload), "utf-8");
      const out = await readJsonInput(filePath, { flagName: "answers-file" });
      expect(out).toEqual(payload);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------- Error type ----------

describe("JsonInputError", () => {
  it("carries the code and message verbatim", () => {
    const err = new JsonInputError("PARSE_ERROR", "broken at line 1");
    expect(err.name).toBe("JsonInputError");
    expect(err.code).toBe("PARSE_ERROR");
    expect(err.message).toBe("broken at line 1");
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts the SCHEMA_ERROR code added in #438", () => {
    const err = new JsonInputError(
      "SCHEMA_ERROR",
      "--answers-file: payload does not match the recovered schema — matcherAnswers[0].id: invalid_type",
    );
    expect(err.code).toBe("SCHEMA_ERROR" satisfies JsonInputErrorCode);
    expect(err.message).toContain("matcherAnswers[0].id");
  });
});

// ---------- parseAsRecovered (#438 Stage-2 surface tightening) ----------

describe("parseAsRecovered", () => {
  const innerSchema = z
    .object({
      id: z.string(),
      answer: z.string(),
    })
    .strict();
  const arraySchema = z.array(innerSchema);

  it("returns the typed value on a happy-path payload (single object)", () => {
    const result = parseAsRecovered({ id: "MQ-1", answer: "yes" }, innerSchema, "answers-file");
    expect(result).toEqual({ id: "MQ-1", answer: "yes" });
  });

  it("returns the typed value on a happy-path array payload", () => {
    const result = parseAsRecovered(
      [
        { id: "MQ-1", answer: "a" },
        { id: "MQ-2", answer: "b" },
      ],
      arraySchema,
      "answers-file",
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: "MQ-1", answer: "a" });
  });

  it("throws SCHEMA_ERROR with a field-path when a required key is missing (AC behavioral scenario 3)", () => {
    expect(() => parseAsRecovered({ answer: "no id" }, innerSchema, "answers-file")).toThrowError(JsonInputError);
    try {
      parseAsRecovered({ answer: "no id" }, innerSchema, "answers-file");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonInputError);
      const typedErr = err as JsonInputError;
      expect(typedErr.code).toBe("SCHEMA_ERROR" satisfies JsonInputErrorCode);
      // Field-path naming in the rendered message — the AC requires
      // "stderr contains a Zod field-path indicating the missing required field".
      expect(typedErr.message).toContain("--answers-file:");
      expect(typedErr.message).toContain("id");
    }
  });

  it("throws SCHEMA_ERROR with a field-path when an unknown key appears (AC behavioral scenario 2 — strict-mode rejection)", () => {
    try {
      parseAsRecovered({ id: "MQ-1", answer: "yes", extraField: "intruder" }, innerSchema, "answers-file");
      throw new Error("expected SCHEMA_ERROR");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonInputError);
      const typedErr = err as JsonInputError;
      expect(typedErr.code).toBe("SCHEMA_ERROR" satisfies JsonInputErrorCode);
      // Strict-mode Zod rejects extra keys with `unrecognized_keys`.
      expect(typedErr.message).toContain("unrecognized_keys");
    }
  });

  it("includes the array index in the field path for per-entry failures (e.g. matcherAnswers[2].id)", () => {
    try {
      parseAsRecovered(
        [{ id: "MQ-1", answer: "a" }, { id: "MQ-2", answer: "b" }, { answer: "no id at index 2" }],
        arraySchema,
        "answers-file",
      );
      throw new Error("expected SCHEMA_ERROR");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonInputError);
      const typedErr = err as JsonInputError;
      expect(typedErr.message).toContain("[2]");
      expect(typedErr.message).toContain("id");
    }
  });

  it("renders the empty-path root as `<root>` when the entire value fails to match", () => {
    try {
      parseAsRecovered("not an object", innerSchema, "answers-file");
      throw new Error("expected SCHEMA_ERROR");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonInputError);
      expect((err as JsonInputError).message).toContain("<root>");
    }
  });

  it("collapses multiple issues into a single semicolon-separated message", () => {
    try {
      // Two failures in one payload: missing `id` AND missing `answer`.
      parseAsRecovered({}, innerSchema, "answers-file");
      throw new Error("expected SCHEMA_ERROR");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonInputError);
      const typedErr = err as JsonInputError;
      // Both field paths surface so the user can fix all issues in one
      // pass rather than playing whack-a-mole.
      expect(typedErr.message).toContain("id");
      expect(typedErr.message).toContain("answer");
      expect(typedErr.message).toContain(";");
    }
  });
});
