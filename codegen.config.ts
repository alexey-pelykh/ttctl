// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { CodegenConfig } from "@graphql-codegen/cli";
import type { Types } from "@graphql-codegen/plugin-helpers";
import type { DefinitionNode } from "graphql";

/**
 * GraphQL Codegen configuration.
 *
 * Operation documents and synthesized SDLs live in the private `ttctl/research`
 * repo (sibling to this repo in the local workspace), organized by **backend**:
 *
 *   - `../research/graphql/gateway/` — `https://www.toptal.com/gateway/graphql/talent/graphql`
 *     backend, shared by the mobile APK and the talent.toptal.com portal SPA.
 *     Operations live under `gateway/operations/{mobile,portal}/`; the
 *     synthesized SDL is `gateway/schema.graphql`.
 *   - `../research/graphql/talent_profile/` —
 *     `https://www.toptal.com/api/talent_profile/graphql` backend (the web
 *     profile editor surface, Cloudflare-protected). Operations live under
 *     `talent_profile/operations/`; the synthesized SDL is
 *     `talent_profile/schema.graphql`.
 *   - `../research/graphql/scheduler/` — `https://scheduler.toptal.com/api/graphql`
 *     backend. Excluded from codegen because no synthesized SDL exists yet (see
 *     `../research/graphql/scheduler/README.md`); revisit when the scheduler
 *     SDL lands.
 *
 * See `../research/graphql/README.md` for the full path contract and the
 * surface-vs-backend distinction.
 *
 * # Codegen scope policy
 *
 * Each `generates:` entry maps one research-repo backend to one TypeScript
 * output file. Documents are sourced as full directory globs so any operation
 * extracted into the research repo automatically surfaces typed bindings on
 * the next `pnpm codegen` run; the research repo is the single source of
 * truth for which operations exist.
 *
 * Some operations select fields the synthesized SDL does not declare. The
 * gateway SDL covers ~95% of its operation surface and the talent_profile SDL
 * uses `Unknown` placeholders for input/output positions where no live
 * capture pinned a concrete type (per `../research/graphql/{gateway,talent_profile}/coverage.md`).
 * Operations that hit those gaps are listed in the per-backend
 * `*_KNOWN_UNTRUSTED_OPS` arrays below and EXCLUDED from codegen — they are
 * "known-untrusted" until research-side schema closure lands. The graphql-codegen
 * v7 `skipValidationAgainstSchema` flag does NOT work around this: it triggers
 * a `typescript-operations` plugin crash (`Cannot read properties of undefined`),
 * so the only working mechanism is per-document exclusion.
 *
 * Newly-extracted operations that fail validation should be added to the
 * relevant `*_KNOWN_UNTRUSTED_OPS` array (and ideally tracked back to the
 * research-side schema gap so it can be closed). The TTCtl-side
 * **schema/contract validation rule** (project CLAUDE.md
 * § "Schema/contract validation rule") still applies to any source code that
 * consumes the typed shapes here: live integration tests
 * (`*.e2e.test.ts`, gated by `TTCTL_E2E=1`) are required before merge for
 * any operation whose wire format is best-effort.
 *
 * # Duplicate-emission handling
 *
 * Two graphql-codegen quirks would otherwise produce TypeScript duplicate-
 * identifier errors in the generated outputs:
 *
 *   1. Fragments inlined per-file. Most operation documents repeat the
 *      `fragment mutationResultFields on MutationResult { ... }` definition
 *      verbatim; without intervention, `typescript-operations` emits the
 *      fragment type once per occurrence. The `dedupeFragments` document
 *      transform keeps the first-loaded definition for each fragment name
 *      and drops subsequent duplicates (operations resolve fragment
 *      references via codegen's global registry, so a single retained
 *      definition is sufficient).
 *
 *   2. Input types re-emitted per output. The `typescript` plugin emits
 *      schema input types at the top of each output; `typescript-operations`
 *      then RE-emits any input it encounters in operation variables (its
 *      escape hatch, `importSchemaTypesFrom`, assumes split outputs). The
 *      `dedupeExportedTypes` `beforeOneFileWrite` hook strips the second
 *      occurrence of any `export type Name` declaration at write time.
 *
 * Both passes are deterministic and order-stable; dropping subsequent
 * occurrences preserves the richer-typed schema-side emission and the
 * canonical fragment shape.
 *
 * # Mobile / portal operation-name collisions (gateway backend)
 *
 * 13 operation names appear in BOTH `gateway/operations/mobile/` and
 * `gateway/operations/portal/` with non-identical selection sets (e.g.
 * `CancelEngagementBreak`, `SubmitTimesheet`). Both validate against the
 * gateway SDL — that SDL is the union of both surfaces' selections (see
 * `../research/graphql/gateway/coverage.md` § Notes), and per the same
 * source the **mobile arg shapes win** during synthesis. To keep
 * graphql-codegen output unambiguous (one TypeScript type per operation
 * name in a single output file), this config excludes the 13 portal-side
 * collision documents, preserving the mobile selection sets as the
 * canonical typed shape. Portal-only operations (the remaining ~154 of 167)
 * are included in full.
 *
 * # Output files
 *
 * Generated TypeScript files are committed to this repo so contributors
 * without research-repo access can build and consume typed operations.
 * Re-running `pnpm codegen` requires the sibling `../research/` working copy
 * and overwrites the committed outputs.
 *
 * Run: `pnpm codegen`
 */

