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

const TOOL_NAME = "ttctl_profile_skills_remove_connection";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Per-edge unlink sibling of `ttctl_profile_skills_add_connection`
 * (#463). T1 disposition; wire input is `{ skillSetId, connectionId }`
 * (no `connectionType` — server discriminates from the Relay id).
 */
export function registerProfileSkillsRemoveConnectionTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Unlink a profile skill from an employment/education/certification/portfolio row (DESTRUCTIVE)",
      description: [
        "Unlink a single connection from a `ProfileSkillSet` via the `removeProfileSkillSetConnection` mutation. Removes the recruiter-visible skill→entity edge without removing the whole skill-set; for cascading removal use `ttctl_profile_skills_remove`.",
        "",
        "**DESTRUCTIVE**: this removes a recruiter-visible skill→entity connection from your public profile. Re-link via `ttctl_profile_skills_add_connection`.",
        "",
        "**Consent gate** (ADR-009 (ttctl) — `profile-capability` domain): the caller MUST set `profileCapabilityConsentIssued: true`. Auto-filling without explicit user direction is FORBIDDEN.",
        "",
        "**Pre-flight discovery** (list tools return the base64-encoded Relay node id — pass it through verbatim):",
        "  - `ttctl_profile_skills_list` → skillSetId (encodes `V1-ProfileSkillSet-NNN`)",
        "  - `ttctl_profile_skills_show` → connectionId from the skill-set's current `connections.nodes[].id` array",
        "",
        "**Post-unlink verification**: `ttctl_profile_skills_show` returns the affected skill-set with `connectionsCount` decremented; this tool's own response carries the remaining `connectionIds[]` list (the just-unlinked id is absent).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Unlink my TypeScript skill from my Acme employment."',
        '  - "Remove the link between my React skill and portfolio item portfolio-abc123."',
        '  - "Disconnect my Python skill from my MIT education entry."',
      ].join("\n"),
      inputSchema: {
        skillSetId: z
          .string()
          .min(1)
          .describe(
            "ProfileSkillSet id — base64-encoded Relay node id from `ttctl_profile_skills_list` (encodes `V1-ProfileSkillSet-NNN`); the decoded form is also accepted. NOT the catalog Skill id.",
          ),
        connectionId: z
          .string()
          .min(1)
          .describe(
            "Connection node id currently linked to the skill-set — the base64-encoded Relay node id from `ttctl_profile_skills_show` (the read-side `connections.nodes[].id` array). The decoded `V1-{Type}-NNN` form is also accepted.",
          ),
        profileCapabilityConsentIssued: z
          .literal(true)
          .describe(
            "REQUIRED — MUST be `true`. Acknowledges this removes a recruiter-visible skill→entity link from the public profile. See ADR-009 (ttctl) § Decision Part 1 for the per-domain consent vocabulary.",
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

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "removeProfileSkillSetConnection",
            "talent-profile",
            {
              input: {
                skillSetId: input.skillSetId,
                connectionId: input.connectionId,
              },
            },
            auth.token,
          ),
        );
      }

      try {
        const outcome = await profile.skills.removeConnection(
          auth.token,
          {
            skillSetId: input.skillSetId,
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
