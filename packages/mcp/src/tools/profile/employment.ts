// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { parseDateInput, profile, splitParagraphs } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildMcpDryRunPreview, dryRunResponse, type ToolRegistrationContext } from "../_shared.js";
import { dateInput, jsonSuccess, presentToolError, textWithStructuredSuccess } from "./shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

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
 *
 * Dry-run path (issue #165): every tool accepts `dryRun?: boolean`. When
 * `dryRun: true`, returns `{ ok: true, dryRun: true, preview }` via
 * MCP-layer preview building. `show` previews `GET_WORK_EXPERIENCE` (the
 * apply path lists then filters client-side; no per-id selector exists).
 * `profileId` carries `DRY_RUN_PROFILE_ID_PLACEHOLDER` where the apply
 * path resolves it via a sibling profile read.
 */
export function registerEmploymentTools(server: McpServer, ctx: ToolRegistrationContext): void {
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
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.employment.add");
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

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "CreateEmployment",
            "talent-profile",
            { input: { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER, employment: fields } },
            auth.token,
          ),
        );
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
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.employment.update");
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

      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "UpdateEmployment",
            "talent-profile",
            { input: { employmentId: input.id, employment: fields } },
            auth.token,
          ),
        );
      }

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
      inputSchema: { id: z.string().min(1).describe("employment id"), dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.employment.remove");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "RemoveEmployment",
            "talent-profile",
            { input: { employmentId: input.id } },
            auth.token,
          ),
        );
      }
      try {
        const id = await profile.employment.remove(auth.token, input.id);
        return textWithStructuredSuccess(`Employment ${id} removed.`, { id, removed: true });
      } catch (err) {
        return presentToolError("profile.employment.remove", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_employment_show",
    {
      title: "Show employment entry",
      description:
        "Show a single employment entry by id (returns the row as JSON). Note: the underlying wire call lists all rows and filters client-side; the dry-run preview emits `GET_WORK_EXPERIENCE` (the list query) accordingly.",
      inputSchema: { id: z.string().min(1).describe("employment id"), dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.employment.show");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "GET_WORK_EXPERIENCE",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }
      try {
        const row = await profile.employment.show(auth.token, input.id);
        return jsonSuccess(row);
      } catch (err) {
        return presentToolError("profile.employment.show", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_employment_list",
    {
      title: "List employment entries",
      description: [
        "List every employment entry on the signed-in user's Toptal profile, with each row's full per-item shape (mirrors `ttctl_profile_employment_show`).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "What employment entries do I have on my Toptal profile?"',
        '  - "Show me all my Toptal work experience."',
        '  - "List my Toptal employment IDs so I can edit one."',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.employment.list");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "GET_WORK_EXPERIENCE",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }
      try {
        const rows = await profile.employment.list(auth.token);
        return jsonSuccess(rows);
      } catch (err) {
        return presentToolError("profile.employment.list", err);
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
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.employment.highlight");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "highlightEmployment",
            "talent-profile",
            { id: input.id, highlight: input.highlight },
            auth.token,
          ),
        );
      }
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
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.employment.employer_autocomplete");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "GET_EMPLOYERS_AUTOCOMPLETE",
            "talent-profile",
            { search: input.query, limit: input.limit },
            auth.token,
          ),
        );
      }
      try {
        const suggestions = await profile.employment.employerAutocomplete(auth.token, input.query, input.limit);
        return jsonSuccess(suggestions);
      } catch (err) {
        return presentToolError("profile.employment.employer_autocomplete", err);
      }
    },
  );
}
