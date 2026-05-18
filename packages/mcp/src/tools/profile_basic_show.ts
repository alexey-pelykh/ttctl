// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import type { ProfileShowQuery } from "@ttctl/core";
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

const TOOL_NAME = "ttctl_profile_basic_show";

/**
 * Merged payload returned by `ttctl_profile_basic_show`. Mirrors the
 * CLI's `BasicShowPayload` shape (`packages/cli/src/commands/profile/
 * basic/show.ts`) so the read surface speaks the same vocabulary across
 * MCP and CLI clients.
 *
 * `profile` carries the mobile-gateway `ProfileShowQuery` (identity, role,
 * vertical, skills, hours, rate); `basicInfo` carries the talent-profile
 * `BasicInfo` projection (`bio`, `headline`, `languages`). The two come
 * from different GraphQL surfaces — the mobile-gateway `Profile` type does
 * NOT publish `about` / `quote`, hence the dedicated `getBasicInfo()`
 * companion shipped in #127.
 *
 * `basicInfo` is `null` when the secondary `getBasicInfo()` call failed in
 * a non-session-level way (network blip, talent-profile `GRAPHQL_ERROR`).
 * Session-level failures (`AuthRevokedError`, `Cf403Error`) propagate as
 * tool errors — they indicate the bearer is no longer accepted, and the
 * primary `show()` call would have hit them too.
 */
export interface BasicShowPayload {
  profile: ProfileShowQuery;
  basicInfo: profile.basic.BasicInfo | null;
}

/**
 * Register the `ttctl_profile_basic_show` MCP tool. Mirrors the
 * `ttctl profile basic show` CLI leaf — fetches the signed-in user's
 * profile from both the mobile-gateway and the talent-profile surfaces
 * and returns the merged payload.
 *
 * Two-call read surface (parity with CLI's post-#129 path, closed in
 * this PR for MCP per #340):
 *
 *   1. `profile.basic.show()` → `mobile-gateway` for identity, role,
 *      vertical, skills, hours, rate.
 *   2. `profile.basic.getBasicInfo()` → `talent_profile/graphql` for
 *      `bio` (`Profile.about`), `headline` (`Profile.quote`), and
 *      `languages`.
 *
 * Errors from the secondary `getBasicInfo()` call are non-fatal: the
 * tool swallows non-session failures and renders `basicInfo: null`, so a
 * glitch on the secondary surface doesn't blank the whole show. Session-
 * level errors (`AuthRevokedError`, `Cf403Error`) still propagate — they
 * indicate the bearer is no longer valid; the primary `show()` would
 * have hit them too.
 *
 * Auth token identifies the user. MCP is the LLM-facing surface, so the
 * description includes example user-intent phrases the model can match
 * against, and reflects the bio/headline/languages coverage added in
 * this PR.
 *
 * Dry-run path (issue #165): when `dryRun: true`, the tool returns a
 * structured preview of the primary `ProfileShow` query — no transport
 * call. The preview shows only the mobile-gateway operation; the
 * secondary `GET_BASIC_INFO` call on the talent-profile surface is also
 * dispatched on the apply path but is not part of the preview envelope
 * (single-op envelope is the cross-cutting dry-run contract; the
 * secondary read is an implementation detail of the merged response).
 */
export function registerProfileBasicShowTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Show profile basic info",
      description: [
        "Fetch the signed-in user's Toptal Talent profile (identity, role, vertical, skills, hours, rate, bio, headline, languages).",
        "",
        "Returns the merged read payload from both the mobile-gateway (`profile`) and the talent-profile (`basicInfo`) surfaces. `basicInfo.bio` mirrors `Profile.about`; `basicInfo.headline` mirrors `Profile.quote`. `basicInfo` is `null` when the secondary read call fails non-fatally.",
        "",
        "Pass `dryRun: true` to preview the primary request without firing the query.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "What\'s on my Toptal profile?"',
        '  - "Show me my Toptal Talent details."',
        '  - "What\'s my hourly rate and vertical?"',
        '  - "Show my bio and headline."',
        '  - "What languages do I have set?"',
      ].join("\n"),
      inputSchema: {
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview: DryRunPreview }` with operationName + variables + redacted bearer header for the primary ProfileShow query. Default: false.",
          ),
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("ProfileShow", "mobile-gateway", {}, auth.token));
      }

      let profilePayload: ProfileShowQuery;
      try {
        profilePayload = await profile.basic.show(auth.token);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.basic.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }

      let basicInfo: profile.basic.BasicInfo | null;
      try {
        basicInfo = await profile.basic.getBasicInfo(auth.token);
      } catch (err) {
        // Session-level errors (AuthRevokedError, Cf403Error) propagate —
        // the user's bearer is no longer valid and they need to act on it.
        // The primary `show()` call would have hit the same issue, so the
        // user must be told. Anything else (NETWORK_ERROR, GRAPHQL_ERROR
        // on the talent-profile surface) is non-fatal: the primary payload
        // landed, so the tool returns the partial result with
        // `basicInfo: null`. Mirrors the CLI's post-#129 read-handler
        // policy in `packages/cli/src/commands/profile/basic/show.ts`.
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        basicInfo = null;
      }

      const payload: BasicShowPayload = { profile: profilePayload, basicInfo };
      return jsonResponse(payload);
    },
  );
}
