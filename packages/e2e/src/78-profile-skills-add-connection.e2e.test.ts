// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile skills add-connection` (#462 — Pattern-6
 * `addProfileSkillSetConnection`).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** —
 * `addProfileSkillSetConnection` is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`
 * (`codegen.config.ts`); both the input shape (`AddProfileSkillSetConnectionInput`
 * — `{ _placeholder: String }` in the synthesized SDL) and the response
 * shape (`AddProfileSkillSetConnectionPayload` — `{ profile: Unknown,
 * skillSet: Unknown }`) are gappy. The live wire is the only authority
 * on the Pattern-6 input from `research/notes/10` § Pattern 6 and the
 * payload selection mirroring the sibling `GetSkillSetWithConnections`.
 *
 * Coverage:
 *
 *   - **Always-on**: dry-run preview (no wire call) + consent-missing
 *     refusal (no wire call). These pin the envelope shape, the
 *     consent-gate's `CONSENT_REQUIRED` code, the Pattern-6 wire input
 *     shape, and the operationName forwarding without touching real
 *     application state.
 *
 *   - **Gated DESTRUCTIVE positive path**: only runs when
 *     `TTCTL_E2E_ADD_SKILL_CONNECTION=<skillSetId>:<connectionType>:<connectionId>`
 *     is exported. The operator supplies a real
 *     `ProfileSkillSet` id + a matching entity id from their own
 *     profile (employment / education / certification / portfolio).
 *     Applying writes a new recruiter-visible link onto the public
 *     profile; the only undo via TTCtl is removing the whole skill-set
 *     (`profile skills rm` cascades the connections server-side).
 *     Only set the env var when you intend to actually link.
 *
 * **Wire-shape snapshot** (T1 per ADR-006 / `docs/wire-validation-routing.md`):
 * the gated positive path captures `addProfileSkillSetConnection.snapshot.json`
 * on first run with `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`; thereafter
 * `assertWireShapeStable(...)` runs on every `TTCTL_E2E=1` invocation
 * (gated by the env var — the snapshot can only be captured when the
 * operator opts into the destructive call).
 *
 * Disposition: **T1** (wire-shape snapshot). `addProfileSkillSetConnection`
 * is in the codegen-exclusion list, so no T2 Zod schema is generated;
 * `assertWireShapeStable` is the continuous wire-drift defense.
 */

// e2e-covers: addProfileSkillSetConnection

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, profile } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Operator opt-in for the DESTRUCTIVE positive path. Format:
 * `<skillSetId>:<connectionType>:<connectionId>`. Example:
 * `V1-ProfileSkillSet-12345:EMPLOYMENT:V1-Employment-67890`. The
 * skill-set and the entity row must both exist on the operator's profile.
 */
const addSkillConnectionFixture = process.env["TTCTL_E2E_ADD_SKILL_CONNECTION"];

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
  connectionType: profile.skills.SkillConnectionType;
  connectionId: string;
}

function parseFixture(raw: string): ParsedFixture {
  const parts = raw.split(":");
  if (parts.length !== 3) {
    throw new Error(
      `TTCTL_E2E_ADD_SKILL_CONNECTION must be "<skillSetId>:<connectionType>:<connectionId>" (got: ${raw}).`,
    );
  }
  const [skillSetId, connectionType, connectionId] = parts as [string, string, string];
  if (!profile.skills.SKILL_CONNECTION_TYPES.includes(connectionType as profile.skills.SkillConnectionType)) {
    throw new Error(
      `TTCTL_E2E_ADD_SKILL_CONNECTION connectionType must be one of: ${profile.skills.SKILL_CONNECTION_TYPES.join(", ")} (got: ${connectionType}).`,
    );
  }
  return {
    skillSetId,
    connectionType: connectionType as profile.skills.SkillConnectionType,
    connectionId,
  };
}

describe("profile skills add-connection (live talent-profile, #462)", () => {
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
    "--dry-run emits the addProfileSkillSetConnection preview envelope and makes no wire call",
    async () => {
      const result = await cli.run([
        "--dry-run",
        "profile",
        "skills",
        "add-connection",
        "--skill-set-id",
        "V1-ProfileSkillSet-fake-dry-run",
        "--connection-type",
        "EMPLOYMENT",
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
      expect(payload.operation).toBe("profile.skills.add-connection");
      expect(payload.preview?.operationName).toBe("addProfileSkillSetConnection");
      expect(payload.preview?.surface).toBe("talent-profile");
      expect(payload.preview?.transport).toBe("impersonated");
      expect(payload.preview?.variables?.input).toEqual({
        skillSetId: "V1-ProfileSkillSet-fake-dry-run",
        connectionType: "EMPLOYMENT",
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
        "add-connection",
        "--skill-set-id",
        "V1-ProfileSkillSet-fake-no-wire",
        "--connection-type",
        "EMPLOYMENT",
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
      expect(payload.operation).toBe("profile.skills.add-connection");
      expect(payload.errors?.[0]?.code).toBe("CONSENT_REQUIRED");
      expect(payload.errors?.[0]?.hint).toMatch(/consent/i);
    },
  );

  // ---------------------------------------------------------------------
  // Gated DESTRUCTIVE positive path — only runs with the operator opt-in.
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled || addSkillConnectionFixture === undefined)(
    "links a skill-set to the supplied entity row and captures the wire-shape snapshot",
    async () => {
      // `it.skipIf` ensures this branch only runs when the fixture is
      // defined; the explicit guard satisfies TypeScript's narrowing
      // without resorting to a non-null assertion.
      if (addSkillConnectionFixture === undefined) throw new Error("unreachable: skipIf guarantees fixture is defined");
      const fixture = parseFixture(addSkillConnectionFixture);
      const token = loadSandboxBearer(sandboxConfigPath);

      // Apply the link directly via the service. The CLI path is
      // verified in the always-on dry-run / consent-missing tests
      // above; the destructive positive path goes via the service so
      // the test can capture the structured response for the snapshot
      // assertion without an extra JSON parse.
      const outcome = await profile.skills.addConnection(
        token,
        {
          skillSetId: fixture.skillSetId,
          connectionType: fixture.connectionType,
          connectionId: fixture.connectionId,
        },
        { profileCapabilityConsentIssued: true },
      );

      expect(outcome.kind).toBe("applied");
      if (outcome.kind !== "applied") throw new Error("unreachable");
      expect(outcome.result.skillSetId).toBe(fixture.skillSetId);
      expect(outcome.result.connectionIds).toContain(fixture.connectionId);
      expect(outcome.result.connectionsCount).toBeGreaterThan(0);

      // T1 wire-shape snapshot — drift in the response shape surfaces
      // on every subsequent `TTCTL_E2E=1` run.
      assertWireShapeStable({
        operationName: "addProfileSkillSetConnection",
        surface: "talent-profile",
        transport: "impersonated",
        response: outcome.result,
      });

      // Write-read symmetry check: list() echoes the post-link count
      // on the matching skill-set node (the AC's explicit requirement).
      const basic = await profile.basic.show(token);
      const profileId = basic.viewer?.viewerRole.profile?.id;
      if (profileId === undefined) throw new Error("Cannot extract profileId from basic.show response.");
      const all = await profile.skills.list(token, profileId);
      const matching = all.find((s) => s.id === fixture.skillSetId);
      expect(matching?.connectionsCount).toBe(outcome.result.connectionsCount);
    },
  );
});
