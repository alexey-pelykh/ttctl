// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { buildProfileCommand } from "../index.js";
import { buildProfileCertificationsCommand } from "../certifications/index.js";
import { buildProfileEducationCommand } from "../education/index.js";
import { buildProfileEmploymentCommand } from "../employment/index.js";
import { buildProfileIndustriesCommand } from "../industries/index.js";

/**
 * Tests for the four sub-domain CLI command trees landing in #74.
 *
 * Each sub-domain registers a fixed set of leaves with specific verbs and
 * required/optional flags. These tests verify the COMMANDER-LEVEL shape:
 * commands exist, required flags are required, optional flags are optional,
 * `-o/--output` only allows the documented format choices.
 *
 * The actions themselves dispatch to `@ttctl/core` and are covered by the
 * core service tests; this file exercises the CLI surface contract only.
 */

function findSubcommand(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name);
}

describe("buildProfileEducationCommand (5 leaves)", () => {
  const cmd = buildProfileEducationCommand();

  it("registers add / update / remove / show / highlight", () => {
    expect(findSubcommand(cmd, "add")).toBeDefined();
    expect(findSubcommand(cmd, "update")).toBeDefined();
    expect(findSubcommand(cmd, "remove")).toBeDefined();
    expect(findSubcommand(cmd, "show")).toBeDefined();
    expect(findSubcommand(cmd, "highlight")).toBeDefined();
  });

  it("add requires --institution and --degree", () => {
    const add = findSubcommand(cmd, "add");
    const opts = add?.options ?? [];
    const inst = opts.find((o) => o.long === "--institution");
    const degree = opts.find((o) => o.long === "--degree");
    expect(inst?.required).toBe(true);
    expect(degree?.required).toBe(true);
  });

  it("show declares -o/--output with text|json|table", () => {
    const show = findSubcommand(cmd, "show");
    const out = show?.options.find((o) => o.long === "--output");
    expect(out).toBeDefined();
    expect(out?.argChoices).toEqual(["text", "json", "table"]);
  });
});

describe("buildProfileCertificationsCommand (5 leaves + `certs` alias)", () => {
  const cmd = buildProfileCertificationsCommand();

  it("preserves the `certs` alias from #72", () => {
    expect(cmd.aliases()).toContain("certs");
  });

  it("registers add / update / remove / show / highlight", () => {
    expect(findSubcommand(cmd, "add")).toBeDefined();
    expect(findSubcommand(cmd, "update")).toBeDefined();
    expect(findSubcommand(cmd, "remove")).toBeDefined();
    expect(findSubcommand(cmd, "show")).toBeDefined();
    expect(findSubcommand(cmd, "highlight")).toBeDefined();
  });

  it("add requires --name and --issuer", () => {
    const add = findSubcommand(cmd, "add");
    const opts = add?.options ?? [];
    expect(opts.find((o) => o.long === "--name")?.required).toBe(true);
    expect(opts.find((o) => o.long === "--issuer")?.required).toBe(true);
  });
});

describe("buildProfileEmploymentCommand (6 leaves + `experience` alias)", () => {
  const cmd = buildProfileEmploymentCommand();

  it("preserves the `experience` alias from #72", () => {
    expect(cmd.aliases()).toContain("experience");
  });

  it("registers add / update / remove / show / highlight / employer-autocomplete", () => {
    expect(findSubcommand(cmd, "add")).toBeDefined();
    expect(findSubcommand(cmd, "update")).toBeDefined();
    expect(findSubcommand(cmd, "remove")).toBeDefined();
    expect(findSubcommand(cmd, "show")).toBeDefined();
    expect(findSubcommand(cmd, "highlight")).toBeDefined();
    expect(findSubcommand(cmd, "employer-autocomplete")).toBeDefined();
  });

  it("add requires --company and --role", () => {
    const add = findSubcommand(cmd, "add");
    const opts = add?.options ?? [];
    expect(opts.find((o) => o.long === "--company")?.required).toBe(true);
    expect(opts.find((o) => o.long === "--role")?.required).toBe(true);
  });

  it("update accepts --description (free-text) and --edit", () => {
    const update = findSubcommand(cmd, "update");
    expect(update?.options.find((o) => o.long === "--description")).toBeDefined();
    expect(update?.options.find((o) => o.long === "--edit")).toBeDefined();
  });
});

describe("buildProfileIndustriesCommand (5 leaves)", () => {
  const cmd = buildProfileIndustriesCommand();

  it("registers add / update / remove / list / autocomplete", () => {
    expect(findSubcommand(cmd, "add")).toBeDefined();
    expect(findSubcommand(cmd, "update")).toBeDefined();
    expect(findSubcommand(cmd, "remove")).toBeDefined();
    expect(findSubcommand(cmd, "list")).toBeDefined();
    expect(findSubcommand(cmd, "autocomplete")).toBeDefined();
  });

  it("add takes <name> as a positional argument and optional --connection", () => {
    const add = findSubcommand(cmd, "add");
    expect(add).toBeDefined();
    // Positional <name> is mandatory (Commander captures it via .argument)
    const required = add?.registeredArguments.filter((a) => a.required) ?? [];
    expect(required.length).toBeGreaterThanOrEqual(1);
    expect(add?.options.find((o) => o.long === "--connection")).toBeDefined();
  });
});

describe("buildProfileCommand wires all four wave-3 sub-domains", () => {
  const profile = buildProfileCommand();

  it("registers `industries`", () => {
    expect(findSubcommand(profile, "industries")).toBeDefined();
  });
  it("registers `education`", () => {
    expect(findSubcommand(profile, "education")).toBeDefined();
  });
  it("registers `certifications` with `certs` alias", () => {
    const certs = findSubcommand(profile, "certifications");
    expect(certs).toBeDefined();
    expect(certs?.aliases()).toContain("certs");
  });
  it("registers `employment` with `experience` alias", () => {
    const emp = findSubcommand(profile, "employment");
    expect(emp).toBeDefined();
    expect(emp?.aliases()).toContain("experience");
  });
});
