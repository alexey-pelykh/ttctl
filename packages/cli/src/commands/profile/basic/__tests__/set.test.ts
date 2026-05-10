// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: re-export everything real (so the rest
// of the runProfileBasicUpdate handler — error classes, freetext lib,
// etc. — resolves correctly) and override only `profile.basic.set` so
// the dry-run integration test can stub a preview outcome without
// touching any transport. The mock applies process-wide, so the
// pure-formatter tests below run AFTER this mock is hoisted, but they
// don't read `profile.basic.set` so the override is a no-op for them.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    profile: {
      ...actual.profile,
      basic: {
        ...actual.profile.basic,
        set: vi.fn(),
      },
    },
  };
});

import { profile } from "@ttctl/core";
import type { DryRunPreview } from "@ttctl/core";

import { resetCliDryRun, setCliDryRun } from "../../../../lib/dry-run.js";
import { formatUpdatePrettyEntity, runProfileBasicUpdate } from "../set.js";

/**
 * Pure-formatter unit tests for `profile basic update`. Post-#128 the
 * action handler emits the v0.4 envelope via `emitUpdateSuccess` rather
 * than a pure `formatUpdateResult` helper — the wire-shape assertions
 * for the envelope itself live in `lib/__tests__/envelopes.test.ts`.
 * The pretty body kept here (`formatUpdatePrettyEntity`) is the
 * indented-bio / indented-headline subset that goes under the
 * `✓ Updated: …` header line.
 *
 * Below, the dry-run integration suite (issue #52) verifies the
 * `runProfileBasicUpdate` handler routes correctly when the global
 * `--dry-run` flag is set: it does NOT call the apply-path, instead
 * passing `dryRun: true` to `profile.basic.set()` and emitting the
 * dry-run envelope on stdout.
 */

const UPDATED: profile.basic.UpdateProfileResult = {
  profile: {
    id: "p1",
    about: "a brand new bio",
    quote: "shorter, sharper, smarter",
  },
  notice: null,
};

describe("formatUpdatePrettyEntity", () => {
  it("echoes back the new bio and headline using the user-facing flag names", () => {
    const out = formatUpdatePrettyEntity(UPDATED);
    expect(out).toContain("bio: a brand new bio");
    expect(out).toContain("headline: shorter, sharper, smarter");
  });

  it("omits unchanged-side lines when the server does not return them", () => {
    const partial: profile.basic.UpdateProfileResult = {
      profile: { id: "p1", about: "only bio", quote: null },
      notice: null,
    };
    const out = formatUpdatePrettyEntity(partial);
    expect(out).toContain("bio: only bio");
    expect(out).not.toContain("headline:");
  });

  it("trims every line to 80 columns (long-bio truncation must end with ellipsis)", () => {
    const longBio = "x".repeat(200);
    const wide: profile.basic.UpdateProfileResult = {
      profile: { id: "p1", about: longBio, quote: null },
      notice: null,
    };
    const out = formatUpdatePrettyEntity(wide);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    const bioLine = out.split("\n").find((l) => l.includes("bio:"));
    expect(bioLine?.endsWith("…")).toBe(true);
  });

  it("does not include a leading confirmation line — that's the envelope's `✓ Updated:` header's job", () => {
    const out = formatUpdatePrettyEntity(UPDATED);
    expect(out).not.toContain("Profile updated.");
    expect(out).not.toContain("✓");
  });
});

// =======================================================================
// runProfileBasicUpdate dry-run integration (issue #52)
// =======================================================================
//
// Verifies the CLI handler's dry-run routing: when the global
// `--dry-run` flag is captured (via `setCliDryRun(true)`), the
// handler MUST pass `{ dryRun: true }` to `profile.basic.set()`. When
// `set()` returns a `kind: "preview"` outcome, the handler emits the
// dry-run envelope on stdout instead of the regular update envelope.
//
// `loadAuthTokenOrExit` is NOT mocked — we exercise its `loadConfigFile`
// fallback by setting TTCTL_CONFIG_FILE to a non-existent path so the
// auth-token-loading path triggers `emitErrorAndExit`. To bypass that
// for the dry-run integration, we mock the token loader by intercepting
// at the `profile.basic.set` boundary — when the handler reaches `set`
// it'll pass through the mock; if it errors on `loadAuthTokenOrExit`
// first we'll see a different error on stderr / the mock won't fire.
// =======================================================================

const MOCKED_SET = profile.basic.set as ReturnType<typeof vi.fn>;

const PREVIEW_FIXTURE: DryRunPreview = {
  surface: "talent-profile",
  transport: "impersonated",
  endpoint: "https://www.toptal.com/api/talent_profile/graphql",
  operationName: "UPDATE_BASIC_INFO",
  variables: {
    input: {
      profileId: "<resolved at send-time from session token>",
      profile: { about: "test bio" },
    },
  },
  headers: {
    accept: "*/*",
    authorization: "Token token=<redacted>",
    "content-type": "application/json",
  },
};

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

