// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { parseDateInput, profile } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildMcpDryRunPreview, dryRunResponse, type ToolRegistrationContext } from "../_shared.js";
import { dateInput, jsonSuccess, presentToolError, textSuccess } from "./shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the five `profile.certifications.*` MCP tools on `server`.
 *
 * MCP tool names use ONLY the canonical `certifications` form — the CLI
 * alias `certs` (per #72) is CLI-only and never appears in the MCP
 * catalog.
 *
 * Dry-run path (issue #165): every tool accepts `dryRun?: boolean`. When
 * `dryRun: true`, returns `{ ok: true, dryRun: true, preview }` via
 * MCP-layer preview building. `show` previews `GET_CERTIFICATION` (the
 * apply path lists then filters client-side; no per-id selector exists).
 * `profileId` carries `DRY_RUN_PROFILE_ID_PLACEHOLDER` where the apply
 * path resolves it via a sibling profile read.
 */
export function registerCertificationsTools(server: McpServer, ctx: ToolRegistrationContext): void {
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
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.certifications.add");
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

      if (input.dryRun === true) {
        // skills: [] mirrors core add() — the wire requires non-null skills
        // and the MCP tool has no skills input, so the apply path always
        // sends []. Surface it so the preview matches the wire payload.
        return dryRunResponse(
          buildMcpDryRunPreview(
            "CREATE_CERTIFICATION",
            "talent-profile",
            {
              input: {
                profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER,
                certification: { ...fields, skills: [] },
              },
            },
            auth.token,
          ),
        );
      }

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
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.certifications.update");
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

      if (input.dryRun === true) {
        // Preview placeholders mirror the UNCONDITIONAL echoes in
        // `buildUpdateCertificationInput`. Conditionally-echoed fields
        // (link, number, validFromMonth, validFromYear) surface only when
        // the caller supplies them — zero-transport preview can't read
        // the current row to know which are non-null.
        const previewCertification: Record<string, unknown> = {
          certificate: profile.certifications.DRY_RUN_CERTIFICATION_FIELD_PLACEHOLDER,
          institution: profile.certifications.DRY_RUN_CERTIFICATION_FIELD_PLACEHOLDER,
          highlight: profile.certifications.DRY_RUN_CERTIFICATION_FIELD_PLACEHOLDER,
          validToMonth: profile.certifications.DRY_RUN_CERTIFICATION_FIELD_PLACEHOLDER,
          validToYear: profile.certifications.DRY_RUN_CERTIFICATION_FIELD_PLACEHOLDER,
          skills: profile.certifications.DRY_RUN_CERTIFICATION_FIELD_PLACEHOLDER,
          ...fields,
        };
        return dryRunResponse(
          buildMcpDryRunPreview(
            "UPDATE_CERTIFICATION",
            "talent-profile",
            { input: { certificationId: input.id, certification: previewCertification } },
            auth.token,
          ),
        );
      }

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
      inputSchema: { id: z.string().min(1).describe("certification id"), dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.certifications.remove");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "REMOVE_CERTIFICATION",
            "talent-profile",
            { input: { certificationId: input.id } },
            auth.token,
          ),
        );
      }
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
      description:
        "Show a single certification entry by id (returns the row as JSON). Note: the underlying wire call lists all rows and filters client-side; the dry-run preview emits `GET_CERTIFICATION` (the list query) accordingly.",
      inputSchema: { id: z.string().min(1).describe("certification id"), dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.certifications.show");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "GET_CERTIFICATION",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }
      try {
        const row = await profile.certifications.show(auth.token, input.id);
        return jsonSuccess(row);
      } catch (err) {
        return presentToolError("profile.certifications.show", err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_certifications_list",
    {
      title: "List certification entries",
      description: [
        "List every certification entry on the signed-in user's Toptal profile, with each row's full per-item shape (mirrors `ttctl_profile_certifications_show`).",
        "",
        "Example user prompts that should map to this tool:",
        '  - "What certifications do I have on my Toptal profile?"',
        '  - "Show me all my Toptal certifications."',
        '  - "List my Toptal certification IDs so I can edit one."',
      ].join("\n"),
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.certifications.list");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "GET_CERTIFICATION",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }
      try {
        const rows = await profile.certifications.list(auth.token);
        return jsonSuccess(rows);
      } catch (err) {
        return presentToolError("profile.certifications.list", err);
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
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (input) => {
      const auth = await ctx.resolveTokenForTool("profile.certifications.highlight");
      if ("error" in auth) return auth.error;
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "highlightCertification",
            "talent-profile",
            { id: input.id, highlight: input.highlight },
            auth.token,
          ),
        );
      }
      try {
        const result = await profile.certifications.highlight(auth.token, input.id, input.highlight);
        return jsonSuccess(result);
      } catch (err) {
        return presentToolError("profile.certifications.highlight", err);
      }
    },
  );
}
