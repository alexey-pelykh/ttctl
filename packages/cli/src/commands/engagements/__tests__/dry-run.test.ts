// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real (so error
// classes, helpers, etc. resolve correctly) and override every
// engagements.breaks mutation function so the dry-run integration
// tests can stub a `kind: "preview"` outcome without touching the
// transport.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    engagements: {
      ...actual.engagements,
      breaks: {
        ...actual.engagements.breaks,
        add: vi.fn(),
        remove: vi.fn(),
        reschedule: vi.fn(),
      },
    },
  };
});

import { engagements } from "@ttctl/core";
import type { DryRunPreview } from "@ttctl/core";

import { resetCliDryRun, setCliDryRun } from "../../../lib/dry-run.js";
import { runEngagementsBreaksAdd, runEngagementsBreaksRemove, runEngagementsBreaksReschedule } from "../breaks.js";

/**
 * CLI integration tests for the dry-run path of the 2 mutating
 * engagement-breaks leaves (issue #163). Each test verifies:
 *
 *   1. `getCliDryRun()` value is forwarded as `{ dryRun: true }` to
 *      the corresponding core mutation.
 *   2. When the core returns `{ kind: "preview", preview }`, the CLI
 *      handler emits the v0.4 dry-run JSON envelope on stdout with
 *      the operation name from the issue's mapping table.
 *   3. The "created" / "removed" wire fields MUST NOT appear in the
 *      stdout payload (those belong to the apply-path envelopes).
 *   4. For `breaks add`, the `notice` field surfacing the
 *      deferred-resolution caveat is present on the envelope.
 *
 * The token loader is exercised via a real on-disk config file at a
 * tmp path; the `TTCTL_CONFIG_FILE` env var steers it. The mocks for
 * engagements.breaks mutations skip every other side effect.
 */

const MOCKED_BREAKS_ADD = engagements.breaks.add as ReturnType<typeof vi.fn>;
const MOCKED_BREAKS_REMOVE = engagements.breaks.remove as ReturnType<typeof vi.fn>;
const MOCKED_BREAKS_RESCHEDULE = engagements.breaks.reschedule as ReturnType<typeof vi.fn>;

function previewFor(operationName: string, variables: Record<string, unknown>): DryRunPreview {
  return {
    surface: "mobile-gateway",
    transport: "stock",
    endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
    operationName,
    variables,
    headers: {
      accept: "*/*",
      authorization: "Token token=<redacted>",
      "content-type": "application/json",
    },
  };
}

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

async function withTmpConfig<T>(fn: () => Promise<T>): Promise<T> {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmpDir = mkdtempSync(join(tmpdir(), "ttctl-engagements-dryrun-"));
  const configPath = join(tmpDir, ".ttctl.yaml");
  writeFileSync(
    configPath,
    [
      "auth:",
      '  credentials: "op://Personal/ttctl"',
      '  token: "user_0123456789abcdef0123456789abcdef0123456789abcdef"',
    ].join("\n"),
    { mode: 0o600 },
  );
  const originalConfigEnv = process.env["TTCTL_CONFIG_FILE"];
  process.env["TTCTL_CONFIG_FILE"] = configPath;
  try {
    return await fn();
  } finally {
    if (originalConfigEnv === undefined) {
      delete process.env["TTCTL_CONFIG_FILE"];
    } else {
      process.env["TTCTL_CONFIG_FILE"] = originalConfigEnv;
    }
  }
}

