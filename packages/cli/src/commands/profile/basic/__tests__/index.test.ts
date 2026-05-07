// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { buildProfileBasicCommand } from "../index.js";
import { buildProfileCommand } from "../../index.js";

/**
 * Tests for the profile command-tree wiring: top-level shortcuts (`show`,
 * `update`) AND the canonical `basic` sub-tree (`basic show`, `basic
 * update`). The profile shape is a hybrid of canonical + alias surfaces —
 * see `buildProfileCommand` doc for the rationale on preserving the
 * wave-0 short forms.
 *
 * Note: this file lives under `basic/__tests__/` (not `profile/__tests__/`)
 * because the AC of #69 dictated relocating the original combined
 * `cli/src/__tests__/profile.test.ts` into `cli/src/commands/profile/basic/__tests__/*.test.ts`
 * — the basic sub-tree is the only sub-tree with operations today and
 * acts as the natural home for the command-tree wiring tests.
 */

function findSubcommand(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name);
}

describe("buildProfileCommand (top-level shortcuts)", () => {
  it("registers a `show` shortcut at the profile level (alias for `profile basic show`)", () => {
    const cmd = buildProfileCommand();
    const show = findSubcommand(cmd, "show");

    expect(show).toBeDefined();
    expect(show?.description()).toMatch(/profile/i);
    const outputOption = show?.options.find((o) => o.long === "--output");
    expect(outputOption).toBeDefined();
    expect(outputOption?.short).toBe("-o");
  });

  it("limits --output choices to text|json|table and defaults to text on the show shortcut", () => {
    const cmd = buildProfileCommand();
    const show = findSubcommand(cmd, "show");
    const outputOption = show?.options.find((o) => o.long === "--output");

    expect(outputOption?.argChoices).toEqual(["text", "json", "table"]);
    expect(outputOption?.defaultValue).toBe("text");
  });

  it("rejects unknown output formats on the show shortcut", () => {
    const cmd = buildProfileCommand();
    cmd.exitOverride();
    expect(() => {
      cmd.parse(["show", "-o", "yaml"], { from: "user" });
    }).toThrow();
  });

  it("registers an `update` shortcut alongside `show`", () => {
    const cmd = buildProfileCommand();
    const update = findSubcommand(cmd, "update");
    expect(update).toBeDefined();
    expect(update?.description()).toMatch(/update/i);
  });

  it("registers --bio, --headline, and -o on the update shortcut", () => {
    const cmd = buildProfileCommand();
    const update = findSubcommand(cmd, "update");

    const bioOption = update?.options.find((o) => o.long === "--bio");
    const headlineOption = update?.options.find((o) => o.long === "--headline");
    const outputOption = update?.options.find((o) => o.long === "--output");

    expect(bioOption).toBeDefined();
    expect(headlineOption).toBeDefined();
    expect(outputOption).toBeDefined();
    expect(outputOption?.argChoices).toEqual(["text", "json", "table"]);
  });

  it("parses --bio and --headline values from argv into the action options on the update shortcut", () => {
    const cmd = buildProfileCommand();
    cmd.exitOverride();

    let captured: { bio?: string; headline?: string; output?: string } = {};
    const update = findSubcommand(cmd, "update");
    update?.action(async (opts: { bio?: string; headline?: string; output: string }) => {
      captured = opts;
      return Promise.resolve();
    });

    cmd.parse(["update", "--bio", "test bio", "--headline", "test headline"], { from: "user" });

    expect(captured.bio).toBe("test bio");
    expect(captured.headline).toBe("test headline");
  });
});

describe("buildProfileCommand (canonical `basic` sub-tree)", () => {
  it("registers a `basic` sub-command on the profile root", () => {
    const cmd = buildProfileCommand();
    const basic = findSubcommand(cmd, "basic");
    expect(basic).toBeDefined();
    expect(basic?.description()).toMatch(/basic-info/i);
  });

  it("exposes `show` and `update` as sub-commands of `basic`", () => {
    const cmd = buildProfileCommand();
    const basic = findSubcommand(cmd, "basic");
    expect(basic).toBeDefined();
    if (basic === undefined) return;

    const basicShow = findSubcommand(basic, "show");
    const basicUpdate = findSubcommand(basic, "update");
    expect(basicShow).toBeDefined();
    expect(basicUpdate).toBeDefined();
  });

  it("registers --output on `basic show` with the same choices as the shortcut", () => {
    const cmd = buildProfileCommand();
    const basic = findSubcommand(cmd, "basic");
    const basicShow = basic ? findSubcommand(basic, "show") : undefined;
    const outputOption = basicShow?.options.find((o) => o.long === "--output");

    expect(outputOption).toBeDefined();
    expect(outputOption?.argChoices).toEqual(["text", "json", "table"]);
    expect(outputOption?.defaultValue).toBe("text");
  });

  it("registers --bio, --headline, --output on `basic update`", () => {
    const cmd = buildProfileCommand();
    const basic = findSubcommand(cmd, "basic");
    const basicUpdate = basic ? findSubcommand(basic, "update") : undefined;

    const bioOption = basicUpdate?.options.find((o) => o.long === "--bio");
    const headlineOption = basicUpdate?.options.find((o) => o.long === "--headline");
    const outputOption = basicUpdate?.options.find((o) => o.long === "--output");

    expect(bioOption).toBeDefined();
    expect(headlineOption).toBeDefined();
    expect(outputOption).toBeDefined();
    expect(outputOption?.argChoices).toEqual(["text", "json", "table"]);
  });
});

describe("buildProfileBasicCommand (standalone)", () => {
  it("returns a Command named `basic` with `show` and `update` sub-commands", () => {
    const basic = buildProfileBasicCommand();
    expect(basic.name()).toBe("basic");

    const show = findSubcommand(basic, "show");
    const update = findSubcommand(basic, "update");
    expect(show).toBeDefined();
    expect(update).toBeDefined();
  });
});
