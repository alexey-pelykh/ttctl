// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real (so error
// classes, helpers, etc. resolve correctly) and override every
// availability mutation function so the dry-run integration tests can
// stub a `kind: "preview"` outcome without touching the transport.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    availability: {
      ...actual.availability,
      workingHours: {
        ...actual.availability.workingHours,
        set: vi.fn(),
      },
      allocatedHours: {
        ...actual.availability.allocatedHours,
        set: vi.fn(),
      },
    },
  };
});

import { availability } from "@ttctl/core";
import type { DryRunPreview } from "@ttctl/core";

import { resetCliDryRun, setCliDryRun } from "../../../lib/dry-run.js";
import { runAllocatedHoursSet } from "../allocated-hours.js";
import { runWorkingHoursSet } from "../working-hours.js";

/**
 * CLI integration tests for the dry-run path of the 2 mutating
 * availability leaves (issue #164). Each test verifies:
 *
 *   1. `getCliDryRun()` value is forwarded as `{ dryRun: true }` to
 *      the corresponding core mutation.
 *   2. When the core returns `{ kind: "preview", preview }`, the CLI
 *      handler emits the v0.4 dry-run JSON envelope on stdout with the
 *      operation name from the issue's mapping table (`UpdateWorkingHours`
 *      / `UpdateAllocatedHours`).
 *   3. The "updated" wire field MUST NOT appear in the stdout payload
 *      (that belongs to the apply-path envelope).
 *   4. The wire variables payload matches the partial-update / integer-arg
 *      shape that would have been sent.
 *
 * The token loader is exercised via a real on-disk config file at a
 * tmp path; the `TTCTL_CONFIG_FILE` env var steers it. The mocks for
 * availability mutations skip every other side effect.
 */

const MOCKED_WH_SET = availability.workingHours.set as ReturnType<typeof vi.fn>;
const MOCKED_AH_SET = availability.allocatedHours.set as ReturnType<typeof vi.fn>;

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
  const tmpDir = mkdtempSync(join(tmpdir(), "ttctl-availability-dryrun-"));
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

