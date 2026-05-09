// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Debug-logging behavior for `persistAuthToken` and `clearAuthToken`.
 *
 * Module-load capture: `configWriter.ts` reads `TTCTL_DEBUG_CONFIG` ONCE at
 * import time so V8 can constant-fold the env-unset path. To exercise both
 * env-set and env-unset paths in one test file we (1) mutate `process.env`
 * before `import()`, and (2) call `vi.resetModules()` between cases so each
 * dynamic `import()` re-evaluates the module with a fresh capture.
 *
 * Stderr capture is via `vi.spyOn(process.stderr, "write")` mirroring the
 * pattern in `config.test.ts`. Records are JSON-per-line; the assertions
 * parse only the JSON-shaped lines so any incidental stderr (proper-lockfile
 * diagnostics, vitest noise) is ignored.
 */

interface DebugRecordShape {
  ts: string;
  op: "persist" | "clear";
  path: string;
  event: string;
  // discriminated extras — typed loosely here so each test inspects the
  // fields it cares about without dragging in the full union.
  [extra: string]: unknown;
}

function parseDebugRecords(captured: string[]): DebugRecordShape[] {
  return captured
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => JSON.parse(line) as DebugRecordShape);
}

function captureStderr(): { reads: () => string[]; restore: () => void } {
  const calls: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown): boolean => {
    if (typeof chunk === "string") calls.push(chunk);
    else if (chunk instanceof Uint8Array) calls.push(Buffer.from(chunk).toString("utf8"));
    return true;
  }) as never);
  return {
    reads: () => calls,
    restore: () => {
      spy.mockRestore();
    },
  };
}

