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
  | "WIRE_SHAPE_ERROR"
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
// need `profileId` (e.g. `set`, `photoShow`, every sibling sub-domain's
// call to the shared `extractProfileId` helper in `../shared.ts`) keep
// using the cheap mobile-gateway-only `show()` path; only the CLI / MCP
// `basic show` surface (post-#129 formatter rewrite) pays the cost of
// the second talent-profile call.
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
 * One software-skill entry on `Profile.softwareSkills.nodes` — identifier
 * + display name. Same `Unknown`-typed-in-SDL story as {@link ProfileLanguage};
 * runtime contract is the source of truth. Filtering of malformed entries
 * happens in {@link getBasicInfo}.
 */
export interface ProfileSoftwareSkill {
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
 * return it). `languages` and `softwareSkills` are arrays — empty when
 * none are set, never `null` (the empty-collection convention agreed in
 * the #124 audit's null-rendering recommendation).
 *
 * **Scope expansion (#393, 2026-05-19)**: pre-#393 this projection carried
 * only `{profileId, bio, headline, languages}`. The Toptal `talent_profile`
 * API treats `UpdateBasicInfoInput` as a **full-replacement contract** —
 * any required non-null field omitted from the input fails with
 * "Expected value to not be null". To support a robust read-merge
 * mutation path in {@link set}, we now fetch the full set of server-
 * required scalars (`fullName`, `legalName`, `city`, `placeIdentity`,
 * `phoneNumber`) and id-bearing relations (`countryId`, `citizenshipId`,
 * `languageIds`, `softwareSkills` — the last surfaced as objects rather
 * than just ids because the API's read-side returns the rich shape).
 * Each is `null` when the user hasn't set it on their profile (the
 * server then rejects an UPDATE if a required field is null on read AND
 * the input omits it — see issue #393's repro). Callers that only want
 * the narrative bits (`bio` / `headline` / `languages`) continue to read
 * what they always did; the additional fields are additive.
 *
 * **Social-field expansion (#604, 2026-05-25)**: extended again with the
 * five social URLs (`linkedin`, `github`, `website`, `behance`,
 * `dribbble`) + `skype` for the same read-merge reason — the
 * full-replacement input carries them, so `set()` must read them to avoid
 * nulling them. These are echoed on the JSON / MCP read surface but NOT on
 * the curated `pretty` / `table` `basic show` rendering.
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
  /** Display name as the user typed it. `null` when unset on this account. */
  fullName: string | null;
  /** Legal name (matches the legal-documents name). `null` when unset. */
  legalName: string | null;
  /** City of residence (free-text). `null` when unset. */
  city: string | null;
  /** Google place identity (string token from the geocoder). `null` when unset. */
  placeIdentity: string | null;
  /** Country-of-residence id (`Country.id`). `null` when unset. */
  countryId: string | null;
  /** Citizenship country id (`Country.id`). `null` when unset. */
  citizenshipId: string | null;
  /** Phone number (free-text, server-validated). `null` when unset. */
  phoneNumber: string | null;
  /**
   * Twitter / X handle (`Profile.twitter`). Stored as a bare handle string
   * (no URL prefix, no leading `@`) per the live wire shape captured for
   * #535. `null` when unset. The `Profile` entity exposes `twitter` to
   * BOTH this `basic` surface and the sibling `external` surface (read
   * side); the **write** side is owned by `basic.set` only — the
   * `UpdateExternalProfilesInput` does NOT accept `twitter` (#526).
   */
  twitter: string | null;
  /**
   * Social / external URLs the `Profile` entity carries
   * (`linkedin / github / website / behance / dribbble`) plus the `skype`
   * handle. `null` when unset.
   *
   * **Read-merge rationale (#604, 2026-05-25)**: these are surfaced here
   * so `set()`'s full-replacement merge can preserve them. The live
   * `UPDATE_BASIC_INFO` `profile` input carries all six (verified via the
   * 2026-05-06 Save-action curl, `research/notes/10` § Captured exception);
   * because the mutation is a full-replacement contract (#393), omitting
   * them from the input NULLS them server-side — every bio/headline edit
   * silently wiped the user's social links. Reading them here lets the
   * merge echo the current value back, the same way `twitter` is preserved.
   *
   * **Write ownership is unchanged (#526)**: `linkedin / github / website /
   * behance / dribbble` remain WRITEABLE only via `external.update`; `skype`
   * is not writeable from any TTCtl surface today. `basic.set` does not
   * accept them as inputs ({@link ProfileUpdate} stays `bio`/`headline`/
   * `twitter`) — it only read-preserves them. They are echoed on the JSON /
   * MCP read surface but intentionally NOT on the `pretty` / `table`
   * `basic show` rendering (that stays curated; `external show` is the
   * human-facing home for the URLs).
   */
  linkedin: string | null;
  /** GitHub URL (`Profile.github`). See {@link BasicInfo.linkedin} for the read-merge / write-ownership semantics. `null` when unset. */
  github: string | null;
  /** Personal website URL (`Profile.website`). See {@link BasicInfo.linkedin}. `null` when unset. */
  website: string | null;
  /** Behance URL (`Profile.behance`). See {@link BasicInfo.linkedin}. `null` when unset. */
  behance: string | null;
  /** Dribbble URL (`Profile.dribbble`). See {@link BasicInfo.linkedin}. `null` when unset. */
  dribbble: string | null;
  /** Skype handle (`Profile.skype`). Not writeable from any TTCtl surface; read-preserved only. See {@link BasicInfo.linkedin}. `null` when unset. */
  skype: string | null;
  /** User-declared software skills (free-form, distinct from the rated `Skill` catalog). Empty array when none. */
  softwareSkills: ProfileSoftwareSkill[];
}

/**
 * Full-document `GET_BASIC_INFO` query string. Subset of the canonical
 * bundle-extracted operation
 * (`research/graphql/talent_profile/operations/GET_BASIC_INFO.graphql`):
 * we ask for the fields surfaced by {@link BasicInfo} — narrative
 * (`about`, `quote`), identity (`fullName`, `legalName`, `phoneNumber`),
 * location (`city`, `placeIdentity`, `country.id`, `citizenship.id`),
 * social (`twitter` — owned here per #535; and `linkedin / github /
 * website / behance / dribbble / skype` — added for #604 so the
 * full-replacement merge can preserve them, see below), and collections
 * (`languages.nodes`, `softwareSkills.nodes`). We skip the
 * `ProfileRecommendations` fragment, `timeZone`, and the top-level
 * `countries` / `languages` catalog payloads that the canonical operation
 * also fetches (autocomplete-tier, not needed for read or merge-on-write).
 *
 * **Social-URL scope expansion (#604)**: the five social URLs +
 * `skype` were previously skipped here because `external.update` owns
 * their WRITE path (#526). But `UPDATE_BASIC_INFO` is a full-replacement
 * contract (#393) and its `profile` input carries all six (live curl,
 * `research/notes/10` § Captured exception) — omitting them from the merge
 * NULLED them on every bio/headline edit. They are now read so `set()` can
 * echo them back. Write ownership is unchanged: still `external.update`.
 *
 * **Scope rationale (#393)**: this selection set covers the full set of
 * server-required non-null fields on `UpdateBasicInfoInput` (per the
 * issue's wire-error trace — `fullName`, `legalName`, `countryId`,
 * `city`, `placeIdentity`, `citizenshipId`, `languageIds`,
 * `phoneNumber`, `softwareSkills`). Adding any of these to the query
 * later would be an additive wire change — the snapshot diff catches
 * accidental regressions.
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
    fullName
    legalName
    city
    placeIdentity
    phoneNumber
    twitter
    linkedin
    github
    website
    behance
    dribbble
    skype
    country {
      id
    }
    citizenship {
      id
    }
    languages {
      nodes {
        id
        name
      }
    }
    softwareSkills {
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
    fullName?: string | null;
    legalName?: string | null;
    city?: string | null;
    placeIdentity?: string | null;
    phoneNumber?: string | null;
    twitter?: string | null;
    linkedin?: string | null;
    github?: string | null;
    website?: string | null;
    behance?: string | null;
    dribbble?: string | null;
    skype?: string | null;
    country?: { id?: string | null } | null;
    citizenship?: { id?: string | null } | null;
    languages?: { nodes?: ({ id?: string | null; name?: string | null } | null)[] | null } | null;
    softwareSkills?: { nodes?: ({ id?: string | null; name?: string | null } | null)[] | null } | null;
  } | null;
}

interface GetBasicInfoResponse {
  data?: GetBasicInfoData | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Fetch the {@link BasicInfo} projection of the `talent_profile`-only
 * profile fields that complement {@link show} — narrative scalars
 * (`bio`, `headline`), identity (`fullName`, `legalName`, `phoneNumber`),
 * location (`city`, `placeIdentity`, `countryId`, `citizenshipId`), and
 * collections (`languages`, `softwareSkills`). The full field roster
 * is required by `set()`'s read-merge path (#393); see
 * {@link BasicInfo} for per-field semantics.
 *
 * Routed against `https://www.toptal.com/api/talent_profile/graphql` via
 * {@link impersonatedTransport} (Cloudflare-protected; Chrome TLS
 * fingerprint required). Internally calls {@link show} first to obtain
 * the `profileId` required by the `profile(id: ID!)` field — same
 * pattern as {@link photoShow}.
 *
 * Returns a typed {@link BasicInfo} projection — `null` for scalars the
 * user hasn't set, empty arrays for `languages` and `softwareSkills`
 * when none.
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
  const languages = collectIdNameNodes(p.languages?.nodes);
  const softwareSkills = collectIdNameNodes(p.softwareSkills?.nodes);

  return {
    profileId: typeof p.id === "string" && p.id.length > 0 ? p.id : profileId,
    bio: typeof p.about === "string" ? p.about : null,
    headline: typeof p.quote === "string" ? p.quote : null,
    languages,
    fullName: typeof p.fullName === "string" ? p.fullName : null,
    legalName: typeof p.legalName === "string" ? p.legalName : null,
    city: typeof p.city === "string" ? p.city : null,
    placeIdentity: typeof p.placeIdentity === "string" ? p.placeIdentity : null,
    countryId: typeof p.country?.id === "string" && p.country.id.length > 0 ? p.country.id : null,
    citizenshipId: typeof p.citizenship?.id === "string" && p.citizenship.id.length > 0 ? p.citizenship.id : null,
    phoneNumber: typeof p.phoneNumber === "string" ? p.phoneNumber : null,
    twitter: typeof p.twitter === "string" ? p.twitter : null,
    linkedin: typeof p.linkedin === "string" ? p.linkedin : null,
    github: typeof p.github === "string" ? p.github : null,
    website: typeof p.website === "string" ? p.website : null,
    behance: typeof p.behance === "string" ? p.behance : null,
    dribbble: typeof p.dribbble === "string" ? p.dribbble : null,
    skype: typeof p.skype === "string" ? p.skype : null,
    softwareSkills,
  };
}

/**
 * Normalise a `{nodes: [{id, name}, ...]}` connection — used identically
 * for `languages` and `softwareSkills`. Drops null entries, entries with
 * empty string ids, and entries where `name` is not a string. The
 * filtered output guarantees both fields are non-empty strings, matching
 * the {@link ProfileLanguage} / {@link ProfileSoftwareSkill} contract.
 */
function collectIdNameNodes(
  rawNodes: ({ id?: string | null; name?: string | null } | null)[] | null | undefined,
): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const node of rawNodes ?? []) {
    if (node === null || typeof node !== "object") continue;
    if (typeof node.id !== "string" || node.id.length === 0) continue;
    if (typeof node.name !== "string") continue;
    out.push({ id: node.id, name: node.name });
  }
  return out;
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
      twitter
    }
  }
}`;

/**
 * Subset of profile fields editable via the wave-0 MVP write-path. `bio` and
 * `headline` are the user-facing flag names exposed by the CLI; they map to
 * the GraphQL fields `about` and `quote` respectively (the field names used
 * by the talent_profile surface — see the response selection in
 * `research/graphql/talent_profile/operations/UPDATE_BASIC_INFO.graphql`).
 * `twitter` maps 1:1 to `Profile.twitter`.
 *
 * All fields are optional. The caller is responsible for ensuring at least
 * one is supplied — `set()` rejects an empty object with a
 * `VALIDATION_ERROR`.
 *
 * `twitter` accepts EITHER a bare handle (`"alexey_pelykh"`) OR a full
 * profile URL (`"https://x.com/alexey_pelykh"`, `"https://twitter.com/…"`,
 * with or without a leading `@`); {@link set} runs it through
 * {@link normalizeTwitterHandle} and stores the **bare handle** the live
 * wire shape expects (curl evidence in #535: the field is sent as
 * `"twitter": "alexey_pelykh"`, NOT a URL — an in-input asymmetry vs the
 * sibling `linkedin`/`github`/`website` URL fields on the same input).
 * Normalising in core (#526) fixes the reopened regression where a URL
 * was forwarded verbatim and stored as a broken "handle". An empty string
 * clears the field; `null` is also accepted and clears the field (both
 * survive normalisation untouched — the wire schema permits both
 * representations of "absent").
 *
 * Why `twitter` lives on this `basic` write-path and NOT on
 * `external.update`: per #526, the `UpdateExternalProfilesInput` rejects
 * `twitter` with `"Field is not defined on ExternalProfilesInput"`.
 * Empirically the only server-side write surface for `Profile.twitter`
 * is `UPDATE_BASIC_INFO` — see #535 for the full evidence trail.
 */
export interface ProfileUpdate {
  bio?: string;
  headline?: string;
  twitter?: string | null;
}

/**
 * Normalise a user-supplied twitter/X value to the bare handle that
 * Toptal's `Profile.twitter` field stores (#526).
 *
 * The live `UPDATE_BASIC_INFO` wire shape expects a BARE HANDLE (e.g.
 * `alexey_pelykh`) — NOT a URL — even though the sibling
 * `linkedin`/`github`/`website` fields on the SAME input are full URLs (an
 * in-input asymmetry confirmed by the #526 live capture). Callers (and
 * ttctl's own pre-#526 docs) naturally pass a URL (`https://x.com/<handle>`);
 * forwarding it verbatim stored a URL where a handle was expected and the
 * field rendered broken. This normaliser accepts any of:
 *
 *   - bare handle:         `alexey_pelykh`                          → `alexey_pelykh`
 *   - leading-`@` handle:  `@alexey_pelykh`                         → `alexey_pelykh`
 *   - x.com URL:           `https://x.com/alexey_pelykh`            → `alexey_pelykh`
 *   - twitter.com URL:     `https://twitter.com/alexey_pelykh`      → `alexey_pelykh`
 *   - www / http / sub.:   `http://www.twitter.com/alexey_pelykh/`  → `alexey_pelykh`
 *   - URL with query/hash: `https://x.com/alexey_pelykh?s=20`       → `alexey_pelykh`
 *
 * Clear-intent values are preserved verbatim: `""` and `null` both mean
 * "clear the field" per {@link ProfileUpdate} and survive untouched.
 *
 * Leading/trailing whitespace is trimmed. A value that does not parse as a
 * recognised twitter/X URL is treated as an already-bare handle (after
 * stripping a single leading `@`) — unknown shapes are NOT rejected because
 * Toptal itself is the only authority on handle validity, and over-eager
 * client validation would block legitimate handles.
 *
 * Exported so the value contract is directly unit-testable and documented;
 * {@link set} applies it on BOTH the apply (merge) path and the dry-run
 * preview path so previews reflect exactly what the live mutation sends.
 */