/**
 * Operation-name collisions between `gateway/operations/mobile/` and
 * `gateway/operations/portal/`. These portal-side documents are excluded from
 * the gateway codegen so the mobile-side selection sets remain the canonical
 * typed shape (see policy above). Sync with the collision set reported by
 * `pnpm codegen` if `../research/` adds or renames a colliding operation.
 */
const GATEWAY_PORTAL_COLLISIONS = [
  "CancelEngagementBreak",
  "CreateMarketplaceHelpRequest",
  "CreateRateChangeRequest",
  "DismissSurvey",
  "RescheduleEngagementBreak",
  "ResetSearchFilters",
  "SaveSearchFilters",
  "SendReferralEmail",
  "SetUnavailable",
  "StartIdVerification",
  "SubmitSurvey",
  "SubmitTimesheet",
  "UpdateTimesheet",
];

/**
 * Mobile-surface gateway operations that select fields the synthesized SDL
 * does not declare. Excluded as known-untrusted until the research-side
 * schema synthesizer closes the corresponding gaps. Maintain alphabetically.
 */
const GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS: string[] = [
  "AcceptInterview",
  "AccessibleRoles",
  "AllNotificationCenterItems",
  "AvailabilityRequest",
  "BecomeClientProgramDetails",
  "BlogPosts",
  "BlogPostsByIDs",
  "CancelEngagementBreak",
  "ClearJobInterestStatus",
  "ClientReferralProgramDetails",
  "CommunityEvent",
  "CommunityEvents",
  "ConfirmAvailabilityRequest",
  "CreateEngagementBreak",
  "CreateRateChangeRequest",
  "DashboardData",
  "DirectClientReferralProgramDetails",
  "DismissSurvey",
  "EnablePreliminaryJobSearch",
  "EngagementBreaks",
  "InitialJobs",
  "Interview",
  "InterviewGuide",
  "Job",
  "JobActivityItem",
  "JobActivityItemPayments",
  "JobActivityItems",
  "JobActivityItemsByIDs",
  "JobActivityMostRelevantApplication",
  "JobApplicationQuestions",
  "JobApplicationRateInsight",
  "JobApply",
  "JobApplyData",
  "JobsByIDs",
  "MarkJobAsNotInterested",
  "MarkJobAsSaved",
  "MarkJobAsViewed",
  "MarkJobOfferDisclaimerAsViewed",
  "MobileFeedbackForm",
  "NotificationCenterByIDs",
  "OmniJob",
  "PastPitches",
  "Payments",
  "PaymentsByIDs",
  "PendingSurveys",
  "RateChangeRequestQuestions",
  "ReferralProgramsList",
  "ReferralTrackers",
  "ReferralTrackersByIDs",
  "RejectAvailabilityRequest",
  "RejectInterview",
  "RemoveProfileSkillSet",
  "RescheduleEngagementBreak",
  "ResetSearchFilters",
  "RsvpToEvent",
  "SaveProfileIndustry",
  "SaveProfileSkillSet",
  "SaveProfileSkillSetsPublicity",
  "SavedJobs",
  "SavedSearchFilters",
  "SaveSearchFilters",
  "SendPasswordResetEmail",
  "SetUnavailable",
  "SimilarJobQuestionAnswers",
  "SkillsAutocomplete",
  "StartIdVerification",
  "StartJobsSearchSubscription",
  "SubmitMobileFeedbackForm",
  "SubmitSurvey",
  "SubmitTimesheet",
  "SurveyById",
  "SwitchMobileRole",
  "TalentBadgeByID",
  "TalentReferralProgramDetails",
  "TerminateJobsSearchSubscription",
  "Timesheets",
  "TopChatAttachmentUpload",
  "TopChatConfiguration",
  "TopChatConversations",
  "UpdateAllocatedHours",
  "UpdateJobAlertSettings",
  "UpdateProposedEndDate",
  "UpdateSmsNotificationsSettings",
  "UpdateTimesheet",
  "UpdateTimesheetReminderSettings",
  "UpsellProgramDetails",
  "ZendeskToken",
  // — surfaced after the 100-error limit was reached on prior iterations —
  "GoogleOAuthSignIn",
  "Home",
  "JobSubscription",
  "LastRateChangeRequest",
  "MobileStory",
  "NotificationSettings",
  "Payment",
  "PendingTimesheets",
  "ProfileOverview",
  "Requests",
  "SavedJobsCount",
  "Talent",
  "TimesheetDetails",
  "TimesheetsByIDs",
  "TopChatConversationById",
  "EmailPasswordSignIn",
];

