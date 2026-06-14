// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `viewer-rich` — the FULL portal `GetViewer` projection behind
 * `profile show --verbose` (issue #469). Separate from `basic.show()`
 * (`ProfileShow`), which is a deliberately TRIMMED, codegen-trusted
 * adaptation of the same upstream op.
 *
 * `basic.show()` drops the heavy/operational fields so the default view
 * stays light; this module restores them: the inline legal-document
 * bodies (`codeOfConduct.body` / `termsOfService.body`, ~25 KB combined),
 * `scheduledAvailability`, `jobActivityList`, `pendingSurveys`/
 * `pendingQuizzes`, `slackApplications`, `ongoingRateChangeRequest`,
 * market-condition, and the ~20 extra `viewerRole` scopes (rate-insight,
 * operations, permissions, talentPartner, lastMobileAccess, …).
 *
 * **Schema/contract status: INFERRED.** `GetViewer` is in
 * `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`) — EXCLUDED
 * from codegen, so there is no generated type. The hand-authored
 * {@link RichViewer} interface below is sourced from
 * `research/notes/13-getviewer-empirical-shape.md` (live capture
 * 2026-05-06) cross-checked against the generated `ProfileShowQuery`
 * scalar shapes for every overlapping field. Wire validation is **Track 1
 * (wire-shape snapshot)** — `packages/e2e/src/72-profile-viewer-rich.e2e.test.ts`
 * + `GetViewer.snapshot.json`. Mandatory live E2E pre-merge per CLAUDE.md
 * § Schema/contract validation rule.
 *
 * **Surface**: `mobile-gateway` (plain HTTPS via `stockTransport`, bearer
 * auth) — same surface and transport as `ProfileShow`. NOT Cloudflare-
 * impersonated.
 *
 * **Wire conventions** (note 13, retained in the types below): `Money.decimal`
 * and the rate-insight rates are STRINGS; `TimeZone.utcOffset`/`stdOffset`
 * are integer seconds (`number`); timestamps are ISO-8601 strings.
 * `JobActivityItemStatus.{raw,slug}` is lowercase (every other enum is
 * `UPPER_SNAKE`) — typed `string` here, parse permissively downstream.
 */

import { AuthRevokedError } from "../../auth/errors.js";
import { stockTransport } from "../../transport.js";
import type { TransportResponse } from "../../transport.js";
import { ProfileError } from "./basic/index.js";
import { isAuthRevokedExtensionCode } from "./shared.js";

/**
 * Full-document `GetViewer` query. Embeds the captured operation verbatim
 * from `research/graphql/gateway/operations/portal/GetViewer.graphql`
 * (query + its 7 fragments) — sent as a full document (not a persisted
 * query) for the same reason as `ProfileShow`: the persisted-query catalog
 * churns on every portal release. Keep in sync with the .graphql source if
 * either is edited.
 */