describe("ttctl availability dry-run integration (issue #164)", () => {
  beforeEach(() => {
    MOCKED_WH_SET.mockReset();
    MOCKED_AH_SET.mockReset();
    resetCliDryRun();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCliDryRun();
  });

  it("availability working-hours set: forwards { dryRun: true } and emits dry-run envelope (op=availability.working-hours.set, wire=UpdateWorkingHours)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_WH_SET.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("UpdateWorkingHours", {
          input: {
            profileId: "<resolved at apply time>",
            profile: { workingTimeFrom: "10:00:00", workingTimeTo: "18:00:00" },
          },
        }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runWorkingHoursSet({ start: "10:00:00", end: "18:00:00", output: "json" });

      expect(MOCKED_WH_SET).toHaveBeenCalledTimes(1);
      const args = MOCKED_WH_SET.mock.calls[0];
      expect(args?.[1]).toEqual({ workingTimeFrom: "10:00:00", workingTimeTo: "18:00:00" });
      expect(args?.[2]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["ok"]).toBe(true);
      expect(parsed["version"]).toBe("1.0");
      expect(parsed["operation"]).toBe("availability.working-hours.set");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("UpdateWorkingHours");
      expect((parsed["preview"] as DryRunPreview).surface).toBe("mobile-gateway");
      // Apply-path envelope fields MUST NOT appear.
      expect(parsed["updated"]).toBeUndefined();
      // Bearer is redacted in the preview headers.
      expect((parsed["preview"] as DryRunPreview).headers["authorization"]).toBe("Token token=<redacted>");
    });
  });

  it("availability working-hours set: passes all 5 supplied fields through to core (timeZone + flex range)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_WH_SET.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("UpdateWorkingHours", {
          input: {
            profileId: "<resolved at apply time>",
            profile: {
              timeZone: "Europe/Berlin",
              workingTimeFrom: "09:00:00",
              workingTimeTo: "17:00:00",
              availableShiftRangeFrom: "07:00:00",
              availableShiftRangeTo: "19:00:00",
            },
          },
        }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runWorkingHoursSet({
        start: "09:00:00",
        end: "17:00:00",
        timeZone: "Europe/Berlin",
        flexStart: "07:00:00",
        flexEnd: "19:00:00",
        output: "json",
      });

      const args = MOCKED_WH_SET.mock.calls[0];
      expect(args?.[1]).toEqual({
        timeZone: "Europe/Berlin",
        workingTimeFrom: "09:00:00",
        workingTimeTo: "17:00:00",
        availableShiftRangeFrom: "07:00:00",
        availableShiftRangeTo: "19:00:00",
      });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["operation"]).toBe("availability.working-hours.set");
    });
  });

  it("availability allocated-hours set: forwards { dryRun: true } and emits dry-run envelope (op=availability.allocated-hours.set, wire=UpdateAllocatedHours)", async () => {
    await withTmpConfig(async () => {
      setCliDryRun(true);
      MOCKED_AH_SET.mockResolvedValueOnce({
        kind: "preview",
        preview: previewFor("UpdateAllocatedHours", { hours: 35 }),
      });

      const stdout = captureStdout();
      captureStderr();

      await runAllocatedHoursSet({ hours: 35, output: "json" });

      expect(MOCKED_AH_SET).toHaveBeenCalledTimes(1);
      const args = MOCKED_AH_SET.mock.calls[0];
      expect(args?.[1]).toBe(35);
      expect(args?.[2]).toEqual({ dryRun: true });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBe(true);
      expect(parsed["ok"]).toBe(true);
      expect(parsed["operation"]).toBe("availability.allocated-hours.set");
      expect((parsed["preview"] as DryRunPreview).operationName).toBe("UpdateAllocatedHours");
      expect((parsed["preview"] as DryRunPreview).variables).toEqual({ hours: 35 });
      expect(parsed["updated"]).toBeUndefined();
    });
  });

  it("availability working-hours set: apply path remains the default when getCliDryRun() is false (sanity check)", async () => {
    await withTmpConfig(async () => {
      // Default: dry-run NOT set.
      MOCKED_WH_SET.mockResolvedValueOnce({
        kind: "applied",
        result: {
          timeZone: null,
          workingTimeFrom: "10:00:00",
          workingTimeTo: "18:00:00",
          availableShiftRangeFrom: null,
          availableShiftRangeTo: null,
          notice: null,
        },
      });

      const stdout = captureStdout();
      captureStderr();

      await runWorkingHoursSet({ start: "10:00:00", end: "18:00:00", output: "json" });

      expect(MOCKED_WH_SET).toHaveBeenCalledTimes(1);
      const args = MOCKED_WH_SET.mock.calls[0];
      expect(args?.[2]).toEqual({ dryRun: false });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      // Apply-path envelope: `updated` present, `dryRun` absent.
      expect(parsed["dryRun"]).toBeUndefined();
      expect(parsed["updated"]).toBeDefined();
    });
  });

  it("availability allocated-hours set: apply path remains the default when getCliDryRun() is false (sanity check)", async () => {
    await withTmpConfig(async () => {
      // Default: dry-run NOT set.
      MOCKED_AH_SET.mockResolvedValueOnce({
        kind: "applied",
        result: { allocatedHours: 35, hiredHours: 0, notice: null },
      });

      const stdout = captureStdout();
      captureStderr();

      await runAllocatedHoursSet({ hours: 35, output: "json" });

      const args = MOCKED_AH_SET.mock.calls[0];
      expect(args?.[2]).toEqual({ dryRun: false });

      const parsed = JSON.parse(stdout.lines.join("").trimEnd()) as Record<string, unknown>;
      expect(parsed["dryRun"]).toBeUndefined();
      expect(parsed["updated"]).toBeDefined();
    });
  });
});
