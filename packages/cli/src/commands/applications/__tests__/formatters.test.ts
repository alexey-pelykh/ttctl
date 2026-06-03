// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { applications } from "@ttctl/core";

import { formatAvailabilityRequestDetail } from "../availability-request.js";
import { formatRespondPayload } from "../confirm.js";
import { formatInterviewDetail, formatInterviewGuide, formatInterviewNotes } from "../interview.js";
import { formatApplicationsTable, formatDate, shortenStatusGroup } from "../list.js";
import { formatRejectReasons } from "../reject-reasons.js";
import { formatFixedRate } from "../shared.js";
import { formatApplicationDetail } from "../show.js";
import { formatStatsPretty } from "../stats.js";

const ITEM: applications.JobActivityItem = {
  id: "act-1",
  statusV2: { value: "ACTIVE", verbose: "Active" },
  statusGroupV2: { value: "ACTIVE_ENGAGEMENT", verbose: "Active engagement" },
  statusColor: "#0f0",
  lastUpdatedAt: "2026-04-01T12:00:00Z",
  job: {
    id: "job-1",
    title: "Senior Engineer",
    url: "https://www.toptal.com/jobs/job-1",
    client: { id: "cli-1", fullName: "Acme Inc." },
  },
  jobApplication: { id: "app-1" },
  engagement: { id: "eng-1" },
  availabilityRequest: null,
  interview: null,
  mostRelevantApplication: null,
  fixedRate: null,
};

/**
 * Embed fixture factory (#539). The public
 * {@link applications.AvailabilityRequestEmbed} extends prior `{ id }`
 * presence indicator with talent-response triple + recruiter; tests
 * default the new fields to null so fixtures stay terse, with overrides
 * exercising the populated branches.
 */
function embedFixture(
  overrides: Partial<applications.AvailabilityRequestEmbed> = {},
): applications.AvailabilityRequestEmbed {
  return {
    id: "ar-1",
    talentComment: null,
    requestedHourlyRate: null,
    rejectReason: null,
    recruiter: null,
    ...overrides,
  };
}

describe("shortenStatusGroup", () => {
  it("maps each known group to a compact label", () => {
    expect(shortenStatusGroup("ACTIVE_ENGAGEMENT")).toBe("Active");
    expect(shortenStatusGroup("ARCHIVED")).toBe("Archived");
    expect(shortenStatusGroup("CLOSED_ENGAGEMENT")).toBe("Closed");
    expect(shortenStatusGroup("ON_CLIENT_REVIEW")).toBe("Client");
    expect(shortenStatusGroup("ON_RECRUITER_REVIEW")).toBe("Recruiter");
  });

  it("returns the input verbatim for an unknown value (forward-compat)", () => {
    expect(shortenStatusGroup("FUTURE_GROUP")).toBe("FUTURE_GROUP");
  });
});

describe("formatDate", () => {
  it("trims an ISO 8601 string to the YYYY-MM-DD prefix", () => {
    expect(formatDate("2026-04-01T12:00:00Z")).toBe("2026-04-01");
    expect(formatDate("2026-04-01T12:00:00+02:00")).toBe("2026-04-01");
  });

  it("returns the input unchanged when it does not start with a date", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
    expect(formatDate("")).toBe("");
  });
});

describe("formatFixedRate (#410)", () => {
  it("returns the server-formatted verbose when present", () => {
    expect(formatFixedRate({ decimal: "77.00", verbose: "$77.00/hr" })).toBe("$77.00/hr");
  });
  it("falls back to $<decimal>/h when verbose is empty (defensive)", () => {
    expect(formatFixedRate({ decimal: "109.00", verbose: "" })).toBe("$109.00/h");
  });
  it("returns empty string when fixedRate is null", () => {
    expect(formatFixedRate(null)).toBe("");
  });
});

describe("formatApplicationsTable", () => {
  it("renders an empty table when there are no items", () => {
    const out = formatApplicationsTable([]);
    expect(out).toContain("id");
    expect(out).toContain("status");
    expect(out).toContain("group");
    expect(out).toContain("job");
    expect(out).toContain("updated");
  });

  it("renders rows with the shortened group label and trimmed date", () => {
    const out = formatApplicationsTable([ITEM]);
    expect(out).toContain("act-1");
    expect(out).toContain("Active");
    expect(out).toContain("Senior Engineer");
    expect(out).toContain("2026-04-01");
  });

  it("renders '(untitled)' when job.title is null", () => {
    const out = formatApplicationsTable([{ ...ITEM, job: { ...ITEM.job, title: null } }]);
    expect(out).toContain("(untitled)");
  });
});

