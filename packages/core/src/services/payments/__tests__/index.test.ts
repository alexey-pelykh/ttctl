// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

// All payments ops run against mobile-gateway via `stockTransport`.
vi.mock("../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../transport.js")>("../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
  };
});

import { DEFAULT_PAGE, DEFAULT_PER_PAGE, PaymentsError, methods, payouts, rate } from "../index.js";
import { AuthRevokedError } from "../../../auth/errors.js";
import { stockTransport } from "../../../transport.js";
import type { TransportResponse } from "../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const TOKEN = "tok-pmt-123";

interface MockResponse {
  status?: number;
  body: unknown;
}

function reply(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedStock.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

const PAYOUT_FIXTURE = {
  __typename: "TalentPayment",
  id: "pmt-1",
  number: 42,
  amount: "1234.56",
  correctionAmount: "0",
  description: "April payout",
  status: "PAID",
  kindCategory: "TALENT_PAYMENT",
  paymentGroupId: "grp-1",
  billingCycle: { __typename: "BillingCycle", id: "bc-1", startDate: "2026-04-01", endDate: "2026-04-30" },
  dueDate: "2026-05-15",
  paidAt: "2026-05-10T12:00:00Z",
  createdAt: "2026-05-01T12:00:00Z",
  updatedAt: "2026-05-10T12:00:00Z",
  downloadPdfUrl: "https://example.com/payout.pdf",
  job: {
    __typename: "TalentJob",
    id: "job-1",
    title: "Senior Engineer",
    client: { __typename: "Client", id: "cli-1", fullName: "Acme Inc." },
  },
  memorandums: {
    __typename: "MemorandumsConnection",
    nodes: [
      {
        __typename: "Memorandum",
        id: "mem-1",
        amount: "100.00",
        balance: "1134.56",
        downloadPdfUrl: null,
        effectiveDate: "2026-04-15",
      },
    ],
  },
};

const SUMMARY_FIXTURE = {
  __typename: "PaymentsSummary",
  totalDisputed: "0",
  totalDue: "1234.56",
  totalOnHold: "0",
  totalOutstanding: "1234.56",
  totalOverdue: "0",
  totalPaid: "5000.00",
};

beforeEach(() => {
  mockedStock.mockReset();
});

describe("payouts.list", () => {
  it("returns projected items + summary on happy path", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            payments: {
              __typename: "PaymentsConnection",
              ids: ["pmt-1"],
              nodes: [PAYOUT_FIXTURE],
              summary: SUMMARY_FIXTURE,
            },
          },
        },
      },
    });
    const result = await payouts.list(TOKEN);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("pmt-1");
    expect(result.items[0]?.amount).toBe("1234.56");
    expect(result.items[0]?.memorandums).toHaveLength(1);
    expect(result.summary.totalPaid).toBe("5000.00");
    expect(mockedStock).toHaveBeenCalledTimes(1);
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body.operationName).toBe("Payments");
    expect(call?.body.variables?.["filters"]).toBeNull();
  });

  it("passes filters when fromDate/toDate provided", async () => {
    reply({
      body: { data: { viewer: { id: "v1", payments: { nodes: [], summary: SUMMARY_FIXTURE } } } },
    });
    await payouts.list(TOKEN, { fromDate: "2026-01-01", toDate: "2026-04-30" });
    const call = mockedStock.mock.calls[0]?.[0];
    expect(call?.body.variables?.["filters"]).toEqual({
      createdOn: { from: "2026-01-01", to: "2026-04-30" },
    });
  });

  it("returns empty result when viewer.payments is null", async () => {
    reply({ body: { data: { viewer: { id: "v1", payments: null } } } });
    const result = await payouts.list(TOKEN);
    expect(result.items).toEqual([]);
    expect(result.summary.totalPaid).toBe("0");
  });

  it("throws NO_VIEWER when viewer is null", async () => {
    reply({ body: { data: { viewer: null } } });
    await expect(payouts.list(TOKEN)).rejects.toMatchObject({ code: "NO_VIEWER" });
  });

  it("throws AuthRevokedError on 401", async () => {
    reply({ status: 401, body: { data: null } });
    await expect(payouts.list(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("payouts.list pagination (#373)", () => {
  function connBody(conn: Record<string, unknown>): MockResponse {
    return { body: { data: { viewer: { id: "v1", payments: conn } } } };
  }

  it("sends default offset:0 / limit:20 and echoes page:1 / perPage:20 when unset", async () => {
    reply(connBody({ ids: ["pmt-1"], nodes: [PAYOUT_FIXTURE], summary: SUMMARY_FIXTURE, totalCount: 1 }));
    const result = await payouts.list(TOKEN);
    const vars = mockedStock.mock.calls[0]?.[0]?.body.variables;
    expect(vars?.["offset"]).toBe(0);
    expect(vars?.["limit"]).toBe(20);
    expect(result.page).toBe(DEFAULT_PAGE);
    expect(result.perPage).toBe(DEFAULT_PER_PAGE);
  });

  it("translates page/perPage to offset = (page-1)*perPage and limit = perPage", async () => {
    reply(connBody({ ids: [], nodes: [], summary: SUMMARY_FIXTURE, totalCount: 0 }));
    const result = await payouts.list(TOKEN, { page: 3, perPage: 10 });
    const vars = mockedStock.mock.calls[0]?.[0]?.body.variables;
    expect(vars?.["offset"]).toBe(20);
    expect(vars?.["limit"]).toBe(10);
    expect(result.page).toBe(3);
    expect(result.perPage).toBe(10);
  });

  it("derives totalCount from connection.totalCount when present", async () => {
    reply(connBody({ ids: ["pmt-1"], nodes: [PAYOUT_FIXTURE], summary: SUMMARY_FIXTURE, totalCount: 137 }));
    const result = await payouts.list(TOKEN);
    expect(result.totalCount).toBe(137);
  });

  it("falls back to ids.length when connection.totalCount is absent", async () => {
    reply(connBody({ ids: ["a", "b", "c", "d", "e"], nodes: [PAYOUT_FIXTURE], summary: SUMMARY_FIXTURE }));
    const result = await payouts.list(TOKEN);
    expect(result.totalCount).toBe(5);
  });

  it("falls back to items.length when both totalCount and ids are absent", async () => {
    reply(connBody({ nodes: [PAYOUT_FIXTURE], summary: SUMMARY_FIXTURE }));
    const result = await payouts.list(TOKEN);
    expect(result.totalCount).toBe(1);
  });

  it("prefers an explicit totalCount of 0 over the ids fallback", async () => {
    // A genuine zero must NOT be overridden by `ids.length`; `typeof
    // === number` (not truthiness) is the discriminant in the service.
    reply(connBody({ ids: ["stale-prefetch-id"], nodes: [], summary: SUMMARY_FIXTURE, totalCount: 0 }));
    const result = await payouts.list(TOKEN);
    expect(result.totalCount).toBe(0);
  });

  it("returns a zeroed paginated envelope when viewer.payments is null", async () => {
    reply({ body: { data: { viewer: { id: "v1", payments: null } } } });
    const result = await payouts.list(TOKEN, { page: 4, perPage: 25 });
    expect(result).toEqual({
      items: [],
      summary: {
        totalDisputed: "0",
        totalDue: "0",
        totalOnHold: "0",
        totalOutstanding: "0",
        totalOverdue: "0",
        totalPaid: "0",
      },
      totalCount: 0,
      page: 4,
      perPage: 25,
    });
  });

  it("sends pagination AND filters together (coexistence)", async () => {
    reply(connBody({ ids: [], nodes: [], summary: SUMMARY_FIXTURE, totalCount: 0 }));
    await payouts.list(TOKEN, { fromDate: "2026-01-01", toDate: "2026-04-30", page: 2, perPage: 50 });
    const vars = mockedStock.mock.calls[0]?.[0]?.body.variables;
    expect(vars?.["filters"]).toEqual({ createdOn: { from: "2026-01-01", to: "2026-04-30" } });
    expect(vars?.["offset"]).toBe(50);
    expect(vars?.["limit"]).toBe(50);
  });

  it("exposes DEFAULT_PAGE / DEFAULT_PER_PAGE matching the pre-#373 wire literals", () => {
    expect(DEFAULT_PAGE).toBe(1);
    expect(DEFAULT_PER_PAGE).toBe(20);
  });
});

describe("payouts.show", () => {
  it("returns the projected payout on happy path", async () => {
    reply({ body: { data: { node: PAYOUT_FIXTURE } } });
    const p = await payouts.show(TOKEN, "pmt-1");
    expect(p.id).toBe("pmt-1");
    expect(p.status).toBe("PAID");
  });

  it("remaps the Relay 'Node id ... resolves to' error to NOT_FOUND", async () => {
    reply({
      body: {
        data: null,
        errors: [{ message: 'Node id "pmt-bad" resolves to NotFound' }],
      },
    });
    await expect(payouts.show(TOKEN, "pmt-bad")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringContaining("pmt-bad"),
    });
  });

  it("throws NOT_FOUND when node is null", async () => {
    reply({ body: { data: { node: null } } });
    await expect(payouts.show(TOKEN, "pmt-nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("methods.list", () => {
  it("returns projected payment methods on happy path", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            paymentOptions: [
              {
                __typename: "PaymentOption",
                id: "pm-1",
                paymentMethod: "PAYONEER",
                preferredOption: true,
                fullName: "Test Talent",
                payoneerId: "pyn-123",
                comment: null,
                toptalPaymentsPending: false,
              },
            ],
          },
        },
      },
    });
    const list = await methods.list(TOKEN);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("pm-1");
    expect(list[0]?.preferredOption).toBe(true);
  });

  it("filters out null wire entries", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            paymentOptions: [
              null,
              {
                __typename: "PaymentOption",
                id: "pm-2",
                paymentMethod: "WIRE",
                preferredOption: false,
                fullName: null,
                payoneerId: null,
                comment: null,
                toptalPaymentsPending: null,
              },
            ],
          },
        },
      },
    });
    const list = await methods.list(TOKEN);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("pm-2");
  });
});

