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

const TOOL_NAME = "ttctl_profile_reviews_approve_item";

/**
 * Register the `ttctl_profile_reviews_approve_item` MCP tool. Mirrors the
 * `ttctl profile reviews approve-item` CLI leaf — approves a single
 * pending item within a section review.
 *
 * The issue's single-positional `<id>` shorthand is replaced by named
 * inputs because the underlying API requires three fields (`reviewId`,
 * `itemId`, `itemKind`) to identify an item. Run
 * `ttctl_profile_reviews_list` first to obtain the three required values.
 *
 * **Destructive**: approval is final per platform semantics. No `--dry-run`
 * gate at v0; that lands separately (see issue #52).
 */
export function registerProfileReviewsApproveItemTool(server: McpServer): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Approve a pending review item",
      description: [
        "Approve a single pending item within a section review. DESTRUCTIVE: approval is final per platform semantics. Run `ttctl_profile_reviews_list` first to obtain the three required IDs.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Approve the suggested change to my education section item."',
        '  - "Accept the pending edit on my employment item."',
        '  - "Approve item ID xyz in review abc."',
      ].join("\n"),
      inputSchema: {
        reviewId: z
          .string()
          .min(1)
          .describe("Section-review ID. Source: `ttctl_profile_reviews_list` row's `id` field."),
        itemId: z
          .string()
          .min(1)
          .describe("Section-review-item ID. Source: `ttctl_profile_reviews_list` row's `items[].id` field."),
        kind: z
          .string()
          .min(1)
          .describe("ItemReviewKind enum value as a string (e.g. EDUCATION, EMPLOYMENT, CERTIFICATION)."),
      },
    },
    async (input) => {
      const auth = await loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      try {
        const result = await profile.reviews.approveItem(auth.token, {
          reviewId: input.reviewId,
          itemId: input.itemId,
          itemKind: input.kind,
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