describe("formatApplicationDetail", () => {
  const DETAIL: applications.JobActivityItemDetail = {
    ...ITEM,
    job: {
      ...ITEM.job,
      descriptionMd: "Para 1.\n\nPara 2.",
      expectedHours: 40,
      startDate: "2026-01-01",
      postedWhen: "1 month ago",
      commitment: { slug: "full_time" },
      workType: { slug: "remote" },
      specialization: { title: "Backend" },
      estimatedLength: { enumValue: "LONG_TERM" },
      isCoaching: false,
      isToptalProject: false,
    },
    jobApplication: {
      id: "app-1",
      requestedHourlyRate: { decimal: "100.00" },
    },
    engagement: {
      id: "eng-1",
      startDate: "2026-02-01",
      endDate: null,
      commitment: { slug: "full_time" },
      expectedHours: 40,
    },
  };

  it("renders the activity header with status and group", () => {
    const out = formatApplicationDetail(DETAIL);
    expect(out).toContain("Activity act-1");
    expect(out).toContain("Status: Active (ACTIVE)");
    expect(out).toContain("Group:  Active engagement (ACTIVE_ENGAGEMENT)");
    expect(out).toContain("Updated: 2026-04-01T12:00:00Z");
  });

  it("renders the Job section with description split into paragraphs", () => {
    const out = formatApplicationDetail(DETAIL);
    expect(out).toContain("Job");
    expect(out).toContain("Senior Engineer");
    expect(out).toContain("https://www.toptal.com/jobs/job-1");
    expect(out).toContain("Client: Acme Inc.");
    expect(out).toContain("Commitment: full_time");
    expect(out).toContain("Work type: remote");
    expect(out).toContain("Specialization: Backend");
    expect(out).toContain("Hours: 40");
    expect(out).toContain("Length: LONG_TERM");
    expect(out).toContain("Starts: 2026-01-01");
    expect(out).toContain("Posted: 1 month ago");
    expect(out).toContain("Description:");
    expect(out).toContain("Para 1.");
    expect(out).toContain("Para 2.");
  });

  it("surfaces job type flags only when true", () => {
    const out = formatApplicationDetail({
      ...DETAIL,
      job: { ...DETAIL.job, isCoaching: true, isToptalProject: false },
    });
    expect(out).toContain("Type: coaching");
    expect(out).not.toContain("Type: toptal-project");
  });

  it("surfaces availability-request and interview presence indicators when present", () => {
    const out = formatApplicationDetail({
      ...DETAIL,
      availabilityRequest: embedFixture(),
      interview: { id: "iv-1" },
    });
    expect(out).toContain("Availability request: ar-1");
    expect(out).toContain("Interview: iv-1");
  });

  it("renders the Application section with requested rate when present", () => {
    const out = formatApplicationDetail(DETAIL);
    expect(out).toContain("Application");
    expect(out).toContain("Id: app-1");
    expect(out).toContain("Requested rate: 100.00");
  });

  it("renders the Engagement section with start date and commitment", () => {
    const out = formatApplicationDetail(DETAIL);
    expect(out).toContain("Engagement");
    expect(out).toContain("Started: 2026-02-01");
    expect(out).toContain("Commitment: full_time");
    expect(out).toContain("Hours: 40");
  });

  it("omits Application and Engagement sections when those fields are null", () => {
    const minimal: applications.JobActivityItemDetail = {
      ...DETAIL,
      jobApplication: null,
      engagement: null,
    };
    const out = formatApplicationDetail(minimal);
    expect(out).not.toContain("Application");
    expect(out).not.toContain("Engagement");
  });

  it("omits Description when descriptionMd is null", () => {
    const noDesc: applications.JobActivityItemDetail = {
      ...DETAIL,
      job: { ...DETAIL.job, descriptionMd: null },
    };
    const out = formatApplicationDetail(noDesc);
    expect(out).not.toContain("Description:");
  });

  it("renders the Fixed rate section when fixedRate is present (#410)", () => {
    const out = formatApplicationDetail({
      ...DETAIL,
      availabilityRequest: embedFixture(),
      fixedRate: { decimal: "77.00", verbose: "$77.00/hr" },
    });
    expect(out).toContain("Fixed rate");
    expect(out).toContain("$77.00/hr");
  });

  it("omits the Fixed rate section when fixedRate is null (#410)", () => {
    const out = formatApplicationDetail(DETAIL);
    expect(out).not.toContain("Fixed rate");
  });

  it("falls back to $<decimal>/h when verbose is empty (#410 defensive)", () => {
    const out = formatApplicationDetail({
      ...DETAIL,
      availabilityRequest: embedFixture(),
      fixedRate: { decimal: "109.00", verbose: "" },
    });
    expect(out).toContain("$109.00/h");
  });

  // ---------------------------------------------------------------------
  // #539 — embedded AR sub-projection on JobActivityItemDetail
  // ---------------------------------------------------------------------

  it("renders the Recruiter line under Availability request when populated (#539)", () => {
    const out = formatApplicationDetail({
      ...DETAIL,
      availabilityRequest: embedFixture({
        recruiter: { firstName: "Alex", lastName: "Recruiter", fullName: "Alex Recruiter" },
      }),
    });
    expect(out).toContain("Availability request:");
    expect(out).toContain("  Recruiter: Alex Recruiter");
  });

  it("falls back to firstName + lastName when embedded recruiter.fullName is null (#539)", () => {
    const out = formatApplicationDetail({
      ...DETAIL,
      availabilityRequest: embedFixture({
        recruiter: { firstName: "Sam", lastName: "Recruiter", fullName: null },
      }),
    });
    expect(out).toContain("  Recruiter: Sam Recruiter");
  });

  it("renders Talent rate / Talent comment / Reject reason when populated on the embed (#539)", () => {
    const out = formatApplicationDetail({
      ...DETAIL,
      availabilityRequest: embedFixture({
        talentComment: "Available next Monday.",
        requestedHourlyRate: { decimal: "85.00", verbose: "$85.00/hr" },
        rejectReason: "scope_mismatch",
      }),
    });
    expect(out).toContain("  Talent rate: $85.00/hr");
    expect(out).toContain("  Talent comment: Available next Monday.");
    expect(out).toContain("  Reject reason: scope_mismatch");
  });

  it("renders only the AR id when no #539 fields are populated", () => {
    const out = formatApplicationDetail({
      ...DETAIL,
      availabilityRequest: embedFixture({ id: "ar-bare" }),
    });
    expect(out).toContain("Availability request: ar-bare");
    expect(out).not.toContain("  Recruiter:");
    expect(out).not.toContain("  Talent rate:");
    expect(out).not.toContain("  Talent comment:");
    expect(out).not.toContain("  Reject reason:");
  });

  // ---------------------------------------------------------------------
  // #547 — mostRelevantApplication deep-link hint
  // ---------------------------------------------------------------------

  it("renders the Most relevant application hint when present (#547)", () => {
    const out = formatApplicationDetail({
      ...DETAIL,
      mostRelevantApplication: { id: "ar-relevant" },
    });
    expect(out).toContain("Most relevant application: ar-relevant");
  });

  it("omits the Most relevant application hint when null (#547)", () => {
    const out = formatApplicationDetail(DETAIL);
    expect(out).not.toContain("Most relevant application:");
  });
});

