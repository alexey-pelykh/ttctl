// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { parseDateInput, profile } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { dateInput, jsonSuccess, presentToolError, resolveTokenForTool, textSuccess } from "./shared.js";

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
 */
export function registerEducationTools(server: McpServer): void {
  server.registerTool(
    "ttctl_profile_education_add",
    {
      title: "Add education entry",
      description:
        "Add a new education entry (institution + degree, with optional field of study, location, title, and start/end years). Dates accept ISO-8601 (YYYY-MM-DD) or year-only (YYYY).",
      inputSchema: {
        institution: z.string().min(1).describe("school / university name"),
        degree: z.string().min(1).describe("degree (e.g. BSc, MSc, PhD)"),
        from: dateInput.optional().describe("start date — ISO-8601 or year"),
        to: dateInput.optional().describe("end date — ISO-8601 or year"),
        fieldOfStudy: z.string().optional(),
        location: z.string().optional(),
        title: z.string().optional(),
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.education.add");
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
      if (input.title !== undefined) fields.title = input.title;

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
        title: z.string().optional(),
        highlight: z.boolean().optional(),
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.education.update");
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
      if (input.title !== undefined) fields.title = input.title;
      if (input.highlight !== undefined) fields.highlight = input.highlight;

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
      inputSchema: { id: z.string().min(1).describe("education id") },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.education.remove");
      if ("error" in auth) return auth.error;
      try {
        const id = await profile.education.remove(auth.token, input.id);
        return textSuccess(`Education ${id} removed.`);
      } catch (err) {
        return presentToolError("profile.education.remove", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_education_show",
    {
      title: "Show education entry",
      description: "Show a single education entry by id (returns the row as JSON).",
      inputSchema: { id: z.string().min(1).describe("education id") },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.education.show");
      if ("error" in auth) return auth.error;
      try {
        const row = await profile.education.show(auth.token, input.id);
        return jsonSuccess(row);
      } catch (err) {
        return presentToolError("profile.education.show", err);
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
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.education.highlight");
      if ("error" in auth) return auth.error;
      try {
        const result = await profile.education.highlight(auth.token, input.id, input.highlight);
        return jsonSuccess(result);
      } catch (err) {
        return presentToolError("profile.education.highlight", err);
      }
    },
  );
}
