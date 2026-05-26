// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E for `removeProfileSkillSetConnection` (#463). Always-on: dry-run
 * + consent-missing (zero-wire). Gated DESTRUCTIVE positive path:
 * `TTCTL_E2E_REMOVE_SKILL_CONNECTION=<skillSetId>:<connectionId>` —
 * captures the T1 wire-shape snapshot. Schema/contract rule satisfied
 * per CLAUDE.md (op is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`).
 */

// e2e-covers: removeProfileSkillSetConnection

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

// Format: `<skillSetId>:<connectionId>`. The connection must be currently
// linked to the skill-set (discover via `ttctl profile skills show`).
const removeSkillConnectionFixture = process.env["TTCTL_E2E_REMOVE_SKILL_CONNECTION"];

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

interface ParsedFixture {
  skillSetId: string;
  connectionId: string;
}

function parseFixture(raw: string): ParsedFixture {
  const parts = raw.split(":");
  if (parts.length !== 2) {
    throw new Error(`TTCTL_E2E_REMOVE_SKILL_CONNECTION must be "<skillSetId>:<connectionId>" (got: ${raw}).`);
  }
  const [skillSetId, connectionId] = parts as [string, string];
  return { skillSetId, connectionId };
}

describe("profile skills remove-connection (live talent-profile, #463)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  // ---------------------------------------------------------------------
  // Always-on paths
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)(
    "--dry-run emits the removeProfileSkillSetConnection preview envelope and makes no wire call",
    async () => {
      const result = await cli.run([
        "--dry-run",
        "profile",
        "skills",
        "remove-connection",
        "--skill-set-id",
        "V1-ProfileSkillSet-fake-dry-run",
        "--connection-id",
        "V1-Employment-fake-dry-run",
        "--consent-profile-capability",
        "-o",
        "json",
      ]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        version?: string;
        dryRun?: boolean;
        operation?: string;
        preview?: {
          operationName?: string;
          surface?: string;
          transport?: string;
          variables?: { input?: Record<string, unknown> };
          headers?: Record<string, string>;
        };
      };
      expect(payload.ok).toBe(true);
      expect(payload.version).toBe("1.0");
      expect(payload.dryRun).toBe(true);
      expect(payload.operation).toBe("profile.skills.remove-connection");
      expect(payload.preview?.operationName).toBe("removeProfileSkillSetConnection");
      expect(payload.preview?.surface).toBe("talent-profile");
      expect(payload.preview?.transport).toBe("impersonated");
      // CAPTURED wire shape: exactly two fields. NO `connectionType`.
      expect(payload.preview?.variables?.input).toEqual({
        skillSetId: "V1-ProfileSkillSet-fake-dry-run",
        connectionId: "V1-Employment-fake-dry-run",
      });
      expect(payload.preview?.headers?.["authorization"]).toBe("Token token=<redacted>");
    },
  );

  it.skipIf(!e2eEnabled)(
    "consent-missing refusal: omitting --consent-profile-capability emits CONSENT_REQUIRED and makes NO wire call",
    async () => {
      const result = await cli.run([
        "profile",
        "skills",
        "remove-connection",
        "--skill-set-id",
        "V1-ProfileSkillSet-fake-no-wire",
        "--connection-id",
        "V1-Employment-fake-no-wire",
        "-o",
        "json",
      ]);
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        errors?: { code?: string; message?: string; hint?: string }[];
      };
      expect(payload.ok).toBe(false);
      expect(payload.operation).toBe("profile.skills.remove-connection");
      expect(payload.errors?.[0]?.code).toBe("CONSENT_REQUIRED");
      expect(payload.errors?.[0]?.hint).toMatch(/consent/i);
    },
  );

  // ---------------------------------------------------------------------
  // Gated DESTRUCTIVE positive path — only runs with the operator opt-in.
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled || removeSkillConnectionFixture === undefined)(
    "unlinks the supplied connection from the skill-set and captures the wire-shape snapshot",
    async () => {
      if (removeSkillConnectionFixture === undefined) {
        throw new Error("unreachable: skipIf guarantees fixture is defined");
      }
      const fixture = parseFixture(removeSkillConnectionFixture);
      const token = loadSandboxBearer(sandboxConfigPath);

      const preShow = await profile.skills.show(token, fixture.skillSetId);
      const preCount = preShow.connectionsCount;

      const outcome = await profile.skills.removeConnection(
        token,
        { skillSetId: fixture.skillSetId, connectionId: fixture.connectionId },
        { profileCapabilityConsentIssued: true },
      );

      expect(outcome.kind).toBe("applied");
      if (outcome.kind !== "applied") throw new Error("unreachable");
      expect(outcome.result.skillSetId).toBe(fixture.skillSetId);
      expect(outcome.result.connectionIds).not.toContain(fixture.connectionId);
      expect(outcome.result.connectionsCount).toBe(preCount - 1);

      assertWireShapeStable({
        operationName: "removeProfileSkillSetConnection",
        surface: "talent-profile",
        transport: "impersonated",
        response: outcome.result,
      });

      const basic = await profile.basic.show(token);
      const profileId = basic.viewer?.viewerRole.profile?.id;
      if (profileId === undefined) throw new Error("Cannot extract profileId from basic.show response.");
      const all = await profile.skills.list(token, profileId);
      const matching = all.find((s) => s.id === fixture.skillSetId);
      expect(matching?.connectionsCount).toBe(outcome.result.connectionsCount);
    },
  );
});
