// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { fetch as wreqFetch } from "node-wreq";

import type { ProfileShowQuery } from "../../../__generated__/gateway.js";
import { AuthRevokedError, TtctlError } from "../../../auth/errors.js";
import { logTransportRequest, logTransportResponse } from "../../../lib/diagnostic-log.js";
import {
  buildDryRunPreview,
  Cf403Error,
  getRedirectLocation,
  IMPERSONATE_PROFILE,
  impersonatedTransport,
  RedirectError,
  stockTransport,
} from "../../../transport.js";
import type { DryRunPreview, TransportResponse } from "../../../transport.js";
import { SURFACE_ENDPOINTS } from "../../../types.js";
import { isAuthRevokedExtensionCode } from "../shared.js";

/**
 * Full-document `ProfileShow` query string.
 *
 * Mirrors `research/graphql/gateway/operations/mobile/ProfileShow.graphql`. Sent as a
 * full-document GraphQL query (not a persisted query) because pinning a
 * sha256 hash against an unstable persisted-query catalog (it changes on
 * every portal client release) costs more in churn than it saves in
 * bandwidth. Keep this in sync with the .graphql file if either is edited;
 * the codegen smoke test in `__tests__/codegen.test.ts` catches structural
 * drift between operation documents and the generated TypeScript types.
 *
 * The selection set is a rich, profile-comprehensive shape adapted from the
 * portal `GetViewer` operation (see `research/graphql/gateway/operations/
 * portal/GetViewer.graphql` and `research/notes/13-getviewer-empirical-shape.md`)
 * trimmed to fields ttctl actually surfaces. Deliberately excluded:
 * `codeOfConduct.body` and `termsOfService.body` (~25 KB combined per the
 * empirical capture in note 13 — CLI does not render legal text); the
 * full `pendingSurveys`/`pendingQuizzes`/`jobActivityList`/operational-state
 * scopes (out of profile-show scope); and fields the SDL types as `Unknown`
 * (no actionable typing — codegen produces `unknown`).
 */
const PROFILE_SHOW_QUERY = `query ProfileShow {
  viewer {
    __typename
    id
    appliedAt
    hasSearchSubscription
    availabilityRequestTalentCardEnabled
    coachingEligibility
    referralUrl {
      __typename
      legacySlug
      pathSuffix
      shortenedUrl
      url
    }
    hireMeBanner {
      __typename
      enabled
      submitted
      experimentVariant
      referralUrl
      personalWebsiteUrl
      verificationStatus
      verifiedCount
    }
    codeOfConduct {
      __typename
      id
      acceptedAt
      title
      revisedOn
    }
    termsOfService {
      __typename
      id
      title
      revisedOn
      requiredAction
    }
    preliminarySearchSetting {
      __typename
      enabled
    }
    viewerRole {
      __typename
      activatedAt
      askExpertMenuVisible
      blockedStatus { __typename isBlocked }
      roleId
      profileId
      availability
      allocatedHours
      hiredHours
      fullName
      firstName
      phoneNumber
      email
      toptalEmail
      toptalEmailSuspended
      sendNotificationsToPrivateEmail
      specializationType
      specializations {
        __typename
        id
        slug
        title
        deliveryModel { __typename id identifier }
      }
      photo { __typename large small }
      postActivationStepsStatus
      publicResumeUrl
      timeZone {
        __typename
        name
        value
        location
        utcOffset
        stdOffset
      }
      hourlyRate { __typename verbose decimal }
      isPassThroughTalent
      isFakeSession
      availableShiftRangeFrom
      availableShiftRangeTo
      workingTimeFrom
      workingTimeTo
      contactFields {
        __typename
        communitySlackId
        email
        phoneNumber
        skype
      }
      talentVerticals {
        __typename
        isApiAllowed
        name
        roleId
        slug
      }
      vertical {
        __typename
        name
        slug
        hasSingleSpecialization
        isMarketplaceAccessEnabled
        profileHandbookUrl
        minPortfolioItems
        marketCondition { __typename condition }
        globalMarketCondition {
          __typename
          condition
          conditionVerbose
          conditionColor
          reportUrl
        }
        talentJobApplicationConfig {
          __typename
          portfolioRequired
          careerHighlightRequired
          highlightFields
        }
      }
      lastAllocatedHoursChangeRequest {
        __typename
        id
        allocatedHours
        comment
        reviewedManually
        statusV2 { __typename value verbose }
      }
      lastMobileAccess { __typename deviceType startedAt }
      rateInsight {
        __typename
        hourly {
          __typename
          currentRateCompetitive
          recentApplicationRate
          recommendedRate
        }
      }
      operations {
        __typename
        createRateChangeRequest { __typename callable }
        startSearchSubscription { __typename callable }
        promoteGigs { __typename callable }
      }
      permissions {
        __typename
        canApplyToJobs
        canFillInAdvancedProfile
        canHaveReferrals
        canViewAskAnExpert
        canViewCoachingRequests
        canViewCommunity
        canViewConsultations
        canViewEligibleJobs
        canViewPayments
        canViewRateInsights
        canViewRecognitionBadges
        canViewRecommendedJobs
        canViewSlackCommunity
        canViewSpecializations
      }
      profile {
        __typename
        id
        fullName
        city
        photo { __typename large }
        skillSets {
          __typename
          nodes {
            __typename
            id
            experience
            rating
            public
            skill { __typename id name }
          }
        }
      }
    }
  }
}`;

/**
 * Profile-domain error codes. The `'UNAUTHENTICATED'` member was retired
 * under issue #77 — auth-revoked failures now throw `AuthRevokedError`
 * (cross-cutting `TtctlError` subclass) so the CLI / MCP surfaces can apply
 * a uniform "Run `ttctl auth signin`" recovery hint regardless of which
 * service raised the failure.
 */
export type ProfileErrorCode =
  | "NO_VIEWER"
  | "GRAPHQL_ERROR"
  | "NETWORK_ERROR"
  | "USER_ERROR"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

