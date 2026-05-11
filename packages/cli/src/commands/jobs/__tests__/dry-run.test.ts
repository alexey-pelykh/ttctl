// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real (so error
// classes, helpers, etc. resolve correctly) and override every jobs
// mutation function so the dry-run integration tests can stub a
// `kind: "preview"` outcome without touching the transport.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    jobs: {
      ...actual.jobs,
      save: vi.fn(),
      unsave: vi.fn(),
      notInterested: vi.fn(),
      markViewed: vi.fn(),
      clearInterest: vi.fn(),
      searchSubscriptionSave: vi.fn(),
      searchSubscriptionRemove: vi.fn(),
    },
  };
});

import { jobs } from "@ttctl/core";
import type { DryRunPreview } from "@ttctl/core";

import { resetCliDryRun, setCliDryRun } from "../../../lib/dry-run.js";
import {
  runJobsClearInterest,
  runJobsMarkViewed,
  runJobsNotInterested,
  runJobsSave,
  runJobsUnsave,
} from "../interest.js";
import { runJobsSearchRemove, runJobsSearchSave } from "../search.js";

/**
 * CLI integration tests for the dry-run path of the 7 mutating jobs
 * leaves (issue #162). Each test verifies:
 *
 *   1. `getCliDryRun()` value is forwarded as `{ dryRun: true }` to
 *      the corresponding core mutation.
 *   2. When the core returns `{ kind: "preview", preview }`, the CLI
 *      handler emits the v0.4 dry-run JSON envelope on stdout with the
 *      operation name from the issue's mapping table.
 *   3. The "updated" / "removed" wire fields MUST NOT appear in the
 *      stdout payload (those belong to the apply-path envelopes).
 *
 * The token loader is exercised via a real on-disk config file at a
 * tmp path; the `TTCTL_CONFIG_FILE` env var steers it. The mocks for
 * jobs mutations skip every other side effect.
 */

const MOCKED_SAVE = jobs.save as ReturnType<typeof vi.fn>;
const MOCKED_UNSAVE = jobs.unsave as ReturnType<typeof vi.fn>;
const MOCKED_NOT_INTERESTED = jobs.notInterested as ReturnType<typeof vi.fn>;
const MOCKED_MARK_VIEWED = jobs.markViewed as ReturnType<typeof vi.fn>;
const MOCKED_CLEAR_INTEREST = jobs.clearInterest as ReturnType<typeof vi.fn>;
const MOCKED_SEARCH_SAVE = jobs.searchSubscriptionSave as ReturnType<typeof vi.fn>;
const MOCKED_SEARCH_REMOVE = jobs.searchSubscriptionRemove as ReturnType<typeof vi.fn>;

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
  const tmpDir = mkdtempSync(join(tmpdir(), "ttctl-jobs-dryrun-"));
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

