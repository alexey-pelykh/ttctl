// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { z } from "zod";

/**
 * MCP `outputSchema` definitions for the top-10 write-capable tools
 * (#226). Each schema mirrors the TypeScript return type from
 * `@ttctl/core` so LLM clients reading the tool registry can validate
 * the structured payload they receive.
 *
 * Each schema describes the SUCCESS-path payload only. Dry-run responses
 * use the uniform `{ ok, dryRun, preview }` envelope advertised via the
 * tool description (see `_shared.ts` § `dryRunResponse`) and intentionally
 * carry NO `structuredContent` — the SDK skips `outputSchema` validation
 * when `structuredContent` is absent (per `@modelcontextprotocol/sdk`
 * `_validateOutput`), so dry-run paths bypass success-shape validation
 * cleanly.
 *
 * The MCP SDK's `normalizeObjectSchema` accepts only ZodObject shapes for
 * `outputSchema`; unions and discriminated unions are silently dropped.
 * Therefore each schema below is a single `z.object()` describing the
 * apply-path payload — sufficient for the AC ("LLM clients can validate
 * tool output against the schema").
 */

/**
 * Shape returned by `profile.basic.set()` on the apply path —
 * mirrors `UpdateProfileResult` from `@ttctl/core`.
 */
export const profileBasicUpdateOutputSchema = z.object({
  profile: z.object({
    id: z.string(),
    about: z.string().nullable(),
    quote: z.string().nullable(),
  }),
  notice: z.string().nullable(),
});

/**
 * Shape returned by `profile.basic.photoUpload()` — mirrors `PhotoUrl`
 * from `@ttctl/core`.
 */
export const profileBasicPhotoUploadOutputSchema = z.object({
  default: z.string().nullable(),
  original: z.string().nullable(),
  small: z.string().nullable(),
  cropped: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .nullable(),
  isResolutionSatisfied: z.boolean(),
});

/**
 * Shape returned by `profile.resume.upload()` — mirrors
 * `UploadResumeResult` from `@ttctl/core`.
 */
export const profileResumeUploadOutputSchema = z.object({
  success: z.boolean(),
});

/**
 * Shape returned by `profile.education.add()` / `update()` — mirrors
 * `Education` from `@ttctl/core`.
 */
export const profileEducationRowOutputSchema = z.object({
  id: z.string(),
  institution: z.string(),
  degree: z.string(),
  fieldOfStudy: z.string().nullable(),
  location: z.string().nullable(),
  title: z.string().nullable(),
  yearFrom: z.number().nullable(),
  yearTo: z.number().nullable(),
  highlight: z.boolean(),
});

/**
 * Shape returned by the `*_remove` tools' structured-content slot —
 * `{ id, removed: true }`. The `text` content slot retains the
 * human-readable confirmation; `structuredContent` exposes a typed
 * acknowledgment.
 */
export const profileRowRemoveOutputSchema = z.object({
  id: z.string(),
  removed: z.literal(true),
});

/**
 * Shape returned by `profile.employment.add()` / `update()` — mirrors
 * `Employment` from `@ttctl/core`. The last four fields were added in
 * #344 to close the write/read asymmetry; they MUST stay in sync with
 * the `Employment` interface or the `add`/`update` tools' declared
 * output schema would under-report the rows they actually return.
 */
export const profileEmploymentRowOutputSchema = z.object({
  id: z.string(),
  company: z.string(),
  position: z.string(),
  companyWebsite: z.string().nullable(),
  noWebsite: z.boolean(),
  startDate: z.number().nullable(),
  endDate: z.number().nullable(),
  experienceItems: z.array(z.string()).nullable(),
  highlight: z.boolean(),
  showViaToptal: z.boolean(),
  toptalRelated: z.boolean(),
  publicationPermit: z.boolean().nullable(),
  reportingTo: z.string().nullable(),
  industries: z.array(z.object({ id: z.string(), name: z.string() })),
  primaryGeography: z.object({ id: z.string(), code: z.string().nullable(), name: z.string().nullable() }).nullable(),
});

/**
 * Shape returned by `profile.industries.update()` / `show()` — mirrors
 * `IndustryProfile` from `@ttctl/core`.
 */
export const profileIndustriesRowOutputSchema = z.object({
  id: z.string(),
  title: z.string(),
  about: z.string().nullable(),
  domainArea: z.string().nullable(),
});

/**
 * Tool names (frozen) that the test suite asserts must carry a populated
 * `outputSchema`. Adding a new write-capable tool: append its name here
 * and define the schema above.
 */
export const TOOLS_WITH_OUTPUT_SCHEMA = [
  "ttctl_profile_basic_update",
  "ttctl_profile_basic_photo_upload",
  "ttctl_profile_resume_upload",
  "ttctl_profile_education_add",
  "ttctl_profile_education_update",
  "ttctl_profile_education_remove",
  "ttctl_profile_employment_add",
  "ttctl_profile_employment_update",
  "ttctl_profile_employment_remove",
  "ttctl_profile_industries_update",
  "ttctl_profile_industries_show",
] as const;
