// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerProfileBasicPhotoShowTool } from "./profile_basic_photo_show.js";
import { registerProfileBasicPhotoUploadTool } from "./profile_basic_photo_upload.js";
import { registerProfileBasicShowTool } from "./profile_basic_show.js";
import { registerProfileBasicUpdateTool } from "./profile_basic_update.js";
import { registerProfileSkillsAddTool } from "./profile_skills_add.js";
import { registerProfileSkillsAutocompleteTool } from "./profile_skills_autocomplete.js";
import { registerProfileSkillsListTool } from "./profile_skills_list.js";
import { registerProfileSkillsReadinessTool } from "./profile_skills_readiness.js";
import { registerProfileSkillsRemoveTool } from "./profile_skills_remove.js";
import { registerProfileSkillsShowTool } from "./profile_skills_show.js";
import { registerProfileSkillsUpdateTool } from "./profile_skills_update.js";
import { registerPortfolioTools } from "./profile/portfolio.js";
import { registerResumeTools } from "./profile/resume.js";
import { registerVisasTools } from "./profile/visas.js";

/**
 * Register every tool TTCtl exposes via MCP. Called once at server
 * construction time. Tool names are the CLI path joined with `_`
 * (`ttctl_profile_basic_show`, `ttctl_profile_skills_add`, …) per
 * project policy — MCP names use ONLY the canonical sub-domain spelling
 * (no aliases like `certs` / `experience` / `rm`; those are CLI-only
 * affordances).
 *
 * Today's surface (issue #73, Wave 3): 4 `profile.basic` tools + 7
 * `profile.skills` tools = 11 tools. Sister bundles #74 / #75 / #76 add
 * more tools when their sub-domains land.
 */
export function registerAllTools(server: McpServer): void {
  // profile.basic — 4 leaves
  registerProfileBasicShowTool(server);
  registerProfileBasicUpdateTool(server);
  registerProfileBasicPhotoShowTool(server);
  registerProfileBasicPhotoUploadTool(server);

  // profile.skills — 7 leaves (cardinality-collapsed from 18 raw operations)
  registerProfileSkillsAddTool(server);
  registerProfileSkillsRemoveTool(server);
  registerProfileSkillsUpdateTool(server);
  registerProfileSkillsShowTool(server);
  registerProfileSkillsListTool(server);
  registerProfileSkillsAutocompleteTool(server);
  registerProfileSkillsReadinessTool(server);

  // profile.portfolio (7), profile.visas (4), profile.resume (2) — #75
  registerPortfolioTools(server);
  registerVisasTools(server);
  registerResumeTools(server);
}