describe("persistAuthToken/clearAuthToken — TTCTL_DEBUG_CONFIG instrumentation", () => {
  let tmpRoot: string;
  const originalEnv = process.env["TTCTL_DEBUG_CONFIG"];

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-debug-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env["TTCTL_DEBUG_CONFIG"];
    else process.env["TTCTL_DEBUG_CONFIG"] = originalEnv;
  });

  it("emits zero JSON debug records on stderr when TTCTL_DEBUG_CONFIG is unset", async () => {
    delete process.env["TTCTL_DEBUG_CONFIG"];
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      await persistAuthToken(configPath, "user_unset_path_token_xxx");

      const records = parseDebugRecords(cap.reads());
      expect(records).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it("emits zero JSON debug records when TTCTL_DEBUG_CONFIG is empty string", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "";
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      await persistAuthToken(configPath, "user_empty_env_xxx");

      const records = parseDebugRecords(cap.reads());
      expect(records).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it("emits zero JSON debug records when TTCTL_DEBUG_CONFIG is a non-'1' value (e.g. 'true')", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "true";
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      await persistAuthToken(configPath, "user_truthy_env_xxx");

      const records = parseDebugRecords(cap.reads());
      expect(records).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it("emits the expected event sequence on a happy persist when TTCTL_DEBUG_CONFIG=1", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      await persistAuthToken(configPath, "user_happy_path_token_aaa");

      const records = parseDebugRecords(cap.reads());
      const events = records.map((r) => r.event);

      // Core event taxonomy must be present (order is total: prewrite_checks
      // first, lock_released last).
      expect(events).toContain("prewrite_checks");
      expect(events).toContain("lock_acquired");
      expect(events).toContain("stat_baseline");
      expect(events).toContain("tempfile_written");
      expect(events).toContain("final_state");
      expect(events).toContain("mtime_drift_check");
      expect(events).toContain("rename_completed");
      expect(events).toContain("lock_released");

      // Order discipline: prewrite_checks before lock_acquired before
      // stat_baseline before rename_completed before lock_released.
      expect(events.indexOf("prewrite_checks")).toBeLessThan(events.indexOf("lock_acquired"));
      expect(events.indexOf("lock_acquired")).toBeLessThan(events.indexOf("stat_baseline"));
      expect(events.indexOf("stat_baseline")).toBeLessThan(events.indexOf("rename_completed"));
      expect(events.indexOf("rename_completed")).toBeLessThan(events.indexOf("lock_released"));

      // `op` discriminator on every record.
      expect(records.every((r) => r.op === "persist")).toBe(true);
      // `path` matches the absolute config path.
      expect(records.every((r) => typeof r.path === "string" && r.path.endsWith(".ttctl.yaml"))).toBe(true);
      // ISO-8601 timestamp on every record.
      expect(records.every((r) => typeof r.ts === "string" && !Number.isNaN(Date.parse(r.ts)))).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it("clearAuthToken emits records with op='clear' and the analogous lifecycle sequence", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { clearAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n  token: user_existing_xxx\n", {
        mode: 0o600,
      });

      await clearAuthToken(configPath);

      const records = parseDebugRecords(cap.reads());
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((r) => r.op === "clear")).toBe(true);
      const events = records.map((r) => r.event);
      expect(events).toContain("lock_acquired");
      expect(events).toContain("rename_completed");
      expect(events).toContain("lock_released");
    } finally {
      cap.restore();
    }
  });

  it("error path STILL emits lock_released (no leaked lock) and an error event", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { persistAuthToken, AuthTokenPersistError } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      // Malformed YAML — parseDocument fails INSIDE the locked region.
      writeFileSync(configPath, ":::\nthis is\n  not valid yaml :::\n", { mode: 0o600 });

      await expect(persistAuthToken(configPath, "user_error_path_zzz")).rejects.toBeInstanceOf(AuthTokenPersistError);

      const records = parseDebugRecords(cap.reads());
      const events = records.map((r) => r.event);

      // Lock was acquired, error event fired in catch, lock_released in finally.
      expect(events).toContain("lock_acquired");
      expect(events).toContain("error");
      expect(events).toContain("lock_released");

      // error event ordered BEFORE lock_released (release happens in finally
      // after the catch block emits).
      expect(events.indexOf("error")).toBeLessThan(events.indexOf("lock_released"));

      // error record carries the discriminated fields.
      const errorRecord = records.find((r) => r.event === "error");
      expect(errorRecord).toBeDefined();
      expect(errorRecord?.error_class).toBe("AuthTokenPersistError");
      expect(typeof errorRecord?.error_message).toBe("string");
      expect(errorRecord?.lock_held_at_error).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it("bearer token NEVER appears in stderr on the happy persist path (R-7 mitigation)", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      const bearer = "user_secret_bearer_DO_NOT_LOG_aaa_111_2222222222";
      await persistAuthToken(configPath, bearer);

      const captured = cap.reads().join("");
      expect(captured).not.toContain(bearer);
    } finally {
      cap.restore();
    }
  });

  it("bearer token NEVER appears in stderr on the malformed-YAML error path", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, ":::\nthis is\n  not valid yaml :::\n", { mode: 0o600 });

      const bearer = "user_secret_bearer_FOR_ERROR_PATH_zzz_222_333333333";
      await expect(persistAuthToken(configPath, bearer)).rejects.toThrow();

      const captured = cap.reads().join("");
      expect(captured).not.toContain(bearer);
    } finally {
      cap.restore();
    }
  });

  it("bearer token NEVER appears in stderr on the missing-config error path", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const missing = join(tmpRoot, "does-not-exist.yaml");
      const bearer = "user_secret_bearer_MISSING_PATH_kkk_555_44444444444";
      await expect(persistAuthToken(missing, bearer)).rejects.toThrow();

      const captured = cap.reads().join("");
      expect(captured).not.toContain(bearer);
    } finally {
      cap.restore();
    }
  });

  it("raw YAML content with a 1Password reference is not echoed verbatim into records", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      // Use a distinctive op:// reference that would only appear if we accidentally
      // dumped raw YAML or the parsed credentials value into a record.
      const opRef = "op://CanaryVault/CanaryItem-DO-NOT-LOG";
      writeFileSync(configPath, `auth:\n  credentials: ${opRef}\n`, { mode: 0o600 });

      await persistAuthToken(configPath, "user_canary_token_bbb");

      const captured = cap.reads().join("");
      expect(captured).not.toContain(opRef);
      expect(captured).not.toContain("CanaryVault");
      expect(captured).not.toContain("CanaryItem");
    } finally {
      cap.restore();
    }
  });

  it("raw YAML content with a literal password is not echoed into records", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      const password = "Canary-Password-DO-NOT-LOG-123!";
      writeFileSync(configPath, `auth:\n  credentials:\n    username: ada@example.com\n    password: "${password}"\n`, {
        mode: 0o600,
      });

      await persistAuthToken(configPath, "user_password_canary_ccc");

      const captured = cap.reads().join("");
      expect(captured).not.toContain(password);
    } finally {
      cap.restore();
    }
  });

  it("rejects empty token BEFORE acquiring the lock — emits zero records", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { persistAuthToken, AuthTokenPersistError } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      await expect(persistAuthToken(configPath, "")).rejects.toBeInstanceOf(AuthTokenPersistError);

      // No lock acquired → no instrumented records (caller-bug check fires
      // synchronously in the public API, before performYamlMutation runs).
      const records = parseDebugRecords(cap.reads());
      expect(records).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it("stat_baseline records the file's pre-write mtime and mode", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      await persistAuthToken(configPath, "user_stat_baseline_test");

      const records = parseDebugRecords(cap.reads());
      const baseline = records.find((r) => r.event === "stat_baseline");
      expect(baseline).toBeDefined();
      expect(typeof baseline?.mtime_ms).toBe("number");
      expect(typeof baseline?.mode_octal).toBe("string");
      // mode 0o600 stat'd back as "600" (POSIX); on Windows mode bits are
      // not meaningful but the stat call still returns SOMETHING.
      if (process.platform !== "win32") {
        expect(baseline?.mode_octal).toBe("600");
      }
    } finally {
      cap.restore();
    }
  });

  it("lock_released records a non-negative duration_ms via the monotonic clock", async () => {
    process.env["TTCTL_DEBUG_CONFIG"] = "1";
    const { persistAuthToken } = await import("../configWriter.js");

    const cap = captureStderr();
    try {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

      await persistAuthToken(configPath, "user_duration_test");

      const records = parseDebugRecords(cap.reads());
      const release = records.find((r) => r.event === "lock_released");
      expect(release).toBeDefined();
      expect(typeof release?.duration_ms).toBe("number");
      // performance.now() is monotonic and never decreases — duration must
      // be >= 0 (and almost always > 0 on real hardware).
      expect(Number(release?.duration_ms)).toBeGreaterThanOrEqual(0);
    } finally {
      cap.restore();
    }
  });
});