describe("ttctl engagements dry-run integration (issue #163)", () => {
  beforeEach(() => {
    MOCKED_BREAKS_ADD.mockReset();
    MOCKED_BREAKS_REMOVE.mockReset();
    MOCKED_BREAKS_RESCHEDULE.mockReset();
    resetCliDryRun();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCliDryRun();
  });

  it("breaks add: forwards { dryRun: true } and emits dry-run envelope (op=engagements.breaks.add, wire=CreateEngagementBreak)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_BREAKS_ADD.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("CreateEngagementBreak", {
          engagementId: "act-eng-1",
          startDate: "2026-06-01",
          endDate: "2026-06-08",
          reasonIdentifier: "talent_on_vacation",
          comment: "Summer break",
        }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runEngagementsBreaksAdd("act-eng-1", {
        from: "2026-06-01",
        to: "2026-06-08",
        reasonId: "talent_on_vacation",
        comment: "Summer break",
        output: "json",
      });

      // Core call shape: (token, jobActivityItemId, opts, { dryRun: true })
      expect(MOCKED_BREAKS_ADD).toHaveBeenCalledTimes(1);
      const args = MOCKED_BREAKS_ADD.mock.calls[0];
      expect(args?.[1]).toBe("act-eng-1");
      expect(args?.[2]).toMatchObject({
        startDate: "2026-06-01",
        endDate: "2026-06-08",
        reasonIdentifier: "talent_on_vacation",
        comment: "Summer break",
      });
      expect(args?.[3]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["ok"]).toBe(true);
      expect(parsed["version"]).toBe("1.0");
      expect(parsed["operation"]).toBe("engagements.breaks.add");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("CreateEngagementBreak");
      // Apply-path wire field must NOT appear in dry-run envelope.
      expect(parsed["created"]).toBeUndefined();
      // Notice surfaces the deferred-resolution caveat.
      expect(typeof parsed["notice"]).toBe("string");
      expect(parsed["notice"]).toContain("engagementId");
      expect(parsed["notice"]).toContain("placeholder");
    });
  });

  it("breaks add: comment omitted → core receives addOpts without comment, dryRun still forwarded", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_BREAKS_ADD.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("CreateEngagementBreak", {
          engagementId: "act-eng-1",
          startDate: "2026-06-01",
          endDate: "2026-06-08",
          reasonIdentifier: "other",
          comment: null,
        }),
      });

      captureStdout();
      captureStderr();

      await runEngagementsBreaksAdd("act-eng-1", {
        from: "2026-06-01",
        to: "2026-06-08",
        reasonId: "other",
        output: "json",
      });

      const args = MOCKED_BREAKS_ADD.mock.calls[0];
      expect(args?.[2]).toEqual({
        startDate: "2026-06-01",
        endDate: "2026-06-08",
        reasonIdentifier: "other",
      });
      expect(args?.[3]).toEqual({ dryRun: true });
    });
  });

  it("breaks remove: forwards { dryRun: true } and emits dry-run envelope (op=engagements.breaks.remove, wire=CancelEngagementBreak)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_BREAKS_REMOVE.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("CancelEngagementBreak", { engagementBreakId: "br-1" }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runEngagementsBreaksRemove("br-1", "json");

      expect(MOCKED_BREAKS_REMOVE).toHaveBeenCalledTimes(1);
      const args = MOCKED_BREAKS_REMOVE.mock.calls[0];
      expect(args?.[1]).toBe("br-1");
      expect(args?.[2]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["ok"]).toBe(true);
      expect(parsed["operation"]).toBe("engagements.breaks.remove");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("CancelEngagementBreak");
      expect((parsed["preview"] as DryRunPreview).variables).toEqual({ engagementBreakId: "br-1" });
      // Apply-path wire field must NOT appear in dry-run envelope.
      expect(parsed["removed"]).toBeUndefined();
      // No notice for remove (no deferred resolution).
      expect(parsed["notice"]).toBeUndefined();
    });
  });

  it("breaks add apply path remains the default when getCliDryRun() is false (sanity check)", async () => {
    await withTmpConfig(async () => {
      // Default: dry-run NOT set.
      MOCKED_BREAKS_ADD.mockResolvedValueOnce({
        kind: "applied",
        result: {
          id: "br-real",
          startDate: "2026-06-01",
          endDate: "2026-06-08",
          comment: null,
          operations: null,
        },
      });

      const stdout = captureStdout();
      captureStderr();

      await runEngagementsBreaksAdd("act-eng-1", {
        from: "2026-06-01",
        to: "2026-06-08",
        reasonId: "other",
        output: "json",
      });

      const args = MOCKED_BREAKS_ADD.mock.calls[0];
      expect(args?.[3]).toEqual({ dryRun: false });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      // Apply-path envelope: `created` present, `dryRun` absent.
      expect(parsed["dryRun"]).toBeUndefined();
      expect(parsed["created"]).toBeDefined();
    });
  });

  it("breaks remove apply path remains the default when getCliDryRun() is false (sanity check)", async () => {
    await withTmpConfig(async () => {
      MOCKED_BREAKS_REMOVE.mockResolvedValueOnce({
        kind: "applied",
        result: { id: "br-1" },
      });

      const stdout = captureStdout();
      captureStderr();

      await runEngagementsBreaksRemove("br-1", "json");

      const args = MOCKED_BREAKS_REMOVE.mock.calls[0];
      expect(args?.[2]).toEqual({ dryRun: false });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      // Apply-path envelope: `removed` present, `dryRun` absent.
      expect(parsed["dryRun"]).toBeUndefined();
      expect((parsed["removed"] as { id?: string })?.id).toBe("br-1");
    });
  });

  it("breaks reschedule: forwards { dryRun: true } and emits dry-run envelope (op=engagements.breaks.reschedule, wire=RescheduleEngagementBreak) (#155)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_BREAKS_RESCHEDULE.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("RescheduleEngagementBreak", {
          engagementBreakId: "br-1",
          startDate: "2026-07-01",
          endDate: "2026-07-08",
        }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runEngagementsBreaksReschedule("br-1", {
        from: "2026-07-01",
        to: "2026-07-08",
        output: "json",
      });

      // Core call shape: (token, engagementBreakId, opts, { dryRun: true })
      expect(MOCKED_BREAKS_RESCHEDULE).toHaveBeenCalledTimes(1);
      const args = MOCKED_BREAKS_RESCHEDULE.mock.calls[0];
      expect(args?.[1]).toBe("br-1");
      expect(args?.[2]).toEqual({
        startDate: "2026-07-01",
        endDate: "2026-07-08",
      });
      expect(args?.[3]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["ok"]).toBe(true);
      expect(parsed["version"]).toBe("1.0");
      expect(parsed["operation"]).toBe("engagements.breaks.reschedule");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("RescheduleEngagementBreak");
      expect((parsed["preview"] as DryRunPreview).variables).toEqual({
        engagementBreakId: "br-1",
        startDate: "2026-07-01",
        endDate: "2026-07-08",
      });
      // Apply-path wire field must NOT appear in dry-run envelope.
      expect(parsed["updated"]).toBeUndefined();
    });
  });

  it("breaks reschedule apply path remains the default when getCliDryRun() is false (sanity check) (#155)", async () => {
    await withTmpConfig(async () => {
      MOCKED_BREAKS_RESCHEDULE.mockResolvedValueOnce({
        kind: "applied",
        result: {
          id: "br-1",
          startDate: "2026-07-01",
          endDate: "2026-07-08",
          comment: "Summer break",
          operations: null,
        },
      });

      const stdout = captureStdout();
      captureStderr();

      await runEngagementsBreaksReschedule("br-1", {
        from: "2026-07-01",
        to: "2026-07-08",
        output: "json",
      });

      const args = MOCKED_BREAKS_RESCHEDULE.mock.calls[0];
      expect(args?.[3]).toEqual({ dryRun: false });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      // Apply-path envelope: `updated` present, `dryRun` absent.
      expect(parsed["dryRun"]).toBeUndefined();
      expect((parsed["updated"] as { id?: string; startDate?: string })?.id).toBe("br-1");
      expect((parsed["updated"] as { startDate?: string })?.startDate).toBe("2026-07-01");
    });
  });
});