const GET_VIEWER_QUERY = `query GetViewer { viewer { id appliedAt hasSearchSubscription hireMeBanner { ...HireMeBanner } availabilityRequestTalentCardEnabled coachingEligibility codeOfConduct { id acceptedAt body title revisedOn revisionNotice } scheduledAvailability { id commitment effectiveDate proceedable } termsOfService { id body title revisedOn revisionNotice requiredAction } viewerRole { activatedAt askExpertMenuVisible blockedStatus { isBlocked reason } roleId profileId availability: availabilityV2 hiredHours fullName phoneNumber email toptalEmail toptalEmailSuspended userChameleonUUID topSchedulerSettingsAllowed sendNotificationsToPrivateEmail applicationReapplyGracePeriodDueDate specializationType specializations { id title deliveryModel { id identifier } } photo { small } postActivationStepsStatus publicResumeUrl timeZone { name value location utcOffset stdOffset } allocatedHours lastAllocatedHoursChangeRequest { id allocatedHours availability: availabilityV2 status: statusV2 { value verbose } rejectReason comment } lastMobileAccess { deviceType startedAt } isPassThroughTalent talentPartner { id fullName email } talentVerticals { isApiAllowed name roleId slug } vertical { name slug hasSingleSpecialization isMarketplaceAccessEnabled profileHandbookUrl minPortfolioItems talentJobApplicationConfig { portfolioRequired careerHighlightRequired highlightFields } marketCondition { condition } globalMarketCondition { condition conditionVerbose conditionColor reportUrl } } nonTalentRoles { id name } hourlyRate { verbose decimal } availableShiftRangeFrom availableShiftRangeTo workingTimeFrom workingTimeTo isFakeSession contactFields { communitySlackId } rateInsight { hourly { currentRateCompetitive recentApplicationRate recommendedRate } } operations { ...ViewerRoleOperationsFragment } permissions { ...Permissions } marketplaceSeenMigrationNotificationAt marketplaceAutoMigrated } ongoingRateChangeRequest { id status } pendingNotifications { slug } pendingSurveys(version: 2) { id ...PendingSurvey } pendingQuizzes { id kind questions { answers { body isCorrect } body feedback } } preliminarySearchSetting { enabled } referralUrl { legacySlug pathSuffix shortenedUrl url } jobActivityList(statusGroup: {except: [ARCHIVED, CLOSED_ENGAGEMENT, ON_CLIENT_REVIEW, ON_RECRUITER_REVIEW, ON_TRIAL]}) { entities { id job { id title engagementDeliveryModel { id identifier } activityItem { id status: statusV2 { raw slug } } client { id isEnterprise } ...JobSimpleMatcherData } engagement { id endDate proposedEnd { id status endDate } startDate commitment { slug verbose } } } } talentPortalSetting { collapsedMenu threeColumnLayout } slackApplications { edges { authorizationStatus node { id name oauthUrl } } } } }

fragment SimpleRecruiterData on Recruiter { id fullName contactFields { email communitySlackId } }

fragment SimplePointsOfContactData on PointsOfContact { current { id ...SimpleRecruiterData } handoff { id ...SimpleRecruiterData } kind }

fragment JobSimpleMatcherData on TalentJob { id pointsOfContact { ...SimplePointsOfContactData } }

fragment HireMeBanner on HireMeBanner { enabled submitted experimentVariant referralUrl personalWebsiteUrl verificationStatus verifiedCount }

fragment ViewerRoleOperationsFragment on ViewerRoleOperations { promoteGigs { callable errors { code message } messages } createRateChangeRequest { callable messages } startSearchSubscription { callable messages } }

fragment Permissions on TalentPermissions { canApplyToJobs canFillInAdvancedProfile canHaveReferrals canViewAskAnExpert canViewCoachingRequests canViewCommunity canViewConsultations canViewEligibleJobs canViewFaq canViewFeedbackCall canViewJobsOnClientReview canViewJobsOnMatcherReview canViewLegalSetting canViewMobileAppPromo canViewOnboardingVideo canViewPayments canViewRateInsights canViewRecognitionBadges canViewSlackCommunity canViewSmsNotificationSettings canViewSpecializations canViewToptalAdvantageSection }

fragment PendingSurvey on Survey { job { id title client { id fullName isEnterprise } ...JobSimpleMatcherData } id createdAt isMandatory kind questions { answers { id label note value } id inputType isMandatory label note placeholder } engagement { id } }`;

// ---------------------------------------------------------------------
// Response projection — `viewer` shape, INFERRED per note 13.
//
// Nullable / empty-on-capture scopes are marked `| null` / typed at their
// selection-set shape (the capture account returned several of these empty:
// pendingSurveys, pendingQuizzes, slackApplications.edges, jobActivityList,
// scheduledAvailability, ongoingRateChangeRequest, talentPartner). The T1
// wire snapshot is the live contract guard; these types are consumer
// ergonomics.
// ---------------------------------------------------------------------

export interface RichHireMeBanner {
  enabled: boolean;
  submitted: boolean;
  experimentVariant: string | null;
  referralUrl: string | null;
  personalWebsiteUrl: string | null;
  verificationStatus: string;
  verifiedCount: number;
}

export interface RichLegalDocument {
  id: string;
  /** Present on `codeOfConduct`; null until accepted. */
  acceptedAt?: string | null;
  /** Inline full legal text — ~9-16 KB each (note 13 § E). */
  body: string;
  title: string;
  revisedOn: string | null;
  revisionNotice: string | null;
  /** `termsOfService` only — e.g. "NONE" / "ACCEPT". */
  requiredAction?: string;
}

export interface RichScheduledAvailability {
  id: string;
  commitment: string;
  effectiveDate: string | null;
  proceedable: boolean;
}

export interface RichBlockedStatus {
  isBlocked: boolean;
  reason: string | null;
}

export interface RichDeliveryModel {
  id: string;
  identifier: string;
}

export interface RichSpecialization {
  id: string;
  title: string;
  deliveryModel: RichDeliveryModel;
}

export interface RichTimeZone {
  name: string;
  value: string;
  location: string;
  /** Integer seconds (note 13). */
  utcOffset: number;
  /** Integer seconds (note 13). */
  stdOffset: number;
}

