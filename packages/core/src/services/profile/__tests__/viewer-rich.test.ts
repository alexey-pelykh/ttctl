// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// `showRich` runs against mobile-gateway via `stockTransport` (same surface
// + transport as `basic.show`; no Cloudflare, no impersonation).
vi.mock("../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport.js")>("../../../transport.js");
  return { ...actual, stockTransport: vi.fn() };
});

import { showRich } from "../viewer-rich.js";
import type { RichViewer } from "../viewer-rich.js";
import { ProfileError } from "../basic/index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { stockTransport } from "../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-rich-123";

function replyStock(status: number, body: unknown): void {
  mockedStock.mockResolvedValueOnce({ status, headers: {}, body } satisfies TransportResponse);
}

/** Complete `RichViewer` fixture — every required field populated. */
const VIEWER_OK: RichViewer = {
  id: "VjEtVmlld2VyLTEyMjc5OQ",
  appliedAt: "2011-12-28T18:01:19+01:00",
  hasSearchSubscription: false,
  hireMeBanner: {
    enabled: true,
    submitted: false,
    experimentVariant: "control",
    referralUrl: "https://www.toptal.com/r/ada",
    personalWebsiteUrl: null,
    verificationStatus: "IDLE",
    verifiedCount: 0,
  },
  availabilityRequestTalentCardEnabled: true,
  coachingEligibility: "QUICK",
  codeOfConduct: {
    id: "coc-1",
    acceptedAt: "2024-01-01T00:00:00+00:00",
    body: "Be excellent to each other.",
    title: "Code of Conduct",
    revisedOn: "2024-01-01",
    revisionNotice: null,
  },
  scheduledAvailability: null,
  termsOfService: {
    id: "tos-1",
    body: "These are the terms.",
    title: "Terms of Service",
    revisedOn: "2024-01-01",
    revisionNotice: null,
    requiredAction: "NONE",
  },
  viewerRole: {
    activatedAt: "2018-06-15T00:00:00+00:00",
    askExpertMenuVisible: true,
    blockedStatus: { isBlocked: false, reason: null },
    roleId: 12345,
    profileId: "p1",
    availability: "PART_TIME",
    hiredHours: 30,
    fullName: "Ada Lovelace",
    phoneNumber: "+1 555 0100",
    email: "ada@example.com",
    toptalEmail: "ada@toptal.com",
    toptalEmailSuspended: false,
    userChameleonUUID: "11111111-1111-4111-8111-111111111111",
    topSchedulerSettingsAllowed: true,
    sendNotificationsToPrivateEmail: false,
    applicationReapplyGracePeriodDueDate: null,
    specializationType: "CORE_WITH_MARKETPLACE",
    specializations: [{ id: "s1", title: "Core", deliveryModel: { id: "dm1", identifier: "CORE" } }],
    photo: { small: "https://cdn.example.com/ada-small.jpg" },
    postActivationStepsStatus: "COMPLETED",
    publicResumeUrl: "https://www.toptal.com/resume/ada",
    timeZone: {
      name: "Europe/Berlin",
      value: "(GMT+01:00) Berlin",
      location: "Berlin",
      utcOffset: 3600,
      stdOffset: 3600,
    },
    allocatedHours: 40,
    lastAllocatedHoursChangeRequest: null,
    lastMobileAccess: { deviceType: "IOS", startedAt: "2026-05-01T08:00:00+00:00" },
    isPassThroughTalent: false,
    talentPartner: null,
    talentVerticals: [{ isApiAllowed: true, name: "AI", roleId: 12345, slug: "ai" }],
    vertical: {
      name: "Artificial Intelligence",
      slug: "ai",
      hasSingleSpecialization: false,
      isMarketplaceAccessEnabled: true,
      profileHandbookUrl: null,
      minPortfolioItems: 2,
      talentJobApplicationConfig: {
        portfolioRequired: true,
        careerHighlightRequired: false,
        highlightFields: ["EMPLOYMENTS"],
      },
      marketCondition: { condition: "POOR" },
      globalMarketCondition: {
        condition: "POOR",
        conditionVerbose: "Poor",
        conditionColor: "WARNING",
        reportUrl: null,
      },
    },
    nonTalentRoles: [],
    hourlyRate: { verbose: "$110.00", decimal: "110.0" },
    availableShiftRangeFrom: null,
    availableShiftRangeTo: null,
    workingTimeFrom: "08:00:00",
    workingTimeTo: "18:00:00",
    isFakeSession: false,
    contactFields: { communitySlackId: "U123" },
    rateInsight: { hourly: { currentRateCompetitive: true, recentApplicationRate: "108.0", recommendedRate: "120.0" } },
    operations: {
      promoteGigs: { callable: "ENABLED", messages: [] },
      createRateChangeRequest: { callable: "ENABLED", messages: [] },
      startSearchSubscription: { callable: "ENABLED", messages: [] },
    },
    permissions: {
      canApplyToJobs: true,
      canFillInAdvancedProfile: true,
      canHaveReferrals: true,
      canViewAskAnExpert: true,
      canViewCoachingRequests: true,
      canViewCommunity: true,
      canViewConsultations: true,
      canViewEligibleJobs: true,
      canViewFaq: true,
      canViewFeedbackCall: true,
      canViewJobsOnClientReview: true,
      canViewJobsOnMatcherReview: true,
      canViewLegalSetting: true,
      canViewMobileAppPromo: true,
      canViewOnboardingVideo: true,
      canViewPayments: true,
      canViewRateInsights: true,
      canViewRecognitionBadges: true,
      canViewSlackCommunity: true,
      canViewSmsNotificationSettings: true,
      canViewSpecializations: true,
      canViewToptalAdvantageSection: true,
    },
    marketplaceSeenMigrationNotificationAt: null,
    marketplaceAutoMigrated: false,
  },
  ongoingRateChangeRequest: null,
  pendingNotifications: [{ slug: "complete-profile" }],
  pendingSurveys: [],
  pendingQuizzes: [],
  preliminarySearchSetting: { enabled: false },
  referralUrl: {
    legacySlug: "ada",
    pathSuffix: "/ada",
    shortenedUrl: "https://tpt.al/ada",
    url: "https://www.toptal.com/r/ada",
  },
  jobActivityList: { entities: [] },
  talentPortalSetting: { collapsedMenu: false, threeColumnLayout: true },
  slackApplications: { edges: [] },
};