/**
 * Portal-surface gateway operations that select fields the synthesized SDL
 * does not declare. Excluded as known-untrusted (see policy header).
 */
const GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS: string[] = [
  "AcceptCodeOfConduct",
  "AcceptFreelanceTalentAgreement",
  "AcceptReachOut",
  "AcceptTermsOfService",
  "AcknowledgeAllTalentBadges",
  "AddProfileIndustryConnections",
  "AddSurveyFeedback",
  "ApplyForJob",
  "ApplyForSpecialization",
  "AttachVideoPitch",
  "ChatQuery",
  "CompleteConsultationsTraining",
  "CompleteConsultingOnboarding",
  "CompleteConsultingTraining",
  "CompleteQuiz",
  "CreateBecomeClient",
  "CreateCoachingRequest",
  "CreateCommunityLeaderApplication",
  "CreateDirectReferral",
  "CreateTalentSignal",
  "CreateTopChatConversation",
  "CreateTopChatUpload",
  "DisableCalendar",
  "DisablePreliminarySearchSetting",
  "EnableCalendar",
  "EnablePreliminarySearchSetting",
  "GetAccessibleRoles",
  "GetAdvancedProfileWizardStatus",
  "GetBecomeClientQuestions",
  "GetChannelCategories",
  "GetChroniclesToken",
  "GetCoachingRequests",
  "GetCommunityLeaderApplication",
  "GetCommunityLeaders",
  "GetConnectedAccounts",
  "GetConsultationMeetings",
  "GetConsultationNotifications",
  "GetConsultationsBookingPageSlug",
  "GetConsultationsReachOuts",
  "GetConsultationsTrainingCompleted",
  "GetConsultingProfile",
  "GetContracts",
  "GetDirectReferralQuestions",
  "GetEngagementPayments",
  "GetExpertiseAreas",
  "GetGigs",
  "GetInterviewNotes",
  "GetJobDetailsForHeader",
  "GetJobDetailsForTimesheet",
  "GetJobMatchQualityMetrics",
  "GetJobsCountForDashboard",
  "GetJobsForDashboard",
  "GetKipperToken",
  "GetLeadTime",
  "GetLensToken",
  "GetMainBookingPageSlug",
  "GetMeetings",
  "GetNearestCommunityLeader",
  "GetNotifications",
  "GetOverviewWidgetData",
  "GetPastPitches",
  "GetPendingConsultationsReachOutsCount",
  "GetPendingFeedbackCallCampaigns",
  "GetPerformedActions",
  "GetPlatformConfiguration",
  "GetPreviousJobCard",
  "GetProfileData",
  "GetProfileMeetingTimes",
  "GetProfileTimestamps",
  "GetPublicationGigRejectionReasons",
  "GetRateChangeRequestQuestions",
  "GetRecognitionNotifications",
  "GetRecommendedChannels",
  "GetRecommendedJobs",
  "GetReferralEvents",
  "GetReferralPrograms",
  "GetReferredRewards",
  "GetReferrer",
  "GetRoleLensToken",
  "GetSearchFilters",
  "GetSearchSubscription",
  "GetSkillsForAutoSuggest",
  "GetSlackAccessSetting",
  "GetSlackChannel",
  "GetSlackChannelCategoriesForHome",
  "GetSlackTopMessages",
  "GetTalentCommunityEvents",
  "GetTalentCommunitySlackChannels",
  "GetTalentDataForDrawer",
  "GetTalentJobRateInsight",
  "GetTalentPayersAutocomplete",
  "GetTalentPaymentOptions",
  "GetTalentPaymentSummary",
  "GetTalentPayments",
  "GetTalentReferralStats",
  "GetTalentReferralTrackers",
  "GetTalentSignalSetup",
  "GetTalentSpecializations",
  "GetTalentUpsellReferralProgram",
  "GetTopSchedulerToken",
  "GetVerticals",
  "GetViewer",
  "GetViewerContributions",
  "GetZendeskToken",
  "HideRecommendedChannel",
  "JobMarkViewed",
  "LearningProgramEnroll",
  "MarkAsPreferredPaymentOption",
  "MarkCalendarAsPrimary",
  "MarkJobsAsViewed",
  "MarkMarketplaceMigrationNotificationSeen",
  "MarkSeenFirstJobNotification",
  "ProposeEngagementEndDate",
  "ReferralizeUrl",
  "RejectAvailabilityRequests",
  "RejectReachOut",
  "RemoveCoachingRequest",
  "RemoveConnectedAccount",
  "ReviewTermsOfService",
  "RevokeSlackApplicationToken",
  "SaveProfileSkillSetsAndConnections",
  "ScheduleEngagementBreak",
  "SetAvailability",
  "SetAvailabilityRequests",
  // — surfaced after the 100-error limit was reached on prior iterations —
  "GetBadgeGroups",
  "GetBillingCycles",
  "ShortenUrl",
  "SubmitHireMePage",
  "SubscribeToSearch",
  "SwitchRole",
  "TimeOffForEdit",
  "TokenQuery",
  "UnsubscribeFromSearch",
  "UpdateAccountSettings",
  "UpdateAppearanceSettings",
  "UpdateConsultingRate",
  "UpdateInterviewTalentNotes",
  "UpdateLeadTime",
  "UpdateMeetingHoursAndTimezone",
  "UpdateNotificationSetting",
  "UpdateOnboardingStatus",
  "UpdatePaymentOption",
  "UpdateTimezone",
  "UpdateWorkingHours",
  "UploadTimesheet",
  "confirmInterviewInvitation",
  "rejectInterviewInvitation",
  "submitGigFeedback",
  "GetTalentCommunitySlackAnnouncements",
];

