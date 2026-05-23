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

const TOOL_NAME = "ttctl_profile_specializations_show";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the `ttctl_profile_specializations_show` MCP tool (#466).
 * Mirrors the `ttctl profile specializations show` CLI leaf — the
 * read-only enumeration of the talent's specialization tracks (Core,
 * Marketplace, Expert Crowd, etc.) and their per-row metadata
 * (applicationStatus, eligibleJobsCount, applicationCompletedAt,
 * operations.apply.{callable, messages}, logoUrl, description).
 *
 * Wraps the `GetTalentSpecializations` gateway-portal op on the
 * `mobile-gateway` surface (no Cloudflare, plain HTTPS) — T1 disposition
 * per `docs/wire-validation-routing.md` (the op is in
 * `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` so no codegen type exists; the
 * committed `GetTalentSpecializations.snapshot.json` is the wire-shape
 * authority).
 *
 * Viewer-scoped — the tool takes no input beyond the standard `dryRun`
 * flag. Empty list is a valid response state (fresh accounts or accounts
 * that haven't completed any specialization application).
 */
export function registerProfileSpecializationsShowTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "List the talent's specialization tracks",
      description: [
        "Read the talent's specialization badges (Core, Marketplace, Expert Crowd, etc.) and per-row metadata: id, slug, title, description, logoUrl, applicationStatus, eligibleJobsCount, applicationCompletedAt, and operations.apply.{callable, messages}.",
        "",
        "Wraps the `GetTalentSpecializations` gateway-portal op (mobile-gateway surface). Viewer-scoped — takes no input.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Which Toptal specializations am I a member of?"',
        '  - "Show me my specialization badges."',
        '  - "Am I in Core? Marketplace?"',
        '  - "What specializations could I apply for?"',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      if (input.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("GetTalentSpecializations", "mobile-gateway", {}, auth.token));
      }

      try {
        const result = await profile.specializations.show(auth.token);
        return jsonResponse(result);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.specializations.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
