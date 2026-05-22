// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { applications } from "@ttctl/core";

import { formatRespondPayload } from "../confirm.js";
import { formatInterviewDetail } from "../interview.js";
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
  fixedRate: null,
};

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
      availabilityRequest: { id: "ar-1" },
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
      availabilityRequest: { id: "ar-1" },
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
      availabilityRequest: { id: "ar-1" },
      fixedRate: { decimal: "109.00", verbose: "" },
    });
    expect(out).toContain("$109.00/h");
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
        },
      ],
      guideId: "gui-1",
      talentNotes: [{ id: "note-1", section: "GAPS", note: "Ask about scaling." }],
      job: { id: "job-1", activityItemId: "act-1" },
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

    expect(out).toContain("Notes");
    expect(out).toContain("[GAPS] Ask about scaling.");

    expect(out).toContain("Job");
    expect(out).toContain("Job id:      job-1");
    expect(out).toContain("Activity id: act-1");

    expect(out).toContain("Prep guide");
    expect(out).toContain("  ID: gui-1");
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
          },
        ],
      }),
    );
    expect(out).toContain("Contacts");
    expect(out).toContain("  ctc-anon");
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

  it("omits the Job activityItemId line when only job.id is present", () => {
    const out = formatInterviewDetail(
      makeDetail({
        job: { id: "job-2", activityItemId: null },
      }),
    );
    expect(out).toContain("Job");
    expect(out).toContain("Job id:      job-2");
    expect(out).not.toContain("Activity id:");
  });
});
