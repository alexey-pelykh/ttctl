// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { surveys } from "@ttctl/core";
import { z } from "zod";

import { ttctlErrorToToolResponseOrNull } from "../errors.js";
import type { ToolErrorResponse } from "../errors.js";
import { buildMcpDryRunPreview, dryRunResponse, type ToolRegistrationContext } from "./_shared.js";

const DRY_RUN_FIELD = z
  .boolean()
  .optional()
  .describe(
    "Preview the request without executing. Returns `{ ok: true, dryRun: true, preview }` with operationName + variables + redacted bearer header. Default: false.",
  );

/**
 * Register the `ttctl_surveys_list` MCP tool. Read-only access to the
 * viewer's pending surveys. Tool name is the canonical CLI path joined
 * with `_` per project policy.
 */
export function registerSurveysTools(server: McpServer, ctx: ToolRegistrationContext): void {
  server.registerTool(
    "ttctl_surveys_list",
    {
      title: "List pending surveys",
      description: [
        "List the signed-in user's pending Toptal surveys (post-interview `INTERVIEW_ENDED`",
        "feedback, NPS, engagement surveys, etc.).",
        "",
        "Each survey carries `id`, `kind` (e.g. INTERVIEW_ENDED, NPS, ENGAGEMENT_ENDED), `title`,",
        "`isMandatory`, `alreadyAnswered`, and `questions[]`. Each question carries `id`, `label`,",
        "`inputType`, `isMandatory`, and the selectable `answers[]` (`id` / `label` / `value`) —",
        "everything needed to drive a future survey-answer flow.",
        "",
        "Read-only — listing never mutates survey state.",
        "",
        "Example user prompts:",
        '  - "What surveys do I have pending on Toptal?"',
        '  - "Show me my post-interview feedback requests."',
      ].join("\n"),
      inputSchema: {
        dryRun: DRY_RUN_FIELD,
      },
    },
    async (args) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;
      if (args.dryRun === true) {
        return dryRunResponse(buildMcpDryRunPreview("PendingSurveys", "mobile-gateway", {}, auth.token));
      }
      try {
        const items = await surveys.list(auth.token);
        return successResponse(items);
      } catch (err) {
        return mapSurveysError(err);
      }
    },
  );

  server.registerTool(
    "ttctl_surveys_submit",
    {
      title: "Submit answers to a pending survey (DESTRUCTIVE)",
      description: [
        "Submit structured answers to one of the signed-in user's pending Toptal surveys",
        "(post-interview `INTERVIEW_ENDED` feedback, NPS, engagement surveys, etc.) via the",
        "`SubmitSurvey` mutation.",
        "",
        "**DESTRUCTIVE & IRREVERSIBLE**: a submitted survey cannot be un-answered, and your",
        "feedback is routed to a third party (the interviewing client, the engagement, or Toptal).",
        "",
        "**Consent gate** (ADR-009 (ttctl) — `survey-submission` domain): the caller MUST set",
        "`surveySubmissionConsentIssued: true`. Auto-filling without explicit user direction is FORBIDDEN.",
        "",
        "**Pre-flight discovery** (`ttctl_surveys_list`): each pending survey carries `id`, `kind`, and",
        "`questions[]`. For each question to answer, pass `{ questionId, value }`:",
        "  - multiple-choice question (`answers[]` non-empty) → `value` is the chosen option's `value`",
        "  - free-text question (`answers[]` empty) → `value` is the free text",
        "The survey `kind` and per-question answer-option ids are resolved from `surveys list` automatically.",
        "",
        "Set `dryRun: true` to preview the request (operationName + your answers + redacted bearer) without",
        "submitting; option-id and kind resolution run against the live survey only on the real call.",
        "",
        "Example user prompts that should map to this tool:",
        '  - "Submit my post-interview survey: rate the interviewer 5 and say it matched well."',
        '  - "Answer my pending NPS survey with a 9."',
      ].join("\n"),
      inputSchema: {
        surveyId: z.string().min(1).describe("Pending survey id from `ttctl_surveys_list`."),
        answers: z
          .array(
            z.object({
              questionId: z.string().min(1).describe("SurveyQuestion id from `ttctl_surveys_list`."),
              value: z.string().describe("Multiple-choice: the chosen option's `value`. Free-text: the answer text."),
            }),
          )
          .min(1)
          .describe("One entry per question being answered."),
        kind: z
          .string()
          .optional()
          .describe("Survey kind override (e.g. INTERVIEW_ENDED). Resolved from `surveys list` when omitted."),
        surveySubmissionConsentIssued: z
          .literal(true)
          .describe(
            "REQUIRED — MUST be `true`. Acknowledges this irreversibly submits answers routed to a third party. See ADR-009 (ttctl) § Decision (survey-submission domain).",
          ),
        dryRun: DRY_RUN_FIELD,
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async (input) => {
      const auth = await ctx.resolveToolAuth();
      if (!auth.ok) return auth.response;

      // Dry-run previews the intent only — it must not touch the network
      // (option-id / kind resolution via `surveys list` is deferred to the
      // real call). Branch before that resolve + the service consent gate.
      if (input.dryRun === true) {
        return dryRunResponse(
          buildMcpDryRunPreview(
            "SubmitSurvey",
            "mobile-gateway",
            {
              surveyId: input.surveyId,
              answers: input.answers,
              ...(input.kind !== undefined ? { kind: input.kind } : {}),
            },
            auth.token,
          ),
        );
      }

      try {
        const args: surveys.SubmitSurveyArgs =
          input.kind === undefined
            ? { surveyId: input.surveyId, answers: input.answers }
            : { surveyId: input.surveyId, answers: input.answers, kind: input.kind };
        const result = await surveys.submit(auth.token, args, {
          surveySubmissionConsentIssued: input.surveySubmissionConsentIssued,
        });
        return successResponse(result);
      } catch (err) {
        return mapSurveysError(err);
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

function mapSurveysError(err: unknown): ToolErrorResponse {
  const typed = ttctlErrorToToolResponseOrNull(err);
  if (typed !== null) return typed;
  if (err instanceof surveys.SurveysError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [
            `Error: ${err.message}`,
            "",
            "Recovery: Retry; if the failure persists, file an issue.",
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
          `Error: surveys request failed: ${message}`,
          "",
          "Recovery: Retry; if the failure persists, file an issue.",
          "",
          "(Code: UNKNOWN)",
        ].join("\n"),
      },
    ],
  };
}