class ExitInvoked extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code.toString()})`);
  }
}

describe("runProfileBasicUpdate dry-run integration (#52)", () => {
  let originalConfigEnv: string | undefined;

  beforeEach(() => {
    MOCKED_SET.mockReset();
    resetCliDryRun();
    // Steer the auth-token loader at a non-existent config path; we
    // override its outcome below by re-mocking only when we want the
    // dry-run flow to run all the way through.
    originalConfigEnv = process.env["TTCTL_CONFIG_FILE"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCliDryRun();
    if (originalConfigEnv === undefined) {
      delete process.env["TTCTL_CONFIG_FILE"];
    } else {
      process.env["TTCTL_CONFIG_FILE"] = originalConfigEnv;
    }
  });

  it("passes `dryRun: true` to profile.basic.set() when getCliDryRun() is true", async () => {
    // Token loader needs to succeed. We point `TTCTL_CONFIG_FILE` at a
    // tmp YAML carrying a token, so `loadAuthTokenOrExit` resolves
    // happily and reaches the `set()` mock.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "ttctl-set-dryrun-"));
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
    process.env["TTCTL_CONFIG_FILE"] = configPath;

    setCliDryRun(true);
    MOCKED_SET.mockResolvedValueOnce({ kind: "preview", preview: PREVIEW_FIXTURE });

    const stdout = captureStdout();
    captureStderr();

    await runProfileBasicUpdate({ bio: "test bio", output: "json" });

    // The CRITICAL AC bullet: `dryRun: true` is passed through.
    expect(MOCKED_SET).toHaveBeenCalledTimes(1);
    const args = MOCKED_SET.mock.calls[0];
    expect(args?.[2]).toEqual({ dryRun: true });

    // Stdout carries the dry-run JSON envelope (NOT the update one).
    const out = stdout.lines.join("");
    const parsed = JSON.parse(out.trimEnd()) as Record<string, unknown>;
    expect(parsed["dryRun"]).toBe(true);
    expect(parsed["operation"]).toBe("profile.basic.update");
    expect((parsed["preview"] as DryRunPreview).operationName).toBe("UPDATE_BASIC_INFO");
    // The "updated" wire field MUST NOT appear — that's the apply-path envelope.
    expect(parsed).not.toHaveProperty("updated");
  });

  it("passes `dryRun: false` (apply path) when getCliDryRun() is false", async () => {
    // Same config setup as above so `loadAuthTokenOrExit` resolves
    // happily and reaches the `set()` mock.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "ttctl-set-applypath-"));
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
    process.env["TTCTL_CONFIG_FILE"] = configPath;

    // Default state: dry-run not set.
    expect(MOCKED_SET).not.toHaveBeenCalled();
    MOCKED_SET.mockResolvedValueOnce({ kind: "applied", result: UPDATED });

    captureStdout();
    captureStderr();

    await runProfileBasicUpdate({ bio: "test bio", output: "json" });

    expect(MOCKED_SET).toHaveBeenCalledTimes(1);
    const args = MOCKED_SET.mock.calls[0];
    expect(args?.[2]).toEqual({ dryRun: false });
  });

  it("dry-run path emits a dry-run envelope (not an update envelope) on success", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "ttctl-dryrun-envelope-"));
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
    process.env["TTCTL_CONFIG_FILE"] = configPath;

    setCliDryRun(true);
    MOCKED_SET.mockResolvedValueOnce({ kind: "preview", preview: PREVIEW_FIXTURE });

    const stdout = captureStdout();
    captureStderr();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitInvoked(code ?? 0);
    }) as never);

    await runProfileBasicUpdate({ bio: "test bio", output: "pretty" });

    const out = stdout.lines.join("");
    expect(out).toContain("Dry run:");
    expect(out).toContain("UPDATE_BASIC_INFO");
    expect(out).toContain("(no changes sent)");
    expect(out).toContain("surface:    talent-profile (impersonated)");
    // The apply-path "Updated:" header MUST NOT appear.
    expect(out).not.toContain("Updated:");
  });

  it("dry-run integration retains the existing validation guard (no --bio / --headline / --edit error)", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = mkdtempSync(join(tmpdir(), "ttctl-dryrun-validation-"));
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
    process.env["TTCTL_CONFIG_FILE"] = configPath;

    setCliDryRun(true);

    captureStdout();
    captureStderr();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitInvoked(code ?? 0);
    }) as never);

    // No bio/headline/edit — the existing validation should fire BEFORE
    // any set() call, even on the dry-run path. This guards against
    // regression where the dry-run short-circuit might inadvertently
    // skip the validation gate.
    await expect(runProfileBasicUpdate({ output: "pretty" })).rejects.toBeInstanceOf(ExitInvoked);
    expect(MOCKED_SET).not.toHaveBeenCalled();
  });
});