describe("profile.showRich (GetViewer rich portal projection)", () => {
  beforeEach(() => {
    mockedStock.mockReset();
  });

  it("returns the full viewer projection on a 200 response", async () => {
    replyStock(200, { data: { viewer: VIEWER_OK } });
    const result = await showRich(TOKEN);
    expect(result.id).toBe(VIEWER_OK.id);
    expect(result.viewerRole.fullName).toBe("Ada Lovelace");
    expect(result.codeOfConduct.body).toContain("excellent");
    expect(result.viewerRole.hourlyRate.decimal).toBe("110.0");
    expect(result.viewerRole.timeZone.utcOffset).toBe(3600);
  });

  it("sends the GetViewer operation against mobile-gateway with the bearer", async () => {
    replyStock(200, { data: { viewer: VIEWER_OK } });
    await showRich(TOKEN);
    const req = mockedStock.mock.calls[0]?.[0] as TransportRequest;
    expect(req.surface).toBe("mobile-gateway");
    expect(req.authToken).toBe(TOKEN);
    expect(req.body.operationName).toBe("GetViewer");
    expect(req.body.query).toContain("query GetViewer");
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    replyStock(401, {});
    await expect(showRich(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws AuthRevokedError on an auth-revoked extensions.code", async () => {
    replyStock(200, { errors: [{ message: "no", extensions: { code: "UNAUTHENTICATED" } }] });
    await expect(showRich(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError(GRAPHQL_ERROR) on a non-auth errors[]", async () => {
    replyStock(200, { errors: [{ message: "boom" }] });
    await expect(showRich(TOKEN)).rejects.toMatchObject({ name: "ProfileError", code: "GRAPHQL_ERROR" });
  });

  it("throws ProfileError(NO_VIEWER) when data.viewer is null", async () => {
    replyStock(200, { data: { viewer: null } });
    await expect(showRich(TOKEN)).rejects.toMatchObject({ name: "ProfileError", code: "NO_VIEWER" });
  });

  it("throws ProfileError(NETWORK_ERROR) when the transport throws", async () => {
    mockedStock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const err = await showRich(TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).code).toBe("NETWORK_ERROR");
  });
});