export interface RichAllocatedHoursChangeRequest {
  id: string;
  allocatedHours: number;
  availability: string;
  status: { value: string; verbose: string };
  rejectReason: string | null;
  comment: string | null;
}

export interface RichMobileAccess {
  deviceType: string;
  startedAt: string;
}

export interface RichTalentPartner {
  id: string;
  fullName: string;
  email: string | null;
}

export interface RichTalentVertical {
  isApiAllowed: boolean;
  name: string;
  roleId: number;
  slug: string;
}

export interface RichJobApplicationConfig {
  portfolioRequired: boolean;
  careerHighlightRequired: boolean;
  highlightFields: string[];
}

export interface RichMarketCondition {
  condition: string;
}

export interface RichGlobalMarketCondition {
  condition: string;
  conditionVerbose: string;
  conditionColor: string;
  reportUrl: string | null;
}

export interface RichVertical {
  name: string;
  slug: string;
  hasSingleSpecialization: boolean;
  isMarketplaceAccessEnabled: boolean;
  profileHandbookUrl: string | null;
  minPortfolioItems: number;
  talentJobApplicationConfig: RichJobApplicationConfig;
  marketCondition: RichMarketCondition;
  globalMarketCondition: RichGlobalMarketCondition;
}

export interface RichMoney {
  verbose: string;
  /** String on the wire — `BigDecimal` (note 13). Parse downstream. */
  decimal: string;
}

export interface RichRateInsightHourly {
  currentRateCompetitive: boolean;
  /** String on the wire (note 13). */
  recentApplicationRate: string;
  /** String on the wire (note 13). */
  recommendedRate: string;
}

export interface RichViewerRoleOperation {
  /** Enum-ish: "ENABLED" / "DISABLED" / "HIDDEN" (note 13). */
  callable: string;
  messages: string[];
  errors?: { code: string; message: string }[];
}

export interface RichViewerRoleOperations {
  promoteGigs: RichViewerRoleOperation;
  createRateChangeRequest: RichViewerRoleOperation;
  startSearchSubscription: RichViewerRoleOperation;
}

/** All 22 selected talent permissions — uniform booleans. */
export interface RichPermissions {
  canApplyToJobs: boolean;
  canFillInAdvancedProfile: boolean;
  canHaveReferrals: boolean;
  canViewAskAnExpert: boolean;
  canViewCoachingRequests: boolean;
  canViewCommunity: boolean;
  canViewConsultations: boolean;
  canViewEligibleJobs: boolean;
  canViewFaq: boolean;
  canViewFeedbackCall: boolean;
  canViewJobsOnClientReview: boolean;
  canViewJobsOnMatcherReview: boolean;
  canViewLegalSetting: boolean;
  canViewMobileAppPromo: boolean;
  canViewOnboardingVideo: boolean;
  canViewPayments: boolean;
  canViewRateInsights: boolean;
  canViewRecognitionBadges: boolean;
  canViewSlackCommunity: boolean;
  canViewSmsNotificationSettings: boolean;
  canViewSpecializations: boolean;
  canViewToptalAdvantageSection: boolean;
}

export interface RichViewerRole {
  activatedAt: string | null;
  askExpertMenuVisible: boolean;
  blockedStatus: RichBlockedStatus;
  roleId: number;
  profileId: string;
  /** Alias for `availabilityV2` — e.g. "PART_TIME" / "FULL_TIME". */
  availability: string;
  hiredHours: number;
  fullName: string;
  phoneNumber: string;
  email: string;
  toptalEmail: string;
  toptalEmailSuspended: boolean;
  userChameleonUUID: string;
  topSchedulerSettingsAllowed: boolean;
  sendNotificationsToPrivateEmail: boolean;
  applicationReapplyGracePeriodDueDate: string | null;
  specializationType: string;
  specializations: RichSpecialization[];
  photo: { small: string };
  postActivationStepsStatus: string;
  publicResumeUrl: string;
  timeZone: RichTimeZone;
  allocatedHours: number;
  lastAllocatedHoursChangeRequest: RichAllocatedHoursChangeRequest | null;
  lastMobileAccess: RichMobileAccess | null;
  isPassThroughTalent: boolean;
  talentPartner: RichTalentPartner | null;
  talentVerticals: RichTalentVertical[];
  vertical: RichVertical;
  nonTalentRoles: { id: string; name: string }[];
  hourlyRate: RichMoney;
  availableShiftRangeFrom: string | null;
  availableShiftRangeTo: string | null;
  workingTimeFrom: string | null;
  workingTimeTo: string | null;
  isFakeSession: boolean;
  contactFields: { communitySlackId: string | null };
  rateInsight: { hourly: RichRateInsightHourly };
  operations: RichViewerRoleOperations;
  permissions: RichPermissions;
  marketplaceSeenMigrationNotificationAt: string | null;
  marketplaceAutoMigrated: boolean;
}