describe("formatRespondPayload (#411)", () => {
  const BASE: applications.AvailabilityRequestRespondPayload = {
    id: "ar-1",
    answeredAt: "2026-05-20T00:00:00Z",
    statusV2: { value: "AVAILABILITY_REQUEST_CONFIRMED", verbose: "Confirmed" },
    talentComment: null,
    requestedHourlyRate: { decimal: "80.00", verbose: "$80.00/hr" },
    rejectReason: null,
  };

  it("renders status verbose+value and the answered timestamp", () => {
    const out = formatRespondPayload(BASE);
    expect(out).toContain("Status: Confirmed (AVAILABILITY_REQUEST_CONFIRMED)");
    expect(out).toContain("Answered: 2026-05-20T00:00:00Z");
  });

  it("renders requested rate with verbose + decimal when present", () => {
    const out = formatRespondPayload(BASE);
    expect(out).toContain("Rate: $80.00/hr (80.00)");
  });

  it("omits Rate line when requestedHourlyRate is null", () => {
    const out = formatRespondPayload({ ...BASE, requestedHourlyRate: null });
    expect(out).not.toContain("Rate:");
  });

  it("omits Answered line when answeredAt is null", () => {
    const out = formatRespondPayload({ ...BASE, answeredAt: null });
    expect(out).not.toContain("Answered:");
  });

  it("renders talent comment when present and non-empty", () => {
    const out = formatRespondPayload({ ...BASE, talentComment: "Sounds good" });
    expect(out).toContain("Comment: Sounds good");
  });

  it("omits Comment line when talentComment is empty string (defensive)", () => {
    const out = formatRespondPayload({ ...BASE, talentComment: "" });
    expect(out).not.toContain("Comment:");
  });

  it("renders reject reason when present (post-reject payload)", () => {
    const out = formatRespondPayload({ ...BASE, rejectReason: "rate_too_low", requestedHourlyRate: null });
    expect(out).toContain("Reject reason: rate_too_low");
  });
});

describe("formatRejectReasons (#411)", () => {
  const FIXED: applications.AvailabilityRequestRejectReason = {
    key: "rate_too_low",
    value: "Rate too low",
    customPlaceholder: null,
    isMandatory: false,
  };
  const FLEXIBLE_MANDATORY: applications.AvailabilityRequestRejectReason = {
    key: "other",
    value: "Other",
    customPlaceholder: "Please describe",
    isMandatory: true,
  };

  it("renders both Fixed-kind and Flexible-kind sections with the right header", () => {
    const out = formatRejectReasons({ fixed: [FIXED], flexible: [FLEXIBLE_MANDATORY] });
    expect(out).toContain("Fixed-kind reasons");
    expect(out).toContain("Flexible-kind reasons");
  });

  it("marks mandatory rows with the ✱ marker and unmarked rows without it", () => {
    const out = formatRejectReasons({ fixed: [FIXED], flexible: [FLEXIBLE_MANDATORY] });
    // Non-mandatory rate_too_low has no marker — the columns end with spaces only.
    const fixedLine = out.split("\n").find((l) => l.includes("rate_too_low")) ?? "";
    expect(fixedLine).not.toContain("✱");
    const flexLine = out.split("\n").find((l) => l.includes("other")) ?? "";
    expect(flexLine).toContain("✱");
  });

  it("renders '(none)' placeholder when a section has zero rows", () => {
    const out = formatRejectReasons({ fixed: [], flexible: [FLEXIBLE_MANDATORY] });
    expect(out).toContain("Fixed-kind reasons");
    expect(out.split("Fixed-kind reasons")[1] ?? "").toContain("(none)");
  });

  it("renders both sections empty when both arrays are empty (defensive)", () => {
    const out = formatRejectReasons({ fixed: [], flexible: [] });
    // Two '(none)' occurrences expected.
    const noneCount = (out.match(/\(none\)/g) ?? []).length;
    expect(noneCount).toBe(2);
  });
});

describe("formatStatsPretty", () => {
  it("renders the header with total and a per-group table", () => {
    const stats: applications.ApplicationsStats = {
      total: 124,
      groups: [
        { name: "ACTIVE_ENGAGEMENT", count: 2 },
        { name: "ARCHIVED", count: 116 },
        { name: "CLOSED_ENGAGEMENT", count: 1 },
        { name: "ON_CLIENT_REVIEW", count: 0 },
        { name: "ON_RECRUITER_REVIEW", count: 5 },
      ],
    };
    const out = formatStatsPretty(stats);
    expect(out).toContain("5 status groups, 124 total activity items:");
    expect(out).toContain("Active");
    expect(out).toContain("Archived");
    expect(out).toContain("Recruiter");
    // Counts present
    expect(out).toContain("116");
    expect(out).toContain("2");
  });
});

// ---------------------------------------------------------------------
// `formatInterviewDetail` (#439)
// ---------------------------------------------------------------------

