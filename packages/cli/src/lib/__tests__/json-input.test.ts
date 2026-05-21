// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolveAbsolutePath } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetStdinClaimForTesting, JsonInputError, type JsonInputErrorCode, readJsonInput } from "../json-input.js";

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

  it("preserves absolute paths verbatim in the FILE_NOT_FOUND message (scenario: /nonexistent.json)", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const fakeReader = vi.fn().mockRejectedValue(enoent);
    await expect(
      readJsonInput("/nonexistent.json", { flagName: "answers-file", readFile: fakeReader }),
    ).rejects.toMatchObject({
      code: "FILE_NOT_FOUND" satisfies JsonInputErrorCode,
      message: expect.stringContaining("/nonexistent.json") as string,
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
});
