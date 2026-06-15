// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import {
  domainErrorResponse,
  dryRunResponse,
  genericErrorResponse,
  isToolErrorResponse,
  jsonResponse,
  type ToolRegistrationContext,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_basic_update";

/**
 * Register the `ttctl_profile_basic_update` MCP tool. Mirrors the
 * `ttctl profile basic update --bio --headline --twitter` CLI leaf —
 * updates the signed-in user's bio, headline, and/or twitter handle
 * via the talent-profile surface.
 *
 * Free-text input modes (stdin / `@file` / `--edit`) are CLI-specific
 * affordances and DO NOT apply here: MCP callers pass the resolved
 * string verbatim. The `bio`, `headline`, and `twitter` parameters
 * are all optional; at least one must be supplied (the core layer
 * validates this and raises a `VALIDATION_ERROR` if all three are
 * omitted).
 *
 * `twitter` is owned by THIS tool (not the sibling
 * `ttctl_profile_external_update`) per the #535 wire evidence — see
 * `ProfileUpdate` in `@ttctl/core`'s `profile.basic` for the cross-
 * surface rationale.
 *
 * Dry-run path (issue #10, harmonised under #165): when `dryRun: true`
 * is supplied, the tool routes through
 * `profile.basic.set(token, changes, { dryRun: true })` which returns a
 * `SetOutcomePreview`. The MCP layer projects that to the uniform
 * `{ ok: true, dryRun: true, preview }` envelope shared by every #165
 * dry-run path. The apply path returns the `UpdateProfileResult`
 * payload directly (the prior `{ kind: "applied", result }` wrapper is
 * dropped — see "Breaking change" note below).
 *
 * **Breaking change vs #10's original wire format (pre-1.0, acceptable):**
 *
 *   - Old apply: `{ kind: "applied", result: { profile, notice } }`
 *   - New apply: `{ profile, notice }`
 *   - Old dry-run: `{ kind: "preview", preview: { ... } }`
 *   - New dry-run: `{ ok: true, dryRun: true, preview: { ... } }`
 *
 * The new envelopes match the rest of the MCP surface — every tool's
 * dry-run path emits `{ ok: true, dryRun: true, preview }` uniformly
 * (issue #165), and apply paths emit the domain payload directly.
 * Bearer token redaction in `headers.authorization` is honored by
 * `buildDryRunPreview` in core; the MCP tool is a thin pass-through.
 */
export function registerProfileBasicUpdateTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Update profile basic info",
      description: [
        "Update the signed-in user's profile bio, headline, and/or twitter handle. At least one must be supplied.",
        "Pass `dryRun: true` to preview the request without firing the mutation.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Update my bio to: Senior backend engineer specialising in Go and PostgreSQL."',
        "  - \"Change my Toptal headline to 'CTO at AcmeCo'.\"",
        '  - "Set my profile bio and headline."',
        '  - "Set my twitter handle to alexey_pelykh."',
        '  - "Set my twitter to https://x.com/alexey_pelykh." (a URL is accepted; ttctl stores the bare handle)',
        '  - "Clear my twitter handle." (call with `twitter: ""` or `twitter: null`)',
        '  - "Show me what would be sent if I changed my bio to X."',
      ].join("\n"),
      inputSchema: {
        bio: z
          .string()
          .optional()
          .describe(
            "Long-form bio paragraph (multi-line). Maps to GraphQL `Profile.about`. Optional. The empty string is a valid value (clears the bio); pass `undefined` to leave the existing bio unchanged.",
          ),
        headline: z
          .string()
          .optional()
          .describe(
            "Short tagline shown above the user's photo (single line). Maps to GraphQL `Profile.quote`. Optional.",
          ),
        twitter: z
          .union([z.string(), z.null()])
          .optional()
          .describe(
            'Twitter / X handle or profile URL. Accepts a bare handle (`alexey_pelykh`), a leading-`@` handle (`@alexey_pelykh`), or a full URL (`https://x.com/alexey_pelykh`, `https://twitter.com/…`) — ttctl normalises any of these to the bare handle Toptal stores on `Profile.twitter` (#526). Optional. Pass `""` or `null` to clear the field; omit the parameter to leave the existing value unchanged.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview: DryRunPreview }` carrying the `UPDATE_BASIC_INFO` operation + redacted bearer header. No transport (read or write) is invoked. Default: false.",
          ),
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      const changes: profile.basic.ProfileUpdate = {};
      if (input.bio !== undefined) changes.bio = input.bio;
      if (input.headline !== undefined) changes.headline = input.headline;
      if (input.twitter !== undefined) changes.twitter = input.twitter;

      try {
        const outcome = await profile.basic.set(auth.token, changes, { dryRun: input.dryRun ?? false });
        if (outcome.kind === "preview") {
          return dryRunResponse(outcome.preview);
        }
        return jsonResponse(outcome.result);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.basic.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