export interface RichReferralUrl {
  legacySlug: string | null;
  pathSuffix: string | null;
  shortenedUrl: string | null;
  url: string;
}

export interface RichJobActivityEntity {
  id: string;
  job: {
    id: string;
    title: string;
    engagementDeliveryModel: { id: string; identifier: string } | null;
    /** `status.{raw,slug}` is lowercase for this type (note 13 § A). */
    activityItem: { id: string; status: { raw: string; slug: string } } | null;
    client: { id: string; isEnterprise: boolean } | null;
    pointsOfContact: unknown;
  };
  engagement: {
    id: string;
    endDate: string | null;
    proposedEnd: { id: string; status: string; endDate: string | null } | null;
    startDate: string | null;
    commitment: { slug: string; verbose: string } | null;
  } | null;
}

export interface RichSlackApplicationEdge {
  authorizationStatus: string;
  node: { id: string; name: string; oauthUrl: string | null };
}

/**
 * The full `viewer` projection returned by `GetViewer`. 19 viewer-level
 * fields; `viewerRole` carries the bulk. See module docblock for status.
 */
export interface RichViewer {
  id: string;
  appliedAt: string | null;
  hasSearchSubscription: boolean;
  hireMeBanner: RichHireMeBanner;
  availabilityRequestTalentCardEnabled: boolean;
  coachingEligibility: string | null;
  codeOfConduct: RichLegalDocument;
  scheduledAvailability: RichScheduledAvailability | null;
  termsOfService: RichLegalDocument;
  viewerRole: RichViewerRole;
  ongoingRateChangeRequest: { id: string; status: string } | null;
  pendingNotifications: { slug: string }[];
  pendingSurveys: unknown[];
  pendingQuizzes: unknown[];
  preliminarySearchSetting: { enabled: boolean };
  referralUrl: RichReferralUrl;
  jobActivityList: { entities: RichJobActivityEntity[] };
  talentPortalSetting: { collapsedMenu: boolean; threeColumnLayout: boolean };
  slackApplications: { edges: RichSlackApplicationEdge[] };
}

interface GraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

interface GetViewerResponse {
  data?: { viewer?: RichViewer | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Fetch the FULL portal `GetViewer` projection for the signed-in user —
 * the `profile show --verbose` data source.
 *
 * Mirrors `basic.show()`'s transport + error taxonomy exactly (mobile-
 * gateway, bearer auth, `ProfileError` / `AuthRevokedError`), so the CLI /
 * MCP error handlers already in place for `profile show` cover this path
 * unchanged. Reuses the same `isAuthRevokedExtensionCode` auth-revoke
 * classifier as `auth status` (AC: "reuses existing auth status
 * infrastructure where applicable").
 *
 * Throws:
 * - `AuthRevokedError` on HTTP 401 or an auth-revoked `extensions.code`.
 * - `ProfileError("NO_VIEWER")` on HTTP 200 with `data.viewer === null`.
 * - `ProfileError("GRAPHQL_ERROR")` on a non-auth `errors[]`.
 * - `ProfileError("NETWORK_ERROR")` on transport failure.
 */
export async function showRich(token: string): Promise<RichViewer> {
  let res: TransportResponse;
  try {
    res = await stockTransport({
      surface: "mobile-gateway",
      authToken: token,
      body: { operationName: "GetViewer", query: GET_VIEWER_QUERY },
    });
  } catch (err) {
    throw new ProfileError("NETWORK_ERROR", `GetViewer request failed: ${(err as Error).message}`, { cause: err });
  }

  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError("UNKNOWN", `GetViewer request returned HTTP ${res.status.toString()}`);
  }

  const body = res.body as GetViewerResponse | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ProfileError("GRAPHQL_ERROR", `GetViewer query failed: ${first?.message ?? "GraphQL error"}`);
  }

  const viewer = body?.data?.viewer;
  if (viewer === null || viewer === undefined) {
    throw new ProfileError("NO_VIEWER", "GetViewer returned no viewer bound to this session.");
  }
  return viewer;
}
