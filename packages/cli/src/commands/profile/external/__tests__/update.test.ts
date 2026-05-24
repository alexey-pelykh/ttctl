// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core: override only `profile.external.update` so
// we can assert the twitter pre-check short-circuits BEFORE the apply path
// (and before auth I/O) — `update` must never be called when twitter is
// supplied. Everything else (TtctlError, TWITTER_NOT_EXTERNAL_MESSAGE,
// ProfileError) resolves to the real module.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    profile: {
      ...actual.profile,
      external: {
        ...actual.profile.external,
        update: vi.fn(),
      },
    },
  };
});

import { profile } from "@ttctl/core";

import { runProfileExternalUpdate } from "../update.js";

/**
 * #526: `ttctl profile external update --twitter <value>` is accepted by
 * commander but is NOT settable here — the handler short-circuits to an
 * actionable `VALIDATION_ERROR` redirect pointing at
 * `ttctl profile basic update --twitter`, surfaced BEFORE auth I/O and
 * BEFORE any call to `profile.external.update`. The wording is the shared
 * `profile.external.TWITTER_NOT_EXTERNAL_MESSAGE`.
 */

const MOCKED_UPDATE = profile.external.update as ReturnType<typeof vi.fn>;

class ExitInvoked extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code.toString()})`);
  }
}

function captureStdout(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

describe("runProfileExternalUpdate — #526 twitter redirect", () => {
  beforeEach(() => {
    MOCKED_UPDATE.mockReset();
    vi.spyOn(process, "exit").mockImplementation((code?: number): never => {
      throw new ExitInvoked(code ?? 0);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects --twitter with a VALIDATION_ERROR redirect, before auth I/O and without calling update()", async () => {
    const stdout = captureStdout();

    await expect(runProfileExternalUpdate({ twitter: "alexey_pelykh", output: "json" })).rejects.toBeInstanceOf(
      ExitInvoked,
    );

    const out = stdout.lines.join("");
    expect(out).toContain("VALIDATION_ERROR");
    // Names where twitter actually lives.
    expect(out).toMatch(/basic update|basic\.set/);
    // The apply path was never reached — twitter is rejected up-front.
    expect(MOCKED_UPDATE).not.toHaveBeenCalled();
  });

  it("rejects --twitter even when co-supplied with a valid URL (no partial write)", async () => {
    const stdout = captureStdout();

    await expect(
      runProfileExternalUpdate({ linkedin: "https://linkedin.com/in/ada", twitter: "@ada", output: "json" }),
    ).rejects.toBeInstanceOf(ExitInvoked);

    const out = stdout.lines.join("");
    expect(out).toContain("VALIDATION_ERROR");
    expect(MOCKED_UPDATE).not.toHaveBeenCalled();
  });

  it("rejects an empty-string --twitter (any value triggers the redirect)", async () => {
    const stdout = captureStdout();

    await expect(runProfileExternalUpdate({ twitter: "", output: "json" })).rejects.toBeInstanceOf(ExitInvoked);

    expect(stdout.lines.join("")).toContain("VALIDATION_ERROR");
    expect(MOCKED_UPDATE).not.toHaveBeenCalled();
  });
});
