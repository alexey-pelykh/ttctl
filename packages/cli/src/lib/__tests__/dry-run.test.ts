// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DRY_RUN_NO_OP_STDERR_NOTE,
  getCliDryRun,
  isMutationCommand,
  markMutation,
  resetCliDryRun,
  setCliDryRun,
} from "../dry-run.js";

afterEach(() => {
  // Defensive — module-scoped state must not bleed across tests.
  resetCliDryRun();
});

describe("getCliDryRun / setCliDryRun / resetCliDryRun (issue #52 module-scoped state)", () => {
  beforeEach(() => {
    resetCliDryRun();
  });

  it("returns false by default (no preAction hook fired)", () => {
    expect(getCliDryRun()).toBe(false);
  });

  it("captures `true` when set", () => {
    setCliDryRun(true);
    expect(getCliDryRun()).toBe(true);
  });

  it("captures `false` when set (apply-path default)", () => {
    setCliDryRun(true);
    setCliDryRun(false);
    expect(getCliDryRun()).toBe(false);
  });

  it("resets to `false` via resetCliDryRun (test-isolation contract)", () => {
    setCliDryRun(true);
    resetCliDryRun();
    expect(getCliDryRun()).toBe(false);
  });
});

describe("markMutation / isMutationCommand (Symbol-keyed Command tagging)", () => {
  it("returns false for an untagged Command (the read-no-op default)", () => {
    const cmd = new Command("show");
    expect(isMutationCommand(cmd)).toBe(false);
  });

  it("returns true for a Command tagged via markMutation", () => {
    const cmd = new Command("update");
    markMutation(cmd);
    expect(isMutationCommand(cmd)).toBe(true);
  });

  it("markMutation returns the same Command instance (chaining)", () => {
    const cmd = new Command("update");
    const result = markMutation(cmd);
    expect(result).toBe(cmd);
  });

  it("tag is set on the Command instance, not its prototype (sibling commands stay unmarked)", () => {
    const tagged = new Command("update");
    markMutation(tagged);
    const sibling = new Command("show");
    expect(isMutationCommand(sibling)).toBe(false);
  });

  it("tag survives Commander mutations (description, options, etc.)", () => {
    const cmd = markMutation(new Command("update"));
    cmd.description("Update profile fields");
    cmd.option("--bio <text>");
    expect(isMutationCommand(cmd)).toBe(true);
  });

  it("idempotent — re-marking is a no-op", () => {
    const cmd = new Command("update");
    markMutation(cmd);
    markMutation(cmd);
    expect(isMutationCommand(cmd)).toBe(true);
  });
});

describe("DRY_RUN_NO_OP_STDERR_NOTE (AC text contract)", () => {
  it("matches the AC-locked text verbatim (no-op for read commands)", () => {
    expect(DRY_RUN_NO_OP_STDERR_NOTE).toBe("note: `--dry-run` is a no-op for read commands\n");
  });

  it("ends with a newline so callers can pass it directly to process.stderr.write", () => {
    expect(DRY_RUN_NO_OP_STDERR_NOTE.endsWith("\n")).toBe(true);
  });
});
