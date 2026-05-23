// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import {
  buildMcpDryRunPreview,
  domainErrorResponse,
  dryRunResponse,
  genericErrorResponse,
  isToolErrorResponse,
  jsonResponse,
  type ToolRegistrationContext,
} from "./_shared.js";

const TOOL_NAME = "ttctl_profile_specializations_apply";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the `ttctl_profile_specializations_apply` MCP tool (#467).
 * Mirrors the `ttctl profile specializations apply <specializationId>`
 * CLI leaf — DESTRUCTIVE: submits the talent's application to a
 * specialization track (e.g. Marketplace, Expert Crowd) via the
 * `ApplyForSpecialization` mutation on the mobile-gateway portal
 * surface.
 *
 * **DESTRUCTIVE**: no withdraw mutation on the wire. Once submitted,
 * the platform's specialization-application workflow (training,
 * compliance, recruiter review) takes over.
 *
 * **Consent gate** (ADR-009 (ttctl) — `profile-capability` domain):
 * the tool requires `profileCapabilityConsentIssued: true` on input.
 * The Zod schema enforces the literal at validation time (rejecting
 * `false` / absent / non-boolean); the service-layer runtime gate is
 * a defense-in-depth layer covering `as`-cast bypasses. The
 * `destructiveHint: true` MCP annotation signals to the MCP host that
 * this tool effects irreversible state (Claude Desktop and similar
 * hosts surface a confirmation prompt to the user).
 *
 * **Wire shape** (T1 disposition per `docs/wire-validation-routing.md`):
 * the op is in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` so no codegen type
 * exists. The committed snapshot at
 * `packages/e2e/src/wire-snapshots/ApplyForSpecialization.snapshot.json`
 * is the wire-shape authority (captured on the gated E2E run when
 * `TTCTL_E2E_APPLY_SPECIALIZATION` is set).
 *
 * **Write-read symmetry**: the post-apply state surfaces on the next
 * `ttctl_profile_specializations_show` call — the affected
 * specialization's `applicationStatus` transitions to `PENDING` (or
 * directly `ACCEPTED` when the platform short-circuits) and
 * `operations.apply.callable` flips to `false`.
 */
export function registerProfileSpecializationsApplyTool(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: "Apply for a Toptal specialization track (DESTRUCTIVE)",
      description: [
        "Apply for an additional Toptal specialization track (e.g. Marketplace, Expert Crowd) on top of existing memberships. Wraps the `ApplyForSpecialization` gateway-portal mutation.",
        "",
        "**DESTRUCTIVE**: this submits the talent's application to the named specialization track's review queue. No withdraw mutation exists on the wire — once submitted, the platform's compliance / training / recruiter-review workflow takes over.",
        "",
        "**Consent gate** (ADR-009 (ttctl) — `profile-capability` domain): the caller MUST set `profileCapabilityConsentIssued: true`. Auto-filling without explicit user direction is FORBIDDEN.",
        "",
        '**Pre-flight check**: call `ttctl_profile_specializations_show` first — every row carries `operations.apply.callable: boolean` and `operations.apply.messages: string[]` indicating whether the apply would succeed (and the server-supplied reasons when it would not, e.g. "Already a member of this specialization.").',
        "",
        "**Post-apply verification**: call `ttctl_profile_specializations_show` again — the affected row's `applicationStatus` transitions to `PENDING` and `operations.apply.callable` flips to `false`.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Apply me for the Marketplace specialization."',
        '  - "Submit my application for Expert Crowd."',
        '  - "Add the Marketplace track to my profile."',
      ].join("\n"),
      inputSchema: {
        specializationId: z
          .string()
          .min(1)
          .describe(
            "Specialization track id (from `ttctl_profile_specializations_show`'s `id` field). NOT the slug — pass the opaque id verbatim.",
          ),
        profileCapabilityConsentIssued: z
          .literal(true)
          .describe(
            "REQUIRED — MUST be `true`. Acknowledges this is a destructive profile-capability action (submits the talent's application to the named specialization track; no withdraw via TTCtl). See ADR-009 (ttctl) § Decision Part 1 for the per-domain consent vocabulary.",
          ),
        dryRun: DRY_RUN_FIELD,
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (input) => {
      const auth = await ctx.loadTokenForTool(TOOL_NAME);
      if (isToolErrorResponse(auth)) return auth;

      // Core's `apply()` supports its own dry-run short-circuit (no
      // pre-fetch; mirrors `applications.apply()`'s pattern). Branch
      // before the wire call so the consent gate still fires first.
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "ApplyForSpecialization",
            "mobile-gateway",
            { specializationId: input.specializationId },
            auth.token,
          ),
        );
      }

      try {
        const outcome = await profile.specializations.apply(auth.token, input.specializationId, {
          profileCapabilityConsentIssued: input.profileCapabilityConsentIssued,
        });
        // Outcome is always `kind: "applied"` here — the dry-run branch
        // above returned before reaching this line.
        if (outcome.kind === "preview") {
          return dryRunResponse(outcome.preview);
        }
        return jsonResponse(outcome.result);
      } catch (err) {
        const typed = ttctlErrorToToolResponseOrNull(err);
        if (typed !== null) return typed;
        if (err instanceof profile.specializations.ProfileError) {
          return domainErrorResponse(TOOL_NAME, err);
        }
        return genericErrorResponse(TOOL_NAME, err);
      }
    },
  );
}
