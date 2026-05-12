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

const TOOL_NAME = "ttctl_profile_skills_list";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register `ttctl_profile_skills_list`. Returns every skill on the
 * signed-in user's profile, with rating / experience / visibility /
 * connection-count summary. Resolves the user's `profileId` internally
 * via `profile.basic.show()` — no input required from the caller.
 *
 * Dry-run path (issue #165): accepts `dryRun?: boolean`; emits the
 * uniform envelope previewing
 * `getSkillSetsWithConnectionsWithConnectionsCount` against the
 * talent-profile surface. `profileId` carries the placeholder because
 * the apply path resolves it via a sibling profile read.
 */
export function registerProfileSkillsListTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "List profile skills",
      description: [
        "List every skill on the signed-in user's Toptal profile, with rating / experience / visibility / connection-count for each.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "What skills do I have on my Toptal profile?"',
        '  - "List my Toptal skills with their ratings."',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "getSkillSetsWithConnectionsWithConnectionsCount",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }

      try {
        const profilePayload = await profile.basic.show(auth.token);
        const profileId = profilePayload.viewer?.viewerRole.profileId;
        if (profileId === undefined) {
          return domainErrorResponse(TOOL_NAME, {
            code: "NO_VIEWER",
            message: "No profile id bound to this session.",
          });
        }
        const skills = await profile.skills.list(auth.token, profileId);
        return jsonResponse(skills);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.skills.SkillsError || err instanceof profile.basic.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
