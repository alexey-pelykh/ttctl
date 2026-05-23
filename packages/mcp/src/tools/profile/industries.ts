// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildMcpDryRunPreview, dryRunResponse, type ToolRegistrationContext } from "../_shared.js";
import { jsonSuccess, presentToolError, textSuccess } from "./shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the six `profile.industries.*` MCP tools on `server`.
 *
 * Tools:
 *   - ttctl_profile_industries_add
 *   - ttctl_profile_industries_update
 *   - ttctl_profile_industries_remove
 *   - ttctl_profile_industries_show
 *   - ttctl_profile_industries_list
 *   - ttctl_profile_industries_autocomplete  (catalog lookup, distinct
 *     from add — the autocomplete leaf returns suggestions from the
 *     known-industry database; add does NOT consult the catalog)
 *
 * `show` is the per-id read companion of `list`, added in #342 to close
 * the Class A surface-shape gap (the service exported a `show()` but
 * neither CLI nor MCP exposed it). The underlying wire call is a true
 * per-id `node()` lookup (`GetIndustryProfile`), distinct from the
 * list-and-filter pattern used by `certifications.show` / `education.show` /
 * `employment.show`.
 *
 * Dry-run path (issue #165): every tool accepts `dryRun?: boolean`.
 * When `dryRun: true`, returns `{ ok: true, dryRun: true, preview }` via
 * MCP-layer preview building. `profileId` carries
 * `DRY_RUN_PROFILE_ID_PLACEHOLDER` where the apply path resolves it via
 * a sibling profile read (`extractProfileId`).
 */
export function registerIndustriesTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_profile_industries_add",
    {
      title: "Add industry-profile entry",
      description:
        "Add a new industry-profile entry to the user's profile (the user's authored domain-expertise entry). `name` becomes the title; `connection` becomes domainArea (the user's role within the industry, e.g. 'Backend' for the 'Healthcare' industry).",
      inputSchema: {
        name: z.string().min(1).describe("industry name (mapped to title)"),
        connection: z.string().optional().describe("connection / role within the industry"),
        about: z.string().optional().describe("longer-form description"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.industries.add");
      if ("error" in auth) return auth.error;

      const fields: profile.industries.IndustryProfileFields = { title: input.name };
      if (input.connection !== undefined) fields.domainArea = input.connection;
      if (input.about !== undefined) fields.about = input.about;

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "CreateIndustryProfile",
            "talent-profile",
            { input: { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER, industryProfile: fields } },
            auth.token,
          ),
        );
      }

      try {
        const created = await profile.industries.add(auth.token, fields);
        return jsonSuccess(created);
      } catch (err) {
        return presentToolError("profile.industries.add", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_industries_update",
    {
      title: "Update industry-profile entry",
      description: "Update an existing industry-profile entry by id. At least one field must be supplied.",
      inputSchema: {
        id: z.string().min(1).describe("industry profile id"),
        name: z.string().optional(),
        connection: z.string().optional(),
        about: z.string().optional(),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.industries.update");
      if ("error" in auth) return auth.error;

      const fields: profile.industries.IndustryProfileFields = {};
      if (input.name !== undefined) fields.title = input.name;
      if (input.connection !== undefined) fields.domainArea = input.connection;
      if (input.about !== undefined) fields.about = input.about;

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "UpdateIndustryProfile",
            "talent-profile",
            { input: { industryProfileId: input.id, industryProfile: fields } },
            auth.token,
          ),
        );
      }

      try {
        const updated = await profile.industries.update(auth.token, input.id, fields);
        return jsonSuccess(updated);
      } catch (err) {
        return presentToolError("profile.industries.update", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_industries_remove",
    {
      title: "Remove industry-profile entry",
      description: "Remove an industry-profile entry by id.",
      inputSchema: {
        id: z.string().min(1).describe("industry profile id"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.industries.remove");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "RemoveIndustryProfile",
            "talent-profile",
            { input: { industryProfileId: input.id } },
            auth.token,
          ),
        );
      }
      try {
        const id = await profile.industries.remove(auth.token, input.id);
        return textSuccess(`Industry ${id} removed.`);
      } catch (err) {
        return presentToolError("profile.industries.remove", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_industries_show",
    {
      title: "Show industry-profile entry",
      description:
        "Show a single industry-profile entry by id (returns the row as JSON). Resolved via the `node()` GraphQL resolver — a true per-id lookup, distinct from certifications/education/employment `show` which list-and-filter client-side.",
      inputSchema: { id: z.string().min(1).describe("industry profile id"), dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.industries.show");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("GetIndustryProfile", "talent-profile", { id: input.id }, auth.token),
        );
      }
      try {
        const row = await profile.industries.show(auth.token, input.id);
        return jsonSuccess(row);
      } catch (err) {
        return presentToolError("profile.industries.show", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_industries_list",
    {
      title: "List industry-profile entries",
      description: "List the user's industry-profile entries (returns an array of rows as JSON).",
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.industries.list");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "ListIndustryProfiles",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }
      try {
        const rows = await profile.industries.list(auth.token);
        return jsonSuccess(rows);
      } catch (err) {
        return presentToolError("profile.industries.list", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_industries_add_connections",
    {
      title: "Link industry to employment/portfolio rows (Pattern-6)",
      description: [
        "Link a catalog industry to one or more employment and/or portfolio rows so the public profile shows 'Industry X (at company Y, …)' rather than orphan tags. Resolve `industryId` via `ttctl_profile_industries_autocomplete`; resolve `employmentIds` via `ttctl_profile_employment_list` and `portfolioItemIds` via `ttctl_profile_portfolio_list`. At least one of `employmentIds` / `portfolioItemIds` is required.",
        "",
        "**DESTRUCTIVE**: this writes recruiter-visible industry tags onto profile rows. The caller MUST set `profileCapabilityConsentIssued: true` to authorize the mutation. See ADR-009 (ttctl) for the per-domain consent vocabulary.",
        "",
        "**INFERRED — UNVERIFIED**: the `AddProfileIndustryConnectionsInput` wire shape is recovered from the portal-bundle decompile (gateway-portal SDL declares only `{ _placeholder: String }`); the live API is the only authority. Wire-shape stability is locked post-merge via the T1 snapshot at `packages/e2e/src/wire-snapshots/AddProfileIndustryConnections.snapshot.json`.",
      ].join("\n"),
      inputSchema: {
        industryId: z
          .string()
          .min(1)
          .describe("Catalog Industry id (V1-Industry-<n>). Resolve via ttctl_profile_industries_autocomplete."),
        employmentIds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Employment row ids (V1-Employment-<n>) to link to this industry. Resolve via ttctl_profile_employment_list.",
          ),
        portfolioItemIds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Portfolio item ids (V1-PortfolioItem-<n>) to link to this industry. Resolve via ttctl_profile_portfolio_list.",
          ),
        profileCapabilityConsentIssued: z
          .literal(true)
          .describe(
            "REQUIRED — MUST be `true`. Acknowledges this is a destructive profile-capability action (writes recruiter-visible industry tags onto profile rows). See ADR-009 (ttctl) § Decision Part 1 for the per-domain consent vocabulary.",
          ),
        dryRun: DRY_RUN_FIELD,
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.industries.add-connections");
      if ("error" in auth) return auth.error;

      const profileItems = [...(input.employmentIds ?? []), ...(input.portfolioItemIds ?? [])];
      if (profileItems.length === 0) {
        return presentToolError(
          "profile.industries.add-connections",
          new Error("at least one of employmentIds or portfolioItemIds is required"),
        );
      }

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "AddProfileIndustryConnections",
            "mobile-gateway",
            {
              input: {
                profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER,
                industriesConnections: [
                  {
                    industryId: input.industryId,
                    profileItems,
                  },
                ],
              },
            },
            auth.token,
          ),
        );
      }

      try {
        const result = await profile.industries.addConnections(
          auth.token,
          [{ industryId: input.industryId, profileItems }],
          { profileCapabilityConsentIssued: input.profileCapabilityConsentIssued },
        );
        return jsonSuccess(result);
      } catch (err) {
        return presentToolError("profile.industries.add-connections", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_industries_autocomplete",
    {
      title: "Search industries catalog",
      description:
        'Search the known-industries catalog by name (e.g. "Healthcare"). Returns up to `limit` suggestions with their canonical IDs. Distinct from `industries_add` — this is a lookup leaf, not a write.',
      inputSchema: {
        query: z.string().min(1).describe("search term"),
        limit: z.number().int().min(1).max(50).default(10),
        withoutIds: z
          .array(z.string())
          .optional()
          .describe("exclude these industry IDs from the result (e.g. industries already on the profile)"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.industries.autocomplete");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        const variables: Record<string, unknown> = { search: input.query, limit: input.limit };
        if (input.withoutIds !== undefined) variables["withoutIds"] = input.withoutIds;
        return dryRunResponse(
          buildMcpDryRunPreview("GET_INDUSTRIES_FOR_AUTOCOMPLETE", "talent-profile", variables, auth.token),
        );
      }
      try {
        const opts: { limit: number; withoutIds?: string[] } = { limit: input.limit };
        if (input.withoutIds !== undefined) opts.withoutIds = input.withoutIds;
        const suggestions = await profile.industries.autocomplete(auth.token, input.query, opts);
        return jsonSuccess(suggestions);
      } catch (err) {
        return presentToolError("profile.industries.autocomplete", err);
      }
    },
  );
}
