// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { buildProfileCertificationsCommand } from "../certifications/index.js";
import { buildProfileEmploymentCommand } from "../employment/index.js";
import { buildProfileCommand } from "../index.js";
import { buildProfilePortfolioCommand } from "../portfolio/index.js";
import { buildProfileResumeCommand } from "../resume/index.js";

/**
 * Tests for the per-sub-domain CLI aliases declared by issue #72:
 *
 * | Canonical        | Alias        | Implementation lands in |
 * |------------------|--------------|-------------------------|
 * | `certifications` | `certs`      | #74                     |
 * | `employment`     | `experience` | #74                     |
 * | `portfolio`      | `projects`   | #75                     |
 * | `resume`         | `cv`         | #75                     |
 *
 * Aliases are CLI-only by project policy (see issue #72) — MCP tool names
 * use ONLY the canonical name. These tests verify two things:
 *   1. Each sub-domain builder declares the right canonical name and alias
 *      via Commander.js `.alias()`.
 *   2. The profile command tree (`buildProfileCommand`) wires each
 *      sub-domain so the alias is reachable as a subcommand at parse time.
 *
 * The bare commands carry no operations yet — those land in #74/#75.
 */

function findSubcommand(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name);
}

interface AliasCase {
  canonical: string;
  alias: string;
  build: () => Command;
}

const aliasCases: AliasCase[] = [
  { canonical: "certifications", alias: "certs", build: buildProfileCertificationsCommand },
  { canonical: "employment", alias: "experience", build: buildProfileEmploymentCommand },
  { canonical: "portfolio", alias: "projects", build: buildProfilePortfolioCommand },
  { canonical: "resume", alias: "cv", build: buildProfileResumeCommand },
];

describe("profile sub-domain aliases (per issue #72)", () => {
  for (const { canonical, alias, build } of aliasCases) {
    describe(`${canonical} (alias: ${alias})`, () => {
      it(`returns a Command named \`${canonical}\``, () => {
        const cmd = build();
        expect(cmd.name()).toBe(canonical);
      });

      it(`declares \`${alias}\` as a Commander.js alias`, () => {
        const cmd = build();
        expect(cmd.aliases()).toContain(alias);
      });

      it("has a description (so --help is informative even before operations land)", () => {
        const cmd = build();
        expect(cmd.description()).toBeTruthy();
      });
    });
  }
});

describe("buildProfileCommand (sub-domain wiring + alias reachability)", () => {
  for (const { canonical, alias } of aliasCases) {
    it(`wires \`${canonical}\` so it is reachable by canonical name`, () => {
      const profile = buildProfileCommand();
      const sub = findSubcommand(profile, canonical);
      expect(sub).toBeDefined();
      expect(sub?.name()).toBe(canonical);
    });

    it(`exposes \`${alias}\` as an alias on the wired \`${canonical}\` sub-command`, () => {
      const profile = buildProfileCommand();
      const sub = findSubcommand(profile, canonical);
      expect(sub?.aliases()).toContain(alias);
    });
  }
});
