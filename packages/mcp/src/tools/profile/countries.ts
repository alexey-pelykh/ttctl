// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildMcpDryRunPreview, dryRunResponse, type ToolRegistrationContext } from "../_shared.js";
import { jsonSuccess, presentToolError } from "./shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register `ttctl_profile_countries_list` — id-discovery for employment's
 * `primaryGeographyId` (#586). Read-only; accepts `dryRun?` per #165.
 */
export function registerCountriesTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_profile_countries_list",
    {
      title: "List Toptal country/geography catalog",
      description:
        "List the Toptal Country/geography catalog (id, ISO code, name) — the full ~250-row catalog (not a search). Use this to resolve a valid Country id to pass as `primaryGeographyId` to ttctl_profile_employment_add / ttctl_profile_employment_update.",
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.countries.list");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("getCountries", "talent-profile", {}, auth.token));
      }
      try {
        const rows = await profile.countries.list(auth.token);
        return jsonSuccess(rows);
      } catch (err) {
        return presentToolError("profile.countries.list", err);
      }
    },
  );
}
