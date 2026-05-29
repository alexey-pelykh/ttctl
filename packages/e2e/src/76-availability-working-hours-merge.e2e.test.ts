// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Regression guard for #608 — `availability.workingHours.set` must
 * preserve unsent snap fields across a partial update. Sibling to
 * #604/#605/#607. Mutates one field, restores in `finally`.
 */

// e2e-covers: UpdateWorkingHours

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, availability } from "@ttctl/core";
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

describe("availability workingHours.set — snap-field preservation", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)("preserves unsent snap fields across a partial workingTimeFrom-only update", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    const before = await availability.workingHours.show(token);

    if (
      before.timeZone === null ||
      before.workingTimeFrom === null ||
      before.workingTimeTo === null ||
      before.availableShiftRangeFrom === null ||
      before.availableShiftRangeTo === null
    ) {
      process.stderr.write("[76-availability-working-hours-merge] one or more snap fields null — skipped.\n");
      return;
    }

    const originalWorkingTimeFrom = before.workingTimeFrom;
    const probeWorkingTimeFrom = originalWorkingTimeFrom === "09:01:00" ? "09:02:00" : "09:01:00";

    try {
      await availability.workingHours.set(token, { workingTimeFrom: probeWorkingTimeFrom });

      const after = await availability.workingHours.show(token);
      expect(after.workingTimeFrom).toBe(probeWorkingTimeFrom);
      expect(after.timeZone?.value).toBe(before.timeZone.value);
      expect(after.workingTimeTo).toBe(before.workingTimeTo);
      expect(after.availableShiftRangeFrom).toBe(before.availableShiftRangeFrom);
      expect(after.availableShiftRangeTo).toBe(before.availableShiftRangeTo);
    } finally {
      await availability.workingHours.set(token, { workingTimeFrom: originalWorkingTimeFrom });
    }
  });
});