describe("formatInterviewDetail (#439)", () => {
  function makeDetail(overrides: Partial<applications.InterviewDetail> = {}): applications.InterviewDetail {
    return {
      id: "int-1",
      status: "SCHEDULED",
      kind: "EXTERNAL",
      interviewType: "Technical",
      interviewTime: "60 minutes",
      information: "Brief paragraph one.\n\nBrief paragraph two.",
      initiator: "Recruiter Recruiterson",
      scheduledAtTimes: ["2026-06-01T10:00:00Z", "2026-06-02T15:30:00Z"],
      schedulingComment: "Pick whichever slot works.",
      method: { typeV2: "ZOOM", conferenceUrl: "https://zoom.us/j/12345", resource: null },
      contacts: [
        {
          id: "ctc-1",
          fullName: "Recruiter Recruiterson",
          email: "recruiter@example.com",
          phoneNumber: null,
          position: "Recruiter",
          main: true,
          timeZone: { value: "America/New_York", location: "New York, NY" },
          topChatConversation: {
            id: "tcc-1",
            slackChannelId: "C0SLACK123",
            uploads: [{ id: "up-1", filename: "brief.pdf", url: "https://files.example.com/brief.pdf" }],
          },
        },
      ],
      clientContactInfo: {
        id: "cli-1",
        contactFields: {
          communitySlackId: "U12CLIENT",
          email: "client@example.com",
          phoneNumber: "+1-555-0199",
          skype: "client.live",
        },
      },
      guideId: "gui-1",
      talentNotes: [{ id: "note-1", section: "GAPS", note: "Ask about scaling." }],
      job: { id: "job-1", title: "Senior Backend Engineer", activityItemId: "act-1" },
      updatedAt: "2026-05-15T08:00:00Z",
      ...overrides,
    };
  }

  it("renders the canonical sectioned layout for a fully-populated interview", () => {
    const out = formatInterviewDetail(makeDetail());
    expect(out).toContain("Interview int-1");
    expect(out).toContain("Status: SCHEDULED");
    expect(out).toContain("Kind:   EXTERNAL");
    expect(out).toContain("Type:   Technical");
    expect(out).toContain("Time:   60 minutes");
    expect(out).toContain("Updated: 2026-05-15T08:00:00Z");

    expect(out).toContain("Scheduling");
    expect(out).toContain("Initiator: Recruiter Recruiterson");
    expect(out).toContain("Proposed slots:");
    expect(out).toContain("    - 2026-06-01T10:00:00Z");
    expect(out).toContain("    - 2026-06-02T15:30:00Z");
    expect(out).toContain("Comment: Pick whichever slot works.");

    expect(out).toContain("Method");
    expect(out).toContain("Type:       ZOOM");
    expect(out).toContain("Conference: https://zoom.us/j/12345");

    expect(out).toContain("Information");
    expect(out).toContain("  Brief paragraph one.");
    expect(out).toContain("  Brief paragraph two.");

    expect(out).toContain("Contacts");
    expect(out).toContain("(main) Recruiter Recruiterson — Recruiter");
    expect(out).toContain("Email:    recruiter@example.com");
    expect(out).toContain("TimeZone: New York, NY (America/New_York)");
    expect(out).toContain("TopChat:  tcc-1");
    expect(out).toContain("Slack channel: C0SLACK123");
    expect(out).toContain("File: brief.pdf (https://files.example.com/brief.pdf)");

    expect(out).toContain("Client");
    expect(out).toContain("Email:    client@example.com");
    expect(out).toContain("Phone:    +1-555-0199");
    expect(out).toContain("Slack:    U12CLIENT");
    expect(out).toContain("Skype:    client.live");

    expect(out).toContain("Notes");
    expect(out).toContain("[GAPS] Ask about scaling.");

    expect(out).toContain("Job");
    expect(out).toContain("Title:       Senior Backend Engineer");
    expect(out).toContain("Job id:      job-1");
    expect(out).toContain("Activity id: act-1");

    expect(out).toContain("Prep guide");
    expect(out).toContain("  ID: gui-1");

    expect(out).toContain("Full job context: ttctl applications show act-1");
  });

  it("omits per-field lines when their value is null (header + nullable subsections)", () => {
    const out = formatInterviewDetail(
      makeDetail({
        status: null,
        kind: null,
        interviewType: null,
        interviewTime: null,
        information: null,
        method: null,
        contacts: [],
        clientContactInfo: null,
        talentNotes: [],
        guideId: null,
      }),
    );
    expect(out).toContain("Interview int-1");
    expect(out).not.toContain("Status:");
    expect(out).not.toContain("Kind:");
    expect(out).not.toContain("Type:");
    expect(out).not.toContain("Method");
    expect(out).not.toContain("Information");
    expect(out).not.toContain("Contacts");
    expect(out).not.toContain("Client");
    expect(out).not.toContain("Notes");
    expect(out).not.toContain("Prep guide");
    // Scheduling block still shows (initiator + slots populated)
    expect(out).toContain("Scheduling");
  });

  it("omits the entire Scheduling block when all three fields are empty", () => {
    const out = formatInterviewDetail(
      makeDetail({
        initiator: null,
        scheduledAtTimes: [],
        schedulingComment: null,
      }),
    );
    expect(out).not.toContain("Scheduling");
  });

  it("falls back to contact id when fullName and main are absent", () => {
    const out = formatInterviewDetail(
      makeDetail({
        contacts: [
          {
            id: "ctc-anon",
            fullName: null,
            email: null,
            phoneNumber: null,
            position: null,
            main: null,
            timeZone: null,
            topChatConversation: null,
          },
        ],
      }),
    );
    expect(out).toContain("Contacts");
    expect(out).toContain("  ctc-anon");
  });

  it("renders the Client section with only the populated channels", () => {
    const out = formatInterviewDetail(
      makeDetail({
        clientContactInfo: {
          id: "cli-2",
          contactFields: { communitySlackId: null, email: "only@example.com", phoneNumber: null, skype: null },
        },
      }),
    );
    expect(out).toContain("Client");
    expect(out).toContain("Email:    only@example.com");
    expect(out).not.toContain("Slack:");
    expect(out).not.toContain("Skype:");
  });

  it("omits the Client section when the client has no contact fields", () => {
    const out = formatInterviewDetail(makeDetail({ clientContactInfo: { id: "cli-3", contactFields: null } }));
    expect(out).not.toContain("Client");
  });

  it("omits the per-contact TopChat block when the contact has no thread", () => {
    const out = formatInterviewDetail(
      makeDetail({
        contacts: [
          {
            id: "ctc-x",
            fullName: "No Thread",
            email: null,
            phoneNumber: null,
            position: null,
            main: false,
            timeZone: null,
            topChatConversation: null,
          },
        ],
      }),
    );
    expect(out).toContain("Contacts");
    expect(out).not.toContain("TopChat:");
  });

  it("renders a TopChat thread with no Slack channel, falling back to upload id when filename is null", () => {
    const out = formatInterviewDetail(
      makeDetail({
        contacts: [
          {
            id: "ctc-y",
            fullName: "Has Thread",
            email: null,
            phoneNumber: null,
            position: null,
            main: false,
            timeZone: null,
            topChatConversation: {
              id: "tcc-9",
              slackChannelId: null,
              uploads: [{ id: "up-9", filename: null, url: null }],
            },
          },
        ],
      }),
    );
    expect(out).toContain("TopChat:  tcc-9");
    expect(out).not.toContain("Slack channel:");
    expect(out).toContain("File: up-9");
  });

  it("handles a PHONE method (resource populated, conferenceUrl absent)", () => {
    const out = formatInterviewDetail(
      makeDetail({
        method: { typeV2: "PHONE", conferenceUrl: null, resource: "+1-555-0100" },
      }),
    );
    expect(out).toContain("Type:       PHONE");
    expect(out).toContain("Resource:   +1-555-0100");
    expect(out).not.toContain("Conference:");
  });

  it("omits the Job Title and activityItemId lines when only job.id is present", () => {
    const out = formatInterviewDetail(
      makeDetail({
        job: { id: "job-2", title: null, activityItemId: null },
      }),
    );
    expect(out).toContain("Job");
    expect(out).toContain("Job id:      job-2");
    expect(out).not.toContain("Title:");
    expect(out).not.toContain("Activity id:");
    // No activity id ⇒ no reach footer (the command can't be constructed).
    expect(out).not.toContain("Full job context:");
  });
});

