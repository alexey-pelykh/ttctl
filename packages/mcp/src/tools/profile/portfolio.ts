// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../../errors.js";
import type { ToolErrorResponse } from "../../errors.js";
import { UPLOAD_CATEGORIES, decodeFileUploadInput, fileUploadInputSchema } from "../file-upload.js";
import { buildMcpDryRunPreview, dryRunResponse, type ToolRegistrationContext } from "../_shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the eight `ttctl_profile_portfolio_*` MCP tools per the #75
 * spec. Tool names use the canonical sub-domain `portfolio` (NOT the CLI
 * alias `projects`) per project policy.
 *
 * Each tool maps 1:1 to a CLI leaf — the schemas describe the same set
 * of fields, with file-upload tools accepting the dual `filePath` /
 * `content` (base64) input per the spec.
 *
 * Dry-run path (issue #165): every tool accepts `dryRun?: boolean`. When
 * `dryRun: true`, returns the uniform `{ ok: true, dryRun: true, preview }`
 * envelope via MCP-layer preview building. For `upload_cover` /
 * `upload_file`, the dry-run path emits the GraphQL operations envelope
 * only (`file: null` placeholder) — the multipart binary body is NOT
 * enumerated, mirroring the `profile.resume.upload` convention.
 * `profileId` carries `DRY_RUN_PROFILE_ID_PLACEHOLDER` where the apply
 * path resolves it via a sibling profile read.
 */
export function registerPortfolioTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_profile_portfolio_list",
    {
      title: "List portfolio items",
      description: "List the signed-in user's portfolio items (id, title, link, highlight, etc).",
      inputSchema: { dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "getPortfolioItems",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER },
            auth.token,
          ),
        );
      }
      try {
        const items = await profile.portfolio.list(auth.token);
        return successResponse(items);
      } catch (err) {
        return mapPortfolioError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_portfolio_add",
    {
      title: "Create a portfolio item",
      description:
        "Create a new portfolio item. `title` is required; other fields are optional. Use `ttctl_profile_portfolio_upload_cover` first if you want to attach a cover image, then pass the resulting `coverImageCacheName` via the `coverImage` field on a follow-up `update` call (or supply via the underlying GraphQL input — currently the cover-then-create flow is two-step).",
      inputSchema: {
        title: z.string().describe("Portfolio item title"),
        description: z.string().optional().describe("Long-form description of the item"),
        link: z.string().optional().describe("Primary URL for the item"),
        websiteUrl: z.string().optional().describe("Public website URL associated with the item"),
        accomplishment: z.string().optional().describe("Short accomplishment summary"),
        clientOrCompanyName: z.string().optional().describe("Client or company name"),
        publicationPermit: z
          .boolean()
          .optional()
          .describe(
            "Server-gated boolean: the server's Rails `.blank?` gate rejects `false` on create with USER_ERROR (`code: blank, key: publicationPermit`) — pass `true` (the default) to satisfy the gate. The same field on Employment has a server-controlled persisted-state semantic (#488) where the caller-supplied value may not match what the server persists; Portfolio likely shares this semantic (uninvestigated). The field does NOT gate public listing on the resume.",
          ),
        toptalRelated: z.boolean().optional().describe("Whether the work is Toptal-related"),
        showViaToptal: z.boolean().optional().describe("Whether the item should be visible via Toptal"),
        highlight: z.boolean().optional().describe("Whether to mark this item as a highlight"),
        industryIds: z
          .array(z.string())
          .min(1)
          .describe(
            'Catalog Industry ids (at least one required). Discover via `ttctl_profile_industries_autocomplete` or `ttctl profile industries autocomplete "<query>"`.',
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      const baseInput = buildPortfolioInput(args);
      // industryIds is required by the schema (zod `.min(1)`); cast through
      // the narrowed add-input type so the type-narrowed `add()` accepts it.
      const input: profile.portfolio.PortfolioItemAddInput = { ...baseInput, industryIds: args.industryIds };
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "createPortfolioItem",
            "talent-profile",
            { input: { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER, portfolioItem: input } },
            auth.token,
          ),
        );
      }
      try {
        const items = await profile.portfolio.add(auth.token, input);
        return successResponse(items);
      } catch (err) {
        return mapPortfolioError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_portfolio_update",
    {
      title: "Update a portfolio item",
      description:
        "Update fields on an existing portfolio item by id. Only supplied fields are updated. " +
        "`industryIds`, when supplied, replaces the item's entire industry set (omit to preserve). " +
        "`skills`, when supplied, replaces the item's entire catalog-skill set (omit to preserve) — discover ids via `ttctl_profile_skills_list`.",
      inputSchema: {
        id: z.string().describe("Id of the portfolio item to update"),
        title: z.string().optional().describe("Portfolio item title"),
        description: z.string().optional().describe("Long-form description of the item"),
        link: z.string().optional().describe("Primary URL for the item"),
        websiteUrl: z.string().optional().describe("Public website URL associated with the item"),
        accomplishment: z.string().optional().describe("Short accomplishment summary"),
        clientOrCompanyName: z.string().optional().describe("Client or company name"),
        publicationPermit: z
          .boolean()
          .optional()
          .describe(
            "Server-gated boolean: input-side Rails `.blank?` gate rejects `false` on the wire with USER_ERROR (`code: blank, key: publicationPermit`) — pass `true` when updating a `false`-current item so other fields can be updated. The same field on Employment has a server-controlled persisted-state semantic (#488) where the caller-supplied value may not match what the server persists; Portfolio likely shares this semantic (uninvestigated). The field does NOT gate public listing on the resume.",
          ),
        toptalRelated: z.boolean().optional().describe("Whether the work is Toptal-related"),
        showViaToptal: z.boolean().optional().describe("Whether the item should be visible via Toptal"),
        highlight: z.boolean().optional().describe("Whether to mark this item as a highlight"),
        industryIds: z
          .array(z.string())
          .min(1)
          .optional()
          .describe("Catalog Industry ids — when supplied, replaces the item's industry set (partial update)."),
        skills: z
          .array(
            z.object({
              id: z.string().min(1).describe("catalog Skill id"),
              name: z.string().optional().describe("display name (optional; supplied verbatim if known)"),
            }),
          )
          .min(1)
          .optional()
          .describe(
            "Catalog skills — when supplied, replaces the item's entire skill set (partial update; omit to preserve). Discover ids via `ttctl_profile_skills_list`. The Toptal server enforces a non-empty `skills` set on `updatePortfolioItem`; ttctl mirrors that as `min(1)` on the wrapper to fail fast.",
          ),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      const { id, ...rest } = args;
      const changes = buildPortfolioInput(rest);
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "updatePortfolioItem",
            "talent-profile",
            { input: { portfolioItemId: id, portfolioItem: changes } },
            auth.token,
          ),
        );
      }
      try {
        const items = await profile.portfolio.update(auth.token, id, changes);
        return successResponse(items);
      } catch (err) {
        return mapPortfolioError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_portfolio_remove",
    {
      title: "Remove a portfolio item",
      description: "Remove a portfolio item by id.",
      inputSchema: {
        id: z.string().describe("Id of the portfolio item to remove"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "removePortfolioItem",
            "talent-profile",
            { input: { portfolioItemId: args.id } },
            auth.token,
          ),
        );
      }
      try {
        const items = await profile.portfolio.remove(auth.token, args.id);
        return successResponse(items);
      } catch (err) {
        return mapPortfolioError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_portfolio_reorder",
    {
      title: "Reorder a portfolio item",
      description:
        "Move a portfolio item to an absolute 0-based position. To compute relative-to-neighbour positions, list portfolio items first to find indices.",
      inputSchema: {
        id: z.string().describe("Id of the portfolio item to move"),
        position: z.number().int().min(0).describe("Absolute 0-based position to move the item to"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "changePortfolioItemPosition",
            "talent-profile",
            { input: { portfolioItemId: args.id, position: args.position } },
            auth.token,
          ),
        );
      }
      try {
        const items = await profile.portfolio.reorder(auth.token, args.id, args.position);
        return successResponse(items);
      } catch (err) {
        return mapPortfolioError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_portfolio_highlight",
    {
      title: "Toggle highlight on a portfolio item",
      description: "Set or clear the `highlight` flag on a portfolio item.",
      inputSchema: {
        id: z.string().describe("Id of the portfolio item"),
        highlight: z.boolean().default(true).describe("`true` to set highlight, `false` to clear"),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "highlightPortfolioItem",
            "talent-profile",
            { id: args.id, highlight: args.highlight },
            auth.token,
          ),
        );
      }
      try {
        const result = await profile.portfolio.highlight(auth.token, args.id, args.highlight);
        return successResponse(result);
      } catch (err) {
        return mapPortfolioError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_portfolio_upload_cover",
    {
      title: "Upload a portfolio cover image",
      description:
        "Upload a cover image for the user's portfolio. Supply EITHER `filePath` (server-relative; preferred when the host has filesystem access — Claude Desktop, Claude Code) OR `content` (base64-encoded; for web-hosted clients without filesystem access). Returns `coverImageCacheName` and `coverImageUrl`; pass the cache name into a subsequent portfolio-add or portfolio-update call's `coverImage` field to bind the cover to a specific item. Server requires the image to be at least 750x500 px and under 5 MB.",
      inputSchema: {
        ...fileUploadInputSchema,
        cropX: z.number().int().nonnegative().optional().describe("crop origin x (px). Default: 0 (whole image)."),
        cropY: z.number().int().nonnegative().optional().describe("crop origin y (px). Default: 0 (whole image)."),
        cropW: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("crop width (px). Default: PNG image width if detectable, otherwise oversized (server clamps)."),
        cropH: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("crop height (px). Default: PNG image height if detectable, otherwise oversized (server clamps)."),
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "uploadPortfolioCover",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER, transformation: null, file: null },
            auth.token,
          ),
        );
      }
      const decoded = decodeFileUploadInput(args, UPLOAD_CATEGORIES.portfolioCover);
      if ("isError" in decoded) return decoded;
      // Build the transformation only when ALL four crop fields are
      // supplied; the service auto-defaults when omitted.
      const transformation: profile.portfolio.PortfolioCoverTransformation | undefined =
        args.cropX !== undefined && args.cropY !== undefined && args.cropW !== undefined && args.cropH !== undefined
          ? { cropX: args.cropX, cropY: args.cropY, cropW: args.cropW, cropH: args.cropH }
          : undefined;
      try {
        const result = await profile.portfolio.uploadCover(auth.token, decoded, transformation);
        return successResponse(result);
      } catch (err) {
        return mapPortfolioError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_portfolio_upload_file",
    {
      title: "Upload a portfolio attachment file",
      description:
        "Upload an arbitrary attachment file for the user's portfolio. Supply EITHER `filePath` (preferred when the host has filesystem access) OR `content` (base64). Returns `fileCacheName` and `fileUrl`.",
      inputSchema: { ...fileUploadInputSchema, dryRun: DRY_RUN_FIELD },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "uploadPortfolioFile",
            "talent-profile",
            { profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER, file: null },
            auth.token,
          ),
        );
      }
      const decoded = decodeFileUploadInput(args, UPLOAD_CATEGORIES.portfolioFile);
      if ("isError" in decoded) return decoded;
      try {
        const result = await profile.portfolio.uploadFile(auth.token, decoded);
        return successResponse(result);
      } catch (err) {
        return mapPortfolioError(err);
      }
    },
  );
}

