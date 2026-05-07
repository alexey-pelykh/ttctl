// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { parseDateInput, profile } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { dateInput, jsonSuccess, presentToolError, resolveTokenForTool, textSuccess } from "./shared.js";

/**
 * Register the five `profile.certifications.*` MCP tools on `server`.
 *
 * MCP tool names use ONLY the canonical `certifications` form — the CLI
 * alias `certs` (per #72) is CLI-only and never appears in the MCP
 * catalog.
 */
export function registerCertificationsTools(server: McpServer): void {
  server.registerTool(
    "ttctl_profile_certifications_add",
    {
      title: "Add certification entry",
      description:
        "Add a new certification entry (name + issuer, with optional issue / expiration dates, credential URL, and credential ID). Dates accept ISO-8601 (YYYY-MM-DD) or year-only (YYYY); month is preserved when given.",
      inputSchema: {
        name: z.string().min(1).describe("certification name (mapped to certificate)"),
        issuer: z.string().min(1).describe("issuing organization (mapped to institution)"),
        issued: dateInput.optional().describe("issue date — ISO-8601 or year"),
        expires: dateInput.optional().describe("expiration date — ISO-8601 or year"),
        link: z.url().optional().describe("credential URL"),
        number: z.string().optional().describe("credential ID / certificate number"),
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.certifications.add");
      if ("error" in auth) return auth.error;

      const fields: profile.certifications.CertificationFields = {
        certificate: input.name,
        institution: input.issuer,
      };
      try {
        if (input.issued !== undefined) {
          const parsed = parseDateInput(input.issued, "issued");
          fields.validFromMonth = parsed.month;
          fields.validFromYear = parsed.year;
        }
        if (input.expires !== undefined) {
          const parsed = parseDateInput(input.expires, "expires");
          fields.validToMonth = parsed.month;
          fields.validToYear = parsed.year;
        }
      } catch (err) {
        return presentToolError("profile.certifications.add", err);
      }
      if (input.link !== undefined) fields.link = input.link;
      if (input.number !== undefined) fields.number = input.number;

      try {
        const created = await profile.certifications.add(auth.token, fields);
        return jsonSuccess(created);
      } catch (err) {
        return presentToolError("profile.certifications.add", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_certifications_update",
    {
      title: "Update certification entry",
      description: "Update an existing certification entry by id. At least one field must be supplied.",
      inputSchema: {
        id: z.string().min(1).describe("certification id (V1-Certification-NNN)"),
        name: z.string().optional(),
        issuer: z.string().optional(),
        issued: dateInput.optional(),
        expires: dateInput.optional(),
        link: z.url().optional(),
        number: z.string().optional(),
        highlight: z.boolean().optional(),
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.certifications.update");
      if ("error" in auth) return auth.error;

      const fields: profile.certifications.CertificationFields = {};
      try {
        if (input.issued !== undefined) {
          const parsed = parseDateInput(input.issued, "issued");
          fields.validFromMonth = parsed.month;
          fields.validFromYear = parsed.year;
        }
        if (input.expires !== undefined) {
          const parsed = parseDateInput(input.expires, "expires");
          fields.validToMonth = parsed.month;
          fields.validToYear = parsed.year;
        }
      } catch (err) {
        return presentToolError("profile.certifications.update", err);
      }
      if (input.name !== undefined) fields.certificate = input.name;
      if (input.issuer !== undefined) fields.institution = input.issuer;
      if (input.link !== undefined) fields.link = input.link;
      if (input.number !== undefined) fields.number = input.number;
      if (input.highlight !== undefined) fields.highlight = input.highlight;

      try {
        const updated = await profile.certifications.update(auth.token, input.id, fields);
        return jsonSuccess(updated);
      } catch (err) {
        return presentToolError("profile.certifications.update", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_certifications_remove",
    {
      title: "Remove certification entry",
      description: "Remove a certification entry by id.",
      inputSchema: { id: z.string().min(1).describe("certification id") },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.certifications.remove");
      if ("error" in auth) return auth.error;
      try {
        const id = await profile.certifications.remove(auth.token, input.id);
        return textSuccess(`Certification ${id} removed.`);
      } catch (err) {
        return presentToolError("profile.certifications.remove", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_certifications_show",
    {
      title: "Show certification entry",
      description: "Show a single certification entry by id (returns the row as JSON).",
      inputSchema: { id: z.string().min(1).describe("certification id") },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.certifications.show");
      if ("error" in auth) return auth.error;
      try {
        const row = await profile.certifications.show(auth.token, input.id);
        return jsonSuccess(row);
      } catch (err) {
        return presentToolError("profile.certifications.show", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_certifications_highlight",
    {
      title: "Toggle certification highlight",
      description: "Toggle the highlight flag on a certification entry.",
      inputSchema: {
        id: z.string().min(1).describe("certification id"),
        highlight: z.boolean().default(true),
      },
    },
    async (input) => {
      const auth = await resolveTokenForTool("profile.certifications.highlight");
      if ("error" in auth) return auth.error;
      try {
        const result = await profile.certifications.highlight(auth.token, input.id, input.highlight);
        return jsonSuccess(result);
      } catch (err) {
        return presentToolError("profile.certifications.highlight", err);
      }
    },
  );
}