describe("ttctl jobs dry-run integration (issue #162)", () => {
  beforeEach(() => {
    MOCKED_SAVE.mockReset();
    MOCKED_UNSAVE.mockReset();
    MOCKED_NOT_INTERESTED.mockReset();
    MOCKED_MARK_VIEWED.mockReset();
    MOCKED_CLEAR_INTEREST.mockReset();
    MOCKED_SEARCH_SAVE.mockReset();
    MOCKED_SEARCH_REMOVE.mockReset();
    resetCliDryRun();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCliDryRun();
  });

  it("jobs save: forwards { dryRun: true } and emits dry-run JSON envelope (op=jobs.save, wire=JobMarkSaved)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_SAVE.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("JobMarkSaved", { jobID: "job-1" }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runJobsSave("job-1", "json");

      expect(MOCKED_SAVE).toHaveBeenCalledTimes(1);
      const args = MOCKED_SAVE.mock.calls[0];
      expect(args?.[2]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["ok"]).toBe(true);
      expect(parsed["version"]).toBe("1.0");
      expect(parsed["operation"]).toBe("jobs.save");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("JobMarkSaved");
      expect(parsed["updated"]).toBeUndefined();
    });
  });

  it("jobs unsave: forwards { dryRun: true } and emits dry-run envelope (op=jobs.unsave, wire=JobClearInterest)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_UNSAVE.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("JobClearInterest", { jobID: "job-1" }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runJobsUnsave("job-1", "json");

      expect(MOCKED_UNSAVE).toHaveBeenCalledTimes(1);
      const args = MOCKED_UNSAVE.mock.calls[0];
      expect(args?.[2]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["operation"]).toBe("jobs.unsave");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("JobClearInterest");
      expect(parsed["removed"]).toBeUndefined();
    });
  });

  it("jobs not-interested: forwards { dryRun: true } and emits dry-run envelope (op=jobs.not-interested, wire=JobMarkNotInterested)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_NOT_INTERESTED.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("JobMarkNotInterested", { jobID: "job-1", reason: "low_rate" }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runJobsNotInterested("job-1", { reason: "low_rate", output: "json" });

      expect(MOCKED_NOT_INTERESTED).toHaveBeenCalledTimes(1);
      const args = MOCKED_NOT_INTERESTED.mock.calls[0];
      expect(args?.[2]).toEqual({ reason: "low_rate" });
      expect(args?.[3]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["operation"]).toBe("jobs.not-interested");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("JobMarkNotInterested");
      expect((parsed["preview"] as DryRunPreview).variables).toEqual({ jobID: "job-1", reason: "low_rate" });
    });
  });

  it("jobs mark-viewed: forwards { dryRun: true } and emits dry-run envelope (op=jobs.mark-viewed, wire=JobMarkViewed)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_MARK_VIEWED.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("JobMarkViewed", { jobID: "job-1" }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runJobsMarkViewed("job-1", "json");

      expect(MOCKED_MARK_VIEWED).toHaveBeenCalledTimes(1);
      const args = MOCKED_MARK_VIEWED.mock.calls[0];
      expect(args?.[2]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["operation"]).toBe("jobs.mark-viewed");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("JobMarkViewed");
    });
  });

  it("jobs clear-interest: forwards { dryRun: true } and emits dry-run envelope (op=jobs.clear-interest, wire=JobClearInterest)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_CLEAR_INTEREST.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("JobClearInterest", { jobID: "job-1" }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runJobsClearInterest("job-1", "json");

      expect(MOCKED_CLEAR_INTEREST).toHaveBeenCalledTimes(1);
      const args = MOCKED_CLEAR_INTEREST.mock.calls[0];
      expect(args?.[2]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["operation"]).toBe("jobs.clear-interest");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("JobClearInterest");
    });
  });

  it("jobs search save: forwards { dryRun: true } and emits dry-run envelope (op=jobs.search.save, wire=JobSearchSubscriptionStart)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_SEARCH_SAVE.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("JobSearchSubscriptionStart", {
          skills: ["React"],
          keywords: null,
          excludeSkills: null,
          excludeKeywords: null,
          commitments: null,
          workTypes: null,
          estimatedLengths: null,
          excludeUnspecifiedBudget: null,
        }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runJobsSearchSave({ skills: ["React"], output: "json" });

      expect(MOCKED_SEARCH_SAVE).toHaveBeenCalledTimes(1);
      const args = MOCKED_SEARCH_SAVE.mock.calls[0];
      expect(args?.[2]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["operation"]).toBe("jobs.search.save");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("JobSearchSubscriptionStart");
    });
  });

  it("jobs search remove: forwards { dryRun: true } and emits dry-run envelope (op=jobs.search.remove, wire=JobSearchSubscriptionTerminate)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_SEARCH_REMOVE.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("JobSearchSubscriptionTerminate", {}),
      });

      const stdout = captureStdout();
      captureStderr();

      await runJobsSearchRemove(undefined, "json");

      expect(MOCKED_SEARCH_REMOVE).toHaveBeenCalledTimes(1);
      const args = MOCKED_SEARCH_REMOVE.mock.calls[0];
      expect(args?.[1]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["operation"]).toBe("jobs.search.remove");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("JobSearchSubscriptionTerminate");
      expect(parsed["removed"]).toBeUndefined();
    });
  });

  it("apply path remains the default when getCliDryRun() is false (jobs save sanity check)", async () => {
    await withTmpConfig(async () => {
      // Default: dry-run NOT set.
      MOCKED_SAVE.mockResolvedValueOnce({
        kind: "applied",
        result: { id: "job-1", saved: true, notInterested: false, viewed: false },
      });

      const stdout = captureStdout();
      captureStderr();

      await runJobsSave("job-1", "json");

      expect(MOCKED_SAVE).toHaveBeenCalledTimes(1);
      const args = MOCKED_SAVE.mock.calls[0];
      expect(args?.[2]).toEqual({ dryRun: false });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      // Apply-path envelope: `updated` present, `dryRun` absent.
      expect(parsed["dryRun"]).toBeUndefined();
      expect(parsed["updated"]).toBeDefined();
    });
  });
});
