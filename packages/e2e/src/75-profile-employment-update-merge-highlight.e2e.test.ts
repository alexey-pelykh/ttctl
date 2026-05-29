// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Regression guard for #607 — `profile.employment.update` must preserve
 * `highlight` across a partial update that omits it. Sibling to #487 /
 * #604; mandatory per CLAUDE.md § Schema/contract validation rule.
 * Mutates first employment row; restores in `finally`.
 */

// e2e-covers: UpdateEmployment, highlightEmployment

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getSharedSession } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("profile employment update — highlight preservation", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)("preserves current.highlight across a partial position-only update (#607)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const all = await profile.employment.list(token);
    if (all.length === 0) {
      process.stderr.write("[75-profile-employment-update-merge-highlight] no employment rows on account — skipped.\n");
      return;
    }

    const target = all[0];
    if (target === undefined) throw new Error("unreachable: all.length > 0");

    const originalPosition = target.position;
    const originalHighlight = target.highlight;

    if (originalHighlight !== true) {
      await profile.employment.highlight(token, target.id, true);
    }

    try {
      const beforeProbe = await profile.employment.show(token, target.id);
      expect(beforeProbe.highlight).toBe(true);

      const probePosition = `${originalPosition} (e2e607)`;
      await profile.employment.update(token, target.id, { position: probePosition });

      const afterProbe = await profile.employment.show(token, target.id);
      expect(afterProbe.highlight).toBe(true);
    } finally {
      await profile.employment.update(token, target.id, { position: originalPosition });
      await profile.employment.highlight(token, target.id, originalHighlight);
    }
  });
});
