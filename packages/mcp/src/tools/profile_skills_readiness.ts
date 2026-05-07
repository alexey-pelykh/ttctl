// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import {
  domainErrorResponse,
  genericErrorResponse,
  isToolErrorResponse,
  jsonResponse,
  loadTokenForTool,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_skills_readiness";

export function registerProfileSkillsReadinessTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Show skill-readiness checklist",
      description: [
        "Fetch the signed-in user's skill-readiness checklist — the same heuristics the portal uses to gate the 'ready to apply' state on the skills section. Each boolean reflects a sub-criterion (expert proficiency count, items count, programming language present, etc.).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Are my Toptal skills complete enough?"',
        '  - "Tell me what\'s missing on my skills section."',
      ].join("\n"),
      inputSchema: {},
    },
    async () => {
      const auth = await loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      try {
        const profilePayload = await profile.basic.show(auth.token);
        const profileId = profilePayload.viewer?.viewerRole.profileId;
        if (profileId === undefined) {
          return domainErrorResponse(TOOL_NAME, {
            code: "NO_VIEWER",
            message: "No profile id bound to this session.",
          });
        }
        const readiness = await profile.skills.readiness(auth.token, profileId);
        return jsonResponse(readiness);
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