/**
 * talent_profile fragments whose selection sets reference fields the
 * synthesized SDL marks as `Unknown` (placeholder for unresolved types).
 * Loading them blocks codegen even when no remaining operation references
 * them. Excluded as known-untrusted; reduce as the talent_profile SDL gains
 * concrete types. Maintain alphabetically.
 */
const TALENT_PROFILE_KNOWN_UNTRUSTED_FRAGMENTS: string[] = [
  "ActivationSteps",
  "Certification",
  "CertificationConnectionTotalCount",
  "Education",
  "EducationConnectionTotalCount",
  "Employer",
  "Employment",
  "EmploymentConnectionTotalCount",
  "EmploymentsMissingData",
  "Experiments",
  "IndustryProfile",
  "PaymentOptions",
  "PhotoProfile",
  "Portfolio",
  "PortfolioItemConnectionTotalCount",
  "PortfolioItemFileConnection",
  "PortfolioItemFileImage",
  "PortfolioItemFilePdf",
  "PortfolioItemGalleryBlock",
  "PortfolioItemImageBlock",
  "ProfileConnection",
  "ProfileConnectionTotalCount",
  "ProfileData",
  "ProfileRecommendations",
  "ProfileSkillSet",
  "ProfileSkillSetWithConnections",
  "ProfileSkillSetWithConnectionsCount",
  "ProfileSkillSetWithConnectionsTotalCounts",
  "ProfileWorkingHours",
  "RealTimeFields",
  "Section",
  "SkillSetMissingConnection",
  "SkillsReadiness",
  "TravelVisa",
  "WorkExperienceProfileFragment",
];

