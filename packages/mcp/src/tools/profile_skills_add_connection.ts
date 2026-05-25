// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import {
  buildMcpDryRunPreview,
  domainErrorResponse,
  dryRunResponse,
  genericErrorResponse,
  isToolErrorResponse,
  jsonResponse,
  type ToolRegistrationContext,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_skills_add_connection";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the `ttctl_profile_skills_add_connection` MCP tool (#462).
 * Mirrors the `ttctl profile skills add-connection` CLI leaf — links an
 * existing `ProfileSkillSet` to one of the talent's
 * employment / education / certification / portfolio rows via the
 * `addProfileSkillSetConnection` Pattern-6 mutation on the talent-profile
 * surface (Cloudflare-protected, impersonated transport).
 *
 * **DESTRUCTIVE** (recruiter-visible state change): writes a new
 * skill→entity link onto the public profile. The reverse op
 * (`removeProfileSkillSetConnection`) exists on the wire but is NOT
 * wired in TTCtl yet — undo via `ttctl_profile_skills_remove` (whole
 * skill-set deletion cascades the connections server-side).
 *
 * **Consent gate** (ADR-009 (ttctl) — `profile-capability` domain): the
 * tool requires `profileCapabilityConsentIssued: true` on input. The
 * Zod schema enforces the literal at validation time; the service-layer
 * runtime gate is a defense-in-depth layer covering `as`-cast bypasses.
 * The `destructiveHint: true` MCP annotation signals to the MCP host
 * that this tool effects irreversible-by-default state (Claude Desktop
 * and similar hosts surface a confirmation prompt).
 *
 * **Wire shape** (T1 disposition per `docs/wire-validation-routing.md`):
 * the op is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS` so no codegen type
 * exists. The committed snapshot at
 * `packages/e2e/src/wire-snapshots/addProfileSkillSetConnection.snapshot.json`
 * (captured on the gated `TTCTL_E2E_ADD_SKILL_CONNECTION=…` run) is the
 * wire-shape authority.
 *
 * **Write-read symmetry**: post-link state surfaces on the next
 * `ttctl_profile_skills_show` (the skill-set's `connectionsCount`
 * increments by 1) and `ttctl_profile_skills_list` (same count on the
 * matching skill-set node) — the connection ids are also returned
 * directly in this tool's response (`connectionIds[]`).
 */
export function registerProfileSkillsAddConnectionTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Link a profile skill to an employment/education/certification/portfolio row (DESTRUCTIVE)",
      description: [
        "Link an existing `ProfileSkillSet` to one of your employment, education, certification, or portfolio rows via the `addProfileSkillSetConnection` Pattern-6 mutation. The link surfaces on your recruiter-visible public profile.",
        "",
        "**DESTRUCTIVE**: this writes a new skill→entity connection onto your public profile. The per-edge unlink op (`removeProfileSkillSetConnection`) is not wired in TTCtl — undo via `ttctl_profile_skills_remove` (whole skill-set removal cascades the connections server-side).",
        "",
        "**Consent gate** (ADR-009 (ttctl) — `profile-capability` domain): the caller MUST set `profileCapabilityConsentIssued: true`. Auto-filling without explicit user direction is FORBIDDEN.",
        "",
        "**Pre-flight discovery**:",
        "  - `ttctl_profile_skills_list` → skillSetId (V1-ProfileSkillSet-NNN)",
        "  - `ttctl_profile_employment_list` → V1-Employment-NNN (use connectionType=EMPLOYMENT)",
        "  - `ttctl_profile_education_list` → V1-Education-NNN (use connectionType=EDUCATION)",
        "  - `ttctl_profile_certifications_list` → V1-Certification-NNN (use connectionType=CERTIFICATION)",
        "  - `ttctl_profile_portfolio_list` → V1-PortfolioItem-NNN (use connectionType=PORTFOLIO_ITEM)",
        "",
        "**Post-link verification**: `ttctl_profile_skills_show` returns the affected skill-set with `connectionsCount` incremented; this tool's own response carries the full `connectionIds[]` list including the just-added id.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Link my TypeScript skill to my Acme employment."',
        '  - "Tag my React skill to portfolio item portfolio-abc123."',
        '  - "Add my Python skill to my MIT education entry."',
      ].join("\n"),
      inputSchema: {
        skillSetId: z
          .string()
          .min(1)
          .describe(
            "ProfileSkillSet id (V1-ProfileSkillSet-NNN). Obtain via `ttctl_profile_skills_list`. NOT the catalog Skill id.",
          ),
        connectionType: z
          .enum([...profile.skills.SKILL_CONNECTION_TYPES] as [
            profile.skills.SkillConnectionType,
            ...profile.skills.SkillConnectionType[],
          ])
          .describe(
            "Target row class — must match the connectionId's entity type. EMPLOYMENT → V1-Employment-NNN, EDUCATION → V1-Education-NNN, CERTIFICATION → V1-Certification-NNN, PORTFOLIO_ITEM → V1-PortfolioItem-NNN.",
          ),
        connectionId: z
          .string()
          .min(1)
          .describe(
            "Target row id of the matching type — must be one of the talent's own entities. Use the matching `*_list` tool for that domain to discover ids.",
          ),
        profileCapabilityConsentIssued: z
          .literal(true)
          .describe(
            "REQUIRED — MUST be `true`. Acknowledges this writes a recruiter-visible skill→entity link to the public profile. See ADR-009 (ttctl) § Decision Part 1 for the per-domain consent vocabulary.",
          ),
        dryRun: DRY_RUN_FIELD,
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      // Core's `addConnection()` supports its own dry-run short-circuit
      // (zero-network). Branch before the wire call so the consent gate
      // still fires first at the service layer.
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "addProfileSkillSetConnection",
            "talent-profile",
            {
              input: {
                skillSetId: input.skillSetId,
                connectionType: input.connectionType,
                connectionId: input.connectionId,
              },
            },
            auth.token,
          ),
        );
      }

      try {
        const outcome = await profile.skills.addConnection(
          auth.token,
          {
            skillSetId: input.skillSetId,
            connectionType: input.connectionType,
            connectionId: input.connectionId,
          },
          { profileCapabilityConsentIssued: input.profileCapabilityConsentIssued },
        );
        if (outcome.kind === "preview") {
          return dryRunResponse(outcome.preview);
        }
        return jsonResponse(outcome.result);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.skills.SkillsError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
