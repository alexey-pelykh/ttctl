// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetStdinClaimForTesting, FreeTextError, resolveFreeText, type FreeTextErrorCode } from "../freetext.js";

// Reset the module-level stdin-claim guard between tests so each test runs
// against a clean slate. The guard exists to prevent two flags from racing
// for stdin in a real CLI invocation; tests deliberately reuse the symbolic
// "stdin" mode many times within a single process.
beforeEach(() => {
  _resetStdinClaimForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- Inline mode ----------

describe("resolveFreeText: inline mode", () => {
  it("returns the rawValue verbatim when it is a plain string", async () => {
    const out = await resolveFreeText("plain inline text", { flagName: "bio" });
    expect(out).toBe("plain inline text");
  });

  it("preserves multi-line inline content (newlines and trailing whitespace) as given", async () => {
    const text = "line one\nline two\n   trailing\n";
    const out = await resolveFreeText(text, { flagName: "bio" });
    expect(out).toBe(text);
  });

  it("preserves an empty inline string ('') verbatim — empty is not the same as 'flag missing'", async () => {
    const out = await resolveFreeText("", { flagName: "bio" });
    expect(out).toBe("");
  });

  it("returns undefined when neither rawValue is defined nor the editor is enabled", async () => {
    const out = await resolveFreeText(undefined, { flagName: "bio" });
    expect(out).toBeUndefined();
  });
});

// ---------- Stdin mode ----------

describe("resolveFreeText: stdin mode", () => {
  it("reads the injected stream to EOF and returns the concatenated content", async () => {
    const stream = Readable.from("piped bio content from upstream");
    const out = await resolveFreeText("-", { flagName: "bio", stdin: stream });
    expect(out).toBe("piped bio content from upstream");
  });

  it("returns the empty string when stdin is empty (NOT an error — per AC)", async () => {
    const stream = Readable.from("");
    const out = await resolveFreeText("-", { flagName: "bio", stdin: stream });
    expect(out).toBe("");
  });

  it("concatenates multiple stdin chunks (simulating slow network or large input)", async () => {
    const stream = new Readable({ read() {} });
    // Push multiple chunks then EOF — simulates stdin arriving in pieces.
    stream.push(Buffer.from("chunk one ", "utf-8"));
    stream.push(Buffer.from("chunk two ", "utf-8"));
    stream.push(Buffer.from("chunk three", "utf-8"));
    stream.push(null);

    const out = await resolveFreeText("-", { flagName: "bio", stdin: stream });
    expect(out).toBe("chunk one chunk two chunk three");
  });

  it("throws STDIN_DOUBLE_CLAIM when a second flag also requests stdin in the same process", async () => {
    const first = Readable.from("first flag content");
    await resolveFreeText("-", { flagName: "bio", stdin: first });

    const second = Readable.from("second flag content");
    await expect(resolveFreeText("-", { flagName: "headline", stdin: second })).rejects.toMatchObject({
      name: "FreeTextError",
      code: "STDIN_DOUBLE_CLAIM" satisfies FreeTextErrorCode,
    });
  });

  it("throws STDIN_UNAVAILABLE when the stream is a TTY (interactive shell, not a pipe)", async () => {
    // Forge a TTY-flagged stream so the helper rejects before blocking on
    // a non-existent pipe. The real `process.stdin.isTTY === true` would
    // mean an interactive user with nothing to send.
    const ttyStream = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
    ttyStream.isTTY = true;

    await expect(resolveFreeText("-", { flagName: "bio", stdin: ttyStream })).rejects.toMatchObject({
      name: "FreeTextError",
      code: "STDIN_UNAVAILABLE" satisfies FreeTextErrorCode,
    });
  });
});

// ---------- File mode ----------

describe("resolveFreeText: file mode (@path)", () => {
  it("strips the leading '@' and reads the file content via the injected reader", async () => {
    const fakeReader = vi.fn().mockResolvedValue("contents from disk");
    const out = await resolveFreeText("@profile/bio.md", {
      flagName: "bio",
      readFile: fakeReader,
    });

    expect(fakeReader).toHaveBeenCalledWith("profile/bio.md");
    expect(out).toBe("contents from disk");
  });

  it("propagates ENOENT as FILE_NOT_FOUND with the path in the message", async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const fakeReader = vi.fn().mockRejectedValue(enoent);

    await expect(resolveFreeText("@missing.md", { flagName: "bio", readFile: fakeReader })).rejects.toMatchObject({
      name: "FreeTextError",
      code: "FILE_NOT_FOUND" satisfies FreeTextErrorCode,
      message: expect.stringContaining("missing.md") as string,
    });
  });

  it("classifies non-ENOENT failures as FILE_READ_ERROR (not FILE_NOT_FOUND)", async () => {
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const fakeReader = vi.fn().mockRejectedValue(eacces);

    await expect(resolveFreeText("@locked.md", { flagName: "bio", readFile: fakeReader })).rejects.toMatchObject({
      name: "FreeTextError",
      code: "FILE_READ_ERROR" satisfies FreeTextErrorCode,
    });
  });

  it("really reads from the local filesystem when no reader is injected (smoke test)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ttctl-freetext-test-"));
    try {
      const filePath = join(dir, "bio.md");
      await writeFile(filePath, "real on-disk bio", "utf-8");

      const out = await resolveFreeText(`@${filePath}`, { flagName: "bio" });
      expect(out).toBe("real on-disk bio");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------- Editor mode ----------

describe("resolveFreeText: editor mode (--edit)", () => {
  it("seeds the temp file with currentValue, runs the editor, returns the modified buffer", async () => {
    let capturedTempPath: string | undefined;

    // The fake spawn simulates an editor that appends ' (edited)' to the
    // seeded buffer and exits 0. The real fs is used underneath — the
    // helper's `mkdtemp` / `writeFile` / `readFile` all run normally.
    const fakeSpawn = vi.fn((_editor: string, args: readonly string[]) => {
      capturedTempPath = args[0];
      const child = new EventEmitter() as EventEmitter & { stdio?: unknown };
      // Defer the work and the close event so callers can attach listeners.
      setImmediate(() => {
        void (async () => {
          if (capturedTempPath !== undefined) {
            const seeded = await readFile(capturedTempPath, "utf-8");
            await writeFile(capturedTempPath, `${seeded} (edited)`, "utf-8");
          }
          child.emit("close", 0);
        })();
      });
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });

    const out = await resolveFreeText(undefined, {
      flagName: "bio",
      enableEditor: true,
      currentValue: "draft bio",
      editorEnv: "fake-editor",
      spawn: fakeSpawn,
    });

    expect(out).toBe("draft bio (edited)");
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    expect(fakeSpawn).toHaveBeenCalledWith("fake-editor", expect.any(Array), { stdio: "inherit" });
    // Sanity-check the temp file path lives under tmpdir() so we know the
    // helper picked the OS temp directory and not the cwd.
    expect(capturedTempPath?.startsWith(tmpdir())).toBe(true);
  });

  it("uses an empty seed when currentValue is omitted", async () => {
    let observedSeed: string | undefined;

    const fakeSpawn = vi.fn((_editor: string, args: readonly string[]) => {
      const tempPath = args[0];
      const child = new EventEmitter();
      setImmediate(() => {
        void (async () => {
          if (tempPath !== undefined) {
            observedSeed = await readFile(tempPath, "utf-8");
            await writeFile(tempPath, "fresh content", "utf-8");
          }
          child.emit("close", 0);
        })();
      });
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });

    const out = await resolveFreeText(undefined, {
      flagName: "bio",
      enableEditor: true,
      editorEnv: "fake-editor",
      spawn: fakeSpawn,
    });

    expect(observedSeed).toBe("");
    expect(out).toBe("fresh content");
  });

  it("throws EDITOR_FAILED when the editor exits with a non-zero code", async () => {
    const fakeSpawn = vi.fn(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", 1));
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });

    await expect(
      resolveFreeText(undefined, {
        flagName: "bio",
        enableEditor: true,
        editorEnv: "broken-editor",
        spawn: fakeSpawn,
      }),
    ).rejects.toMatchObject({
      name: "FreeTextError",
      code: "EDITOR_FAILED" satisfies FreeTextErrorCode,
    });
  });

  it("throws EDITOR_FAILED when spawn itself fails (e.g. editor binary not found)", async () => {
    const fakeSpawn = vi.fn(() => {
      const child = new EventEmitter();
      setImmediate(() => {
        const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        child.emit("error", err);
      });
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });

    await expect(
      resolveFreeText(undefined, {
        flagName: "bio",
        enableEditor: true,
        editorEnv: "no-such-editor-binary",
        spawn: fakeSpawn,
      }),
    ).rejects.toMatchObject({
      name: "FreeTextError",
      code: "EDITOR_FAILED" satisfies FreeTextErrorCode,
    });
  });

  it("cleans up the temp directory even when the editor fails", async () => {
    let capturedTempPath: string | undefined;

    const fakeSpawn = vi.fn((_editor: string, args: readonly string[]) => {
      capturedTempPath = args[0];
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", 1));
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });

    await expect(
      resolveFreeText(undefined, {
        flagName: "bio",
        enableEditor: true,
        editorEnv: "broken-editor",
        spawn: fakeSpawn,
      }),
    ).rejects.toMatchObject({ code: "EDITOR_FAILED" });

    // The temp file lived under a directory that should be gone now.
    expect(capturedTempPath).toBeDefined();
    if (capturedTempPath !== undefined) {
      await expect(readFile(capturedTempPath, "utf-8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("falls back to $EDITOR (env) and ultimately to 'vi' when neither editorEnv nor $EDITOR is set", async () => {
    const observedCommands: string[] = [];

    const fakeSpawn = vi.fn((cmd: string, args: readonly string[]) => {
      observedCommands.push(cmd);
      const tempPath = args[0];
      const child = new EventEmitter();
      setImmediate(() => {
        void (async () => {
          if (tempPath !== undefined) {
            await writeFile(tempPath, "ok", "utf-8");
          }
          child.emit("close", 0);
        })();
      });
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });

    // Path 1: editorEnv option wins.
    await resolveFreeText(undefined, {
      flagName: "bio",
      enableEditor: true,
      editorEnv: "explicit-editor",
      spawn: fakeSpawn,
    });

    // Path 2: process.env.EDITOR fallback when editorEnv is undefined.
    const prevEditor = process.env.EDITOR;
    process.env.EDITOR = "env-editor";
    try {
      await resolveFreeText(undefined, {
        flagName: "bio",
        enableEditor: true,
        spawn: fakeSpawn,
      });
    } finally {
      if (prevEditor === undefined) {
        delete process.env.EDITOR;
      } else {
        process.env.EDITOR = prevEditor;
      }
    }

    // Path 3: 'vi' when both option and env are unset.
    delete process.env.EDITOR;
    try {
      await resolveFreeText(undefined, {
        flagName: "bio",
        enableEditor: true,
        spawn: fakeSpawn,
      });
    } finally {
      if (prevEditor !== undefined) process.env.EDITOR = prevEditor;
    }

    expect(observedCommands).toEqual(["explicit-editor", "env-editor", "vi"]);
  });
});

// ---------- Mode-conflict detection ----------

describe("resolveFreeText: mode-conflict detection", () => {
  it("rejects --edit + an inline value before performing any I/O", async () => {
    const fakeSpawn = vi.fn();
    const fakeReader = vi.fn();

    await expect(
      resolveFreeText("inline content", {
        flagName: "bio",
        enableEditor: true,
        spawn: fakeSpawn as never,
        readFile: fakeReader,
      }),
    ).rejects.toMatchObject({
      name: "FreeTextError",
      code: "MODE_CONFLICT" satisfies FreeTextErrorCode,
    });

    expect(fakeSpawn).not.toHaveBeenCalled();
    expect(fakeReader).not.toHaveBeenCalled();
  });

  it("rejects --edit + stdin ('-')", async () => {
    await expect(resolveFreeText("-", { flagName: "bio", enableEditor: true })).rejects.toMatchObject({
      code: "MODE_CONFLICT" satisfies FreeTextErrorCode,
    });
  });

  it("rejects --edit + file ('@path')", async () => {
    await expect(resolveFreeText("@bio.md", { flagName: "bio", enableEditor: true })).rejects.toMatchObject({
      code: "MODE_CONFLICT" satisfies FreeTextErrorCode,
    });
  });

  it("includes the user-facing flag name in the conflict message (so users know which flag tripped)", async () => {
    try {
      await resolveFreeText("text", { flagName: "headline", enableEditor: true });
      expect.fail("expected MODE_CONFLICT throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FreeTextError);
      expect((err as FreeTextError).message).toContain("--headline");
    }
  });
});