/**
 * talent_profile operations that select subfields on positions the
 * synthesized SDL types as `Unknown` (placeholder for unresolved types).
 * Excluded as known-untrusted; reduce as the talent_profile SDL gains
 * concrete types.
 */
const TALENT_PROFILE_KNOWN_UNTRUSTED_OPS: string[] = [
  "ADD_PROFILE_SKILL_SET",
  "AcceptFreelanceTalentAgreement",
  "ApproveItemReview",
  "ApproveSectionReview",
  "CREATE_CERTIFICATION",
  "CREATE_EDUCATION",
  "CREATE_PAYONEER_PAYMENT_OPTION",
  "CREATE_TOPTAL_PAYMENT_ACCOUNT",
  "CreateEmployment",
  "GET_BASIC_INFO",
  "GET_CERTIFICATION",
  "GET_EDUCATION",
  "GET_ELIGIBLE_ENGAGEMENTS",
  "GET_EMPLOYERS_AUTOCOMPLETE",
  "GET_ENGAGEMENT_AUTOCOMPLETE",
  "GET_ENGAGEMENT_SURVEY_MODAL",
  "GET_PHOTO",
  "GET_REPORTING_TO_AUTOCOMPLETE",
  "GET_SKILLS_FOR_AUTOCOMPLETE",
  "GET_WORK_EXPERIENCE",
  "GetActivationLegalData",
  "GetFreelanceTalentAgreement",
  "GetSkillSetWithConnections",
  "GetSkillSetWithConnectionsTotalCounts",
  "GetTimeZoneWorkingHours",
  "LogOut",
  "REFETCH_PROFILE_SECTIONS_SKILLS",
  "REMOVE_CERTIFICATION",
  "REMOVE_EDUCATION",
  "REMOVE_PROFILE_SKILL_SET",
  "RemoveEmployment",
  "RequestTaxForm",
  "SEND_CONTRACTS",
  "UPDATE_BASIC_INFO",
  "UpdateAdvancedProfileWizardStatus",
  "UpdateExternalProfiles",
  "sectionReviews",
  "updateCustomRequirements",
  "UPDATE_CERTIFICATION",
  "UPDATE_EDUCATION",
  "UPDATE_PROFILE_SKILL_SET_EXPERIENCE",
  "UPDATE_PROFILE_SKILL_SET_PUBLICITY",
  "UPDATE_PROFILE_SKILL_SET_RATING",
  "UpdateEmployment",
  "UploadProfilePhoto",
  "acceptAgreement",
  "acceptTraining",
  "addProfileSkillSetConnection",
  "analyticsInfo",
  "changePortfolioItemPosition",
  "createPortfolioItem",
  "createTravelVisa",
  "getActivationTalentRecentIdVerification",
  "getAdvancedProfileData",
  "getAgreement",
  "getCountries",
  "getLegalSettingsData",
  "getPaymentData",
  "getPortfolioItems",
  "getProfileItems",
  "getProfileSettingsUrls",
  "getProfileVersionsCount",
  "getPublicProfileUrl",
  "getScreeningExperienceSurveyUrl",
  "getSkillSetsWithConnectionsWithConnectionsCount",
  "getSkills",
  "getSnapshotHistory",
  "getSnapshotText",
  "getExperiments",
  "GetIndustryProfile",
  "getProfileData",
  "getProfileReadiness",
  "getProfileRecommendations",
  "getSkillsReadiness",
  "getStaffTalentUrl",
  "getStepsAndLinks",
  "getSupportStaff",
  "getTalentTrainingData",
  "getTravelVisas",
  "getVerticalConfig",
  "getViewer",
  "highlightCertification",
  "highlightEducation",
  "highlightEmployment",
  "highlightPortfolioItem",
  "removePortfolioItem",
  "removeProfileSkillSetConnection",
  "removeTravelVisa",
  "stepStaff",
  "submitForReview",
  "updatePortfolioItem",
  "updateTimeZoneWorkingHours",
  "updateTravelVisa",
  "uploadPortfolioCover",
  "uploadPortfolioFile",
  "viewerName",
];

