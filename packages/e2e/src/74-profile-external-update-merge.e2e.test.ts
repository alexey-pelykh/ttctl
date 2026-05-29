// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E verification of the `profile.external.update` wire contract (#606).
 * Mandatory per CLAUDE.md § Schema/contract validation rule (touches
 * `packages/core/src/services/profile/external/**`).
 *
 * Verifies external.update is PARTIAL-merge — changing one URL preserves the
 * others server-side, unlike its full-replacement siblings #604/#605/#394.
 * This is the deterministic one-at-a-time detector that 42-profile-external-
 * show's round-trip is not (42's preservation check is vacuous unless ≥2
 * writable URLs are set). No `assertWireShapeStable` — 42 owns the
 * UpdateExternalProfiles snapshot.
 *
 * Mutates the primary account's URLs; restores originals in `finally`. Only
 * originally-set writable fields are touched — null fields cannot be restored
 * via `update` (no null write). twitter (#526) is read-only, never written.
 */

// e2e-covers: UpdateExternalProfiles

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

// The five fields the live `ExternalProfilesInput` accepts (twitter excluded — #526).
const WRITABLE_URL_FIELDS = ["linkedin", "github", "website", "behance", "dribbble"] as const;

describe("profile external update — partial-merge verification", () => {
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    sandboxConfigPath = getSharedSession().sandboxConfigPath;
  });

  it.skipIf(!e2eEnabled)(
    "changing one URL preserves the OTHER writable URLs (external is partial-merge, not full-replace) (#606)",
    async () => {
      const token = loadSandboxBearer(sandboxConfigPath);
      const before = await profile.external.show(token);

      // Need ≥2 writable URLs set — an already-null omitted field can't reveal
      // full-replace nulling. Skip otherwise (42 covers the read side).
      const setWritable = WRITABLE_URL_FIELDS.filter((f) => typeof before[f] === "string" && before[f] !== "");
      if (setWritable.length < 2) {
        process.stderr.write(
          "[74-profile-external-update-merge] <2 writable external URLs set — partial-merge subtest skipped.\n",
        );
        return;
      }

      const updateField = setWritable[0];
      if (updateField === undefined) throw new Error("unreachable: setWritable.length >= 2");
      const originalUpdateValue = before[updateField];
      if (typeof originalUpdateValue !== "string") throw new Error("unreachable: setWritable holds string fields only");

      // A DISTINCT new value (re-applying the same value can't distinguish
      // partial-merge from a full-replace that no-ops on unchanged input).
      // Derived from the real URL so it stays valid and harmless if left behind.
      const sep = originalUpdateValue.includes("?") ? "&" : "?";
      const newValue = `${originalUpdateValue}${sep}e2e606=${Date.now().toString()}`;

      try {
        const updated = await profile.external.update(token, { [updateField]: newValue });
        expect(updated.profile.id).toBe(before.id);
        expect(updated.profile[updateField]).not.toBeNull();

        const after = await profile.external.show(token);
        expect(after[updateField]).not.toBeNull();
        for (const f of setWritable) {
          if (f === updateField) continue;
          expect(after[f]).toBe(before[f]);
        }
        expect(after.twitter).toBe(before.twitter);
      } finally {
        const restore: profile.external.ExternalProfilesUpdate = {};
        for (const f of WRITABLE_URL_FIELDS) {
          const v = before[f];
          if (typeof v === "string" && v !== "") restore[f] = v;
        }
        if (Object.keys(restore).length > 0) {
          await profile.external.update(token, restore);
        }
      }
    },
  );
});