export class ProfileError extends Error {
  override readonly name = "ProfileError";
  constructor(
    public readonly code: ProfileErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

interface GraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

interface ProfileShowResponse {
  data?: ProfileShowQuery | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Fetch the signed-in user's profile from the mobile-gateway GraphQL
 * surface (`https://www.toptal.com/gateway/graphql/talent/graphql`).
 *
 * Authenticates via `Authorization: Token token=<token>` (the canonical
 * Toptal auth mechanism — see `hq/engineering/adr/ADR-005-auth-model.md`).
 * The mobile-gateway is plain HTTPS — no Cloudflare, no TLS impersonation
 * required (empirically validated in `research/notes/13-getviewer-empirical-shape.md`).
 *
 * The returned shape is profile-comprehensive: identity (email, fullName,
 * phoneNumber, photo), role (allocatedHours, hiredHours, availability,
 * specializations, vertical, hourlyRate, timeZone, permissions, contact
 * fields), profile sub-object (id, fullName, city, photo, skillSets), and
 * operational metadata (codeOfConduct/termsOfService acceptance state,
 * hireMeBanner, lastAllocatedHoursChangeRequest, rateInsight). Caller may
 * project as needed for display.
 *
 * Note: `Profile.about` (bio) and `Profile.quote` (headline) are NOT on
 * mobile-gateway's `Profile` type. They are write-side fields surfaced by
 * `set()`'s response payload via the talent-profile surface. If a
 * read-side bio/headline display becomes needed, that requires a follow-up
 * issue to add a second talent-profile call.
 *
 * Errors:
 * - `AuthRevokedError` when the surface returns 401, OR the GraphQL
 *   response carries `extensions.code` matching `isAuthRevokedExtensionCode`
 *   (`'UNAUTHENTICATED'`, `'AUTHENTICATION_REQUIRED'`, or `'UNAUTHORIZED'`
 *   — see `services/profile/shared.ts` for per-code surface attribution and
 *   empirical history; #89 added `'UNAUTHORIZED'` for mobile-gateway).
 *   Caller-agnostic — the CLI / MCP surfaces render `error.recovery`
 *   verbatim ("Run `ttctl auth signin` to re-authenticate.").
 * - `ProfileError` with code `NO_VIEWER` when the response is 200 but
 *   `data.viewer` is `null` (the API contract says this means the token
 *   does not bind to a viewer).
 * - `ProfileError` with code `GRAPHQL_ERROR` when the response carries a
 *   non-empty `errors` array (other than auth-revoked).
 * - `ProfileError` with code `NETWORK_ERROR` when the transport itself
 *   throws (DNS, connection reset, etc).
 */
export async function show(token: string): Promise<ProfileShowQuery> {
  let res: TransportResponse;
  try {
    res = await stockTransport({
      surface: "mobile-gateway",
      authToken: token,
      body: {
        operationName: "ProfileShow",
        query: PROFILE_SHOW_QUERY,
      },
    });
  } catch (err) {
    throw new ProfileError("NETWORK_ERROR", `Profile request failed: ${(err as Error).message}`, { cause: err });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }

  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError("UNKNOWN", `Profile request returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as ProfileShowResponse | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    const message = first?.message ?? "GraphQL error";
    // Toptal returns HTTP 200 with `errors[0].extensions.code` set for
    // missing/expired/invalid sessions. Auth-revoked codes collapse to
    // `AuthRevokedError` (see `isAuthRevokedExtensionCode` for the list and
    // empirical history).
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ProfileError("GRAPHQL_ERROR", `Profile query failed: ${message}`);
  }

  if (!body?.data) {
    throw new ProfileError("UNKNOWN", "Profile response had no `data` field");
  }

  if (body.data.viewer === null) {
    throw new ProfileError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }

  return body.data;
}

// =======================================================================
// getBasicInfo: read-side companion to show() for talent_profile-only fields
// =======================================================================
//
// `show()` (above) talks to `mobile-gateway` and returns the rich role +
// viewer shape, but the mobile-gateway `Profile` type does NOT expose the
// user-edited narrative fields — `about` (bio), `quote` (headline),
// `languages`, etc. Those live on the `talent_profile/graphql` surface
// only (the same surface `set()` writes to). #127 (Wave 2 of the
// output-format reframe epic, #121) closes the read-side gap by adding a
// dedicated `getBasicInfo()` call that fetches the talent_profile-side
// fields, mirroring the established two-surface pattern of `photoShow`
// (also routed through talent_profile because mobile-gateway's `Profile`
// only carries a flat `photo.large` URL).
//
// The function is independent of `show()` — internal callers that only
// need `profileId` (e.g. `set`, `photoShow`, the sibling sub-domains'
// `resolveProfileId` helpers) keep using the cheap mobile-gateway-only
// `show()` path; only the CLI / MCP `basic show` surface (post-#129
// formatter rewrite) pays the cost of the second talent-profile call.
//
// The selection set is a deliberate subset of the canonical
// `GET_BASIC_INFO` operation (research/graphql/talent_profile/operations/
// GET_BASIC_INFO.graphql) — `about`, `quote`, and `languages.nodes`. The
// canonical operation also surfaces `legalName`, `placeIdentity`,
// `country`, `citizenship`, `softwareSkills`, the social URLs, and a
// `ProfileRecommendations` fragment; those are out of scope for #127's
// audit-confirmed defects (LOW severity per the audit report —
// `summary`/`memberSince` aren't in either schema; the social URLs are
// already covered by the `external` sub-domain). Future expansions can
// extend this selection in additive PRs without breaking the contract.
// =======================================================================

/**
 * One language entry on `Profile.languages.nodes` — identifier + display
 * name. The talent_profile schema types `languages` as `Unknown` (the
 * synthesized SDL marks anything the generator couldn't resolve), so the
 * runtime contract is the source of truth: nodes are objects with
 * non-empty string `id` and `name`. Empty / null entries are filtered
 * out by {@link getBasicInfo} before the caller sees them.
 */
export interface ProfileLanguage {
  id: string;
  name: string;
}

/**
 * Read-side projection of the `talent_profile`-only profile fields that
 * complement {@link show}. Returned by {@link getBasicInfo}.
 *
 * Naming: `bio` and `headline` are the user-facing CLI flag names exposed
 * by `set()`'s {@link ProfileUpdate}, mapped to the GraphQL
 * `Profile.about` / `Profile.quote` fields. We surface them as `bio` /
 * `headline` here so the read and write surfaces use the same vocabulary
 * — callers don't need to know the wire-side names to render the value
 * the user typed.
 *
 * `null` indicates the user hasn't set the field (or the server didn't
 * return it). `languages` is an array — empty when none are set, never
 * `null` (the empty-collection convention agreed in the #124 audit's
 * null-rendering recommendation).
 */
export interface BasicInfo {
  /** Echoes the talent_profile-side `Profile.id` (matches `show()`'s `viewerRole.profileId`). */
  profileId: string;
  /** The long-form bio (`Profile.about`). `null` when unset. */
  bio: string | null;
  /** The short tagline (`Profile.quote`). `null` when unset. */
  headline: string | null;
  /** User-declared languages. Empty array when none. */
  languages: ProfileLanguage[];
}

/**
 * Full-document `GET_BASIC_INFO` query string. Trimmed subset of the
 * canonical bundle-extracted operation
 * (`research/graphql/talent_profile/operations/GET_BASIC_INFO.graphql`):
 * we ask only for the read-display-relevant fields surfaced by
 * {@link BasicInfo} — `about`, `quote`, `languages.nodes` — and skip
 * the `ProfileRecommendations`, `softwareSkills`, social URL, and
 * top-level `countries` / `languages` catalog fields that the canonical
 * operation also fetches (out of scope for the read-display surface; the
 * social URLs are owned by the `external` sub-domain, the catalog
 * payloads are autocomplete-tier).
 *
 * Operation name `GET_BASIC_INFO` (SCREAMING_CASE) matches the bundle-
 * extracted document so the server's literal `operationName` allowlist
 * matches our request — same rationale as `UPDATE_BASIC_INFO` below.
 */
const GET_BASIC_INFO_QUERY = `query GET_BASIC_INFO($profileId: ID!) {
  profile(id: $profileId) {
    id
    about
    quote
    languages {
      nodes {
        id
        name
      }
    }
  }
}`;

interface GetBasicInfoData {
  profile?: {
    id?: string | null;
    about?: string | null;
    quote?: string | null;
    languages?: { nodes?: ({ id?: string | null; name?: string | null } | null)[] | null } | null;
  } | null;
}

interface GetBasicInfoResponse {
  data?: GetBasicInfoData | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Fetch the read-side `talent_profile`-only basic-info fields that
 * complement {@link show} — `bio` (→ `Profile.about`), `headline` (→
 * `Profile.quote`), and `languages`.
 *
 * Routed against `https://www.toptal.com/api/talent_profile/graphql` via
 * {@link impersonatedTransport} (Cloudflare-protected; Chrome TLS
 * fingerprint required). Internally calls {@link show} first to obtain
 * the `profileId` required by the `profile(id: ID!)` field — same
 * pattern as {@link photoShow}.
 *
 * Returns a typed {@link BasicInfo} projection — `null` for fields the
 * user hasn't set, an empty array for `languages` when none.
 *
 * Errors:
 * - `Cf403Error` propagates from the talent-profile transport.
 * - `AuthRevokedError` on token expiry (HTTP 401, or any GraphQL
 *   `extensions.code` matching `isAuthRevokedExtensionCode`).
 * - `ProfileError` with code `NO_VIEWER` when no viewer is bound.
 * - `ProfileError` with code `USER_ERROR` when the profile id doesn't
 *   resolve (server returns `data.profile === null`).
 * - `ProfileError` with code `GRAPHQL_ERROR` on top-level GraphQL errors
 *   (other than auth-revoked).
 * - `ProfileError` with code `NETWORK_ERROR` on transport-level throws.
 * - `ProfileError` with code `UNKNOWN` on unexpected non-2xx statuses or
 *   missing `data` field.
 */
export async function getBasicInfo(token: string): Promise<BasicInfo> {
  const profileResp = await show(token);
  const profileId = profileResp.viewer?.viewerRole.profileId;
  if (profileId === undefined) {
    throw new ProfileError(
      "NO_VIEWER",
      "Cannot fetch basic info: viewer or profile id missing from the session response.",
    );
  }

  let res: TransportResponse;
  try {
    res = await impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: { operationName: "GET_BASIC_INFO", query: GET_BASIC_INFO_QUERY, variables: { profileId } },
    });
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    throw new ProfileError("NETWORK_ERROR", `Basic info request failed: ${(err as Error).message}`, { cause: err });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError("UNKNOWN", `Basic info request returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as GetBasicInfoResponse | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ProfileError("GRAPHQL_ERROR", `Basic info query failed: ${first?.message ?? "GraphQL error"}`);
  }
  if (!body?.data) {
    throw new ProfileError("UNKNOWN", "Basic info response had no `data` field");
  }
  if (!body.data.profile) {
    throw new ProfileError("USER_ERROR", `No profile found with id "${profileId}".`);
  }

  const p = body.data.profile;
  const rawNodes = p.languages?.nodes ?? [];
  const languages: ProfileLanguage[] = [];
  for (const node of rawNodes) {
    if (node === null || typeof node !== "object") continue;
    if (typeof node.id !== "string" || node.id.length === 0) continue;
    if (typeof node.name !== "string") continue;
    languages.push({ id: node.id, name: node.name });
  }

  return {
    profileId: typeof p.id === "string" && p.id.length > 0 ? p.id : profileId,
    bio: typeof p.about === "string" ? p.about : null,
    headline: typeof p.quote === "string" ? p.quote : null,
    languages,
  };
}

/**
 * Full-document `UPDATE_BASIC_INFO` mutation string.
 *
 * The Toptal `talent_profile/graphql` surface does not publish a persisted-query
 * catalog — every operation is sent as a full document. This is a SIMPLIFIED
 * version of the bundle-extracted `UPDATE_BASIC_INFO` mutation
 * (`research/graphql/talent_profile/operations/UPDATE_BASIC_INFO.graphql`): we ask only
 * for the response fields we actually use (id, about, quote, success, notice,
 * errors), avoiding the bundle version's dependency on five fragments
 * (`RealTimeFields`, `ProfileCompletion`, `SkillsReadiness`,
 * `ProfileRecommendations`, `UserErrorFragment`) that haven't been wired into
 * codegen.
 *
 * Operation name is `UPDATE_BASIC_INFO` (SCREAMING_CASE), matching the
 * bundle-extracted document. Per `research/notes/05-talent-profile-api.md`,
 * the server matches `operationName` against the request body literally and
 * the React app sends the SCREAMING_CASE form — keeping the same shape avoids
 * any chance of server-side allowlist drift.
 */
const UPDATE_BASIC_INFO_MUTATION = `mutation UPDATE_BASIC_INFO($input: UpdateBasicInfoInput!) {
  updateBasicInfo(input: $input) {
    success
    notice
    errors {
      code
      key
      message
    }
    profile {
      id
      about
      quote
    }
  }
}`;

/**
 * Subset of profile fields editable via the wave-0 MVP write-path. `bio` and
 * `headline` are the user-facing flag names exposed by the CLI; they map to
 * the GraphQL fields `about` and `quote` respectively (the field names used
 * by the talent_profile surface — see the response selection in
 * `research/graphql/talent_profile/operations/UPDATE_BASIC_INFO.graphql`).
 *
 * Both fields are optional. The caller is responsible for ensuring at least
 * one is supplied — `set()` rejects an empty object with a
 * `VALIDATION_ERROR`.
 */
export interface ProfileUpdate {
  bio?: string;
  headline?: string;
}

/**
 * `UpdateBasicInfoInput` shape, validated against live `talent_profile/graphql`
 * via captured browser curl 2026-05-06 (see
 * `research/notes/10-mutation-input-patterns.md` § UPDATE_BASIC_INFO exception).
 *
 * Wire format:
 *   input: { profileId: "VjEt…", profile: { about?, quote?, … } }
 *
 * NOT `{ profileId, basicInfo: { … } }` — that was an inference from sibling
 * mutations (Pattern 1), falsified empirically. `UPDATE_BASIC_INFO` is the
 * documented exception to Pattern 1.
 *
 * The full input shape supports many more fields than ttctl currently exposes
 * (`fullName`, `legalName`, `city`, `placeIdentity`, `countryId`,
 * `citizenshipId`, `languageIds`, social URLs, `softwareSkills`). Only
 * `about` / `quote` are typed here, matching what `set()` writes. Adding more
 * fields is a future enhancement (tracked separately).
 */
interface UpdateBasicInfoInput {
  profileId: string;
  profile: {
    about?: string;
    quote?: string;
  };
}

interface UpdateBasicInfoUserError {
  code?: string | null;
  key?: string | null;
  message?: string | null;
}

interface UpdateBasicInfoPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UpdateBasicInfoUserError[] | null;
  profile?: {
    id: string;
    about?: string | null;
    quote?: string | null;
  } | null;
}

interface UpdateBasicInfoResponse {
  data?: { updateBasicInfo?: UpdateBasicInfoPayload | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Result of a successful `set()` call. Mirrors the GraphQL field
 * names so callers see `about`/`quote` rather than the CLI flag names — the
 * mapping back to user-facing `bio`/`headline` is a presentation concern
 * handled at the CLI layer.
 */
export interface UpdateProfileResult {
  profile: {
    id: string;
    about: string | null;
    quote: string | null;
  };
  notice: string | null;
}

/**
 * Options accepted by {@link set}. Today carries only `dryRun` (#52);
 * a `confirm`-style anti-fat-finger gate is planned for `timesheet
 * submit` (#13) and will follow the same option-object shape so callers
 * can opt in additively without API churn.
 */
export interface SetOptions {
  /**
   * When `true`, {@link set} short-circuits before any transport call,
   * returning a {@link DryRunPreview}-bearing outcome ({@link
   * SetOutcomePreview}) instead of executing the mutation. Default:
   * `false` — normal apply-the-mutation path.
   *
   * The preview is built with placeholder substitutions for fields that
   * would normally be resolved via sibling reads (e.g. `profileId`,
   * which {@link set} fetches from `show()` in the apply path). Neither
   * the read transport nor the write transport is invoked when `dryRun`
   * is true — the AC for issue #52 is "transport never called" and the
   * helper honors it for both directions of network I/O.
   */
  dryRun?: boolean;
}

/**
 * Placeholder string substituted for fields that the apply-path would
 * normally resolve via a sibling read (e.g. `profileId` from `show()`).
 * Surfaced verbatim in the dry-run preview's variables payload so
 * downstream consumers can see the request structure without TTCtl
 * having fired any network I/O.
 *
 * Public (re-exported via `index.ts`) so MCP / future CLI tooling can
 * recognize the placeholder when surfacing the preview.
 */
export const DRY_RUN_PROFILE_ID_PLACEHOLDER = "<resolved at send-time from session token>" as const;

/**
 * Discriminated outcome of a {@link set} call when the apply-path
 * succeeded — the server-confirmed payload normalised to {@link
 * UpdateProfileResult}. Identical to the pre-#52 return type wrapped in
 * a `{ kind: "applied" }` discriminator.
 */
export interface SetOutcomeApplied {
  kind: "applied";
  result: UpdateProfileResult;
}

/**
 * Discriminated outcome of a {@link set} call invoked with
 * `dryRun: true` — the structured preview of the request that WOULD have
 * been sent. No transport (read or write) was invoked along this path.
 */
export interface SetOutcomePreview {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link set}. Apply-path callers
 * branch on `outcome.kind === "applied"`; dry-run callers branch on
 * `"preview"`. The pre-#52 surface returned `UpdateProfileResult`
 * directly — that surface no longer exists. Pre-1.0 (`0.0.0`) the
 * breaking change is acceptable per CLAUDE.md's "single-step migration"
 * stance for the programmatic API.
 */
export type SetOutcome = SetOutcomeApplied | SetOutcomePreview;

/**
 * Update a subset of the signed-in user's basic-info fields (currently
 * `bio` → `about` and `headline` → `quote`) via the Cloudflare-protected
 * `talent_profile/graphql` surface.
 *
 * Authenticates via `Authorization: Token token=<token>` (the canonical
 * Toptal auth mechanism). Cookies are NOT load-bearing — Chrome TLS
 * impersonation alone passes Cloudflare. Internally calls `show()`
 * (against mobile-gateway) first to obtain the `profileId` required by the
 * mutation input, then issues the typed `UpdateBasicInfo` mutation against
 * talent-profile via `impersonatedTransport`. Returns the server-confirmed
 * updated values wrapped in a {@link SetOutcomeApplied} discriminator.
 *
 * Dry-run path (issue #52): when invoked with `options.dryRun === true`,
 * builds a {@link DryRunPreview} of the WRITE request without invoking
 * any transport (read OR write) and returns it wrapped in {@link
 * SetOutcomePreview}. The preview substitutes a placeholder string
 * ({@link DRY_RUN_PROFILE_ID_PLACEHOLDER}) for `profileId` because the
 * apply-path resolves it via `show()` (a stock-transport read call) and
 * the dry-run AC requires zero transport invocations. The bearer token
 * is redacted in the preview's `headers.authorization` per the security
 * contract documented on {@link DryRunPreview}.
 *
 * Errors:
 * - `ProfileError` with code `VALIDATION_ERROR` when neither `bio` nor
 *   `headline` is supplied — the contract requires at least one. Fires
 *   in BOTH the apply-path and the dry-run path.
 * - `Cf403Error` propagates from the talent-profile transport when
 *   Cloudflare returns 403. Apply-path only.
 * - `AuthRevokedError` on token expiry (HTTP 401, or any GraphQL
 *   `extensions.code` matching `isAuthRevokedExtensionCode` — currently
 *   `'UNAUTHENTICATED'`, `'AUTHENTICATION_REQUIRED'`, or `'UNAUTHORIZED'`).
 *   Apply-path only.
 * - `ProfileError` with code `NO_VIEWER` when no viewer is bound.
 *   Apply-path only — dry-run skips the read entirely.
 * - `ProfileError` with code `USER_ERROR` when the mutation returns a
 *   non-empty `errors` array (validation failures from the server, e.g., a
 *   bio that exceeds the platform's length limit). Apply-path only.
 * - `ProfileError` with code `GRAPHQL_ERROR` on top-level GraphQL errors.
 *   Apply-path only.
 * - `ProfileError` with code `NETWORK_ERROR` on transport-level throws.
 *   Apply-path only.
 */
export async function set(token: string, changes: ProfileUpdate, options: SetOptions = {}): Promise<SetOutcome> {
  if (changes.bio === undefined && changes.headline === undefined) {
    throw new ProfileError("VALIDATION_ERROR", "Profile update requires at least one of `bio` or `headline`.");
  }

  const profileFields: UpdateBasicInfoInput["profile"] = {};
  if (changes.bio !== undefined) profileFields.about = changes.bio;
  if (changes.headline !== undefined) profileFields.quote = changes.headline;

  // Dry-run short-circuit: build the WRITE request shape with a
  // placeholder `profileId` and return a preview without any transport
  // call. Apply-path resolves `profileId` via `show()` (a mobile-gateway
  // read), but dry-run skips that step so neither transport is invoked
  // — the AC for issue #52 reads "transport never called" in the
  // singular and the helper honors it for both directions.
  if (options.dryRun === true) {
    const previewInput: UpdateBasicInfoInput = {
      profileId: DRY_RUN_PROFILE_ID_PLACEHOLDER,
      profile: profileFields,
    };
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "talent-profile",
        authToken: token,
        body: {
          operationName: "UPDATE_BASIC_INFO",
          query: UPDATE_BASIC_INFO_MUTATION,
          variables: { input: previewInput },
        },
      }),
    };
  }

  // Need profileId for the mutation input — fetch the current profile first.
  // Errors from show() (ProfileError) propagate verbatim: a write attempt
  // that can't read its own profile is unrecoverable, and surfacing the
  // read-side error gives the user the same actionable message they'd get
  // from `ttctl profile show`.
  const profile = await show(token);
  const profileId = profile.viewer?.viewerRole.profileId;
  if (profileId === undefined) {
    throw new ProfileError(
      "NO_VIEWER",
      "Cannot update profile: viewer or profile id missing from the session response.",
    );
  }

  let res: TransportResponse;
  try {
    res = await impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "UPDATE_BASIC_INFO",
        query: UPDATE_BASIC_INFO_MUTATION,
        variables: { input: { profileId, profile: profileFields } satisfies UpdateBasicInfoInput },
      },
    });
  } catch (err) {
    // Typed-error subclasses (Cf403Error, AuthRevokedError, …) propagate as-is so
    // the CLI / MCP surfaces can render their `recovery` hints. Anything else is
    // a transport-level failure and surfaces as a domain ProfileError.
    if (err instanceof TtctlError) throw err;
    throw new ProfileError("NETWORK_ERROR", `Profile update request failed: ${(err as Error).message}`, { cause: err });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }

  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError("UNKNOWN", `Profile update returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as UpdateBasicInfoResponse | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    const message = first?.message ?? "GraphQL error";
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ProfileError("GRAPHQL_ERROR", `Profile update failed: ${message}`);
  }

  const payload = body?.data?.updateBasicInfo;
  if (!payload) {
    throw new ProfileError("UNKNOWN", "Profile update response had no `data.updateBasicInfo` field");
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const fieldHint = first?.key ? ` (${first.key})` : "";
    throw new ProfileError("USER_ERROR", `Profile update rejected${fieldHint}: ${first?.message ?? "unknown error"}`);
  }

  if (payload.success === false) {
    throw new ProfileError(
      "USER_ERROR",
      `Profile update reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }

  if (!payload.profile) {
    throw new ProfileError("UNKNOWN", "Profile update succeeded but response had no profile payload");
  }

  return {
    kind: "applied",
    result: {
      profile: {
        id: payload.profile.id,
        about: payload.profile.about ?? null,
        quote: payload.profile.quote ?? null,
      },
      notice: payload.notice ?? null,
    },
  };
}

// =======================================================================
// Photo: show + upload
// =======================================================================
//
// Both operations target the Cloudflare-protected `talent_profile/graphql`
// surface (the mobile gateway exposes only `viewer.viewerRole.profile.photo`
// as a flat URL, not the full `Photo` shape with original/transformations).
//
// `photoShow` is a vanilla query — same transport pattern as `set` above.
// `photoUpload` is the special case: GraphQL multipart-upload-spec
// (https://github.com/jaydenseric/graphql-multipart-request-spec). It can't
// share `impersonatedTransport()` directly because that helper hardcodes
// `Content-Type: application/json`; instead it builds a `FormData` body and
// dispatches via `node-wreq`'s `fetch` with the same TLS profile.
// =======================================================================

const GET_PHOTO_QUERY = `query GET_PHOTO($profileId: ID!) {
  profile(id: $profileId) {
    id
    photo {
      default
      original
      small
      transformations {
        cropped { height width x y }
      }
    }
    profileReadiness {
      isPhotoResolutionSatisfied
    }
  }
}`;

/**
 * `UpdatePhotoInput` shape, derived from the bundle-extracted
 * `UploadProfilePhoto` mutation (`research/graphql/talent_profile/
 * operations/UploadProfilePhoto.graphql`) and Pattern-1-aligned per
 * `research/notes/10-mutation-input-patterns.md` (`{profileId, transformation,
 * file}`).
 *
 * `file` is `null` in the JSON `operations` payload — the actual file
 * binary travels in a separate `0` form field per the multipart-upload
 * spec; the JSON placeholder is mapped onto it via the `map` form field.
 *
 * `transformation` carries the crop rectangle the server uses to render
 * the small/cropped variants; we default to "no crop" (a 0,0 to width,height
 * rectangle) when the caller doesn't supply one — server falls back to
 * its own auto-crop heuristic in that case.
 */
interface PhotoTransformationInput {
  cropped: { x: number; y: number; width: number; height: number };
}

const UPLOAD_PROFILE_PHOTO_MUTATION = `mutation UploadProfilePhoto($input: UpdatePhotoInput!) {
  updatePhoto(input: $input) {
    success
    notice
    errors { code key message }
    profile {
      id
      photo {
        default
        original
        small
        transformations {
          cropped { height width x y }
        }
      }
    }
  }
}`;

/**
 * Photo URLs as exposed to consumers — mirrors the `Photo` selection set
 * we ask for on the talent_profile surface. `transformations.cropped` is
 * the server-recommended crop rectangle for the `small` variant; consumers
 * typically use `default` for in-CLI display and `original` for export.
 */
export interface PhotoUrl {
  default: string | null;
  original: string | null;
  small: string | null;
  cropped: { x: number; y: number; width: number; height: number } | null;
  isResolutionSatisfied: boolean;
}

interface GetPhotoData {
  profile?: {
    id: string;
    photo: {
      default: string | null;
      original: string | null;
      small: string | null;
      transformations: { cropped: { x: number; y: number; width: number; height: number } | null } | null;
    } | null;
    profileReadiness: { isPhotoResolutionSatisfied: boolean };
  } | null;
}

interface UploadPhotoUserError {
  code?: string | null;
  key?: string | null;
  message?: string | null;
}

interface UploadPhotoData {
  updatePhoto?: {
    success?: boolean | null;
    notice?: string | null;
    errors?: UploadPhotoUserError[] | null;
    profile?: GetPhotoData["profile"];
  } | null;
}

interface UploadPhotoResponse {
  data?: UploadPhotoData | null;
  errors?: GraphQLErrorEntry[] | null;
}

function normalisePhoto(profile: NonNullable<GetPhotoData["profile"]>): PhotoUrl {
  const photo = profile.photo;
  const cropped = photo?.transformations?.cropped ?? null;
  return {
    default: photo?.default ?? null,
    original: photo?.original ?? null,
    small: photo?.small ?? null,
    cropped: cropped,
    isResolutionSatisfied: profile.profileReadiness.isPhotoResolutionSatisfied,
  };
}

/**
 * Fetch the URLs of the signed-in user's profile photo (default / original
 * / small variants plus the server's recommended crop rectangle and the
 * "is the resolution satisfactory?" boolean from `profileReadiness`).
 *
 * Routed against `talent_profile/graphql` via `impersonatedTransport`
 * (Cloudflare-protected) because the mobile gateway exposes only a single
 * flat URL on `Profile.photo` — not the variant shape we surface.
 *
 * Internally calls `show()` first to get the `profileId` (same pattern
 * as `set()` — the talent-profile surface keys `profile(id: ID!)` rather
 * than resolving from the auth token), then fires the typed query.
 *
 * Errors:
 * - `Cf403Error` propagates from the talent-profile transport.
 * - `AuthRevokedError` on token expiry (HTTP 401, or any auth-revoked
 *   `extensions.code` — see `isAuthRevokedExtensionCode` in
 *   `services/profile/shared.ts`).
 * - `ProfileError` `NO_VIEWER` when no viewer is bound.
 * - `ProfileError` `GRAPHQL_ERROR` on top-level GraphQL errors.
 * - `ProfileError` `NETWORK_ERROR` on transport-level throws.
 * - `ProfileError` `USER_ERROR` when the profile id doesn't resolve
 *   (server returns `data.profile === null`).
 */
export async function photoShow(token: string): Promise<PhotoUrl> {
  const profileResp = await show(token);
  const profileId = profileResp.viewer?.viewerRole.profileId;
  if (profileId === undefined) {
    throw new ProfileError("NO_VIEWER", "Cannot fetch photo: viewer or profile id missing from the session response.");
  }

  let res: TransportResponse;
  try {
    res = await impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: { operationName: "GET_PHOTO", query: GET_PHOTO_QUERY, variables: { profileId } },
    });
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    throw new ProfileError("NETWORK_ERROR", `Photo request failed: ${(err as Error).message}`, { cause: err });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError("UNKNOWN", `Photo request returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as { data?: GetPhotoData | null; errors?: GraphQLErrorEntry[] | null } | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ProfileError("GRAPHQL_ERROR", `Photo query failed: ${first?.message ?? "GraphQL error"}`);
  }
  if (!body?.data) {
    throw new ProfileError("UNKNOWN", "Photo response had no `data` field");
  }
  if (!body.data.profile) {
    throw new ProfileError("USER_ERROR", `No profile found with id "${profileId}".`);
  }
  return normalisePhoto(body.data.profile);
}

/**
 * Photo upload input. The caller supplies either a path to an image file
 * (string) or an in-memory buffer. When a path is given, the helper reads
 * the file via `node:fs/promises` and infers content-type from the
 * extension. When a buffer is given, the caller may supply
 * `contentType` and `filename` to control the multipart parts (defaults
 * to `image/jpeg` and `photo.jpg`).
 *
 * `transformation` is optional: when omitted, the helper sends a default
 * (no-crop) rectangle and lets the server's auto-crop heuristic pick.
 */
export interface PhotoUploadInput {
  file: Buffer | string;
  filename?: string;
  contentType?: string;
  transformation?: PhotoTransformationInput;
}

const DEFAULT_PHOTO_CONTENT_TYPE = "image/jpeg";
const DEFAULT_PHOTO_FILENAME = "photo.jpg";
const DEFAULT_PHOTO_TRANSFORMATION: PhotoTransformationInput = {
  cropped: { x: 0, y: 0, width: 0, height: 0 },
};

function inferContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpeg") || lower.endsWith(".jpg")) return "image/jpeg";
  return DEFAULT_PHOTO_CONTENT_TYPE;
}

/**
 * Upload a new profile photo. Implements the GraphQL multipart-upload
 * spec — the request body is a `multipart/form-data` envelope with three
 * named parts (`operations`, `map`, and the file payload at field `0`),
 * NOT the JSON envelope every other operation in this module uses. The
 * transport hand-rolls a `node-wreq` fetch call rather than going through
 * `impersonatedTransport()` because that helper hardcodes
 * `Content-Type: application/json`; both transports use the same Chrome
 * TLS profile so Cloudflare treats them uniformly.
 *
 * `input.file` accepts either a path string or a Buffer. Path strings
 * are read with `node:fs/promises` and the content-type is inferred from
 * the extension; Buffer callers may override `contentType` / `filename`.
 *
 * Errors:
 * - `Cf403Error` propagates from the multipart transport call.
 * - `AuthRevokedError` on token expiry (HTTP 401, or auth-revoked
 *   `extensions.code` on the GraphQL response).
 * - `ProfileError` `VALIDATION_ERROR` when `input.file` is empty / missing.
 * - `ProfileError` `NO_VIEWER` when no viewer is bound.
 * - `ProfileError` `USER_ERROR` when the mutation returns user errors
 *   (e.g., resolution too low, file format unsupported).
 * - Standard transport-error path.
 */
export async function photoUpload(token: string, input: PhotoUploadInput): Promise<PhotoUrl> {
  // Resolve the binary first so input failures surface BEFORE any
  // network call — same UX principle the CLI uses for `--bio` / `--headline`.
  const { fileBuffer, filename, contentType } = await resolvePhotoBinary(input);
  if (fileBuffer.byteLength === 0) {
    throw new ProfileError("VALIDATION_ERROR", "Photo file is empty.");
  }

  const profileResp = await show(token);
  const profileId = profileResp.viewer?.viewerRole.profileId;
  if (profileId === undefined) {
    throw new ProfileError("NO_VIEWER", "Cannot upload photo: viewer or profile id missing from the session response.");
  }

  const operations = JSON.stringify({
    operationName: "UploadProfilePhoto",
    query: UPLOAD_PROFILE_PHOTO_MUTATION,
    variables: {
      input: {
        profileId,
        transformation: input.transformation ?? DEFAULT_PHOTO_TRANSFORMATION,
        file: null,
      },
    },
  });
  const map = JSON.stringify({ "0": ["variables.input.file"] });

  const form = new FormData();
  form.set("operations", operations);
  form.set("map", map);
  // `Blob` is provided globally on Node 18+. The cast through Uint8Array
  // is a TS-side shim because `BlobPart` doesn't accept `Buffer` directly;
  // a Buffer is structurally a Uint8Array, so the conversion is zero-copy.
  const blob = new Blob([new Uint8Array(fileBuffer)], { type: contentType });
  form.set("0", blob, filename);

  // Diagnostic-log context (issue #139): hand over the parsed operation
  // envelope + multipart map so `multipartImpersonatedFetch` can emit a
  // truthful debug trace with the full GraphQL body (operationName,
  // query, variables) and the actual slot label / variable-path mapping
  // that goes on the wire. Without this, the debug log would show
  // body=null and a fabricated multipart map — accurate-shape data is
  // what makes the trace useful for `paste-into-issue` debugging.
  const operationEnvelope = JSON.parse(operations) as {
    operationName: string;
    query: string;
    variables: Record<string, unknown>;
  };
  const slotMap = JSON.parse(map) as Record<string, string[]>;

  let res: TransportResponse;
  try {
    res = await multipartImpersonatedFetch(token, form, { operationEnvelope, slotMap });
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    throw new ProfileError("NETWORK_ERROR", `Photo upload request failed: ${(err as Error).message}`, { cause: err });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError("UNKNOWN", `Photo upload returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as UploadPhotoResponse | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ProfileError("GRAPHQL_ERROR", `Photo upload failed: ${first?.message ?? "GraphQL error"}`);
  }

  const payload = body?.data?.updatePhoto;
  if (!payload) {
    throw new ProfileError("UNKNOWN", "Photo upload response had no `data.updatePhoto` field");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const fieldHint = first?.key ? ` (${first.key})` : "";
    throw new ProfileError("USER_ERROR", `Photo upload rejected${fieldHint}: ${first?.message ?? "unknown error"}`);
  }
  if (payload.success === false) {
    throw new ProfileError(
      "USER_ERROR",
      `Photo upload reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
  if (!payload.profile) {
    throw new ProfileError("UNKNOWN", "Photo upload succeeded but response had no profile payload");
  }
  return normalisePhoto(payload.profile);
}

interface ResolvedPhotoBinary {
  fileBuffer: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Resolve the caller-supplied `file` (Buffer or path) into a Buffer plus
 * the content-type / filename to use in the multipart envelope. Pulls
 * `node:fs/promises` lazily so the module can still be imported in
 * environments where the upload path isn't exercised (e.g., a future
 * browser bundle that wraps the read APIs only).
 */
async function resolvePhotoBinary(input: PhotoUploadInput): Promise<ResolvedPhotoBinary> {
  if (typeof input.file === "string") {
    // Lazy import keeps the module tree-shakable for downstream bundlers
    // that don't need the upload path. Top-level `import` would pull
    // node:fs into every consumer of `profile.basic`.
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    let buffer: Buffer;
    try {
      buffer = await readFile(input.file);
    } catch (err) {
      throw new ProfileError("VALIDATION_ERROR", `Photo file not readable: ${(err as Error).message}`, { cause: err });
    }
    const filename = input.filename ?? basename(input.file);
    return {
      fileBuffer: buffer,
      filename,
      contentType: input.contentType ?? inferContentType(filename),
    };
  }
  return {
    fileBuffer: input.file,
    filename: input.filename ?? DEFAULT_PHOTO_FILENAME,
    contentType: input.contentType ?? DEFAULT_PHOTO_CONTENT_TYPE,
  };
}

/**
 * Hand-rolled impersonated fetch for the multipart upload path. Mirrors
 * the headers and TLS profile of `impersonatedTransport()` but lets
 * `node-wreq` set `Content-Type` itself (with the multipart boundary)
 * instead of forcing `application/json`. Kept private; production code
 * goes through `photoUpload()` which composes the multipart envelope.
 *
 * Test injection: callers can pass an alternate `fetch` implementation
 * via the `fetchOverride` parameter on the public {@link photoUpload}
 * function (see {@link _setMultipartFetchForTesting}). Production never
 * sets the override; the fallback `wreqFetch` import resolves at module
 * load time.
 */
/**
 * Diagnostic-log context for `multipartImpersonatedFetch`. The caller
 * (only {@link photoUpload} today) hands over the parsed operation
 * envelope and the slot-to-variable-path map so the `--debug` trace
 * carries the actual GraphQL operation name, query, variables, and the
 * real wire-shape multipart map — not fabricated stand-ins. The fields
 * mirror the values that get serialized into the `operations` and
 * `map` form parts of the multipart request body (see the GraphQL
 * multipart request spec linked in {@link buildGraphQLMultipart}).
 */
interface MultipartLogContext {
  operationEnvelope: { operationName: string; query: string; variables: Record<string, unknown> };
  slotMap: Record<string, string[]>;
}

async function multipartImpersonatedFetch(
  token: string,
  form: FormData,
  logContext: MultipartLogContext,
): Promise<TransportResponse> {
  const url = SURFACE_ENDPOINTS["talent-profile"];
  const fetchImpl = multipartFetchOverride ?? wreqFetch;

  // Mirror COMMON_HEADERS minus the JSON content-type; node-wreq's FormData
  // body sets multipart/form-data; boundary=... itself. The "x-toptal-..."
  // header preserves fingerprint alignment with the rest of the surface.
  const headers: Record<string, string> = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    authorization: `Token token=${token}`,
    origin: "https://talent.toptal.com",
    referer: "https://talent.toptal.com/",
    "sec-fetch-site": "same-site",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "x-toptal-analytics-origin": "mobile",
  };

  // Diagnostic log hook (issue #139). This path is photo-upload-specific;
  // duplicating the `impersonatedMultipartTransport` hook here keeps both
  // paths covered without adding a circular dep between transport.ts and
  // this module. The operation envelope and slot map come from the
  // caller so the trace reflects the actual GraphQL operation +
  // wire-shape map (the binary file content is intentionally NOT in
  // the body — it carries no diagnostic value and binary in a terminal
  // would be useless).
  logTransportRequest({
    surface: "talent-profile",
    endpoint: url,
    transport: "impersonated-multipart",
    method: "POST",
    operationName: logContext.operationEnvelope.operationName,
    headers,
    body: logContext.operationEnvelope,
    multipart: { files: Object.keys(logContext.slotMap), map: logContext.slotMap },
  });
  const startMs = performance.now();

  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: form,
    browser: IMPERSONATE_PROFILE,
    // No-follow redirect policy (issue #268). This hand-rolled fetch
    // mirrors `impersonatedMultipartTransport` and must carry the same
    // posture — file-upload is the highest-impact body-exfiltration
    // vector if redirect handling weakens. `node-wreq` defaults to
    // `redirect: "follow"`; pinning `"manual"` returns a 3xx verbatim so
    // the check below can reject it.
    redirect: "manual",
  });

  const responseHeaders = res.headers.toObject();

  if (res.status === 403) {
    logTransportResponse({
      surface: "talent-profile",
      endpoint: url,
      operationName: logContext.operationEnvelope.operationName,
      status: 403,
      headers: responseHeaders,
      body: null,
      elapsedMs: performance.now() - startMs,
    });
    throw new Cf403Error("talent-profile", url);
  }

  // Redirect anomaly (issue #268) — same no-follow posture as the
  // transport.ts entry points. Capture the response in the diagnostic
  // trace before rejecting so an operator sees the redirect target.
  const redirectLocation = getRedirectLocation(res.status, responseHeaders);
  if (redirectLocation !== undefined) {
    logTransportResponse({
      surface: "talent-profile",
      endpoint: url,
      operationName: logContext.operationEnvelope.operationName,
      status: res.status,
      headers: responseHeaders,
      body: null,
      elapsedMs: performance.now() - startMs,
    });
    throw new RedirectError("talent-profile", url, res.status, redirectLocation);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  logTransportResponse({
    surface: "talent-profile",
    endpoint: url,
    operationName: logContext.operationEnvelope.operationName,
    status: res.status,
    headers: responseHeaders,
    body: parsed,
    elapsedMs: performance.now() - startMs,
  });
  return {
    status: res.status,
    headers: responseHeaders,
    body: parsed,
  };
}

// Test-only override slot for the multipart fetch implementation. Production
// code never sets this — production callers go through `photoUpload()` which
// wires up the real `node-wreq` fetch by default.
type MultipartFetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData; browser: string },
) => Promise<{
  status: number;
  text: () => Promise<string>;
  headers: { toObject: () => Record<string, string> };
}>;

let multipartFetchOverride: MultipartFetchImpl | null = null;

/**
 * Test-only: replace the multipart-fetch implementation used by
 * {@link photoUpload}. Pass `null` to restore the default. The override
 * receives the same arguments as `node-wreq`'s `fetch` and must return a
 * shape compatible with its `Response` (we only rely on `.status`,
 * `.text()`, and `.headers.toObject()`).
 *
 * @internal
 */
export function _setMultipartFetchForTesting(impl: MultipartFetchImpl | null): void {
  multipartFetchOverride = impl;
}