// ---------------------------------------------------------------------
// `formatInterviewNotes` (#440)
// ---------------------------------------------------------------------

describe("formatInterviewNotes (#440)", () => {
  function makeNotes(
    overrides: Partial<applications.InterviewNotesProjection> = {},
  ): applications.InterviewNotesProjection {
    return {
      jobId: "job-1",
      interviewId: "int-1",
      interviewKind: "EXTERNAL",
      notes: [
        { id: "note-1", section: "GAPS", note: "Ask about scaling." },
        { id: "note-2", section: "STRENGTHS", note: "Highlight prior client wins." },
      ],
      ...overrides,
    };
  }

  it("renders the full canonical layout (header + notes block)", () => {
    const out = formatInterviewNotes(makeNotes());
    expect(out).toContain("Interview notes for job job-1");
    expect(out).toContain("Interview id:   int-1");
    expect(out).toContain("Interview kind: EXTERNAL");
    expect(out).toContain("Notes");
    expect(out).toContain("[GAPS] Ask about scaling.");
    expect(out).toContain("[STRENGTHS] Highlight prior client wins.");
    expect(out).toContain("Full interview detail: ttctl applications interview show int-1");
  });

  it("renders the no-interview-attached message when interviewId is null (no reach footer)", () => {
    const out = formatInterviewNotes(makeNotes({ interviewId: null, interviewKind: null, notes: [] }));
    expect(out).toBe("Interview notes for job job-1\n  (no interview attached to this job)");
  });

  it("renders the no-prep-notes message when notes is empty but the interview exists", () => {
    const out = formatInterviewNotes(makeNotes({ notes: [] }));
    expect(out).toContain("Interview id:   int-1");
    expect(out).toContain("Interview kind: EXTERNAL");
    expect(out).toContain("(no prep notes)");
    expect(out).not.toContain("[GAPS]");
    expect(out).toContain("Full interview detail: ttctl applications interview show int-1");
  });

  it("omits the kind line when interviewKind is null but interview exists", () => {
    const out = formatInterviewNotes(makeNotes({ interviewKind: null }));
    expect(out).toContain("Interview id:   int-1");
    expect(out).not.toContain("Interview kind:");
    expect(out).toContain("[GAPS] Ask about scaling.");
  });

  it("renders unsectioned notes without the [section] prefix", () => {
    const out = formatInterviewNotes(
      makeNotes({
        notes: [
          { id: "note-1", section: null, note: "Loose thought, no section." },
          { id: "note-2", section: "", note: "Empty-string section also unsectioned." },
        ],
      }),
    );
    // Line is just the body — no [null] or [] prefix.
    expect(out).toContain("  Loose thought, no section.");
    expect(out).toContain("  Empty-string section also unsectioned.");
    expect(out).not.toContain("[null]");
    expect(out).not.toContain("[]");
  });

  it("renders empty-string note bodies as blank-line placeholders rather than crashing", () => {
    const out = formatInterviewNotes(
      makeNotes({
        notes: [{ id: "note-1", section: "PRO_TIPS", note: null }],
      }),
    );
    // Section prefix preserved; note body resolves to "".
    expect(out).toContain("[PRO_TIPS] ");
  });
});

