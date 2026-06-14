// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Argv-level routing test for `profile show --full` (#469).
 *
 * The other show tests call `runProfileBasicShow(format, full)` directly,
 * which bypasses Commander's flag parsing. That hid a collision: the root
 * program already owns a global `--verbose` (#139 transport logging), and
 * Commander binds `--verbose` to the root option in every position — so a
 * command-level `--verbose` on `profile show` never receives the flag and
 * the rich path would never fire. The flag was renamed to `--full`; this
 * test drives the real `buildProgram()` parse to prove the two flags are
 * now distinct: `--full` routes to `showRich`, `--verbose` routes to the
 * #139 diagnostic logger (never the rich path).
 */
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    resolveConfig: vi.fn(),
    setDiagnosticLogger: vi.fn(),
    profile: {
      ...actual.profile,
      showRich: vi.fn(),
      basic: {
        ...actual.profile.basic,
        show: vi.fn(),
        getBasicInfo: vi.fn(),
      },
    },
  };
});

import { profile, resolveConfig, setDiagnosticLogger } from "@ttctl/core";

import { resetCliConfigPath } from "../../../../lib/config-context.js";
import { resetCliDryRun } from "../../../../lib/dry-run.js";
import { buildProgram } from "../../../../program.js";

const mockedResolveConfig = vi.mocked(resolveConfig);
const mockedSetDiagnosticLogger = vi.mocked(setDiagnosticLogger);
const mockedShowRich = vi.mocked(profile.showRich);
const mockedBasicShow = vi.mocked(profile.basic.show);
const mockedGetBasicInfo = vi.mocked(profile.basic.getBasicInfo);

const RICH_STUB = { id: "v-rich-stub" } as unknown as Awaited<ReturnType<typeof profile.showRich>>;
const COMPACT_STUB = { viewer: null } as unknown as Awaited<ReturnType<typeof profile.basic.show>>;

async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await program.parseAsync(argv, { from: "user" });
}

describe("profile show flag routing — --full vs global --verbose (#469)", () => {
  beforeEach(() => {
    resetCliConfigPath();
    resetCliDryRun();
    mockedResolveConfig.mockReset().mockReturnValue({
      config: { auth: { token: "tok-routing-test" } },
      path: "/dev/null/config.yaml",
    });
    mockedSetDiagnosticLogger.mockReset();
    mockedShowRich.mockReset().mockResolvedValue(RICH_STUB);
    mockedBasicShow.mockReset().mockResolvedValue(COMPACT_STUB);
    mockedGetBasicInfo.mockReset().mockResolvedValue(null);
    delete process.env["TTCTL_CONFIG_FILE"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCliConfigPath();
    resetCliDryRun();
  });

  it("`profile show --full` fetches the rich GetViewer projection", async () => {
    await run(["profile", "show", "--full", "-o", "json"]);
    expect(mockedShowRich).toHaveBeenCalledTimes(1);
    expect(mockedBasicShow).not.toHaveBeenCalled();
  });

  it("`profile basic show --full` (canonical leaf) fetches the rich projection", async () => {
    await run(["profile", "basic", "show", "--full", "-o", "json"]);
    expect(mockedShowRich).toHaveBeenCalledTimes(1);
    expect(mockedBasicShow).not.toHaveBeenCalled();
  });

  it("`profile show` (no flag) uses the compact ProfileShow projection", async () => {
    await run(["profile", "show", "-o", "json"]);
    expect(mockedBasicShow).toHaveBeenCalledTimes(1);
    expect(mockedShowRich).not.toHaveBeenCalled();
  });

  it("`profile show --verbose` routes to #139 diagnostics, NOT the rich path", async () => {
    await run(["profile", "show", "--verbose", "-o", "json"]);
    // --verbose is the GLOBAL #139 flag: it enables the diagnostic logger and
    // leaves the command on the compact path. The rich fetch must not fire.
    expect(mockedSetDiagnosticLogger).toHaveBeenCalledWith("verbose");
    expect(mockedShowRich).not.toHaveBeenCalled();
    expect(mockedBasicShow).toHaveBeenCalledTimes(1);
  });
});