export function normalizeTwitterHandle(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return "";

  // Recognised twitter/X URL → first path segment is the handle. Optional
  // scheme, optional `www.`/`mobile.`/other subdomains, `twitter.com` or
  // `x.com` host, an optional legacy `#!/` hashbang, an optional leading
  // `@`, then the handle up to the next `/`, `?`, `#`, or whitespace.
  const urlMatch = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:twitter|x)\.com\/(?:#!\/)?@?([^/?#\s]+)/i.exec(trimmed);
  if (urlMatch?.[1] !== undefined && urlMatch[1].length > 0) {
    return urlMatch[1];
  }

  // Not a recognised URL — treat as a bare handle, stripping one leading `@`.
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
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
 * **Full-replacement contract (#393)**: empirically (issue #393, wire error
 * 2026-05-19), the server's `UpdateBasicInfoInput!` rejects any required
 * non-null field omitted from the input — `fullName`, `legalName`,
 * `countryId`, `city`, `placeIdentity`, `citizenshipId`, `languageIds`,
 * `phoneNumber`, `softwareSkills`. The `talent_profile` API treats this
 * mutation as a **full-replacement contract** despite the JS bundle's
 * partial-input shape suggesting otherwise. `set()` therefore reads the
 * current profile state via {@link getBasicInfo} and merges user-supplied
 * fields over it before submitting the full input.
 *
 * `softwareSkills` is `{id, name}[]` per the captured-curl shape — NOT
 * just ids or `{id}` — so we echo back the full read-side objects.
 * `languageIds` is the documented input key (whereas read returns
 * `languages.nodes[]` — input and output use different field names).
 *
 * Social URL ownership across surfaces (#526 / #535): `twitter` is
 * **basic-owned** on the write side — the server's
 * `UpdateBasicInfoProfileInput` accepts it as a bare handle string and
 * persists it on `Profile.twitter` (read-visible on both `basic.show`
 * and `external.show`). The sibling social URLs
 * (`linkedin / github / website / behance / dribbble`) plus `skype`
 * remain WRITE-owned by `external.update` — they ARE writeable via
 * `UpdateExternalProfilesInput`, and #526 explicitly chose to keep them
 * there rather than migrating to this surface. `twitter` is the only one
 * the user can SET through `basic.set`, because it's the only one the
 * `external` write-input rejects.
 *
 * **But all six are SENT on this input (#604)**: because `UPDATE_BASIC_INFO`
 * is a full-replacement contract, the merge must echo every field the
 * `profile` input carries — and the live input carries all six social
 * fields + `skype`. They are read via {@link getBasicInfo} and preserved
 * unchanged (the user cannot change them here; {@link ProfileUpdate} has
 * no field for them). Sending them is preservation, not a new write path.
 * The basic-info merge runs user-supplied `twitter` through
 * {@link normalizeTwitterHandle} (URL / leading-`@` / bare → bare handle)
 * before sending it; the field is sent on every UPDATE_BASIC_INFO call
 * (read-merge preserves the current value — already a bare handle — when
 * the user doesn't supply a new one).
 */
interface UpdateBasicInfoInput {
  profileId: string;
  profile: UpdateBasicInfoProfileInput;
}

interface UpdateBasicInfoSoftwareSkillRef {
  id: string;
  name: string;
}

interface UpdateBasicInfoProfileInput {
  about: string | null;
  quote: string | null;
  fullName: string | null;
  legalName: string | null;
  city: string | null;
  placeIdentity: string | null;
  countryId: string | null;
  citizenshipId: string | null;
  phoneNumber: string | null;
  twitter: string | null;
  linkedin: string | null;
  github: string | null;
  website: string | null;
  behance: string | null;
  dribbble: string | null;
  skype: string | null;
  languageIds: string[];
  softwareSkills: UpdateBasicInfoSoftwareSkillRef[];
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
    twitter?: string | null;
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
 * handled at the CLI layer. `twitter` is server-echoed verbatim — the
 * write side accepts both bare-handle and empty/null shapes; the echo
 * normalises the persisted value back to either a string or `null`.
 */
export interface UpdateProfileResult {
  profile: {
    id: string;
    about: string | null;
    quote: string | null;
    twitter: string | null;
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
 * Placeholder string substituted for the basic-info scalar fields that
 * the apply-path merges from the current profile state via
 * {@link getBasicInfo}. The dry-run preview keeps the full input shape
 * (so consumers see exactly which fields the live mutation will send)
 * but uses these placeholders for values that would normally be read
 * server-side. The placeholder is intentionally distinct from
 * {@link DRY_RUN_PROFILE_ID_PLACEHOLDER} so the two preview surfaces
 * remain separately recognisable.
 *
 * Applies to: `fullName`, `legalName`, `city`, `placeIdentity`,
 * `countryId`, `citizenshipId`, `phoneNumber`, `about`, `quote`,
 * `twitter`, and the read-preserved social fields `linkedin`, `github`,
 * `website`, `behance`, `dribbble`, `skype` (#604) — any scalar field
 * that the merge path reads from current state when the user didn't
 * supply it. (Fields the user DID supply are echoed verbatim into the
 * preview, same as the apply path.)
 *
 * `languageIds` and `softwareSkills` use a dedicated empty-array
 * placeholder (`[]`) — the absence of an array is more readable than a
 * placeholder array, and consumers branching on the dry-run shape can
 * inspect `Array.isArray(...)` without special-case logic.
 */
export const DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER = "<preserved from current profile state>" as const;

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
 * Update a subset of the signed-in user's basic-info fields (`bio` →
 * `about`, `headline` → `quote`, `twitter` 1:1) via the Cloudflare-
 * protected `talent_profile/graphql` surface. `twitter` is owned by this
 * mutation rather than `external.update` per the #535 wire evidence —
 * see {@link ProfileUpdate} for the cross-surface rationale.
 *
 * Authenticates via `Authorization: Token token=<token>` (the canonical
 * Toptal auth mechanism). Cookies are NOT load-bearing — Chrome TLS
 * impersonation alone passes Cloudflare.
 *
 * **Read-merge protocol (#393)**: the server treats `UpdateBasicInfoInput!`
 * as a **full-replacement contract** — required non-null fields omitted
 * from the input fail with "Expected value to not be null", regardless
 * of their value in the current profile state. To support a partial
 * "I only want to change bio + headline" use case without losing
 * any of the other required fields, the apply path:
 *
 *   1. Calls {@link getBasicInfo} to read the current full state (this
 *      transitively calls `show()` for `profileId`).
 *   2. Merges user-supplied fields (`bio` → `about`, `headline` → `quote`)
 *      over the read snapshot.
 *   3. Submits the full {@link UpdateBasicInfoInput} with every required
 *      field populated.
 *
 * The extra read round-trip is acceptable for an update-the-profile
 * use case (profile updates are infrequent; the read is plain HTTPS
 * against the talent-profile surface).
 *
 * `twitter` plays the same merge role with one extra step: a
 * user-supplied value is first run through {@link normalizeTwitterHandle}
 * (URL / leading-`@` / bare → bare handle) so a URL is never stored as a
 * broken "handle" (#526); when the caller doesn't supply it, the current
 * persisted value (read via `getBasicInfo`, already a bare handle) is sent
 * unchanged. The wire schema accepts either a bare-handle string or
 * `null`; both shapes survive the merge (`""` / `null` clear-intents are
 * preserved by the normaliser untouched).
 *
 * Dry-run path (issue #52, extended for #393): when invoked with
 * `options.dryRun === true`, the preview is built WITHOUT firing any
 * transport (zero network I/O — preserved from the #52 AC). Fields that
 * the apply-path would have read from current state use
 * {@link DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER}; user-supplied fields
 * are echoed verbatim. Result: the preview's `variables.input.profile`
 * carries the exact key set the live mutation will send, with values
 * differentiated by `<preserved from current profile state>` (read-merged)
 * vs the user's literals (overridden). The bearer token is redacted in
 * the preview's `headers.authorization` per the security contract
 * documented on {@link DryRunPreview}.
 *
 * **Account-state precondition (#536)**: the Toptal API gates
 * `UPDATE_BASIC_INFO` behind an account-state flag — the talent must
 * have agreed to "receive text messages for important notifications,
 * like job requests and upcoming interviews" in their account settings
 * (talent.toptal.com → notifications). When SMS-notification consent
 * is disabled, the mutation does not "go through" — observed live but
 * the precise wire failure mode (a `USER_ERROR` with a specific
 * `code`/`key`, a `success: false` with no error, or an HTTP-layer
 * rejection) has NOT been empirically captured at this time. The
 * failure surfaces today via whichever of the {@link ProfileError}
 * branches below catches it (most likely `USER_ERROR` or
 * `GRAPHQL_ERROR`); a dedicated domain error code is deferred until a
 * captured failure response is available (#536 Tier 2). TTCtl
 * deliberately does NOT expose `UpdateSmsNotificationsSettings` (see
 * README § Out of scope — abuse-prevention rationale), so the only
 * remediation path is a one-time toggle by the user in the web UI
 * before retrying `basic.set`.
 *
 * Errors:
 * - `ProfileError` with code `VALIDATION_ERROR` when none of `bio`,
 *   `headline`, or `twitter` is supplied — the contract requires at
 *   least one. Fires in BOTH the apply-path and the dry-run path.
 * - `Cf403Error` propagates from the talent-profile transport when
 *   Cloudflare returns 403. Apply-path only (dry-run never touches the
 *   network).
 * - `AuthRevokedError` on token expiry (HTTP 401, or any GraphQL
 *   `extensions.code` matching `isAuthRevokedExtensionCode` — currently
 *   `'UNAUTHENTICATED'`, `'AUTHENTICATION_REQUIRED'`, or `'UNAUTHORIZED'`).
 *   Apply-path only — fires on EITHER the read-merge call or the write.
 * - `ProfileError` with code `NO_VIEWER` when no viewer is bound.
 *   Apply-path only — fires on the read-merge call.
 * - `ProfileError` with code `USER_ERROR` when the mutation returns a
 *   non-empty `errors` array (validation failures from the server, e.g., a
 *   bio that exceeds the platform's length limit). Apply-path only.
 * - `ProfileError` with code `GRAPHQL_ERROR` on top-level GraphQL errors
 *   from EITHER the read or write call. Apply-path only.
 * - `ProfileError` with code `NETWORK_ERROR` on transport-level throws.
 *   Apply-path only.
 */
export async function set(token: string, changes: ProfileUpdate, options: SetOptions = {}): Promise<SetOutcome> {
  if (changes.bio === undefined && changes.headline === undefined && changes.twitter === undefined) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      "Profile update requires at least one of `bio`, `headline`, or `twitter`.",
    );
  }

  // Dry-run short-circuit: build the WRITE request shape with placeholders
  // for fields that the apply-path would read from current state. Zero
  // transport calls (read OR write) — the #52 AC reads "transport never
  // called" in the singular and we honor it for both directions.
  if (options.dryRun === true) {
    const previewInput: UpdateBasicInfoInput = {
      profileId: DRY_RUN_PROFILE_ID_PLACEHOLDER,
      profile: {
        about: changes.bio !== undefined ? changes.bio : DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        quote: changes.headline !== undefined ? changes.headline : DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        fullName: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        legalName: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        city: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        placeIdentity: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        countryId: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        citizenshipId: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        phoneNumber: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        twitter:
          changes.twitter !== undefined
            ? normalizeTwitterHandle(changes.twitter)
            : DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        // #604: read-merged social fields — never user-supplied via basic.set,
        // so always the placeholder in the preview (apply-path echoes current).
        linkedin: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        github: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        website: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        behance: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        dribbble: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        skype: DRY_RUN_BASIC_INFO_FIELD_PLACEHOLDER,
        languageIds: [],
        softwareSkills: [],
      },
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

  // Read-merge: fetch the current full basic-info state so the mutation
  // input carries every server-required non-null field (#393). Errors
  // from getBasicInfo (ProfileError / AuthRevokedError / Cf403Error)
  // propagate verbatim — a write attempt that can't read its own profile
  // is unrecoverable, and surfacing the read-side error gives the user
  // the same actionable message they'd get from `ttctl profile show`.
  const current = await getBasicInfo(token);

  // Merge user-supplied fields over the current state. User intent wins:
  // `changes.bio === ""` is a real "clear the bio" intent, distinct from
  // "leave it alone" (which is `changes.bio === undefined`). The same
  // distinction applies to `changes.twitter` — `""` / `null` are real
  // "clear it" intents, `undefined` preserves the current value.
  const merged: UpdateBasicInfoProfileInput = {
    about: changes.bio !== undefined ? changes.bio : current.bio,
    quote: changes.headline !== undefined ? changes.headline : current.headline,
    fullName: current.fullName,
    legalName: current.legalName,
    city: current.city,
    placeIdentity: current.placeIdentity,
    countryId: current.countryId,
    citizenshipId: current.citizenshipId,
    phoneNumber: current.phoneNumber,
    twitter: changes.twitter !== undefined ? normalizeTwitterHandle(changes.twitter) : current.twitter,
    // #604: preserve the social URLs + skype the full-replacement contract
    // would otherwise NULL. These are NOT user-settable via basic.set (write
    // ownership stays with external.update per #526) — the merge only echoes
    // the current value back so a bio/headline edit stops wiping them.
    linkedin: current.linkedin,
    github: current.github,
    website: current.website,
    behance: current.behance,
    dribbble: current.dribbble,
    skype: current.skype,
    languageIds: current.languages.map((l) => l.id),
    softwareSkills: current.softwareSkills.map((s) => ({ id: s.id, name: s.name })),
  };

  let res: TransportResponse;
  try {
    res = await impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "UPDATE_BASIC_INFO",
        query: UPDATE_BASIC_INFO_MUTATION,
        variables: {
          input: { profileId: current.profileId, profile: merged } satisfies UpdateBasicInfoInput,
        },
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
        twitter: payload.profile.twitter ?? null,
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