const SHARED_PLUGIN_CONFIG = {
  useTypeImports: true,
  avoidOptionals: true,
  skipTypename: false,
  enumsAsTypes: true,
} as const;

/**
 * Document transform that deduplicates fragment definitions by name across
 * the entire document set. Each `.graphql` operation file in the research
 * repo inlines its own copy of any fragment it depends on (e.g. nearly every
 * mutation that returns a `MutationResult` re-declares
 * `fragment mutationResultFields on MutationResult { ... }`). Without dedup,
 * `typescript-operations` emits one `MutationResultFieldsFragment` (and one
 * `MutationResultFields_<Payload>_Fragment` per implementing payload type)
 * per file that includes the fragment, producing TypeScript duplicate
 * identifier errors.
 *
 * The transform keeps the FIRST occurrence of each fragment name (glob order:
 * mobile/ then portal/ for the gateway output, operations/ then fragments/
 * for the talent_profile output; alphabetical within each directory) and
 * drops subsequent duplicates. Operations that reference the fragment by
 * name continue to resolve via codegen's global fragment registry — the
 * fragment only needs to exist in ONE document to be referenceable from
 * any other.
 *
 * If two same-named fragments have NON-IDENTICAL selection sets, only the
 * first-loaded shape is retained in the generated types. This matches the
 * pre-dedup `skipDuplicateValidation: true` behavior, but makes it explicit
 * (and removes the duplicate type emissions as a side effect).
 */
const dedupeFragments: Types.DocumentTransformObject = {
  transform: ({ documents }) => {
    const seen = new Set<string>();
    return documents.map((file) => {
      if (!file.document) return file;
      const definitions: DefinitionNode[] = [];
      let dropped = false;
      for (const def of file.document.definitions) {
        if (def.kind === "FragmentDefinition") {
          const name = def.name.value;
          if (seen.has(name)) {
            dropped = true;
            continue;
          }
          seen.add(name);
        }
        definitions.push(def);
      }
      if (!dropped) return file;
      return {
        ...file,
        document: { ...file.document, definitions },
      };
    });
  },
};

/**
 * Post-emission `beforeOneFileWrite` hook that deduplicates `export type`
 * declarations by name, keeping only the FIRST occurrence.
 *
 * Why this is needed: the `typescript` plugin emits every input type from the
 * schema; the `typescript-operations` plugin THEN re-emits any input type
 * referenced by an operation's variable definitions
 * (see `@graphql-codegen/typescript-operations/visitor.js` ::
 * `InputObjectTypeDefinition`). The plugin author's intended escape hatch
 * (`importSchemaTypesFrom`) assumes operations and schema types live in
 * SEPARATE files — when both plugins emit into the same combined output
 * (the layout this repo uses), the inputs collide.
 *
 * The first emission (typescript plugin, near the top of the file) uses the
 * full `Scalars['X']['input']` and `InputMaybe<...>` typing; the second
 * (typescript-operations, just before the operation types) flattens to raw
 * primitives — semantically equivalent but textually distinct. Keeping the
 * earlier (richer-typed) emission and dropping the later one is correct for
 * downstream consumers; the only thing the typescript-operations re-emission
 * adds is the duplicate-identifier TypeScript error.
 *
 * The line-based scan handles both shapes typescript-operations emits:
 *   - Multi-line object/union types ending on a standalone `};` or `;` line
 *   - Single-line aliases (`export type X = Y;`)
 */