// ---------------------------------------------------------------------
// `formatAvailabilityRequestDetail` (#442)
// ---------------------------------------------------------------------

describe("formatAvailabilityRequestDetail (#442)", () => {
  function makeDetail(
    overrides: Partial<applications.AvailabilityRequestDetail> = {},
  ): applications.AvailabilityRequestDetail {
    return {
      id: "ar-1",
      status: "CONFIRMED",
      kind: "FIXED",
      fixedRate: { decimal: "95.00", verbose: "$95.00/hr" },
      comment: "Recruiter note one.\n\nRecruiter note two.",
      // #539 — talent-response triple + recruiter; default to null
      // (most fixtures don't need them; per-test overrides exercise the
      // populated branches).
      talentComment: null,
      requestedHourlyRate: null,
      rejectReason: null,
      recruiter: null,
      createdAt: "2026-05-01T09:00:00Z",
      updatedAt: "2026-05-15T08:00:00Z",
      answeredAt: "2026-05-16T10:00:00Z",
      job: {
        id: "job-1",
        title: "Senior Engineer",
        url: "https://www.toptal.com/jobs/job-1",
        client: { id: "cli-1", fullName: "Acme Inc." },
      },
      // #585 — matcher questions; default empty (per-test overrides
      // exercise the populated branches).
      matcherQuestions: [],
      ...overrides,
    };
  }

  it("renders the canonical sectioned layout for a fully-populated availability request", () => {
    const out = formatAvailabilityRequestDetail(makeDetail());
    expect(out).toContain("Availability request ar-1");
    expect(out).toContain("Status:     CONFIRMED");
    expect(out).toContain("Kind:       FIXED");
    expect(out).toContain("Fixed rate: $95.00/hr");
    expect(out).toContain("Created:    2026-05-01T09:00:00Z");
    expect(out).toContain("Updated:    2026-05-15T08:00:00Z");
    expect(out).toContain("Answered:   2026-05-16T10:00:00Z");

    expect(out).toContain("Comment");
    expect(out).toContain("  Recruiter note one.");
    expect(out).toContain("  Recruiter note two.");

    expect(out).toContain("Job");
    expect(out).toContain("  Title:  Senior Engineer\n  Job id: job-1");
    expect(out).toContain("URL:    https://www.toptal.com/jobs/job-1");
    expect(out).toContain("Client: Acme Inc.");
  });

  it("omits per-field header lines when their value is null", () => {
    const out = formatAvailabilityRequestDetail(
      makeDetail({
        status: null,
        kind: null,
        fixedRate: null,
        createdAt: null,
        updatedAt: null,
        answeredAt: null,
      }),
    );
    expect(out).toContain("Availability request ar-1");
    expect(out).not.toContain("Status:");
    expect(out).not.toContain("Kind:");
    expect(out).not.toContain("Fixed rate:");
    expect(out).not.toContain("Created:");
    expect(out).not.toContain("Updated:");
    expect(out).not.toContain("Answered:");
    // Comment + Job sections still render — their data is populated.
    expect(out).toContain("Comment");
    expect(out).toContain("Job");
  });

  it("omits the Comment section when comment is null", () => {
    const out = formatAvailabilityRequestDetail(makeDetail({ comment: null }));
    expect(out).not.toContain("Comment");
  });

  it("omits the Comment section when comment is an empty string", () => {
    const out = formatAvailabilityRequestDetail(makeDetail({ comment: "" }));
    expect(out).not.toContain("Comment");
  });

  it("omits the Job section entirely when job is null", () => {
    const out = formatAvailabilityRequestDetail(makeDetail({ job: null }));
    expect(out).not.toContain("Job");
  });

  it("falls back to $<decimal>/h for fixedRate when verbose is empty", () => {
    const out = formatAvailabilityRequestDetail(makeDetail({ fixedRate: { decimal: "109.00", verbose: "" } }));
    expect(out).toContain("Fixed rate: $109.00/h");
  });

  it("omits Title/URL/Client job lines when those fields are null but keeps Job id", () => {
    const out = formatAvailabilityRequestDetail(
      makeDetail({ job: { id: "job-bare", title: null, url: null, client: null } }),
    );
    expect(out).toContain("Job");
    expect(out).toContain("Job id: job-bare");
    expect(out).not.toContain("Title:");
    expect(out).not.toContain("URL:");
    expect(out).not.toContain("Client:");
  });

  it("omits the Client line when client is present but fullName is null", () => {
    const out = formatAvailabilityRequestDetail(
      makeDetail({
        job: { id: "job-1", title: "Senior Engineer", url: null, client: { id: "cli-1", fullName: null } },
      }),
    );
    expect(out).toContain("Title:  Senior Engineer");
    expect(out).not.toContain("Client:");
  });

  // ---------------------------------------------------------------------
  // #539 — talent-response fields + recruiter section
  // ---------------------------------------------------------------------

  it("renders the talent-rate line when requestedHourlyRate is present (#539)", () => {
    const out = formatAvailabilityRequestDetail(
      makeDetail({ requestedHourlyRate: { decimal: "85.00", verbose: "$85.00/hr" } }),
    );
    expect(out).toContain("Talent rate: $85.00/hr");
  });

  it("omits the talent-rate line when requestedHourlyRate is null (#539)", () => {
    const out = formatAvailabilityRequestDetail(makeDetail());
    expect(out).not.toContain("Talent rate:");
  });

  it("renders the Recruiter section with fullName when populated (#539)", () => {
    const out = formatAvailabilityRequestDetail(
      makeDetail({
        recruiter: { firstName: "Alex", lastName: "Recruiterson", fullName: "Alex Recruiterson" },
      }),
    );
    expect(out).toContain("Recruiter");
    expect(out).toContain("Name:  Alex Recruiterson");
  });

  it("falls back to firstName + lastName when recruiter.fullName is null (#539)", () => {
    const out = formatAvailabilityRequestDetail(
      makeDetail({
        recruiter: { firstName: "Sam", lastName: "Recruiter", fullName: null },
      }),
    );
    expect(out).toContain("Name:  Sam Recruiter");
  });

  it("omits the Recruiter section when all three recruiter name fields are null (#539)", () => {
    // `comment` defaults to text containing the word "Recruiter", so
    // assert on the section's content line (`Name:`) rather than the
    // bare word — the Recruiter section renders a `Name:` line.
    const out = formatAvailabilityRequestDetail(
      makeDetail({ recruiter: { firstName: null, lastName: null, fullName: null } }),
    );
    expect(out).not.toContain("Name:");
  });

  it("renders the Talent comment section when talentComment is populated (#539)", () => {
    const out = formatAvailabilityRequestDetail(
      makeDetail({ talentComment: "Available next Monday.\n\nLooking forward." }),
    );
    expect(out).toContain("Talent comment");
    expect(out).toContain("  Available next Monday.");
    expect(out).toContain("  Looking forward.");
  });

  it("omits the Talent comment section when talentComment is null (#539)", () => {
    const out = formatAvailabilityRequestDetail(makeDetail());
    expect(out).not.toContain("Talent comment");
  });

  it("omits the Talent comment section when talentComment is an empty string (#539)", () => {
    const out = formatAvailabilityRequestDetail(makeDetail({ talentComment: "" }));
    expect(out).not.toContain("Talent comment");
  });

  it("renders the Reject reason line when rejectReason is populated (#539)", () => {
    const out = formatAvailabilityRequestDetail(makeDetail({ rejectReason: "rate_too_low" }));
    expect(out).toContain("Reject reason: rate_too_low");
  });

  it("omits the Reject reason line when rejectReason is null (#539)", () => {
    const out = formatAvailabilityRequestDetail(makeDetail());
    expect(out).not.toContain("Reject reason:");
  });

  it("renders all #539 sections together on a rejected-AR fixture (#539)", () => {
    const out = formatAvailabilityRequestDetail(
      makeDetail({
        status: "REJECTED",
        talentComment: "Out of scope for me right now.",
        requestedHourlyRate: null,
        rejectReason: "scope_mismatch",
        recruiter: { firstName: "Pat", lastName: null, fullName: "Pat" },
      }),
    );
    expect(out).toContain("Status:     REJECTED");
    expect(out).toContain("Recruiter");
    expect(out).toContain("Name:  Pat");
    expect(out).toContain("Talent comment");
    expect(out).toContain("Reject reason: scope_mismatch");
    expect(out).not.toContain("Talent rate:");
  });

  // ---------------------------------------------------------------------
  // #585 — matcher questions section
  // ---------------------------------------------------------------------

  it("renders a dropdown matcher question with options + suggested answer (#585)", () => {
    const out = formatAvailabilityRequestDetail(
      makeDetail({
        matcherQuestions: [
          {
            identifier: "MQ-1",
            prompt: "How many hours of timezone overlap can you offer?",
            type: "matcher",
            isMandatory: true,
            options: ["Less than 2 hours", "2 to 6 hours", "More than 6 hours"],
            suggestedAnswer: "More than 6 hours",
            inputType: "dropdown",
          },
        ],
      }),
    );
    expect(out).toContain("Matcher questions");
    expect(out).toContain("[MQ-1] How many hours of timezone overlap can you offer?  (required, dropdown)");
    expect(out).toContain("Options:   Less than 2 hours | 2 to 6 hours | More than 6 hours");
    expect(out).toContain("Suggested: More than 6 hours");
  });

  it("renders a free-text matcher question without Options/Suggested lines (#585)", () => {
    const out = formatAvailabilityRequestDetail(
      makeDetail({
        matcherQuestions: [
          {
            identifier: "MQ-2",
            prompt: "Anything else to share?",
            type: "matcher",
            isMandatory: false,
            options: [],
            suggestedAnswer: null,
            inputType: "free-text",
          },
        ],
      }),
    );
    expect(out).toContain("[MQ-2] Anything else to share?  (optional, free-text)");
    expect(out).not.toContain("Options:");
    expect(out).not.toContain("Suggested:");
  });

  it("omits the Matcher questions section when there are none (#585)", () => {
    const out = formatAvailabilityRequestDetail(makeDetail());
    expect(out).not.toContain("Matcher questions");
  });
});

