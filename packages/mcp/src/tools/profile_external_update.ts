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

const TOOL_NAME = "ttctl_profile_external_update";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the `ttctl_profile_external_update` MCP tool. Mirrors the
 * `ttctl profile external update` CLI leaf — sets one or more external
 * profile URLs (LinkedIn, GitHub, website, Behance, Dribbble) on the
 * signed-in talent's profile.
 *
 * Each URL field is independently optional; at least one must be supplied.
 * The schema's `--portfolio-url` from issue #76 is intentionally absent —
 * see the service module top-comment for the spec/API reconciliation.
 *
 * **Twitter / X is not a writable field** (#526). The live `talent-profile`
 * server rejects `twitter` on the `ExternalProfilesInput` type. Earlier
 * versions exposed `twitter` here based on a wire inference from the
 * response selection set; that inference was wrong and produced
 * transactional failures (a `linkedin + github + website + twitter` batch
 * lost ALL fields when twitter was supplied). The read-side
 * `ttctl_profile_external_show` continues to return `twitter` because the
 * server's `Profile` entity still exposes it.
 */
export function registerProfileExternalUpdateTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Update external profile URLs",
      description: [
        "Set one or more external profile URLs (LinkedIn, GitHub, website, Behance, Dribbble) on the signed-in talent's profile. At least one field must be provided.",
        "",
        "Twitter / X is NOT settable here — set it via `ttctl_profile_basic_update` (which accepts a URL OR a bare handle). The live server rejects `twitter` on the `ExternalProfilesInput` type (#526); supplying `twitter` to this tool returns a VALIDATION_ERROR redirect (it is not silently dropped). The read-side `ttctl_profile_external_show` still surfaces the stored value.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Update my LinkedIn URL to https://linkedin.com/in/janedoe."',
        '  - "Set my GitHub and personal website."',
        '  - "Add my Behance and Dribbble profiles to my Toptal page."',
      ].join("\n"),
      inputSchema: {
        linkedin: z.url().optional().describe("LinkedIn profile URL"),
        github: z.url().optional().describe("GitHub profile URL"),
        website: z.url().optional().describe("Personal website URL"),
        behance: z.url().optional().describe("Behance profile URL"),
        dribbble: z.url().optional().describe("Dribbble profile URL"),
        twitter: z
          .union([z.string(), z.null()])
          .optional()
          .describe(
            'NOT settable here — set twitter via `ttctl_profile_basic_update` (#526). Declared so a supplied value returns an actionable redirect instead of being silently stripped; any value (including `""` / `null`) triggers the redirect.',
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      // #526: twitter is not settable here. Reject with the shared
      // actionable redirect BEFORE the dry-run branch or any apply call —
      // so the value is neither silently dropped nor surfaced in a
      // misleading dry-run preview. The wording matches the core guard
      // (`profile.external.update`) and the CLI surface.
      if (input.twitter !== undefined) {
        return domainErrorResponse(
          TOOL_NAME,
          new profile.external.ProfileError("VALIDATION_ERROR", profile.external.TWITTER_NOT_EXTERNAL_MESSAGE),
        );
      }

      const changes: profile.external.ExternalProfilesUpdate = {};
      if (input.linkedin !== undefined) changes.linkedin = input.linkedin;
      if (input.github !== undefined) changes.github = input.github;
      if (input.website !== undefined) changes.website = input.website;
      if (input.behance !== undefined) changes.behance = input.behance;
      if (input.dribbble !== undefined) changes.dribbble = input.dribbble;

      if (input.dryRun === true) {
        // `profile:` wrapper matches the apply path; the prior `externalProfiles:`
        // was stale and misrepresented the request (#606).
        return dryRunResponse(
          buildMcpDryRunPreview(
            "UpdateExternalProfiles",
            "talent-profile",
            {
              input: { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER, profile: changes },
            },
            auth.token,
          ),
        );
      }

      try {
        const result = await profile.external.update(auth.token, changes);
        return jsonResponse(result);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.external.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