const dedupeExportedTypes = (_filePath: string, content: string): string => {
  const seen = new Set<string>();
  const lines = content.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const match = /^export type (\w+)\b/.exec(line);
    const name = match?.[1];
    if (!name) {
      result.push(line);
      i++;
      continue;
    }
    let braceDepth = 0;
    let blockEnd = i;
    while (blockEnd < lines.length) {
      const trimmed = (lines[blockEnd] ?? "").trimEnd();
      for (const ch of trimmed) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
      }
      if (braceDepth === 0 && /;\s*$/.test(trimmed)) break;
      blockEnd++;
    }
    const isDuplicate = seen.has(name);
    if (!isDuplicate) {
      seen.add(name);
      for (let k = i; k <= blockEnd; k++) result.push(lines[k] ?? "");
    }
    i = blockEnd + 1;
    if (isDuplicate && i < lines.length && lines[i] === "") i++;
  }
  return result.join("\n");
};

const SHARED_HOOKS = {
  beforeOneFileWrite: [dedupeExportedTypes],
} as const;

const config: CodegenConfig = {
  overwrite: true,
  generates: {
    "packages/core/src/__generated__/gateway.ts": {
      schema: "../research/graphql/gateway/schema.graphql",
      documents: [
        "../research/graphql/gateway/operations/mobile/*.graphql",
        "../research/graphql/gateway/operations/portal/*.graphql",
        ...GATEWAY_PORTAL_COLLISIONS.map((name) => `!../research/graphql/gateway/operations/portal/${name}.graphql`),
        ...GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS.map(
          (name) => `!../research/graphql/gateway/operations/mobile/${name}.graphql`,
        ),
        ...GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS.map(
          (name) => `!../research/graphql/gateway/operations/portal/${name}.graphql`,
        ),
      ],
      documentTransforms: [dedupeFragments],
      hooks: SHARED_HOOKS,
      plugins: [
        {
          add: {
            content: [
              "// SPDX-License-Identifier: AGPL-3.0-only",
              "// Copyright (C) 2026 Oleksii PELYKH",
              "//",
              "// AUTO-GENERATED by `pnpm codegen` from",
              "// `../research/graphql/gateway/schema.graphql` and operations under",
              "// `../research/graphql/gateway/operations/{mobile,portal}/`.",
              "// Do not edit by hand; re-run codegen instead.",
              "",
            ].join("\n"),
          },
        },
        "typescript",
        "typescript-operations",
      ],
      config: SHARED_PLUGIN_CONFIG,
    },
    "packages/core/src/__generated__/talent-profile.ts": {
      schema: [
        "../research/graphql/talent_profile/schema.graphql",
        // The talent_profile SDL uses bare `Unknown` as a placeholder for
        // input/output positions where no live capture pinned a concrete
        // type. Declaring it as a scalar lets graphql-codegen accept the
        // schema and emit `unknown` at consumer sites — same shape the
        // gateway SDL declares natively. Operations that select SUBFIELDS on
        // an `Unknown` position still fail validation and must be listed in
        // `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`.
        "scalar Unknown",
      ],
      documents: [
        "../research/graphql/talent_profile/operations/*.graphql",
        // talent_profile operations reference standalone fragment files
        // (e.g. `...Education`, `...UserErrorFragment`); load them so
        // graphql-codegen can resolve the references.
        "../research/graphql/talent_profile/fragments/*.graphql",
        ...TALENT_PROFILE_KNOWN_UNTRUSTED_OPS.map(
          (name) => `!../research/graphql/talent_profile/operations/${name}.graphql`,
        ),
        ...TALENT_PROFILE_KNOWN_UNTRUSTED_FRAGMENTS.map(
          (name) => `!../research/graphql/talent_profile/fragments/${name}.graphql`,
        ),
      ],
      documentTransforms: [dedupeFragments],
      hooks: SHARED_HOOKS,
      plugins: [
        {
          add: {
            content: [
              "// SPDX-License-Identifier: AGPL-3.0-only",
              "// Copyright (C) 2026 Oleksii PELYKH",
              "//",
              "// AUTO-GENERATED by `pnpm codegen` from",
              "// `../research/graphql/talent_profile/schema.graphql` and operations under",
              "// `../research/graphql/talent_profile/operations/`.",
              "// Do not edit by hand; re-run codegen instead.",
              "",
            ].join("\n"),
          },
        },
        "typescript",
        "typescript-operations",
      ],
      config: SHARED_PLUGIN_CONFIG,
    },
  },
};

export default config;
