// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { profile } from "@ttctl/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveToolAuth } from "../../auth.js";
import { ttctlErrorToToolResponseOrNull } from "../../errors.js";
import type { ToolErrorResponse } from "../../errors.js";

/**
 * Register the four `ttctl_profile_visas_*` MCP tools.
 *
 * Tool names use the canonical sub-domain `visas` (no CLI alias). Each
 * tool maps 1:1 to a CLI leaf.
 */
export function registerVisasTools(server: McpServer): void {
  server.registerTool(
    "ttctl_profile_visas_list",
    {
      title: "List travel visas",
      description: "List the signed-in user's travel-visa records (id, country, type, expiry).",
      inputSchema: {},
    },
    async () => {
      const auth = await resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const visas = await profile.visas.list(auth.token);
        return successResponse(visas);
      } catch (err) {
        return mapVisasError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_visas_add",
    {
      title: "Create a travel-visa record",
      description:
        "Create a new travel-visa record. Both `countryId` and `visaType` are required; `expiryDate` is optional.",
      inputSchema: {
        countryId: z.string().describe("Country id (server-issued; query the Toptal travel-visa form for valid ids)"),
        visaType: z.string().describe("Visa type (e.g., Schengen, B1/B2, Tier 5)"),
        expiryDate: z.string().optional().describe("Expiry date in YYYY-MM-DD"),
      },
    },
    async (args) => {
      const auth = await resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const input: profile.visas.TravelVisaInput = {
          countryId: args.countryId,
          visaType: args.visaType,
        };
        if (args.expiryDate !== undefined) input.expiryDate = args.expiryDate;
        const visas = await profile.visas.add(auth.token, input);
        return successResponse(visas);
      } catch (err) {
        return mapVisasError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_visas_update",
    {
      title: "Update a travel-visa record",
      description: "Update fields on a travel-visa record by id. Only supplied fields are updated.",
      inputSchema: {
        id: z.string().describe("Id of the travel-visa record"),
        countryId: z.string().optional().describe("Country id"),
        visaType: z.string().optional().describe("Visa type"),
        expiryDate: z.string().optional().describe("Expiry date in YYYY-MM-DD"),
      },
    },
    async (args) => {
      const auth = await resolveToolAuth();
      if (!auth.ok) return auth.response;
      const changes: profile.visas.TravelVisaInput = {};
      if (args.countryId !== undefined) changes.countryId = args.countryId;
      if (args.visaType !== undefined) changes.visaType = args.visaType;
      if (args.expiryDate !== undefined) changes.expiryDate = args.expiryDate;
      try {
        const visas = await profile.visas.update(auth.token, args.id, changes);
        return successResponse(visas);
      } catch (err) {
        return mapVisasError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_profile_visas_remove",
    {
      title: "Remove a travel-visa record",
      description: "Remove a travel-visa record by id.",
      inputSchema: {
        id: z.string().describe("Id of the travel-visa record to remove"),
      },
    },
    async (args) => {
      const auth = await resolveToolAuth();
      if (!auth.ok) return auth.response;
      try {
        const visas = await profile.visas.remove(auth.token, args.id);
        return successResponse(visas);
      } catch (err) {
        return mapVisasError(err);
      }
    },
  );
}

interface ToolSuccessResponse {
  [x: string]: unknown;
  content: [{ type: "text"; text: string }];
}

function successResponse(data: unknown): ToolSuccessResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function mapVisasError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof profile.visas.VisasError) {
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
          `Error: travel-visa request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}
