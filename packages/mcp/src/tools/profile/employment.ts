// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { parseDateInput, profile, splitParagraphs } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { dateInput, jsonSuccess, presentToolError, resolveTokenForTool, textSuccess } from "./shared.js";

/**
 * Register the six `profile.employment.*` MCP tools on `server`.
 *
 * MCP tool names use ONLY the canonical `employment` form — the CLI
 * alias `experience` (per #72) is CLI-only and never appears in the MCP
 * catalog.
 *
 * The sixth tool (`employer_autocomplete`) is the catalog lookup leaf
 * — it returns suggestions from the known-employer database, useful
 * for resolving free-text employer names to canonical Toptal IDs
 * before adding a new employment row.
 */
export function registerEmploymentTools(server: McpServer): void {
  server.registerTool(
    "ttctl_profile_employment_add",
    {
      title: "Add employment entry",
      description:
        "Add a new employment entry (company + role, with optional start/end years and `current` flag). Dates accept ISO-8601 (YYYY-MM-DD) or year-only (YYYY); year only is stored.",
      inputSchema: {
        company: z.string().min(1).describe("company / employer name"),
        role: z.string().min(1).describe("job title (mapped to position)"),
        from: dateInput.optional().describe("start date — ISO-8601 or year"),
        to: dateInput.optional().describe("end date — ISO-8601 or year"),
        current: z.boolean().optional().describe("mark as current position (no end date)"),
        website: z.url().optional().describe("company website"),
        description: z
          .string()
          .optional()
          .describe("multi-paragraph description; split on blank lines into experienceItems"),
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.employment.add");
      if ("error" in auth) return auth.error;

      const fields: profile.employment.EmploymentFields = {
        company: input.company,
        position: input.role,
      };
      try {
        if (input.from !== undefined) fields.startDate = parseDateInput(input.from, "from").year;
        if (input.to !== undefined) fields.endDate = parseDateInput(input.to, "to").year;
      } catch (err) {
        return presentToolError("profile.employment.add", err);
      }
      if (input.current === true) fields.endDate = null;
      if (input.website !== undefined) {
        fields.companyWebsite = input.website;
        fields.noWebsite = false;
      }
      if (input.description !== undefined) {
        fields.experienceItems = splitParagraphs(input.description);
      }

      try {
        const created = await profile.employment.add(auth.token, fields);
        return jsonSuccess(created);
      } catch (err) {
        return presentToolError("profile.employment.add", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_employment_update",
    {
      title: "Update employment entry",
      description:
        "Update an existing employment entry by id. At least one field must be supplied. `description` is multi-paragraph free-text and splits on blank lines.",
      inputSchema: {
        id: z.string().min(1).describe("employment id (V1-Employment-NNN)"),
        company: z.string().optional(),
        role: z.string().optional(),
        from: dateInput.optional(),
        to: dateInput.optional(),
        current: z.boolean().optional(),
        website: z.url().optional(),
        description: z.string().optional(),
        highlight: z.boolean().optional(),
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.employment.update");
      if ("error" in auth) return auth.error;

      const fields: profile.employment.EmploymentFields = {};
      try {
        if (input.from !== undefined) fields.startDate = parseDateInput(input.from, "from").year;
        if (input.to !== undefined) fields.endDate = parseDateInput(input.to, "to").year;
      } catch (err) {
        return presentToolError("profile.employment.update", err);
      }
      if (input.current === true) fields.endDate = null;
      if (input.company !== undefined) fields.company = input.company;
      if (input.role !== undefined) fields.position = input.role;
      if (input.website !== undefined) {
        fields.companyWebsite = input.website;
        fields.noWebsite = false;
      }
      if (input.description !== undefined) {
        fields.experienceItems = splitParagraphs(input.description);
      }
      if (input.highlight !== undefined) fields.highlight = input.highlight;

      try {
        const updated = await profile.employment.update(auth.token, input.id, fields);
        return jsonSuccess(updated);
      } catch (err) {
        return presentToolError("profile.employment.update", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_employment_remove",
    {
      title: "Remove employment entry",
      description: "Remove an employment entry by id.",
      inputSchema: { id: z.string().min(1).describe("employment id") },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.employment.remove");
      if ("error" in auth) return auth.error;
      try {
        const id = await profile.employment.remove(auth.token, input.id);
        return textSuccess(`Employment ${id} removed.`);
      } catch (err) {
        return presentToolError("profile.employment.remove", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_employment_show",
    {
      title: "Show employment entry",
      description: "Show a single employment entry by id (returns the row as JSON).",
      inputSchema: { id: z.string().min(1).describe("employment id") },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.employment.show");
      if ("error" in auth) return auth.error;
      try {
        const row = await profile.employment.show(auth.token, input.id);
        return jsonSuccess(row);
      } catch (err) {
        return presentToolError("profile.employment.show", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_employment_highlight",
    {
      title: "Toggle employment highlight",
      description: "Toggle the highlight flag on an employment entry.",
      inputSchema: {
        id: z.string().min(1).describe("employment id"),
        highlight: z.boolean().default(true),
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.employment.highlight");
      if ("error" in auth) return auth.error;
      try {
        const result = await profile.employment.highlight(auth.token, input.id, input.highlight);
        return jsonSuccess(result);
      } catch (err) {
        return presentToolError("profile.employment.highlight", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_employment_employer_autocomplete",
    {
      title: "Search employer catalog",
      description:
        'Search the known-employer catalog by name (e.g. "Google"). Returns up to `limit` suggestions with their canonical IDs.',
      inputSchema: {
        query: z.string().min(1).describe("search term"),
        limit: z.number().int().min(1).max(50).default(10).describe("max results"),
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.employment.employer_autocomplete");
      if ("error" in auth) return auth.error;
      try {
        const suggestions = await profile.employment.employerAutocomplete(auth.token, input.query, input.limit);
        return jsonSuccess(suggestions);
      } catch (err) {
        return presentToolError("profile.employment.employer_autocomplete", err);
      }
    },
  );
}
