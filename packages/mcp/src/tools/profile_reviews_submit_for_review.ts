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

const TOOL_NAME = "ttctl_profile_reviews_submit_for_review";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the `ttctl_profile_reviews_submit_for_review` MCP tool.
 * Mirrors the `ttctl profile reviews submit-for-review` CLI leaf — re-
 * submits the talent's profile for platform-side re-review.
 *
 * The platform may reject if the profile is not yet ready (cross-check
 * via `ttctl_profile_external_readiness`). The mutation's input shape is
 * **INFERRED — UNVERIFIED** (`{ profileId: ID! }`); deviations would
 * surface as `USER_ERROR` at runtime.
 *
 * **Consent gate** (ADR-009 (ttctl) — `profile-capability` domain): the
 * tool requires `profileCapabilityConsentIssued: true` on input. The
 * Zod schema enforces the literal at validation time (rejecting
 * `false` / absent / non-boolean); the service-layer runtime gate is a
 * defense-in-depth layer covering `as`-cast bypasses. The
 * `destructiveHint: true` MCP annotation signals to the MCP host that
 * this tool effects irreversible state (Claude Desktop and similar
 * hosts surface a confirmation prompt to the user).
 */
export function registerProfileReviewsSubmitForReviewTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Submit profile for platform re-review",
      description: [
        "Submit the talent's profile for platform-side re-review. Used after profile edits that need re-verification (skills, employments, etc.). The platform may reject if the profile is not yet ready (use `ttctl_profile_external_readiness` to check first).",
        "",
        "**DESTRUCTIVE**: this enters the maintainer's profile into the Toptal platform review queue. The operation has no safe round-trip — once invoked, the platform begins the re-review process. The caller MUST set `profileCapabilityConsentIssued: true` to authorize the mutation. See ADR-009 (ttctl) for the per-domain consent vocabulary.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Submit my profile for review."',
        '  - "Re-submit my Toptal profile after my edits."',
        '  - "I\'m done editing — submit for re-review."',
      ].join("\n"),
      inputSchema: {
        profileCapabilityConsentIssued: z
          .literal(true)
          .describe(
            "REQUIRED — MUST be `true`. Acknowledges this is a destructive profile-capability action (enters the maintainer's profile into the Toptal review queue; no safe round-trip). See ADR-009 (ttctl) § Decision Part 1 for the per-domain consent vocabulary.",
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
            "submitForReview",
            "talent-profile",
            { input: { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER } },
            auth.token,
          ),
        );
      }

      try {
        const result = await profile.reviews.submitForReview(auth.token, {
          profileCapabilityConsentIssued: input.profileCapabilityConsentIssued,
        });
        return jsonResponse(result);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.reviews.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
