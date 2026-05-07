// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `profile.external` service module.
 *
 * The "external" sub-domain is the most heterogeneous of the 11 profile
 * sub-domains: it bundles operations that the operation catalog clusters
 * under the umbrella names `external profile / advanced profile / wizard`.
 * Per issue #76 the v0 user-facing surface exposes:
 *
 *   1. {@link update}                   — set external profile URLs (linkedin/github/website/…)
 *   2. {@link customRequirementsShow}   — read the three onboarding-readiness toggles
 *   3. {@link customRequirementsSet}    — toggle the three onboarding-readiness booleans
 *   4. {@link readiness}                — read the per-section completion meter
 *   5. {@link recommendations}          — read the per-section "do this next" recommendations
 *   6. {@link advancedWizardShow}       — read the advanced-profile-wizard status
 *
 * ## Spec / API divergences (documented per #76 AC)
 *
 * The issue (#76) describes `customRequirementsSet` as multi-paragraph
 * **free-text** (and the AC explicitly lists "Free-text helper (#70) consumed
 * by `external custom-requirements set`"). Empirically — see
 * `research/captures/web/inputs/UpdateCustomRequirementsInput.json` and
 * `research/graphql/talent_profile/fragments/CustomRequirements.graphql` —
 * the underlying `CustomRequirementsInput` is in fact **three booleans**
 * (`backgroundCheck`, `drugTest`, `timeTrackingTools`); no free-text field
 * exists on the schema. The capture notes:
 *
 *   "Form has no save button — autosaves on checkbox toggle. Each toggle
 *    sends ALL three current states (no diff/PATCH semantics)."
 *
 * We follow API ground truth: the `set` function takes the boolean trio.
 * The free-text helper (#70) is therefore **not** consumed by this leaf.
 * The AC item failure is surfaced in the PR description and CHANGELOG.
 *
 * The issue spec also lists `--portfolio-url` as a field of `update`. The
 * actual schema's settable external-profile fields are `linkedin / github /
 * website / twitter / behance / dribbble`; a portfolio URL is a server-
 * determined read (`getPublicProfileUrl`), not a settable input. We expose
 * the schema-supported set; `--portfolio-url` is dropped.
 *
 * ## Operations explicitly NOT exposed at v0
 *
 * Per issue #76 § "Operations explicitly NOT exposed as user-facing CLI
 * leaves", the following are intentionally **not** implemented at v0. None
 * is exported from this module — they are not even private helpers — so
 * future maintainers can audit the exact deferral set without shadow-API
 * hazards. File a follow-up issue if user demand surfaces:
 *
 *   - `getStepsAndLinks`               — implementation-detail navigation helper
 *   - `getProfilePrefillStatus`        — server-determined prefill state
 *   - `getProfileSettingsUrls`         — settings-URL navigator
 *   - `getPublicProfileUrl`            — single value; defer until user demand
 *   - `getProfileVersionsCount`        — internal telemetry
 *   - `analyticsInfo`                  — internal telemetry
 *   - `getProfileTimestamps`           — internal telemetry
 *   - `getProfileItems`                — generic list with unclear semantics
 *   - `UpdateAdvancedProfileWizardStatus` — wizard-internal state mutation
 *
 * ## Wire-shape decisions
 *
 * All operations target the talent_profile surface
 * (`https://www.toptal.com/api/talent_profile/graphql`) which is
 * Cloudflare-protected and uses {@link impersonatedTransport}. Because the
 * talent_profile backend does not publish a persisted-query catalog, every
 * operation is sent as a full-document GraphQL request. We hand-write the
 * query/mutation strings here (mirrored from `research/graphql/
 * talent_profile/operations/`) and the input/output TypeScript types because
 * codegen is currently scoped to the gateway surface only (see
 * `codegen.config.ts`).
 *
 * Mutation input shapes follow Pattern 1 of
 * `research/notes/10-mutation-input-patterns.md` (`{ input: { profileId,
 * <wrapper>: { … } } }`). The wrapper key is `externalProfiles` for
 * `UpdateExternalProfiles` and `customRequirements` for
 * `updateCustomRequirements` (the latter is empirically validated by
 * `research/captures/web/inputs/UpdateCustomRequirementsInput.json`).
 */

import { AuthRevokedError, TtctlError } from "../../../auth/errors.js";
import { impersonatedTransport } from "../../../transport.js";
import type { TransportResponse } from "../../../transport.js";
import { ProfileError, show as basicShow } from "../basic/index.js";
import type { ProfileErrorCode } from "../basic/index.js";
import { isAuthRevokedExtensionCode } from "../shared.js";

// Re-export the shared `ProfileError` / `ProfileErrorCode` so consumers can
// continue to write `profile.external.ProfileError` (mirrors the
// `profile.basic.ProfileError` ergonomics).
export { ProfileError };
export type { ProfileErrorCode };

interface GraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

interface UserErrorEntry {
  message?: string | null;
  field?: string | null;
}

/**
 * Resolve the signed-in user's `profileId` by replaying the rich
 * `ProfileShow` mobile-gateway query and projecting `viewerRole.profileId`
 * out of the response. Mirrors the pattern from `profile.basic.set()`.
 *
 * Throws the same error taxonomy as `basic.show()`: `AuthRevokedError`,
 * `ProfileError(NO_VIEWER)`, `ProfileError(GRAPHQL_ERROR)`,
 * `ProfileError(NETWORK_ERROR)`. Callers re-throw verbatim.
 */
async function getProfileId(token: string): Promise<string> {
  const profile = await basicShow(token);
  const profileId = profile.viewer?.viewerRole.profileId;
  if (profileId === undefined) {
    throw new ProfileError(
      "NO_VIEWER",
      "Cannot fulfil request: viewer or profile id missing from the session response.",
    );
  }
  return profileId;
}

/**
 * Common HTTP / GraphQL response shape for talent_profile operations.
 * Each operation declares its own concrete `data` payload type and threads
 * it through {@link parseTalentProfileResponse}.
 */
interface TalentProfileResponse<TData> {
  data?: TData | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Parse a `TransportResponse` from the talent_profile surface into the
 * typed `data` payload. Centralises the HTTP-status check, top-level
 * GraphQL `errors` interpretation (with auth-revoked routing), and `data`
 * presence check that every operation in this module needs.
 *
 * Returns `unknown` so callers can narrow to their operation-specific
 * payload shape via a single `as` cast — this avoids `no-unnecessary-type-
 * parameters` lint hits while keeping every call site one-line.
 *
 * `commandLabel` is folded into the error message ("<commandLabel> failed:
 * …") so the user sees a meaningful prefix even for operations that share
 * the same error code.
 */
function parseTalentProfileResponse(
  res: TransportResponse,
  commandLabel: string,
  fallbackErrorCode: ProfileErrorCode = "UNKNOWN",
): unknown {
  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError(fallbackErrorCode, `${commandLabel} returned HTTP ${res.status.toString()}`);
  }
  const body = res.body as TalentProfileResponse<unknown> | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    const message = first?.message ?? "GraphQL error";
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ProfileError("GRAPHQL_ERROR", `${commandLabel} failed: ${message}`);
  }
  if (!body?.data) {
    throw new ProfileError(fallbackErrorCode, `${commandLabel} response had no \`data\` field`);
  }
  return body.data;
}

/**
 * Wrap a transport call so any thrown error becomes a typed
 * `ProfileError(NETWORK_ERROR)`. `TtctlError` and `ProfileError` subclasses
 * are preserved verbatim (the former carry their own `recovery` hints; the
 * latter are already shape-correct).
 */
async function withNetworkErrorMapping<T>(commandLabel: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    if (err instanceof ProfileError) throw err;
    throw new ProfileError("NETWORK_ERROR", `${commandLabel} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

function coerceBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function coerceString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// -----------------------------------------------------------------------------
// External profile URLs — `update`
// -----------------------------------------------------------------------------

/**
 * Subset of `UpdateExternalProfilesInput` actually exposed at v0. All fields
 * are optional; the caller is responsible for passing at least one or the
 * service will reject with `VALIDATION_ERROR`.
 *
 * `twitter / behance / dribbble` are exposed because they are present in the
 * `UpdateExternalProfilesPayload` response selection of the captured
 * `UpdateExternalProfiles` mutation document
 * (`research/graphql/talent_profile/operations/UpdateExternalProfiles.graphql`).
 * `skype` is also present on the underlying `Profile` type but the captured
 * mutation document does not request it back; we omit it from the v0 surface
 * (the user can still update it via the web portal).
 */
export interface ExternalProfilesUpdate {
  linkedin?: string;
  github?: string;
  website?: string;
  twitter?: string;
  behance?: string;
  dribbble?: string;
}

/**
 * Server-confirmed result of {@link update}. Mirrors the response selection
 * of the captured `UpdateExternalProfiles` mutation. Fields are nullable
 * because the server returns `null` for any external link the talent has
 * not set.
 */
export interface UpdateExternalProfilesResult {
  profile: {
    id: string;
    updatedByTalentAt: string | null;
    linkedin: string | null;
    github: string | null;
    website: string | null;
    behance: string | null;
    dribbble: string | null;
  };
  notice: string | null;
}

/**
 * Full-document `UpdateExternalProfiles` mutation. Mirrors
 * `research/graphql/talent_profile/operations/UpdateExternalProfiles.graphql`
 * with the fragments inlined. The `recommendations` selection from the
 * upstream document is intentionally omitted at v0 — recommendations are
 * surfaced via the dedicated `getProfileRecommendations` query
 * ({@link recommendations}) and pulling them through every external-update
 * response would force an over-broad type contract that's hard to keep
 * stable. Caller can re-fetch recommendations after a successful update if
 * they need the freshest list.
 */
const UPDATE_EXTERNAL_PROFILES_MUTATION = `mutation UpdateExternalProfiles($input: UpdateExternalProfilesInput!) {
  updateExternalProfiles(input: $input) {
    profile {
      id
      updatedByTalentAt
      linkedin
      github
      website
      behance
      dribbble
    }
    errors {
      message
      field
    }
    notice
    success
  }
}`;

interface UpdateExternalProfilesInput {
  profileId: string;
  externalProfiles: {
    linkedin?: string;
    github?: string;
    website?: string;
    twitter?: string;
    behance?: string;
    dribbble?: string;
  };
}

interface UpdateExternalProfilesPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserErrorEntry[] | null;
  profile?: {
    id: string;
    updatedByTalentAt?: unknown;
    linkedin?: string | null;
    github?: string | null;
    website?: string | null;
    behance?: string | null;
    dribbble?: string | null;
  } | null;
}

/**
 * Update external profile URLs (linkedin / github / website / twitter /
 * behance / dribbble). Each field is optional; the caller must pass at
 * least one. Unknown / extraneous fields are rejected at compile time by
 * the {@link ExternalProfilesUpdate} type.
 *
 * Wire shape follows Pattern 1 of `research/notes/10-mutation-input-patterns.md`
 * with the wrapper key `externalProfiles`. **INFERRED — UNVERIFIED**: no
 * live curl capture exists in `research/captures/web/inputs/` for this
 * mutation; deviations would surface as `USER_ERROR` at runtime.
 *
 * Errors:
 *   - `ProfileError("VALIDATION_ERROR")` when no fields are supplied
 *   - `ProfileError("USER_ERROR")` when the server rejects an individual
 *     field (e.g. malformed URL)
 *   - `AuthRevokedError`, `Cf403Error`, other `TtctlError` subclasses
 *     propagate verbatim
 */
export async function update(token: string, changes: ExternalProfilesUpdate): Promise<UpdateExternalProfilesResult> {
  const fields: UpdateExternalProfilesInput["externalProfiles"] = {};
  if (changes.linkedin !== undefined) fields.linkedin = changes.linkedin;
  if (changes.github !== undefined) fields.github = changes.github;
  if (changes.website !== undefined) fields.website = changes.website;
  if (changes.twitter !== undefined) fields.twitter = changes.twitter;
  if (changes.behance !== undefined) fields.behance = changes.behance;
  if (changes.dribbble !== undefined) fields.dribbble = changes.dribbble;
  if (Object.keys(fields).length === 0) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      "External profile update requires at least one of linkedin/github/website/twitter/behance/dribbble.",
    );
  }

  const profileId = await getProfileId(token);

  const res = await withNetworkErrorMapping("External profile update", () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "UpdateExternalProfiles",
        query: UPDATE_EXTERNAL_PROFILES_MUTATION,
        variables: { input: { profileId, externalProfiles: fields } satisfies UpdateExternalProfilesInput },
      },
    }),
  );

  const data = parseTalentProfileResponse(res, "External profile update") as {
    updateExternalProfiles?: UpdateExternalProfilesPayload | null;
  };
  const payload = data.updateExternalProfiles;
  if (!payload) {
    throw new ProfileError("UNKNOWN", "External profile update response had no `data.updateExternalProfiles` field");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const fieldHint = first?.field ? ` (${first.field})` : "";
    throw new ProfileError(
      "USER_ERROR",
      `External profile update rejected${fieldHint}: ${first?.message ?? "unknown error"}`,
    );
  }
  if (payload.success === false) {
    throw new ProfileError(
      "USER_ERROR",
      `External profile update reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
  if (!payload.profile) {
    throw new ProfileError("UNKNOWN", "External profile update succeeded but response had no profile payload");
  }

  return {
    profile: {
      id: payload.profile.id,
      updatedByTalentAt: coerceString(payload.profile.updatedByTalentAt),
      linkedin: payload.profile.linkedin ?? null,
      github: payload.profile.github ?? null,
      website: payload.profile.website ?? null,
      behance: payload.profile.behance ?? null,
      dribbble: payload.profile.dribbble ?? null,
    },
    notice: payload.notice ?? null,
  };
}

// -----------------------------------------------------------------------------
// Custom requirements — `customRequirementsShow`, `customRequirementsSet`
// -----------------------------------------------------------------------------

/**
 * Boolean trio comprising the talent's onboarding-readiness self-attestation.
 * All three are exposed unchanged (no display-name remapping) because each
 * field name is already self-documenting.
 *
 * Returned by {@link customRequirementsShow}. Callers willing to accept the
 * "missing fields default to current state" semantic of
 * {@link customRequirementsSet} pass a {@link CustomRequirementsUpdate} (a
 * partial of this trio).
 */
export interface CustomRequirements {
  backgroundCheck: boolean | null;
  drugTest: boolean | null;
  timeTrackingTools: boolean | null;
}

const GET_CUSTOM_REQUIREMENTS_QUERY = `query getCustomRequirements($profileId: ID!) {
  profile(id: $profileId) {
    id
    customRequirements {
      backgroundCheck
      drugTest
      timeTrackingTools
    }
  }
}`;

interface GetCustomRequirementsData {
  profile?: {
    id: string;
    customRequirements?: {
      backgroundCheck?: unknown;
      drugTest?: unknown;
      timeTrackingTools?: unknown;
    } | null;
  } | null;
}

/**
 * Read the three onboarding-readiness toggles for the signed-in user.
 *
 * Errors: `AuthRevokedError`, `ProfileError(GRAPHQL_ERROR)`,
 * `ProfileError(NETWORK_ERROR)`, `Cf403Error` (and other `TtctlError`
 * subclasses) propagate verbatim.
 */
export async function customRequirementsShow(token: string): Promise<CustomRequirements> {
  const profileId = await getProfileId(token);

  const res = await withNetworkErrorMapping("Custom requirements show", () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "getCustomRequirements",
        query: GET_CUSTOM_REQUIREMENTS_QUERY,
        variables: { profileId },
      },
    }),
  );

  const data = parseTalentProfileResponse(res, "Custom requirements show") as GetCustomRequirementsData;
  if (!data.profile) {
    throw new ProfileError("NO_VIEWER", "Custom requirements query returned no profile.");
  }
  const cr = data.profile.customRequirements ?? {};
  return {
    backgroundCheck: coerceBoolean(cr.backgroundCheck),
    drugTest: coerceBoolean(cr.drugTest),
    timeTrackingTools: coerceBoolean(cr.timeTrackingTools),
  };
}

/**
 * Partial-update shape for {@link customRequirementsSet}. Each missing
 * field is filled from the current server state before the mutation is
 * dispatched (the underlying `updateCustomRequirements` mutation sends ALL
 * three booleans per call, no PATCH semantics — see the capture notes
 * referenced in the module comment).
 */
export interface CustomRequirementsUpdate {
  backgroundCheck?: boolean;
  drugTest?: boolean;
  timeTrackingTools?: boolean;
}

const UPDATE_CUSTOM_REQUIREMENTS_MUTATION = `mutation updateCustomRequirements($input: UpdateCustomRequirementsInput!) {
  updateCustomRequirements(input: $input) {
    profile {
      id
      updatedByTalentAt
      customRequirements {
        backgroundCheck
        drugTest
        timeTrackingTools
      }
    }
    errors {
      message
      field
    }
    notice
    success
  }
}`;

interface UpdateCustomRequirementsInput {
  profileId: string;
  customRequirements: {
    backgroundCheck: boolean;
    drugTest: boolean;
    timeTrackingTools: boolean;
  };
}

interface UpdateCustomRequirementsPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserErrorEntry[] | null;
  profile?: {
    id: string;
    updatedByTalentAt?: unknown;
    customRequirements?: {
      backgroundCheck?: unknown;
      drugTest?: unknown;
      timeTrackingTools?: unknown;
    } | null;
  } | null;
}