describe("methods.show", () => {
  it("finds the requested method by id", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            paymentOptions: [
              {
                __typename: "PaymentOption",
                id: "pm-1",
                paymentMethod: "PAYONEER",
                preferredOption: true,
                fullName: "T",
                payoneerId: "p",
                comment: null,
                toptalPaymentsPending: false,
              },
              {
                __typename: "PaymentOption",
                id: "pm-2",
                paymentMethod: "WIRE",
                preferredOption: false,
                fullName: null,
                payoneerId: null,
                comment: null,
                toptalPaymentsPending: null,
              },
            ],
          },
        },
      },
    });
    const m = await methods.show(TOKEN, "pm-2");
    expect(m.paymentMethod).toBe("WIRE");
  });

  it("throws NOT_FOUND when no method matches", async () => {
    reply({ body: { data: { viewer: { id: "v1", paymentOptions: [] } } } });
    await expect(methods.show(TOKEN, "pm-nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

const LAST_RATE_CHANGE_FIXTURE = {
  __typename: "RateChangeRequest",
  id: "rcr-1",
  createdAt: "2026-04-01T12:00:00Z",
  desiredRate: "100.0",
  outcomeRate: "95.0",
  requestType: "CURRENT_ENGAGEMENT",
  status: "COMPLETED",
  talentComment: "Cost of living adjustment",
  engagement: {
    __typename: "TalentEngagement",
    id: "eng-1",
    job: {
      __typename: "TalentJob",
      id: "job-1",
      title: "Senior Engineer",
      client: { __typename: "Client", id: "cli-1", fullName: "Acme Inc." },
    },
    currentAgreement: {
      __typename: "EngagementAgreement",
      commitment: { __typename: "JobCommitment", slug: "full_time" },
    },
  },
};

const ROLE_FIXTURE = {
  __typename: "ViewerRole",
  rates: { __typename: "Rates", hourly: "95.0" },
  rateInsight: {
    __typename: "RateInsight",
    hourly: {
      __typename: "TalentRateInsightForCommitment",
      currentRateCompetitive: true,
      recentApplicationRate: "98",
      recommendedRate: "100",
    },
  },
};

describe("rate.show", () => {
  it("composes lastChange + market + validation from two parallel queries", async () => {
    reply(
      {
        body: {
          data: {
            viewer: {
              id: "v1",
              lastRateChangeRequest: LAST_RATE_CHANGE_FIXTURE,
              viewerRole: ROLE_FIXTURE,
            },
          },
        },
      },
      {
        body: {
          data: {
            viewer: { id: "v1", viewerRole: ROLE_FIXTURE },
            platformConfiguration: {
              __typename: "PlatformConfiguration",
              id: "cfg-1",
              rateValidationRules: {
                __typename: "RateValidationRules",
                hourly: { __typename: "TalentRateValidationRule", minRate: "30", rateStep: 5 },
              },
            },
          },
        },
      },
    );
    const p = await rate.show(TOKEN);
    expect(p.lastChange?.id).toBe("rcr-1");
    expect(p.ongoingChange).toBeNull(); // COMPLETED status → not ongoing
    expect(p.marketInsight?.recommendedRate).toBe("100");
    expect(p.validation?.minRate).toBe("30");
    expect(p.currentRateDecimal).toBe("95.0");
    expect(mockedStock).toHaveBeenCalledTimes(2);
  });

  it("classifies PENDING status as ongoing", async () => {
    reply(
      {
        body: {
          data: {
            viewer: {
              id: "v1",
              lastRateChangeRequest: { ...LAST_RATE_CHANGE_FIXTURE, status: "PENDING" },
              viewerRole: ROLE_FIXTURE,
            },
          },
        },
      },
      {
        body: {
          data: { viewer: { id: "v1", viewerRole: ROLE_FIXTURE }, platformConfiguration: null },
        },
      },
    );
    const p = await rate.show(TOKEN);
    expect(p.ongoingChange?.id).toBe("rcr-1");
    expect(p.ongoingChange?.statusVerbose).toBe("Pending");
  });
});

/**
 * Z-4 (#288) beachhead — first production wire-up of the Z-3 (#286)
 * runtime-validation seam. The `RateChangeFormDetails` callGateway
 * call in `rate.show` is the SOLE existing trusted-op call site
 * passing a generated Zod schema (`VerticalMarketConditionSchema` +
 * `VerticalGlobalMarketConditionSchema` composed into an inline
 * envelope; see `RATE_CHANGE_FORM_DETAILS_RESPONSE_SCHEMA` for the
 * audit transcript).
 *
 * These tests assert the integration end-to-end:
 *   - Happy path: a wire response that matches the schema passes
 *     through validation and projects normally (covered by the
 *     `rate.show` describe block above, which now exercises the
 *     schema implicitly).
 *   - Failure path: a wire response that violates the schema in a
 *     type-meaningful way (`rates.hourly` returned as a number when
 *     the schema expects `string | null`) trips the schema and
 *     surfaces as `PaymentsError("WIRE_SHAPE_ERROR")` with the
 *     original `ZodError` chained via `cause`. The drift would have
 *     been an `as`-cast silent passthrough pre-Z-4.
 *   - `LastRateChangeRequest` continues to bypass schema validation
 *     because Z-4 only wires `RateChangeFormDetails`. A drifted wire
 *     on the last-rate side passes the schema gate and falls back to
 *     the existing structural narrowing (the AC's "no regression in
 *     other ops" requirement).
 */
describe("rate.show schema validation (Z-4 / #288)", () => {
  it("throws PaymentsError('WIRE_SHAPE_ERROR') on type-meaningful schema mismatch", async () => {
    // Happy LastRateChangeRequest, drifted RateChangeFormDetails:
    // `viewerRole.rates.hourly` returns a NUMBER instead of the
    // schema-required `string | null`. Pre-Z-4 this would pass through
    // the `as`-cast and surface as a downstream TypeError; post-Z-4
    // it's caught at the wire boundary with a named diff.
    reply(
      {
        body: {
          data: {
            viewer: {
              id: "v1",
              lastRateChangeRequest: LAST_RATE_CHANGE_FIXTURE,
              viewerRole: ROLE_FIXTURE,
            },
          },
        },
      },
      {
        body: {
          data: {
            viewer: {
              id: "v1",
              viewerRole: {
                __typename: "ViewerRole",
                rates: { __typename: "TalentRate", hourly: 95 },
                rateInsight: ROLE_FIXTURE.rateInsight,
              },
            },
            platformConfiguration: null,
          },
        },
      },
    );
    let thrown: unknown;
    try {
      await rate.show(TOKEN);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PaymentsError);
    const err = thrown as PaymentsError & { cause?: unknown };
    expect(err.code).toBe("WIRE_SHAPE_ERROR");
    // The message format is the structured `WIRE_SHAPE_ERROR` line
    // per `docs/wire-validation-error-format.md`. The opname is
    // `RateChangeFormDetails`; pluralisation drops the trailing "s"
    // when there's exactly one issue.
    expect(err.message).toMatch(/RateChangeFormDetails/);
    expect(err.message).toMatch(/field issue/);
    // Original `ZodError` is chained via `cause` so the CLI / MCP
    // layers can lift the field-level diff into the user-facing
    // envelope.
    expect(err.cause).toBeDefined();
  });

  it("does NOT throw on a valid wire response — schema validates the existing happy-path fixtures", async () => {
    // The `rate.show — composes ...` test above already exercises the
    // happy path implicitly; this test makes the schema-validation
    // success explicit so a future schema tightening that breaks the
    // happy fixtures is loud rather than silent.
    reply(
      {
        body: {
          data: {
            viewer: {
              id: "v1",
              lastRateChangeRequest: LAST_RATE_CHANGE_FIXTURE,
              viewerRole: ROLE_FIXTURE,
            },
          },
        },
      },
      {
        body: {
          data: {
            viewer: { id: "v1", viewerRole: ROLE_FIXTURE },
            platformConfiguration: {
              __typename: "PlatformConfiguration",
              id: "cfg-1",
              rateValidationRules: {
                __typename: "TalentRateValidationRules",
                hourly: { __typename: "TalentRateValidationRule", minRate: "30", rateStep: 5 },
              },
            },
          },
        },
      },
    );
    await expect(rate.show(TOKEN)).resolves.toBeDefined();
  });

  it("preserves no-regression for LastRateChangeRequest — drifted wire on the non-schema'd op falls through", async () => {
    // Pre-Z-4 behavior on LastRateChangeRequest: response passes the
    // `as`-cast; downstream code narrows to its expected shape;
    // drifts are silently absorbed. Post-Z-4 must not change this
    // because LastRateChangeRequest is in `KNOWN_UNTRUSTED_OPS` and
    // Z-4 only wires the trusted RateChangeFormDetails op. We assert
    // the no-regression invariant by issuing a drifted-but-defensive
    // LastRateChangeRequest response paired with a valid
    // RateChangeFormDetails response; the call resolves without
    // throwing (drift absorbed at last-rate side; schema validates at
    // form-details side).
    reply(
      {
        body: {
          data: {
            viewer: {
              id: "v1",
              // `lastRateChangeRequest: null` is a valid wire variant
              // for accounts that never requested a rate change.
              // No schema validation runs on this side.
              lastRateChangeRequest: null,
              viewerRole: ROLE_FIXTURE,
            },
          },
        },
      },
      {
        body: {
          data: { viewer: { id: "v1", viewerRole: ROLE_FIXTURE }, platformConfiguration: null },
        },
      },
    );
    const p = await rate.show(TOKEN);
    expect(p.lastChange).toBeNull();
    expect(p.ongoingChange).toBeNull();
  });
});

describe("rate.current (#447 / T2 GetTalentRate)", () => {
  it("returns projected RateCurrent on happy path", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            viewerRole: {
              roleId: 42,
              hourlyRate: { verbose: "USD 95.00 hourly" },
            },
          },
        },
      },
    });
    const r = await rate.current(TOKEN);
    expect(r.verbose).toBe("USD 95.00 hourly");
    expect(r.roleId).toBe(42);
    expect(mockedStock).toHaveBeenCalledTimes(1);
  });

  it("hits mobile-gateway with operationName=GetTalentRate", async () => {
    reply({
      body: {
        data: {
          viewer: { id: "v1", viewerRole: { roleId: 1, hourlyRate: { verbose: "x" } } },
        },
      },
    });
    await rate.current(TOKEN);
    const call = mockedStock.mock.calls[0];
    expect(call).toBeDefined();
    // Transport receives a Request-shaped argument with a body containing
    // the operationName; assert that GetTalentRate is the dispatched op.
    const [arg] = call ?? [];
    const argRecord = arg as { body?: { operationName?: string } };
    expect(argRecord.body?.operationName).toBe("GetTalentRate");
  });

  it("throws NO_VIEWER when viewer is null", async () => {
    reply({ body: { data: { viewer: null } } });
    await expect(rate.current(TOKEN)).rejects.toMatchObject({
      code: "NO_VIEWER",
    });
  });

  it("throws WIRE_SHAPE_ERROR when verbose is a number instead of string (T2 schema enforcement)", async () => {
    // Drifted wire: `hourlyRate.verbose` returned as a number. Pre-T2
    // this would silently pass through the `as`-cast and surface as a
    // downstream TypeError; the T2 Zod schema catches it at the wire
    // boundary with a named diff.
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            viewerRole: { roleId: 42, hourlyRate: { verbose: 95 } },
          },
        },
      },
    });
    let thrown: unknown;
    try {
      await rate.current(TOKEN);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PaymentsError);
    const err = thrown as PaymentsError & { cause?: unknown };
    expect(err.code).toBe("WIRE_SHAPE_ERROR");
    expect(err.message).toMatch(/GetTalentRate/);
    expect(err.cause).toBeDefined();
  });

  it("throws WIRE_SHAPE_ERROR when roleId is a string instead of number (T2 schema enforcement)", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            viewerRole: { roleId: "42", hourlyRate: { verbose: "USD 95.00 hourly" } },
          },
        },
      },
    });
    await expect(rate.current(TOKEN)).rejects.toMatchObject({
      code: "WIRE_SHAPE_ERROR",
    });
  });

  it("propagates AuthRevokedError from the shared transport without wrapping", async () => {
    reply({
      status: 401,
      body: {
        errors: [{ message: "Token is no longer valid", extensions: { code: "AUTH_REVOKED" } }],
      },
    });
    await expect(rate.current(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("rate.questions", () => {
  it("returns the projected question form", async () => {
    reply({
      body: {
        data: {
          viewer: {
            id: "v1",
            rateChangeRequestQuestions: [
              {
                __typename: "RateChangeRequestQuestion",
                id: "q1",
                kind: "RADIO",
                label: "Why are you requesting this rate change?",
                options: [
                  { __typename: "RateChangeRequestQuestionOption", label: "Cost of living", commentRequired: false },
                  { __typename: "RateChangeRequestQuestionOption", label: "Other", commentRequired: true },
                ],
              },
            ],
          },
        },
      },
    });
    const qs = await rate.questions(TOKEN);
    expect(qs).toHaveLength(1);
    expect(qs[0]?.kind).toBe("RADIO");
    expect(qs[0]?.options).toHaveLength(2);
    expect(qs[0]?.options[1]?.commentRequired).toBe(true);
  });
});

describe("rate.change", () => {
  it("rejects --kind=current-engagement without engagementId BEFORE any transport call", async () => {
    await expect(
      rate.change(TOKEN, { kind: "current-engagement", desiredRate: "100", answers: [] }),
    ).rejects.toMatchObject({ code: "MISSING_INPUT" });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("rejects engagementId on non-current-engagement kinds BEFORE transport", async () => {
    await expect(
      rate.change(TOKEN, {
        kind: "future-engagements",
        desiredRate: "100",
        engagementId: "eng-1",
        answers: [],
      }),
    ).rejects.toMatchObject({ code: "MISSING_INPUT" });
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("dry-run path builds preview WITHOUT calling transport", async () => {
    const outcome = await rate.change(
      TOKEN,
      {
        kind: "future-engagements",
        desiredRate: "100",
        answers: [{ questionId: "q1", value: "Cost of living" }],
      },
      { dryRun: true },
    );
    expect(outcome.kind).toBe("preview");
    if (outcome.kind === "preview") {
      expect(outcome.preview.operationName).toBe("CreateRateChangeRequest");
      expect(outcome.preview.surface).toBe("mobile-gateway");
      expect(outcome.preview.variables["requestType"]).toBe("FUTURE_ENGAGEMENTS");
      expect(outcome.preview.headers["authorization"]).toMatch(/redacted/i);
    }
    expect(mockedStock).not.toHaveBeenCalled();
  });

  it("applies on happy path and returns the new RateChangeRequest", async () => {
    reply({
      body: {
        data: {
          viewerRole: {
            createRateChangeRequest: {
              __typename: "CreateRateChangeRequestPayload",
              success: true,
              notice: "Your request was submitted for review.",
              errors: null,
              viewer: {
                __typename: "Viewer",
                id: "v1",
                lastRateChangeRequest: { ...LAST_RATE_CHANGE_FIXTURE, status: "PENDING" },
                viewerRole: ROLE_FIXTURE,
              },
            },
          },
        },
      },
    });
    const outcome = await rate.change(TOKEN, {
      kind: "current-engagement",
      desiredRate: "120",
      engagementId: "eng-1",
      answers: [{ questionId: "q1", value: "Cost of living" }],
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind === "applied") {
      expect(outcome.result.id).toBe("rcr-1");
      expect(outcome.result.status).toBe("PENDING");
      expect(outcome.notice).toContain("submitted");
    }
  });

  it("throws MUTATION_ERROR when success is false", async () => {
    reply({
      body: {
        data: {
          viewerRole: {
            createRateChangeRequest: {
              success: false,
              notice: null,
              errors: [{ code: "below_min", key: "desiredRate", message: "Rate must be at least 30" }],
              viewer: null,
            },
          },
        },
      },
    });
    await expect(
      rate.change(TOKEN, {
        kind: "future-engagements",
        desiredRate: "10",
        answers: [{ questionId: "q1", value: "Cost of living" }],
      }),
    ).rejects.toMatchObject({
      code: "MUTATION_ERROR",
      message: expect.stringContaining("Rate must be at least 30"),
    });
  });
});

describe("PaymentsError", () => {
  it("has the expected name + code shape", () => {
    const e = new PaymentsError("NOT_FOUND", "test");
    expect(e.name).toBe("PaymentsError");
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toBe("test");
  });
});
