// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { jsonSuccess, presentToolError, resolveTokenForTool, textSuccess } from "./shared.js";

/**
 * Register the five `profile.industries.*` MCP tools on `server`.
 *
 * Tools:
 *   - ttctl_profile_industries_add
 *   - ttctl_profile_industries_update
 *   - ttctl_profile_industries_remove
 *   - ttctl_profile_industries_list
 *   - ttctl_profile_industries_autocomplete  (catalog lookup, distinct
 *     from add — the autocomplete leaf returns suggestions from the
 *     known-industry database; add does NOT consult the catalog)
 */
export function registerIndustriesTools(server: McpServer): void {
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
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.industries.add");
      if ("error" in auth) return auth.error;

      const fields: profile.industries.IndustryProfileFields = { title: input.name };
      if (input.connection !== undefined) fields.domainArea = input.connection;
      if (input.about !== undefined) fields.about = input.about;

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
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.industries.update");
      if ("error" in auth) return auth.error;

      const fields: profile.industries.IndustryProfileFields = {};
      if (input.name !== undefined) fields.title = input.name;
      if (input.connection !== undefined) fields.domainArea = input.connection;
      if (input.about !== undefined) fields.about = input.about;

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
      inputSchema: { id: z.string().min(1).describe("industry profile id") },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.industries.remove");
      if ("error" in auth) return auth.error;
      try {
        const id = await profile.industries.remove(auth.token, input.id);
        return textSuccess(`Industry ${id} removed.`);
      } catch (err) {
        return presentToolError("profile.industries.remove", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_industries_list",
    {
      title: "List industry-profile entries",
      description: "List the user's industry-profile entries (returns an array of rows as JSON).",
      inputSchema: {},
    },
    async () => {
      const auth = await resolveTokenForTool("profile.industries.list");
      if ("error" in auth) return auth.error;
      try {
        const rows = await profile.industries.list(auth.token);
        return jsonSuccess(rows);
      } catch (err) {
        return presentToolError("profile.industries.list", err);
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
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.industries.autocomplete");
      if ("error" in auth) return auth.error;
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
