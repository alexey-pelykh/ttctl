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
        "Add a new employment entry (company + role, with optional start/end years and `current` flag). " +
        "The `company` string is resolved to the server-side `employerId` via the employer-autocomplete catalog: " +
        "0 matches or 2+ matches return a VALIDATION_ERROR with disambiguation guidance. Pass an explicit `employerId` to " +
        "bypass autocomplete entirely. Set `noEmployer: true` for a custom (non-catalog) workplace — sends the free-text " +
        "`company` with employerId:null and skips autocomplete (cannot be combined with `employerId`). " +
        "On the `noEmployer:true` path the Toptal server requires an anchor: pass EITHER `website` (a URL) OR " +
        "`noWebsite: true` (the explicit no-website signal). Without either, the server rejects the row with " +
        "`USER_ERROR: employerId: You can't leave this empty` (#484 — settled by `45-profile-employment-add.e2e.test.ts`). " +
        "`industryIds` (at least one required) attaches catalog industries to the entry — " +
        "discover ids via `ttctl_profile_industries_autocomplete`. " +
        "Dates accept ISO-8601 (YYYY-MM-DD) or year-only (YYYY); year only is stored.",
      inputSchema: {
        company: z
          .string()
          .min(1)
          .describe("company / employer name (resolved to employerId via autocomplete unless noEmployer is set)"),
        role: z.string().min(1).describe("job title (mapped to position)"),
        employerId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "explicit employerId (bypasses autocomplete; use `ttctl_profile_employment_employer_autocomplete` to discover)",
          ),
        industryIds: z
          .array(z.string())
          .min(1)
          .describe(
            'Catalog Industry ids (at least one required). Discover via `ttctl_profile_industries_autocomplete` or `ttctl profile industries autocomplete "<query>"`.',
          ),
        skills: z
          .array(
            z.object({
              id: z.string().min(1).describe("catalog Skill id"),
              name: z.string().optional().describe("display name (optional; supplied verbatim if known)"),
            }),
          )
          .optional()
          .describe(
            "Catalog skills to attach (optional). Discover ids via `ttctl_profile_skills_list`. Required on the live wire when `noEmployer: true` is set (#484); the catalog-employer path may inherit skills from the resolved Employer.",
          ),
        noEmployer: z
          .boolean()
          .optional()
          .describe(
            "custom (non-catalog) workplace: send the free-text `company` with employerId:null and skip the employer-autocomplete catalog. Cannot be combined with `employerId`. Requires either `website` (a URL) or `noWebsite: true` per the #484 CREATE-side anchor contract.",
          ),
        from: dateInput.optional().describe("start date — ISO-8601 or year"),
        to: dateInput.optional().describe("end date — ISO-8601 or year"),
        current: z.boolean().optional().describe("mark as current position (no end date)"),
        website: z.url().optional().describe("company website (mutually exclusive with `noWebsite: true`)"),
        noWebsite: z
          .boolean()
          .optional()
          .describe(
            "explicit no-website signal (#484): required with `noEmployer: true` when `website` is not supplied — the Toptal server rejects custom workplaces with neither anchor. Mutually exclusive with `website`.",
          ),
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
        // industryIds is required by the schema (zod `.min(1)`). The
        // live `CreateEmployment` wire rejects a blank industry set
        // (#395 cascade); surfacing it as a required parameter mirrors
        // `portfolio_add` and fails fast before the wire.
        industryIds: input.industryIds,
      };
      if (input.employerId !== undefined) {
        fields.employerId = input.employerId;
      }
      if (input.noEmployer === true) {
        fields.noEmployer = true;
      }
      try {
        if (input.from !== undefined) fields.startDate = parseDateInput(input.from, "from").year;
        if (input.to !== undefined) fields.endDate = parseDateInput(input.to, "to").year;
      } catch (err) {
        return presentToolError("profile.employment.add", err);
      }
      if (input.current === true) fields.endDate = null;
      // Anchor handling (#484): `website` and `noWebsite` are the two
      // anchor signals required on the `noEmployer:true` path. They are
      // mutually exclusive — the wire's `EmploymentInput` expresses no
      // website by sending `companyWebsite: null` together with
      // `noWebsite: true`, and (a URL with `noWebsite: true`) would be
      // a contradictory shape. Refuse client-side; otherwise core's
      // anchor validator will throw with a less specific message.
      if (input.website !== undefined && input.noWebsite === true) {
        return presentToolError(
          "profile.employment.add",
          new profile.basic.ProfileError(
            "VALIDATION_ERROR",
            "profile.employment.add: `website` and `noWebsite: true` are mutually exclusive. Supply one or the other.",
          ),
        );
      }
      if (input.website !== undefined) {
        fields.companyWebsite = input.website;
        fields.noWebsite = false;
      } else if (input.noWebsite === true) {
        fields.noWebsite = true;
      }
      if (input.description !== undefined) {
        fields.experienceItems = splitParagraphs(input.description);
      }
      // #484: surface `skills` so the noEmployer path can satisfy the
      // live wire's `skills: [≥1 SkillRefInput]` requirement. Caller
      // supplies catalog ids (discoverable via `ttctl_profile_skills_list`);
      // the `name` field is optional and passed verbatim when supplied.
      if (input.skills !== undefined) {
        fields.skills = input.skills.map((s) => ({ id: s.id, name: s.name ?? "" }));
      }

      // Per-#395: dry-run path is delegated to the core service so the
      // preview's `variables.input.employment.employerId` carries the
      // resolved id (not the raw `company` string). The autocomplete
      // read query fires in dry-run too — EXCEPT on the #401
      // custom-workplace path (`noEmployer: true`), where core skips
      // resolution entirely (zero network). The CreateEmployment
      // mutation transport never fires in dry-run regardless.
      try {
        const outcome = await profile.employment.add(auth.token, fields, { dryRun: input.dryRun === true });
        if (outcome.kind === "preview") {
          return dryRunResponse(outcome.preview);
        }
        return jsonSuccess(outcome.result);
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
        "Update an existing employment entry by id. At least one field must be supplied. `description` is multi-paragraph free-text and splits on blank lines. " +
        "`industryIds`, when supplied, replaces the entry's entire industry set (omit to preserve the current set) — discover ids via `ttctl_profile_industries_autocomplete`. " +
        "`publicationPermit`, `showViaToptal`, and `toptalRelated` are server-gated booleans that callers may explicitly override (#402); each carries a distinct server constraint — see per-field descriptions. " +
        '`publicationPermit` is Rails `.blank?`-gated: the server rejects `false` with `USER_ERROR: "You can\'t leave this empty"`, so any update on a row currently at `false` requires passing `true` explicitly — otherwise the read-current+merge preserves the `false` and the wire rejects.',
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
        industryIds: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            "Catalog Industry ids — when supplied, replaces the entry's industry set (partial update; omit to preserve). Discover via `ttctl_profile_industries_autocomplete`.",
          ),
        publicationPermit: z
          .boolean()
          .optional()
          .describe(
            "Whether this entry is publicly listable. Rails `.blank?`-gated on the server (#402): the server rejects `false` with USER_ERROR. When supplied, overrides the merged current value; when omitted, current state is preserved (defaulting to `true` for null current). Updating any field on a row currently at `false` requires passing `true` explicitly to avoid the blank-gate USER_ERROR.",
          ),
        showViaToptal: z
          .boolean()
          .optional()
          .describe(
            "Whether this entry was sourced via Toptal. Wire-required non-null (#344): the merge unconditionally sends the current value. When supplied, overrides the merged current value.",
          ),
        toptalRelated: z
          .boolean()
          .optional()
          .describe(
            "Whether this entry is a Toptal-related engagement. Server-determined (#402 discovery 2026-05-20): the wire accepts any boolean input, but the server applies business logic (likely keyed on employer affiliation) and may override the supplied value on read. The override THROUGHPUT works (client → wire); the persisted state is server-determined regardless of caller input.",
          ),
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
      // Replace-on-supply: when present, the supplied catalog set wins
      // over the merge placeholder (dry-run) / current-state projection
      // (apply path, via `buildUpdateEmploymentInput`'s `...fields`).
      if (input.industryIds !== undefined) fields.industryIds = input.industryIds;
      // #402 server-gate overrides. `publicationPermit` and `showViaToptal`
      // participate in `buildUpdateEmploymentInput`'s merge (`{ ...merged,
      // ...fields }`) — supplying either beats the current-state fallback,
      // which is the rc.4-preserving behavior. `publicationPermit`
      // specifically unblocks rows where the current value is `false` (the
      // server's Rails `.blank?` gate rejects `false` on update with
      // USER_ERROR).
      //
      // `toptalRelated` is NOT in `buildUpdateEmploymentInput`'s merged
      // object — when supplied it lands directly on the wire payload via
      // the `...fields` spread. The server applies its own business logic
      // (per #402 empirical discovery 2026-05-20) and may override the
      // supplied value on read; client-side throughput works, persisted
      // state is server-determined.
      if (input.publicationPermit !== undefined) fields.publicationPermit = input.publicationPermit;
      if (input.showViaToptal !== undefined) fields.showViaToptal = input.showViaToptal;
      if (input.toptalRelated !== undefined) fields.toptalRelated = input.toptalRelated;

      if (input.dryRun === true) {
        // Dry-run preview shows the full merged shape — the wire-required
        // fields the apply path injects from current state appear as
        // placeholders, plus user-supplied overrides verbatim. Mirrors
        // `basic.set`'s `DRY_RUN_PROFILE_ID_PLACEHOLDER` posture —
        // preserves the zero-transport-in-dry-run invariant (#165 / #379)
        // while honoring #394's AC that the preview shows the full merged
        // input. A real read is intentionally NOT issued here.
        //
        // Field set mirrors `buildUpdateEmploymentInput` in
        // `services/profile/employment/index.ts`: GraphQL-required-non-null
        // (5: experienceItems, position, skills, showViaToptal, startDate
        // — `position` added #407) + Rails `.blank?` gates (company,
        // publicationPermit) + catalog refs (employerId, industryIds —
        // both injected conditionally on current state in the apply path).
        // The optional catalog refs (primaryGeographyId, reportingTo)
        // appear in the preview only when the current row has them; here
        // we surface them as placeholders so the preview is non-misleading
        // about the potential shape.
        const previewEmployment: Record<string, unknown> = {
          experienceItems: profile.employment.DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER,
          position: profile.employment.DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER,
          skills: profile.employment.DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER,
          showViaToptal: profile.employment.DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER,
          startDate: profile.employment.DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER,
          company: profile.employment.DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER,
          publicationPermit: profile.employment.DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER,
          employerId: profile.employment.DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER,
          industryIds: profile.employment.DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER,
          ...fields,
        };
        return dryRunResponse(
          buildMcpDryRunPreview(
            "UpdateEmployment",
            "talent-profile",
            { input: { employmentId: input.id, employment: previewEmployment } },
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