// ---------------------------------------------------------------------
// `formatInterviewGuide` (#470)
// ---------------------------------------------------------------------

describe("formatInterviewGuide (#470)", () => {
  function makeGuide(
    overrides: Partial<applications.InterviewGuideProjection> = {},
  ): applications.InterviewGuideProjection {
    return {
      interviewId: "int-1",
      guideId: "gui-1",
      sections: [
        {
          identifier: "STRENGTHS",
          title: "Your strengths",
          subtitle: "Match between profile and role",
          tips: [
            {
              identifier: "STRENGTHS_OVERLAP",
              title: "Profile overlap",
              content: "5 years TypeScript matches the requirement.",
              hardcodedContent: "Highlight overlapping experience.",
            },
          ],
        },
        {
          identifier: "PRO_TIPS",
          title: "Toptal interview tips",
          subtitle: null,
          tips: [
            {
              identifier: "BE_PRESENTABLE",
              title: "Dress professionally",
              content: null,
              hardcodedContent: "Wear business-casual attire.",
            },
          ],
        },
      ],
      ...overrides,
    };
  }

  it("renders the canonical sectioned layout for a fully-populated guide", () => {
    const out = formatInterviewGuide(makeGuide());
    expect(out).toContain("Interview guide for interview int-1");
    expect(out).toContain("Guide id: gui-1");
    expect(out).toContain("[STRENGTHS] Your strengths");
    expect(out).toContain("Match between profile and role");
    expect(out).toContain("• STRENGTHS_OVERLAP — Profile overlap");
    expect(out).toContain("Content:");
    expect(out).toContain("5 years TypeScript matches the requirement.");
    expect(out).toContain("Template:");
    expect(out).toContain("Highlight overlapping experience.");
    expect(out).toContain("[PRO_TIPS] Toptal interview tips");
    expect(out).toContain("• BE_PRESENTABLE — Dress professionally");
    expect(out).toContain("Wear business-casual attire.");
    expect(out).toContain("Full interview detail: ttctl applications interview show int-1");
  });

  it("renders the no-guide-attached message when guideId is null (reach footer still appears)", () => {
    const out = formatInterviewGuide(makeGuide({ guideId: null, sections: [] }));
    expect(out).toBe(
      "Interview guide for interview int-1\n  (no guide attached to this interview)\n\nFull interview detail: ttctl applications interview show int-1",
    );
  });

  it("renders the no-sections message when guide exists but sections is empty", () => {
    const out = formatInterviewGuide(makeGuide({ sections: [] }));
    expect(out).toContain("Guide id: gui-1");
    expect(out).toContain("(guide has no sections)");
    expect(out).toContain("Full interview detail: ttctl applications interview show int-1");
  });

  it("renders the no-tips message for a section with no tips", () => {
    const out = formatInterviewGuide(
      makeGuide({
        sections: [{ identifier: "GAPS", title: "Gaps", subtitle: null, tips: [] }],
      }),
    );
    expect(out).toContain("[GAPS] Gaps");
    expect(out).toContain("(no tips)");
  });

  it("omits the Template block when hardcodedContent is null", () => {
    const out = formatInterviewGuide(
      makeGuide({
        sections: [
          {
            identifier: "GAPS",
            title: "Gaps",
            subtitle: null,
            tips: [
              {
                identifier: "GAP_ANALYSIS",
                title: "Likely follow-ups",
                content: "Be ready to address gaps.",
                hardcodedContent: null,
              },
            ],
          },
        ],
      }),
    );
    expect(out).toContain("Content:");
    expect(out).toContain("Be ready to address gaps.");
    expect(out).not.toContain("Template:");
  });

  it("omits the Content block when content is null but renders Template", () => {
    const out = formatInterviewGuide(
      makeGuide({
        sections: [
          {
            identifier: "PRO_TIPS",
            title: "Tips",
            subtitle: null,
            tips: [
              {
                identifier: "CAMERA_ON",
                title: "Camera on",
                content: null,
                hardcodedContent: "Keep your camera on.",
              },
            ],
          },
        ],
      }),
    );
    expect(out).not.toContain("Content:");
    expect(out).toContain("Template:");
    expect(out).toContain("Keep your camera on.");
  });

  it("falls back to identifier-only header when section title is null", () => {
    const out = formatInterviewGuide(
      makeGuide({
        sections: [
          {
            identifier: "PRO_TIPS",
            title: null,
            subtitle: null,
            tips: [],
          },
        ],
      }),
    );
    expect(out).toContain("[PRO_TIPS]");
    expect(out).not.toContain("[PRO_TIPS] ");
  });

  it("falls back to title-only header when identifier is null", () => {
    const out = formatInterviewGuide(
      makeGuide({
        sections: [
          {
            identifier: null,
            title: "Custom section",
            subtitle: null,
            tips: [],
          },
        ],
      }),
    );
    expect(out).toContain("Custom section");
    expect(out).not.toContain("[");
  });

  it("falls back to '(unnamed section)' when both identifier and title are null", () => {
    const out = formatInterviewGuide(
      makeGuide({
        sections: [
          {
            identifier: null,
            title: null,
            subtitle: null,
            tips: [],
          },
        ],
      }),
    );
    expect(out).toContain("(unnamed section)");
  });

  it("falls back to identifier-only tip header when tip title is null", () => {
    const out = formatInterviewGuide(
      makeGuide({
        sections: [
          {
            identifier: "PRO_TIPS",
            title: "Tips",
            subtitle: null,
            tips: [{ identifier: "CAMERA_ON", title: null, content: null, hardcodedContent: "Keep camera on." }],
          },
        ],
      }),
    );
    expect(out).toContain("• CAMERA_ON");
    expect(out).not.toContain("• CAMERA_ON —");
  });

  it("preserves multi-line content (each newline becomes its own indented line)", () => {
    const out = formatInterviewGuide(
      makeGuide({
        sections: [
          {
            identifier: "PRO_TIPS",
            title: "Tips",
            subtitle: null,
            tips: [
              {
                identifier: "CAMERA_ON",
                title: "Camera",
                content: "Line one.\nLine two.\nLine three.",
                hardcodedContent: null,
              },
            ],
          },
        ],
      }),
    );
    expect(out).toContain("Line one.");
    expect(out).toContain("Line two.");
    expect(out).toContain("Line three.");
  });
});
