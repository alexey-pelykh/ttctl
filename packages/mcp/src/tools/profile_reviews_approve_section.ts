// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import {
  domainErrorResponse,
  genericErrorResponse,
  isToolErrorResponse,
  jsonResponse,
  loadTokenForTool,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_reviews_approve_section";

/**
 * Register the `ttctl_profile_reviews_approve_section` MCP tool. Mirrors
 * the `ttctl profile reviews approve-section` CLI leaf — approves all
 * pending items within a section review.
 *
 * The issue's single-positional `<id>` shorthand is replaced by named
 * inputs because the API requires both `reviewId` and `section`. Run
 * `ttctl_profile_reviews_list` first to obtain the IDs.
 *
 * **Destructive**: approval is final per platform semantics.
 */
export function registerProfileReviewsApproveSectionTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Approve all pending items in a section",
      description: [
        "Approve all pending items within a section review. DESTRUCTIVE: approval is final per platform semantics. Run `ttctl_profile_reviews_list` first to obtain the section ID.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Approve all the suggested changes to my skills section."',
        '  - "Accept all pending edits in my employment section."',
        '  - "Approve everything in section EDUCATION."',
      ].join("\n"),
      inputSchema: {
        reviewId: z
          .string()
          .min(1)
          .describe("Section-review ID. Source: `ttctl_profile_reviews_list` row's `id` field."),
        section: z
          .string()
          .min(1)
          .describe("ReviewSection enum value as a string (e.g. EDUCATION, EMPLOYMENT, SKILLS)."),
      },
    },
    async (input) => {
      const auth = await loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      try {
        const result = await profile.reviews.approveSection(auth.token, {
          reviewId: input.reviewId,
          section: input.section,
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