/**
 * Tool success response. Carries the open `[x: string]: unknown` index
 * signature the SDK's `CallToolResult` requires (so the structured-content
 * path remains compatible). Each tool encodes its result as a single JSON
 * blob in the `content[0].text` slot — MCP-aware clients render or parse.
 */
interface ToolSuccessResponse {
  [x: string]: unknown;
  content: [{ type: "text"; text: string }];
}

function successResponse(data: unknown): ToolSuccessResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Filter `undefined` values out of the optional-fields map so the
 * resulting `PortfolioItemInput` satisfies `exactOptionalPropertyTypes`
 * (which rejects `string | undefined` where `string` is expected).
 *
 * Zod's optional fields surface as `T | undefined` at the inferred type
 * level; the service layer uses pure-optional `T?` keys. This helper
 * bridges the two.
 */
function buildPortfolioInput(args: {
  title?: string | undefined;
  description?: string | undefined;
  link?: string | undefined;
  websiteUrl?: string | undefined;
  accomplishment?: string | undefined;
  clientOrCompanyName?: string | undefined;
  publicationPermit?: boolean | undefined;
  toptalRelated?: boolean | undefined;
  showViaToptal?: boolean | undefined;
  highlight?: boolean | undefined;
  industryIds?: string[] | undefined;
  // #541: catalog skill refs accepted on update. `name` is optional on
  // the wrapper schema — falls back to "" for the wire (the Toptal
  // server keys on `id`; the empty display-name path matches the CLI
  // `--skill-id` shape).
  skills?: { id: string; name?: string | undefined }[] | undefined;
}): profile.portfolio.PortfolioItemInput {
  const out: profile.portfolio.PortfolioItemInput = {};
  if (args.title !== undefined) out.title = args.title;
  if (args.description !== undefined) out.description = args.description;
  if (args.link !== undefined) out.link = args.link;
  if (args.websiteUrl !== undefined) out.websiteUrl = args.websiteUrl;
  if (args.accomplishment !== undefined) out.accomplishment = args.accomplishment;
  if (args.clientOrCompanyName !== undefined) out.clientOrCompanyName = args.clientOrCompanyName;
  if (args.publicationPermit !== undefined) out.publicationPermit = args.publicationPermit;
  if (args.toptalRelated !== undefined) out.toptalRelated = args.toptalRelated;
  if (args.showViaToptal !== undefined) out.showViaToptal = args.showViaToptal;
  if (args.highlight !== undefined) out.highlight = args.highlight;
  if (args.industryIds !== undefined) out.industryIds = args.industryIds;
  if (args.skills !== undefined) {
    out.skills = args.skills.map((s) => ({ id: s.id, name: s.name ?? "" }));
  }
  return out;
}

function mapPortfolioError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof profile.portfolio.PortfolioError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `Error: ${err.message}`,
            "",
            "Recovery: Adjust the tool input or retry; see the code below.",
            "",
            `(Code: ${err.code})`,
          ].join("\n"),
        },
      ],
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          `Error: portfolio request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}
