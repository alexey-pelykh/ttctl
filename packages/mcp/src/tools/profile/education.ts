// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { parseDateInput, profile } from "@ttctl/core";
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
 * Register the five `profile.education.*` MCP tools on `server`. Mirrors
 * the CLI surface 1:1 (canonical names — no CLI-only aliases per project
 * policy in #72).
 *
 * Tools:
 *   - ttctl_profile_education_add
 *   - ttctl_profile_education_update
 *   - ttctl_profile_education_remove
 *   - ttctl_profile_education_show
 *   - ttctl_profile_education_highlight
 *
 * Dry-run path (issue #165): every tool accepts `dryRun?: boolean`. When
 * `dryRun: true`, returns `{ ok: true, dryRun: true, preview }` via
 * MCP-layer preview building. `show` previews `GET_EDUCATION` (the
 * apply path lists then filters client-side; no per-id selector exists).
 * `profileId` carries `DRY_RUN_PROFILE_ID_PLACEHOLDER` where the apply
 * path resolves it via a sibling profile read.
 */
export function registerEducationTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_profile_education_add",
    {
      title: "Add education entry",
      description:
        "Add a new education entry (institution + degree, with optional field of study, location, and start/end years). Dates accept ISO-8601 (YYYY-MM-DD) or year-only (YYYY).",
      inputSchema: {
        institution: z.string().min(1).describe("school / university name"),
        degree: z.string().min(1).describe("degree (e.g. BSc, MSc, PhD)"),
        from: dateInput.optional().describe("start date — ISO-8601 or year"),
        to: dateInput.optional().describe("end date — ISO-8601 or year"),
        fieldOfStudy: z.string().optional(),
        location: z.string().optional(),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.education.add");
      if ("error" in auth) return auth.error;

      const fields: profile.education.EducationFields = {
        institution: input.institution,
        degree: input.degree,
      };
      try {
        if (input.from !== undefined) fields.yearFrom = parseDateInput(input.from, "from").year;
        if (input.to !== undefined) fields.yearTo = parseDateInput(input.to, "to").year;
      } catch (err) {
        return presentToolError("profile.education.add", err);
      }
      if (input.fieldOfStudy !== undefined) fields.fieldOfStudy = input.fieldOfStudy;
      if (input.location !== undefined) fields.location = input.location;

      if (input.dryRun === true) {
        // skills: [] mirrors core add() — the wire requires non-null
        // skills (#605 cert sibling). Wire shape uses `title` for the
        // school name (no `institution` slot on EducationInput).
        return dryRunResponse(
          buildMcpDryRunPreview(
            "CREATE_EDUCATION",
            "talent-profile",
            {
              input: {
                profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER,
                education: { ...profile.education.toEducationWireInput(fields), skills: [] },
              },
            },
            auth.token,
          ),
        );
      }

      try {
        const created = await profile.education.add(auth.token, fields);
        return jsonSuccess(created);
      } catch (err) {
        return presentToolError("profile.education.add", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_education_update",
    {
      title: "Update education entry",
      description: "Update an existing education entry by id. At least one field must be supplied.",
      inputSchema: {
        id: z.string().min(1).describe("education id (V1-Education-NNN)"),
        institution: z.string().optional(),
        degree: z.string().optional(),
        from: dateInput.optional(),
        to: dateInput.optional(),
        fieldOfStudy: z.string().optional(),
        location: z.string().optional(),
        highlight: z.boolean().optional(),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.education.update");
      if ("error" in auth) return auth.error;

      const fields: profile.education.EducationFields = {};
      try {
        if (input.from !== undefined) fields.yearFrom = parseDateInput(input.from, "from").year;
        if (input.to !== undefined) fields.yearTo = parseDateInput(input.to, "to").year;
      } catch (err) {
        return presentToolError("profile.education.update", err);
      }
      if (input.institution !== undefined) fields.institution = input.institution;
      if (input.degree !== undefined) fields.degree = input.degree;
      if (input.fieldOfStudy !== undefined) fields.fieldOfStudy = input.fieldOfStudy;
      if (input.location !== undefined) fields.location = input.location;
      if (input.highlight !== undefined) fields.highlight = input.highlight;

      if (input.dryRun === true) {
        // Preview placeholders mirror UNCONDITIONAL echoes in
        // `buildUpdateEducationInput`. Conditionally-echoed fields
        // (fieldOfStudy, location, yearFrom, yearTo) surface only when
        // the caller supplies them — zero-transport preview can't read
        // the current row to know which are non-null. Wire-side names
        // (`title` for school) — EducationInput has no `institution`.
        const previewEducation: Record<string, unknown> = {
          title: profile.education.DRY_RUN_EDUCATION_FIELD_PLACEHOLDER,
          degree: profile.education.DRY_RUN_EDUCATION_FIELD_PLACEHOLDER,
          highlight: profile.education.DRY_RUN_EDUCATION_FIELD_PLACEHOLDER,
          skills: profile.education.DRY_RUN_EDUCATION_FIELD_PLACEHOLDER,
          ...profile.education.toEducationWireInput(fields),
        };
        return dryRunResponse(
          buildMcpDryRunPreview(
            "UPDATE_EDUCATION",
            "talent-profile",
            { input: { educationId: input.id, education: previewEducation } },
            auth.token,
          ),
        );
      }

      try {
        const updated = await profile.education.update(auth.token, input.id, fields);
        return jsonSuccess(updated);
      } catch (err) {
        return presentToolError("profile.education.update", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_education_remove",
    {
      title: "Remove education entry",
      description: "Remove an education entry by id.",
      inputSchema: { id: z.string().min(1).describe("education id"), dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.education.remove");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview("REMOVE_EDUCATION", "talent-profile", { input: { educationId: input.id } }, auth.token),
        );
      }
      try {
        const id = await profile.education.remove(auth.token, input.id);
        return textWithStructuredSuccess(`Education ${id} removed.`, { id, removed: true });
      } catch (err) {
        return presentToolError("profile.education.remove", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_education_show",
    {
      title: "Show education entry",
      description:
        "Show a single education entry by id (returns the row as JSON). Note: the underlying wire call lists all rows and filters client-side; the dry-run preview emits `GET_EDUCATION` (the list query) accordingly.",
      inputSchema: { id: z.string().min(1).describe("education id"), dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.education.show");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "GET_EDUCATION",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }
      try {
        const row = await profile.education.show(auth.token, input.id);
        return jsonSuccess(row);
      } catch (err) {
        return presentToolError("profile.education.show", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_education_list",
    {
      title: "List education entries",
      description: [
        "List every education entry on the signed-in user's Toptal profile, with each row's full per-item shape (mirrors `ttctl_profile_education_show`).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "What education entries do I have on my Toptal profile?"',
        '  - "Show me all my Toptal education history."',
        '  - "List my Toptal education IDs so I can edit one."',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.education.list");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "GET_EDUCATION",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }
      try {
        const rows = await profile.education.list(auth.token);
        return jsonSuccess(rows);
      } catch (err) {
        return presentToolError("profile.education.list", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_education_highlight",
    {
      title: "Toggle education highlight",
      description: "Toggle the highlight flag on an education entry.",
      inputSchema: {
        id: z.string().min(1).describe("education id"),
        highlight: z.boolean().default(true).describe("true to highlight, false to un-highlight"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.education.highlight");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "highlightEducation",
            "talent-profile",
            { id: input.id, highlight: input.highlight },
            auth.token,
          ),
        );
      }
      try {
        const result = await profile.education.highlight(auth.token, input.id, input.highlight);
        return jsonSuccess(result);
      } catch (err) {
        return presentToolError("profile.education.highlight", err);
      }
    },
  );
}
