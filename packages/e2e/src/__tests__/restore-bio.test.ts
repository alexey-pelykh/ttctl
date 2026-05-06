// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyMinimalWhitespaceEdit,
  captureBioToDisk,
  deleteBreadcrumb,
  generateRunId,
  readBreadcrumb,
} from "../restore-bio.js";

let workDir: string;

beforeEach(async () => {
  // Use a tmpdir-based fixture so unit tests can construct an arbitrary
  // "repo root". `captureBioToDisk` resolves the restore dir as
  // `<repoRoot>/.tmp/e2e-restore` and mkdir-p's it; the fixture exercises
  // that lazy-create branch.
  workDir = await mkdtemp(join(tmpdir(), "ttctl-restore-bio-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("generateRunId", () => {
  it("returns a non-empty string", () => {
    const id = generateRunId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns a UUID-shaped value (8-4-4-4-12 hex with v4 marker)", () => {
    // Match RFC 4122 v4: third group starts with `4`, fourth group starts
    // with 8/9/a/b. Stricter than a generic length check — protects against
    // an accidental switch to a non-crypto-strength generator.
    const id = generateRunId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns a fresh value on every call (no global state)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateRunId());
    expect(ids.size).toBe(100);
  });
});

describe("applyMinimalWhitespaceEdit — #21 B4 invariants", () => {
  it("appends exactly one trailing space", () => {
    expect(applyMinimalWhitespaceEdit("hello world")).toBe("hello world ");
  });

  it("diff size is exactly 1 character (≤2 per AC B4)", () => {
    const original = "I build distributed systems for talent platforms.";
    const mutated = applyMinimalWhitespaceEdit(original);
    expect(mutated.length - original.length).toBe(1);
    expect(mutated.length - original.length).toBeLessThanOrEqual(2);
  });

  it("preserves the original prefix verbatim (round-trip-safe restore via prefix-strip)", () => {
    const original = "Senior backend engineer.\nI like sushi.";
    const mutated = applyMinimalWhitespaceEdit(original);
    expect(mutated.slice(0, original.length)).toBe(original);
    expect(mutated.endsWith(" ")).toBe(true);
  });

  it("contains no test-identifying text (#21 B4: no marker strings)", () => {
    const original = "anything";
    const mutated = applyMinimalWhitespaceEdit(original);
    // The mutation MUST NOT inject substrings like "TEST", "E2E", "ttctl",
    // a UUID, a timestamp, or any other recognizable marker. The only added
    // characters must be whitespace.
    const added = mutated.slice(original.length);
    expect(added).toMatch(/^\s+$/);
    expect(added).not.toMatch(/test|e2e|ttctl|uuid|\d{4}-\d{2}-\d{2}/i);
  });

  it("works on empty input (degenerate case — bio could be cleared)", () => {
    expect(applyMinimalWhitespaceEdit("")).toBe(" ");
  });

  it("works on input that already ends in whitespace (idempotent shape, never collides with original)", () => {
    // If the bio happened to end in a space, our mutation produces TWO
    // trailing spaces — still ≤2-char diff, still distinct from the
    // original, still recoverable by writing the original back verbatim.
    const original = "trailing space already ";
    const mutated = applyMinimalWhitespaceEdit(original);
    expect(mutated).toBe("trailing space already  ");
    expect(mutated).not.toBe(original);
  });
});

describe("captureBioToDisk", () => {
  it("creates the e2e-restore dir lazily and writes a JSON breadcrumb", async () => {
    const runId = "test-run-001";
    const bio = "operator's actual bio";
    const file = await captureBioToDisk(workDir, runId, bio);

    expect(file).toBe(join(workDir, ".tmp", "e2e-restore", `${runId}.json`));
    expect(existsSync(file)).toBe(true);

    const onDisk = JSON.parse(await readFile(file, "utf8")) as {
      runId: string;
      capturedAt: string;
      bio: string;
    };
    expect(onDisk.runId).toBe(runId);
    expect(onDisk.bio).toBe(bio);
    expect(onDisk.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  it("writes the file at mode 0600 (owner-only — bio may contain personal info)", async () => {
    const file = await captureBioToDisk(workDir, "perm-check", "secret-ish");
    const stats = statSync(file);
    // Mask out the file-type bits; compare only the rwx triplets.
    // On Windows, mode bits are not POSIX — skip the assertion there to
    // keep the unit test cross-platform.
    if (process.platform !== "win32") {
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it("trailing newline + 2-space indent (matches harness lockfile shell-friendliness)", async () => {
    const file = await captureBioToDisk(workDir, "format-check", "abc");
    const raw = await readFile(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "runId":');
  });

  it("preserves bio prose verbatim (no normalization, no encoding shifts)", async () => {
    const tricky = "line1\nline2\t\"quoted\"\\backslash — em-dash 日本語";
    const file = await captureBioToDisk(workDir, "verbatim", tricky);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { bio: string };
    expect(onDisk.bio).toBe(tricky);
  });

  it("overwrites an existing breadcrumb at the same runId (last-write-wins)", async () => {
    const file1 = await captureBioToDisk(workDir, "same-id", "first bio");
    const file2 = await captureBioToDisk(workDir, "same-id", "second bio");
    expect(file1).toBe(file2);
    const onDisk = JSON.parse(await readFile(file2, "utf8")) as { bio: string };
    expect(onDisk.bio).toBe("second bio");
  });
});

describe("readBreadcrumb", () => {
  it("round-trips a captured breadcrumb byte-for-byte", async () => {
    const bio = "round-trip me";
    const file = await captureBioToDisk(workDir, "rt-1", bio);
    const breadcrumb = await readBreadcrumb(file);
    expect(breadcrumb).toEqual({
      runId: "rt-1",
      capturedAt: expect.any(String) as unknown,
      bio,
    });
  });

  it("throws on a missing file (recovery-script dx: explicit failure beats silent default)", async () => {
    const missing = join(workDir, "does-not-exist.json");
    await expect(readBreadcrumb(missing)).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("throws on malformed JSON", async () => {
    const file = join(workDir, "malformed.json");
    await writeFile(file, "{ not valid json", { mode: 0o600 });
    await expect(readBreadcrumb(file)).rejects.toThrow(/malformed breadcrumb/);
  });

  it("throws when the parsed value is not an object (e.g., a literal number)", async () => {
    const file = join(workDir, "primitive.json");
    await writeFile(file, "42", { mode: 0o600 });
    await expect(readBreadcrumb(file)).rejects.toThrow(/not an object/);
  });

  it("throws when 'runId' is missing", async () => {
    const file = join(workDir, "no-runid.json");
    await writeFile(file, JSON.stringify({ capturedAt: "2026-01-01T00:00:00.000Z", bio: "x" }), { mode: 0o600 });
    await expect(readBreadcrumb(file)).rejects.toThrow(/runId/);
  });

  it("throws when 'bio' is the wrong type (defensive against a hand-edited file)", async () => {
    const file = join(workDir, "bio-wrong-type.json");
    await writeFile(
      file,
      JSON.stringify({ runId: "x", capturedAt: "2026-01-01T00:00:00.000Z", bio: 123 }),
      { mode: 0o600 },
    );
    await expect(readBreadcrumb(file)).rejects.toThrow(/bio/);
  });

  it("throws when 'capturedAt' is missing or empty", async () => {
    const missing = join(workDir, "no-capturedAt.json");
    await writeFile(missing, JSON.stringify({ runId: "x", bio: "y" }), { mode: 0o600 });
    await expect(readBreadcrumb(missing)).rejects.toThrow(/capturedAt/);

    const empty = join(workDir, "empty-capturedAt.json");
    await writeFile(empty, JSON.stringify({ runId: "x", capturedAt: "", bio: "y" }), { mode: 0o600 });
    await expect(readBreadcrumb(empty)).rejects.toThrow(/capturedAt/);
  });
});

describe("deleteBreadcrumb", () => {
  it("removes an existing breadcrumb file", async () => {
    const file = await captureBioToDisk(workDir, "delete-me", "ephemeral");
    expect(existsSync(file)).toBe(true);
    await deleteBreadcrumb(file);
    expect(existsSync(file)).toBe(false);
  });

  it("is idempotent: silently succeeds on a missing file (defensive against partial-state crashes)", async () => {
    const missing = join(workDir, "never-existed.json");
    await expect(deleteBreadcrumb(missing)).resolves.toBeUndefined();
    expect(existsSync(missing)).toBe(false);
  });
});