/**
 * Server-confirmed result of {@link customRequirementsSet}. Mirrors the
 * response selection of the captured mutation document.
 */
export interface CustomRequirementsSetResult {
  profile: {
    id: string;
    updatedByTalentAt: string | null;
    customRequirements: CustomRequirements;
  };
  notice: string | null;
}

/**
 * Toggle one or more of the three onboarding-readiness booleans
 * (`backgroundCheck`, `drugTest`, `timeTrackingTools`). Caller-omitted
 * fields are pre-filled from the current server state via
 * {@link customRequirementsShow} before the mutation is sent (the underlying
 * `updateCustomRequirements` mutation has no diff/PATCH semantics — every
 * call resubmits all three booleans).
 *
 * Pre-fill of missing fields treats `null` (server has no value yet) as
 * `false` for the post-merge wire shape, since the mutation input is
 * `Boolean!` and rejects `null`.
 *
 * Errors: same taxonomy as {@link update}.
 */
export async function customRequirementsSet(
  token: string,
  changes: CustomRequirementsUpdate,
): Promise<CustomRequirementsSetResult> {
  if (
    changes.backgroundCheck === undefined &&
    changes.drugTest === undefined &&
    changes.timeTrackingTools === undefined
  ) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      "Custom requirements update requires at least one of backgroundCheck/drugTest/timeTrackingTools.",
    );
  }

  // Resolve current state to fill in any caller-omitted fields. We deliberately
  // make this fetch every time (rather than caching) — the mutation input is
  // `Boolean!` for all three, and a stale cache would silently flip a bit the
  // user didn't mean to change. The cost (one extra round-trip per set) is
  // small relative to the user-visible correctness improvement.
  const current = await customRequirementsShow(token);
  const profileId = await getProfileId(token);

  const merged: UpdateCustomRequirementsInput["customRequirements"] = {
    backgroundCheck: changes.backgroundCheck ?? current.backgroundCheck ?? false,
    drugTest: changes.drugTest ?? current.drugTest ?? false,
    timeTrackingTools: changes.timeTrackingTools ?? current.timeTrackingTools ?? false,
  };

  const res = await withNetworkErrorMapping("Custom requirements update", () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "updateCustomRequirements",
        query: UPDATE_CUSTOM_REQUIREMENTS_MUTATION,
        variables: { input: { profileId, customRequirements: merged } satisfies UpdateCustomRequirementsInput },
      },
    }),
  );

  const data = parseTalentProfileResponse(res, "Custom requirements update") as {
    updateCustomRequirements?: UpdateCustomRequirementsPayload | null;
  };
  const payload = data.updateCustomRequirements;
  if (!payload) {
    throw new ProfileError("UNKNOWN", "Custom requirements update response had no payload field");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const fieldHint = first?.field ? ` (${first.field})` : "";
    throw new ProfileError(
      "USER_ERROR",
      `Custom requirements update rejected${fieldHint}: ${first?.message ?? "unknown error"}`,
    );
  }
  if (payload.success === false) {
    throw new ProfileError(
      "USER_ERROR",
      `Custom requirements update reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
  if (!payload.profile) {
    throw new ProfileError("UNKNOWN", "Custom requirements update succeeded but response had no profile payload");
  }
  const cr = payload.profile.customRequirements ?? {};
  return {
    profile: {
      id: payload.profile.id,
      updatedByTalentAt: coerceString(payload.profile.updatedByTalentAt),
      customRequirements: {
        backgroundCheck: coerceBoolean(cr.backgroundCheck),
        drugTest: coerceBoolean(cr.drugTest),
        timeTrackingTools: coerceBoolean(cr.timeTrackingTools),
      },
    },
    notice: payload.notice ?? null,
  };
}

// -----------------------------------------------------------------------------
// Profile readiness — `readiness`
// -----------------------------------------------------------------------------

/**
 * The flat boolean set returned by `getProfileReadiness`. Each field
 * corresponds to a section completion check the platform runs before a
 * talent can submit-for-review. Schema types each as `Unknown` (the
 * SDL reflects what we've inferred, not strongly typed) so we coerce
 * defensively at the boundary.
 */
export interface ProfileReadiness {
  isPhotoResolutionSatisfied: boolean | null;
  isBasicInfoSatisfied: boolean | null;
  isCertificationsSatisfied: boolean | null;
  isEmploymentsCountSatisfied: boolean | null;
  isEmploymentConnectionsSatisfied: boolean | null;
  isSkillValidationsSatisfied: boolean | null;
  isPortfolioItemsCountSatisfied: boolean | null;
  isPortfolioItemConnectionsSatisfied: boolean | null;
  isWorkingHoursSatisfied: boolean | null;
  /**
   * `submitAvailable` rolls up the per-section signals into a single
   * "ready to submit?" boolean. Hoisted alongside the per-section
   * booleans because it's the value the user usually wants at a glance.
   */
  submitAvailable: boolean | null;
  /** ISO timestamp of last talent-side edit, returned by the same query. */
  updatedByTalentAt: string | null;
}

const GET_PROFILE_READINESS_QUERY = `query getProfileReadiness($profileId: ID!) {
  profile(id: $profileId) {
    id
    submitAvailable
    updatedByTalentAt
    profileReadiness {
      isPhotoResolutionSatisfied
      isBasicInfoSatisfied
      isCertificationsSatisfied
      isEmploymentsCountSatisfied
      isEmploymentConnectionsSatisfied
      isSkillValidationsSatisfied
      isPortfolioItemsCountSatisfied
      isPortfolioItemConnectionsSatisfied
      isWorkingHoursSatisfied
    }
  }
}`;

interface GetProfileReadinessData {
  profile?: {
    id: string;
    submitAvailable?: unknown;
    updatedByTalentAt?: unknown;
    profileReadiness?: Record<string, unknown> | null;
  } | null;
}

/**
 * Read the per-section profile-readiness booleans plus the rolled-up
 * `submitAvailable` flag and the last-edit timestamp.
 *
 * Errors: same taxonomy as {@link customRequirementsShow}.
 */
export async function readiness(token: string): Promise<ProfileReadiness> {
  const profileId = await getProfileId(token);

  const res = await withNetworkErrorMapping("Profile readiness", () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "getProfileReadiness",
        query: GET_PROFILE_READINESS_QUERY,
        variables: { profileId },
      },
    }),
  );

  const data = parseTalentProfileResponse(res, "Profile readiness") as GetProfileReadinessData;
  if (!data.profile) {
    throw new ProfileError("NO_VIEWER", "Profile readiness query returned no profile.");
  }
  const pr = data.profile.profileReadiness ?? {};
  return {
    isPhotoResolutionSatisfied: coerceBoolean(pr.isPhotoResolutionSatisfied),
    isBasicInfoSatisfied: coerceBoolean(pr.isBasicInfoSatisfied),
    isCertificationsSatisfied: coerceBoolean(pr.isCertificationsSatisfied),
    isEmploymentsCountSatisfied: coerceBoolean(pr.isEmploymentsCountSatisfied),
    isEmploymentConnectionsSatisfied: coerceBoolean(pr.isEmploymentConnectionsSatisfied),
    isSkillValidationsSatisfied: coerceBoolean(pr.isSkillValidationsSatisfied),
    isPortfolioItemsCountSatisfied: coerceBoolean(pr.isPortfolioItemsCountSatisfied),
    isPortfolioItemConnectionsSatisfied: coerceBoolean(pr.isPortfolioItemConnectionsSatisfied),
    isWorkingHoursSatisfied: coerceBoolean(pr.isWorkingHoursSatisfied),
    submitAvailable: coerceBoolean(data.profile.submitAvailable),
    updatedByTalentAt: coerceString(data.profile.updatedByTalentAt),
  };
}

// -----------------------------------------------------------------------------
// Profile recommendations — `recommendations`
// -----------------------------------------------------------------------------

/**
 * A single recommendation item. The platform returns recommendations as a
 * union over multiple concrete types
 * (`EmploymentsCountRecommendation`, `PortfolioItemsCountRecommendation`,
 * `EmploymentsMissingDataRecommendation`, etc.). We surface the discriminator
 * `type` plus the entire payload as a generic `payload` map rather than
 * typing each variant — the per-variant fields are descriptive UX hints, not
 * enforced data, and the schema types most fields as `Unknown` anyway.
 * CLI/MCP formatters render `type` and a stringified payload preview;
 * consumers who need richer typing can extend later.
 */
export interface ProfileRecommendation {
  type: string;
  payload: Record<string, unknown>;
}

const GET_PROFILE_RECOMMENDATIONS_QUERY = `query getProfileRecommendations($profileId: ID!) {
  profile(id: $profileId) {
    id
    recommendations {
      nodes {
        type
        ... on EmploymentsCountRecommendation { minimumCount }
        ... on PortfolioItemsCountRecommendation { minimumCount }
        ... on AdvancedProfileRecommendation { isCustomRequirementsCompleted isTravelInformationCompleted }
        ... on ProfileFreshnessRecommendation {
          skillsStatus
          certificationsStatus
          educationsStatus
          workExperiencesStatus
          portfolioItemsStatus
        }
      }
    }
  }
}`;

interface GetProfileRecommendationsData {
  profile?: {
    id: string;
    recommendations?: {
      nodes?: (Record<string, unknown> | null)[] | null;
    } | null;
  } | null;
}

/**
 * Read the list of profile recommendations. Each recommendation has a
 * discriminator `type` and a small payload of variant-specific fields.
 *
 * Recommendations that involve nested entity lists (e.g.
 * `EmploymentsMissingDataRecommendation` with a `nodes` array of employments)
 * are intentionally trimmed at the GraphQL level — at v0 the CLI/MCP only
 * surfaces the recommendation `type` and any scalar variant fields. Drilling
 * into nested entity lists requires fetching the underlying domain
 * (employments, portfolio items, skills) directly, which is outside the
 * recommendations leaf's scope.
 */
export async function recommendations(token: string): Promise<ProfileRecommendation[]> {
  const profileId = await getProfileId(token);

  const res = await withNetworkErrorMapping("Profile recommendations", () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "getProfileRecommendations",
        query: GET_PROFILE_RECOMMENDATIONS_QUERY,
        variables: { profileId },
      },
    }),
  );

  const data = parseTalentProfileResponse(res, "Profile recommendations") as GetProfileRecommendationsData;
  if (!data.profile) {
    throw new ProfileError("NO_VIEWER", "Profile recommendations query returned no profile.");
  }
  const nodes = data.profile.recommendations?.nodes ?? [];
  return nodes
    .filter((n): n is Record<string, unknown> => n !== null && typeof n === "object")
    .map((node) => {
      // Build a clean payload by stripping the discriminator and `__typename`.
      const payload: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === "type" || k === "__typename") continue;
        payload[k] = v;
      }
      const type = node.type;
      return {
        type: typeof type === "string" ? type : "Unknown",
        payload,
      };
    });
}

// -----------------------------------------------------------------------------
// Advanced profile wizard — `advancedWizardShow`
// -----------------------------------------------------------------------------

/**
 * Combined view of the advanced-profile-wizard state. Issue #76 spec collapses
 * `getAdvancedProfileData` and `GetAdvancedProfileWizardStatus` into a single
 * read leaf — but `getAdvancedProfileData` already includes
 * `advancedProfileWizardStatus` in its selection, so a single query suffices.
 *
 * `travelVisas` is a list of the talent's submitted travel visas; we surface
 * a count + the IDs at v0 to keep the payload bounded. Full visa CRUD lives
 * in the `visas` sub-domain (separate wave).
 */
export interface AdvancedProfileSnapshot {
  /**
   * Wizard-status discriminator. Schema types as `Unknown`; we surface
   * whatever the server returns without introspection.
   */
  wizardStatus: string | null;
  travelVisaCount: number;
  travelVisaIds: string[];
}

const GET_ADVANCED_PROFILE_DATA_QUERY = `query getAdvancedProfileData($profileId: ID!) {
  profile(id: $profileId) {
    id
    advancedProfileWizardStatus
    travelVisas {
      nodes {
        id
      }
    }
  }
}`;

interface GetAdvancedProfileDataData {
  profile?: {
    id: string;
    advancedProfileWizardStatus?: unknown;
    travelVisas?: {
      nodes?: ({ id?: unknown } | null)[] | null;
    } | null;
  } | null;
}

/**
 * Read the advanced-profile-wizard status plus a summary of the talent's
 * travel-visa list. This is the read-side combined view of
 * `getAdvancedProfileData` — the spec also references
 * `GetAdvancedProfileWizardStatus` as a separate operation, but
 * `getAdvancedProfileData` already returns `advancedProfileWizardStatus`, so
 * one query is sufficient.
 *
 * The full TravelVisa fragment is intentionally trimmed to `id` only. Visa
 * CRUD operations live in the `visas` sub-domain — surfacing the rich shape
 * here would create a partial duplication that drifts as the visas
 * sub-domain evolves.
 */
export async function advancedWizardShow(token: string): Promise<AdvancedProfileSnapshot> {
  const profileId = await getProfileId(token);

  const res = await withNetworkErrorMapping("Advanced profile wizard show", () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "getAdvancedProfileData",
        query: GET_ADVANCED_PROFILE_DATA_QUERY,
        variables: { profileId },
      },
    }),
  );

  const data = parseTalentProfileResponse(res, "Advanced profile wizard show") as GetAdvancedProfileDataData;
  if (!data.profile) {
    throw new ProfileError("NO_VIEWER", "Advanced profile data query returned no profile.");
  }
  const visaNodes = data.profile.travelVisas?.nodes ?? [];
  const travelVisaIds = visaNodes
    .filter((n): n is { id?: unknown } => n !== null && typeof n === "object")
    .map((n) => (typeof n.id === "string" ? n.id : ""))
    .filter((id) => id.length > 0);
  return {
    wizardStatus: coerceString(data.profile.advancedProfileWizardStatus),
    travelVisaCount: travelVisaIds.length,
    travelVisaIds,
  };
}
