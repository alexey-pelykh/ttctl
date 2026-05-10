// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolRegistrationContext } from "./_shared.js";
import { registerApplicationsTools } from "./applications.js";
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
import { registerProfileExternalAdvancedWizardShowTool } from "./profile_external_advanced_wizard_show.js";
import { registerProfileExternalCustomRequirementsSetTool } from "./profile_external_custom_requirements_set.js";
import { registerProfileExternalCustomRequirementsShowTool } from "./profile_external_custom_requirements_show.js";
import { registerProfileExternalReadinessTool } from "./profile_external_readiness.js";
import { registerProfileExternalRecommendationsTool } from "./profile_external_recommendations.js";
import { registerProfileExternalUpdateTool } from "./profile_external_update.js";
import { registerProfileReviewsApproveItemTool } from "./profile_reviews_approve_item.js";
import { registerProfileReviewsApproveSectionTool } from "./profile_reviews_approve_section.js";
import { registerProfileReviewsListTool } from "./profile_reviews_list.js";
import { registerProfileReviewsSubmitForReviewTool } from "./profile_reviews_submit_for_review.js";
import { registerProfileSkillsAddTool } from "./profile_skills_add.js";
import { registerProfileSkillsAutocompleteTool } from "./profile_skills_autocomplete.js";
import { registerProfileSkillsListTool } from "./profile_skills_list.js";
import { registerProfileSkillsReadinessTool } from "./profile_skills_readiness.js";
import { registerProfileSkillsRemoveTool } from "./profile_skills_remove.js";
import { registerProfileSkillsShowTool } from "./profile_skills_show.js";
import { registerProfileSkillsUpdateTool } from "./profile_skills_update.js";

export type { ToolRegistrationContext } from "./_shared.js";

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
 * 4 `profile.visas` + 2 `profile.resume` (#75) + 6 `profile.external` +
 * 4 `profile.reviews` (#76, one tool per file) = 56 tools.
 *
 * Post-#113: takes a `ToolRegistrationContext` carrying the per-session
 * auth resolvers bound to the config path captured at `buildServer()`
 * time. Tools call `ctx.resolveToolAuth()` / `ctx.loadTokenForTool()` on
 * each invocation; both target the captured path, so env-var shifts
 * mid-session do NOT retarget reads or writes.
 */
export function registerAllTools(server: McpServer, ctx: ToolRegistrationContext): void {
  // profile.basic — 4 leaves (#73)
  registerProfileBasicShowTool(server, ctx);
  registerProfileBasicUpdateTool(server, ctx);
  registerProfileBasicPhotoShowTool(server, ctx);
  registerProfileBasicPhotoUploadTool(server, ctx);

  // profile.skills — 7 leaves (#73, cardinality-collapsed from 18 raw operations)
  registerProfileSkillsAddTool(server, ctx);
  registerProfileSkillsRemoveTool(server, ctx);
  registerProfileSkillsUpdateTool(server, ctx);
  registerProfileSkillsShowTool(server, ctx);
  registerProfileSkillsListTool(server, ctx);
  registerProfileSkillsAutocompleteTool(server, ctx);
  registerProfileSkillsReadinessTool(server, ctx);

  // profile.industries / education / certifications / employment — 21 leaves (#74)
  registerIndustriesTools(server, ctx);
  registerEducationTools(server, ctx);
  registerCertificationsTools(server, ctx);
  registerEmploymentTools(server, ctx);

  // profile.portfolio (8), profile.visas (4), profile.resume (2) — #75
  registerPortfolioTools(server, ctx);
  registerVisasTools(server, ctx);
  registerResumeTools(server, ctx);

  // profile.external — 6 leaves (#76)
  registerProfileExternalUpdateTool(server, ctx);
  registerProfileExternalCustomRequirementsShowTool(server, ctx);
  registerProfileExternalCustomRequirementsSetTool(server, ctx);
  registerProfileExternalReadinessTool(server, ctx);
  registerProfileExternalRecommendationsTool(server, ctx);
  registerProfileExternalAdvancedWizardShowTool(server, ctx);

  // profile.reviews — 4 leaves (#76)
  registerProfileReviewsListTool(server, ctx);
  registerProfileReviewsApproveItemTool(server, ctx);
  registerProfileReviewsApproveSectionTool(server, ctx);
  registerProfileReviewsSubmitForReviewTool(server, ctx);

  // applications — 3 leaves (#15). Read-only access to the user's
  // Toptal Talent Activity view (TalentJobActivityItem rows). Per
  // project non-goals, no apply / withdraw / edit tools are exposed.
  registerApplicationsTools(server, ctx);
}
