// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCertificationsTools } from "./profile/certifications.js";
import { registerEducationTools } from "./profile/education.js";
import { registerEmploymentTools } from "./profile/employment.js";
import { registerIndustriesTools } from "./profile/industries.js";
import { registerPortfolioTools } from "./profile/portfolio.js";
import { registerResumeTools } from "./profile/resume.js";
import { registerVisasTools } from "./profile/visas.js";
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

/**
 * Register every tool TTCtl exposes via MCP. Called once at server
 * construction time. Tool names are the CLI path joined with `_`
 * (`ttctl_profile_basic_show`, `ttctl_profile_industries_add`, …) per
 * project policy — MCP names use ONLY the canonical sub-domain spelling
 * (no aliases like `certs` / `experience` / `rm`; those are CLI-only
 * affordances).
 *
 * Today's surface (Wave 3): 4 `profile.basic` + 7 `profile.skills` (#73,
 * one tool per file) + 5 `profile.industries` + 5 `profile.education` +
 * 5 `profile.certifications` + 6 `profile.employment` (#74, one file per
 * sub-domain registering its full leaf set) + 8 `profile.portfolio` +
 * 4 `profile.visas` + 2 `profile.resume` (#75) = 45 tools. Sister bundle
 * #76 adds more tools when its sub-domains land.
 */
export function registerAllTools(server: McpServer): void {
  // profile.basic — 4 leaves (#73)
  registerProfileBasicShowTool(server);
  registerProfileBasicUpdateTool(server);
  registerProfileBasicPhotoShowTool(server);
  registerProfileBasicPhotoUploadTool(server);

  // profile.skills — 7 leaves (#73, cardinality-collapsed from 18 raw operations)
  registerProfileSkillsAddTool(server);
  registerProfileSkillsRemoveTool(server);
  registerProfileSkillsUpdateTool(server);
  registerProfileSkillsShowTool(server);
  registerProfileSkillsListTool(server);
  registerProfileSkillsAutocompleteTool(server);
  registerProfileSkillsReadinessTool(server);

  // profile.industries / education / certifications / employment — 21 leaves (#74)
  registerIndustriesTools(server);
  registerEducationTools(server);
  registerCertificationsTools(server);
  registerEmploymentTools(server);

  // profile.portfolio (8), profile.visas (4), profile.resume (2) — #75
  registerPortfolioTools(server);
  registerVisasTools(server);
  registerResumeTools(server);
}
