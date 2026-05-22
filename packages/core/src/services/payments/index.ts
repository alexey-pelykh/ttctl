// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `payments` service module — read payouts, list configured payment
 * methods, inspect the talent's current rate, and submit rate-change
 * requests on engagements.
 *
 * In Toptal vocabulary, "Payments" is the talent's earnings surface:
 *   - **Payouts** — historical `TalentPayment` events (billing-cycle
 *     paid amounts, memorandums, status — DUE / PAID / DISPUTED / etc.)
 *   - **Methods** — `PaymentOption` records (Payoneer / direct deposit /
 *     etc.) the talent has configured.
 *   - **Rate** — the talent's hourly rate as defaulted on
 *     `viewerRole.hourlyRate` (the "rack rate" used for future
 *     engagements). Per-engagement rates live on
 *     `engagement.currentAgreement.talentRate` (already surfaced by the
 *     `engagements` service). A talent can request a rate change via
 *     `CreateRateChangeRequest`; the most recent / ongoing request is
 *     readable via `viewer.lastRateChangeRequest` /
 *     `viewer.ongoingRateChangeRequest`.
 *
 * | Leaf                              | Operation(s)                          |
 * |-----------------------------------|---------------------------------------|
 * | `payouts.list`                    | `Payments(filters: PaymentFilter)`    |
 * | `payouts.show`                    | `Payment(id: ID!)` (Relay `node`)     |
 * | `methods.list`                    | `PaymentOptions` (hand-authored)      |
 * | `methods.show`                    | `methods.list` + client-side filter   |
 * | `rate.show`                       | `LastRateChangeRequest` + `RateChangeFormDetails` |
 * | `rate.questions`                  | `RateChangeRequestQuestions`          |
 * | `rate.change`                     | `CreateRateChangeRequest(input)`      |
 *
 * **Routing**: All ops talk to the **mobile-gateway** surface
 * (`https://www.toptal.com/gateway/graphql/talent/graphql`) via
 * `stockTransport`. Plain HTTPS — no Cloudflare, no TLS impersonation
 * needed. Same surface as `engagements`, `jobs`, `applications`.
 *
 * **Operations are inlined as strings** (NOT codegen-driven). Every
 * payment-domain operation is in `GATEWAY_{MOBILE,PORTAL}_KNOWN_UNTRUSTED_OPS`
 * per `codegen.config.ts` — the SDL synthesizer has `Unknown` placeholders
 * for `PaymentFilter.{kind,status,…}` and the `engagement: Unknown` field
 * on `RateChangeRequest`, so generated types do not exist. Captured
 * operation documents live in:
 *   - `../research/graphql/gateway/operations/mobile/Payments.graphql`
 *   - `../research/graphql/gateway/operations/mobile/Payment.graphql`
 *   - `../research/graphql/gateway/operations/mobile/LastRateChangeRequest.graphql`
 *   - `../research/graphql/gateway/operations/mobile/RateChangeRequestQuestions.graphql`
 *   - `../research/graphql/gateway/operations/mobile/RateChangeFormDetails.graphql`
 *   - `../research/graphql/gateway/operations/mobile/CreateRateChangeRequest.graphql`
 *   - `PaymentOptions` is hand-authored (the captured portal op
 *     `GetTalentPaymentOptions` doesn't have a mobile sibling; this
 *     service uses a minimal projection compatible with the mobile-gateway
 *     surface; verified-via-E2E).
 *
 * **CLAUDE.md schema/contract validation rule**: Every operation in
 * this module is **[INFERRED — UNVERIFIED]** until its gated
 * `*.e2e.test.ts` file passes against a live session. The mutation
 * (`rate.change`) is the highest-stakes trigger; ALL operations need
 * E2E coverage before merge per `scripts/check-e2e-coverage.ts`.
 *
 * **Rate-change semantics**:
 *   - `requestType: CURRENT_ENGAGEMENT` — rate change for ONE existing
 *     engagement; requires `engagementId`.
 *   - `requestType: FUTURE_ENGAGEMENTS` — change the talent's default
 *     "rack rate" applied to NEW engagement applications. Does NOT
 *     affect any active engagements.
 *   - `requestType: CONSULTATION` — rate change for the consultation
 *     surface (separate from engagement work). The talent's role must
 *     support consultations; rejection by the server surfaces as
 *     `MUTATION_ERROR` here.
 *
 * **Out of scope for v1** (deferred to follow-ups):
 *   - Payment-method mutations (create / update / remove /
 *     mark-as-preferred) — explicitly excluded per issue #149's
 *     out-of-scope list.
 *   - Withdrawal request initiation — Toptal admin-side flow.
 *   - Tax document generation / download — post-v1.
 *   - Cross-engagement payment aggregation beyond what the API
 *     surfaces.
 */

import { z } from "zod";

import { VerticalGlobalMarketConditionSchema, VerticalMarketConditionSchema } from "../../__generated__/zod-schemas.js";
import { buildDryRunPreview } from "../../transport.js";
import type { DryRunPreview } from "../../transport.js";
import { callGatewayShared } from "../_shared/transport.js";

// ---------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------

/**
 * Payments-domain error codes. Mirrors the `EngagementsError` shape.
 *
 * - `NO_VIEWER`: HTTP 200 + `data.viewer === null`.
 * - `NOT_FOUND`: caller's id doesn't resolve to a viewable payment /
 *   payment method. Folds two wire shapes: top-level `Record not found`
 *   AND `data.viewer.*` null sentinel.
 * - `MISSING_INPUT`: caller-side validation failure (e.g.,
 *   `kind: current-engagement` without `engagementId`). Surfaced
 *   BEFORE any transport call.
 * - `GRAPHQL_ERROR`: top-level `errors[]` from the gateway, not
 *   auth-revoked, not `Record not found`.
 * - `MUTATION_ERROR`: the `MutationResult.errors[]` payload (operation
 *   succeeded at GraphQL level, but the mutation itself reports
 *   per-field errors — validation, ineligibility, etc.).
 * - `NETWORK_ERROR`, `UNKNOWN`: standard transport failure modes.
 *
 * Auth-revoked failures throw `AuthRevokedError` (cross-cutting
 * `TtctlError` subclass per #77), not a code on this enum.
 */
export type PaymentsErrorCode =
  | "NO_VIEWER"
  | "NOT_FOUND"
  | "MISSING_INPUT"
  | "GRAPHQL_ERROR"
  | "MUTATION_ERROR"
  | "NETWORK_ERROR"
  | "WIRE_SHAPE_ERROR"
  | "UNKNOWN";

export class PaymentsError extends Error {
  override readonly name = "PaymentsError";
  constructor(
    public readonly code: PaymentsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------
// Public types — payouts namespace
// ---------------------------------------------------------------------

/**
 * Status payload for a payout. Both `status` (specific enum value, e.g.
 * `"PAID"`, `"DUE"`) and the same payout's `kindCategory` (`"TALENT_PAYMENT"`,
 * `"BONUS_PAYMENT"`, `"REFERRAL_PAYMENT"`) carry a single string from a
 * known enum; we expose them as `string` to remain forward-compatible
 * with new server-side values without forcing a TTCtl release.
 */
export interface PayoutBillingCycle {
  id: string;
  startDate: string;
  endDate: string;
}

export interface PayoutMemorandum {
  id: string;
  amount: string;
  balance: string;
  downloadPdfUrl: string | null;
  effectiveDate: string | null;
}

export interface PayoutJobRef {
  id: string;
  title: string | null;
  client: { id: string; fullName: string | null } | null;
}

/**
 * Single payout (row in the payouts list, OR the detail returned by
 * `payouts.show`). Matches the `paymentFields` fragment captured at
 * `gateway/operations/mobile/Payments.graphql`.
 *
 * `amount` and `correctionAmount` are decimal strings (e.g. `"1234.56"`)
 * — Toptal's `Money` type returns string-encoded decimals to avoid
 * float-rounding errors. Surface them as strings to preserve precision;
 * any decimal arithmetic at the CLI / MCP layer should parse via a
 * decimal library, not `parseFloat`.
 *
 * `status` carries the wire enum value (`"PAID"`, `"DUE"`,
 * `"OUTSTANDING"`, `"OVERDUE"`, `"ON_HOLD"`, `"DISPUTED"`); the
 * `TalentPaymentStatus` enum is forward-compatible but kept as `string`
 * here to avoid coupling.
 */
export interface Payout {
  id: string;
  number: number;
  amount: string;
  correctionAmount: string;
  description: string | null;
  status: string;
  kindCategory: string;
  paymentGroupId: string | null;
  billingCycle: PayoutBillingCycle | null;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  downloadPdfUrl: string | null;
  job: PayoutJobRef | null;
  memorandums: PayoutMemorandum[];
}

/**
 * Aggregate totals across the queried payment range — populated for
 * both the list and the per-engagement summary endpoints.
 */
export interface PayoutsSummary {
  totalDisputed: string;
  totalDue: string;
  totalOnHold: string;
  totalOutstanding: string;
  totalOverdue: string;
  totalPaid: string;
}

/**
 * Result of `payouts.list`. Carries the projected payout rows + the
 * server-provided summary aggregates for the same filter window, plus
 * the offset-style pagination metadata (#373) so the CLI / MCP layer
 * can render `pageInfo` (mirrors {@link jobs.JobListPage}).
 *
 * `totalCount` is the server-reported size of the full filtered result
 * set (NOT `items.length`, which is one page). `page` / `perPage` are
 * the effective values used in the query after defaults were applied.
 */
export interface PayoutsListResult {
  items: Payout[];
  summary: PayoutsSummary;
  /** Total payouts matching the filter window, across all pages. */
  totalCount: number;
  /** 1-indexed page number actually requested. */
  page: number;
  /** Items per page actually requested. */
  perPage: number;
}

/**
 * Options for {@link payouts.list}. Date-range filtering uses
 * server-side `createdOn` filter (the same window the Toptal portal's
 * "From / To" date pickers feed into). Both endpoints are inclusive
 * ISO-8601 dates (YYYY-MM-DD).
 *
 * `kind` and `status` filters are deliberately omitted from v1 — the
 * `PaymentFilter` input has `Unknown`-typed fields for them so the wire
 * shape is unverified. If users ask, add them in a follow-up after a
 * live-capture confirms the value enum.
 *
 * Pagination (#373): `page` (1-indexed) and `perPage` are translated to
 * the wire's `offsetPagination: { offset: (page-1)*perPage, limit:
 * perPage }`. Defaults `page: 1, perPage: 20` reproduce the pre-#373
 * hard-coded `offset: 0, limit: 20` behavior exactly.
 */
export interface ListPayoutsOptions {
  /** Inclusive lower bound (YYYY-MM-DD). */
  fromDate?: string;
  /** Inclusive upper bound (YYYY-MM-DD). */
  toDate?: string;
  /**
   * 1-indexed page number (#373). Translated to the wire's
   * `offsetPagination.offset` as `(page - 1) * perPage`. Default `1`.
   */
  page?: number;
  /**
   * Items per page (#373). Forwarded to the wire's
   * `offsetPagination.limit`. Default `20`, matching the pre-#373
   * hard-coded value.
   */
  perPage?: number;
}

/**
 * Default values for {@link ListPayoutsOptions} pagination fields when
 * the caller does not specify them. Mirrors the pre-#373 hard-coded
 * wire literals (`offset: 0, limit: 20` → `page: 1, perPage: 20`
 * user-facing). Exposed so tests + the MCP dry-run preview assert
 * against the same constants the production code uses (parallels
 * {@link jobs.DEFAULT_PAGE} / {@link jobs.DEFAULT_PER_PAGE}).
 */
export const DEFAULT_PAGE = 1 as const;
export const DEFAULT_PER_PAGE = 20 as const;

// ---------------------------------------------------------------------
// Public types — methods namespace
// ---------------------------------------------------------------------

/**
 * Configured payment method on the talent's profile. Matches the
 * minimal projection sent against the mobile-gateway endpoint; the full
 * portal-side `GetTalentPaymentOptions` projection includes
 * `operations.markAsPreferred.{callable, errors, messages}` which is
 * out of scope for v1 (no mutation surface here).
 *
 * `paymentMethod` is the wire enum value (`"PAYONEER"`, `"WIRE"`,
 * `"TOPTAL_PAYMENTS"`, etc.) — kept as `string` to remain
 * forward-compatible.
 */
export interface PaymentMethod {
  id: string;
  paymentMethod: string;
  preferredOption: boolean;
  fullName: string | null;
  payoneerId: string | null;
  comment: string | null;
  toptalPaymentsPending: boolean | null;
}

// ---------------------------------------------------------------------
// Public types — rate namespace
// ---------------------------------------------------------------------

/**
 * Three flavors of rate-change request, mapped to the wire enum
 * `RateChangeRequestTypeEnum`.
 */
export const RATE_CHANGE_KINDS = ["current-engagement", "future-engagements", "consultation"] as const;
export type RateChangeKind = (typeof RATE_CHANGE_KINDS)[number];

const RATE_CHANGE_KIND_TO_WIRE: Record<RateChangeKind, "CURRENT_ENGAGEMENT" | "FUTURE_ENGAGEMENTS" | "CONSULTATION"> = {
  "current-engagement": "CURRENT_ENGAGEMENT",
  "future-engagements": "FUTURE_ENGAGEMENTS",
  consultation: "CONSULTATION",
};

const RATE_CHANGE_STATUS_VERBOSE: Record<string, string> = {
  PENDING: "Pending",
  CLAIMED: "Claimed",
  COMPLETED: "Completed",
};

/**
 * Compact summary of one rate-change request — used by both
 * `rate.show()` (which embeds at most one of `last` / `ongoing`) and
 * downstream renderers.
 *
 * `requestType` is the wire enum (`"CURRENT_ENGAGEMENT" | …`); the
 * CLI / MCP surface translates to/from the kebab-case
 * {@link RateChangeKind} at the action handler boundary.
 *
 * `engagementId` / `engagementTitle` are populated only when
 * `requestType` references an engagement (i.e., not for
 * `FUTURE_ENGAGEMENTS` or `CONSULTATION`).
 *
 * **Platform-level write-only asymmetry**: the matching {@link RateChangeOptions}
 * input carries an `answers: RateChangeAnswerInput[]` that is NOT echoed
 * here. The wire-level `RateChangeRequest` type has no `answers` field
 * (`research/graphql/gateway/schema.graphql:1373-1382`), every captured
 * Toptal op (mobile `LastRateChangeRequest`, portal `OngoingRateChangeRequest`,
 * portal+mobile `CreateRateChangeRequest` mutation response) omits answers
 * from the selection set, and the answers persist server-side as
 * form-submission audit metadata rather than display data. See `RateChangeOptions.answers`
 * `// write-only:` marker and issue #347.
 */
export interface RateChangeRequest {
  id: string;
  createdAt: string;
  desiredRate: string;
  outcomeRate: string;
  requestType: string;
  status: string;
  statusVerbose: string;
  talentComment: string;
  engagementId: string | null;
  engagementTitle: string | null;
  clientName: string | null;
}

/**
 * Per-commitment market insight returned by `RateChangeFormDetails`.
 *
 * `currentRateCompetitive` is `Boolean!` per the synthesized SDL — and
 * the live wire returns a JSON boolean (verified 2026-05-16, issue
 * #319). Pre-#319, the hand-rolled type widened this to `string | null`
 * defensively; the T2 Zod runtime validator caught the drift.
 */
export interface RateMarketInsight {
  currentRateCompetitive: boolean | null;
  recentApplicationRate: string | null;
  recommendedRate: string | null;
}

/**
 * Server-side validation rules for the hourly-rate input. Used by
 * `rate.show()` to surface the floor / step that the
 * `CreateRateChangeRequest` mutation would otherwise reject silently.
 *
 * `rateStep` is `Int!` per the synthesized SDL — and the live wire
 * returns a JSON number (verified 2026-05-16, issue #319). Pre-#319,
 * the hand-rolled type widened this to `string | null` defensively;
 * the T2 Zod runtime validator caught the drift.
 */
export interface RateValidation {
  minRate: string | null;
  rateStep: number | null;
}

/**
 * Lightweight projection for `rate.current()` — the talent's current
 * hourly rate plus the active talent role id, read in a single fast
 * `GetTalentRate` query (#447). Sibling to the heavy {@link RateProjection}
 * returned by {@link rate.show}: where `show()` composes two parallel
 * queries to surface market insight + validation + change history,
 * `current()` answers "what's my rate right now" in one round trip.
 *
 * - `verbose` — the talent's hourly rate formatted as a display string
 *   (e.g. `"USD 95.00 hourly"`). Server-formatted; the literal grammar
 *   varies by locale / currency and is wire-side authority. Consumers
 *   parse at their own risk.
 * - `roleId` — the active `ViewerRole.roleId` (numeric). Useful for
 *   downstream invocations that key off the role; same id the portal's
 *   `viewerRole` selection set surfaces.
 */
export interface RateCurrent {
  verbose: string;
  roleId: number;
}

/**
 * Unified projection for `rate.show()`. Composes the current rate, the
 * latest known rate-change request (last completed OR ongoing), the
 * market insight at the talent's vertical, and the rate-validation
 * rules.
 *
 * The `ongoingRateChangeRequest` field on the wire is `Unknown`-typed
 * in the synthesized SDL; this service projects the same shape used
 * for `lastRateChangeRequest` (one of the trusted assumptions in v1 —
 * to be verified by the live E2E for `rate show`).
 */
export interface RateProjection {
  /** Current default rate (talent's "rack rate"), as a verbose string. */
  currentRateVerbose: string | null;
  /** Numeric value of the current hourly rate (string, decimal). */
  currentRateDecimal: string | null;
  /** Most recently completed rate-change request, or `null` if never requested. */
  lastChange: RateChangeRequest | null;
  /**
   * In-flight rate-change request (PENDING / CLAIMED), or `null` if no
   * change is ongoing. May overlap with `lastChange` if the last change
   * is still in flight.
   */
  ongoingChange: RateChangeRequest | null;
  /** Per-commitment market insight (hourly tier shown in the portal). */
  marketInsight: RateMarketInsight | null;
  /** Server-side validation rules (minimum rate, rate step). */
  validation: RateValidation | null;
}

/**
 * One question in the rate-change form — answers are required for the
 * `CreateRateChangeRequest` mutation's `answers[]` input.
 */
export interface RateQuestionOption {
  label: string;
  commentRequired: boolean;
}

export interface RateQuestion {
  id: string;
  // Known wire values: "RADIO", "TEXT". String-typed because the API is
  // hand-authored (no SDL enum) and may add kinds without notice.
  kind: string;
  label: string;
  options: RateQuestionOption[];
}

/**
 * Caller-supplied answer for one rate-change question. `value` is the
 * option label for `RADIO`-kind questions, or the free-text response
 * for `TEXT`-kind questions. `comment` is required when the picked
 * option had `commentRequired: true`.
 */
export interface RateChangeAnswerInput {
  questionId: string;
  value: string;
  comment?: string;
}

/**
 * Input for {@link rate.change}. Validated client-side:
 *   - `kind === "current-engagement"` requires `engagementId`.
 *   - Other kinds reject `engagementId` if supplied.
 *   - `desiredRate` must be a decimal string (e.g. `"95.0"`); the
 *     server validates against `validation.minRate` / `validation.rateStep`.
 */
export interface RateChangeOptions {
  kind: RateChangeKind;
  desiredRate: string;
  engagementId?: string;
  talentComment?: string;
  // write-only: platform-level Class B asymmetry. The wire-level `RateChangeRequest` type has no read-side `answers` field — the synthesized SDL at research/graphql/gateway/schema.graphql:1373-1382 lists only id/createdAt/desiredRate/engagement/outcomeRate/requestType/status/talentComment, and every captured Toptal op omits answers from the selection set: the mobile `LastRateChangeRequest` query (research/graphql/gateway/operations/mobile/LastRateChangeRequest.graphql), the portal `OngoingRateChangeRequest` fragment (research/graphql/gateway/fragments/portal/OngoingRateChangeRequest.graphql), and both the mobile and portal `CreateRateChangeRequest` mutation responses. Toptal's own first-party clients never read answers back — they persist server-side as form-submission audit metadata (immutable trail, not display data). See #347.
  answers: RateChangeAnswerInput[];
}

/**
 * Per-mutation option object for the dry-run short-circuit (issue
 * #163). When `dryRun === true`, the mutation builds a
 * {@link DryRunPreview} and returns `{ kind: "preview", preview }`
 * without invoking the gateway transport. Default `false`.
 */
export interface DryRunOptions {
  dryRun?: boolean;
}

/**
 * Apply-path outcome for {@link rate.change}. Carries the server-confirmed
 * `RateChangeRequest` payload (the just-created request, with status
 * usually `"PENDING"`).
 */
export interface RateChangeAppliedOutcome {
  kind: "applied";
  result: RateChangeRequest;
  notice: string | null;
}

/**
 * Dry-run outcome for {@link rate.change}. Carries a
 * {@link DryRunPreview} — emitted verbatim by the CLI's dry-run
 * envelope (`emitDryRunSuccess` in `packages/cli/src/lib/envelopes.ts`).
 */
export interface RateChangeDryRunOutcome {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link rate.change}. Apply path
 * returns `{ kind: "applied", result, notice }`; dry-run returns
 * `{ kind: "preview", preview }`.
 */
export type RateChangeOutcome = RateChangeAppliedOutcome | RateChangeDryRunOutcome;

// ---------------------------------------------------------------------
// GraphQL operation strings — verbatim from captured documents where
// possible. Hand-authored ops carry a doc-string note.
// ---------------------------------------------------------------------

// Adapted from `../research/graphql/gateway/operations/mobile/Payments.graphql`
// (#373): the captured mobile op hard-codes `offsetPagination: { offset: 0
// limit: 20 }` and omits `totalCount`. Parameterized here to `$offset` /
// `$limit` and `paymentsData` extended with `totalCount` so callers can
// paginate and render `pageInfo` (mirrors the #138/#183 `eligibleJobs`
// pattern for `jobs list`).
//
// The variable-driven `offsetPagination` shape and the `totalCount`
// selection are NOT in the captured MOBILE document, BUT both are
// directly attested by the captured PORTAL op
// `../research/graphql/gateway/operations/portal/GetTalentPayments.graphql`,
// which targets the SAME gateway backend's `payments` connection with
// `payments(offsetPagination: {limit: $limit, offset: $offset}, …)`
// (`$limit: Int!`, `$offset: Int!`) and selects `totalCount` directly on
// the connection. Per CLAUDE.md § Schema/contract validation rule this is
// still an INFERRED wire shape for the mobile op until a live `TTCTL_E2E=1`
// round-trip confirms it — see `packages/e2e/src/30-payments-payouts.e2e.test.ts`.
const PAYMENTS_QUERY = `query Payments($filters: PaymentFilter, $offset: Int!, $limit: Int!) { viewer { __typename id payments(offsetPagination: { offset: $offset limit: $limit } , filters: $filters) { __typename ...paymentsData } } }  fragment paymentFields on TalentPayment { __typename amount correctionAmount billingCycle { __typename id endDate startDate } description job { __typename id title client { __typename id fullName } } memorandums { __typename nodes { __typename amount balance downloadPdfUrl effectiveDate id } } kindCategory paymentGroupId createdAt updatedAt downloadPdfUrl dueDate paidAt id number status }  fragment paymentsData on PaymentsConnection { __typename ids nodes { __typename ...paymentFields } summary { __typename totalDisputed totalDue totalOnHold totalOutstanding totalOverdue totalPaid } totalCount }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/Payment.graphql`.
const PAYMENT_QUERY = `query Payment($id: ID!) { node(id: $id) { __typename ... on TalentPayment { ...paymentFields } } }  fragment paymentFields on TalentPayment { __typename amount correctionAmount billingCycle { __typename id endDate startDate } description job { __typename id title client { __typename id fullName } } memorandums { __typename nodes { __typename amount balance downloadPdfUrl effectiveDate id } } kindCategory paymentGroupId createdAt updatedAt downloadPdfUrl dueDate paidAt id number status }`;

// Hand-authored — no mobile-side `PaymentOptions` operation exists in
// the research repo. Minimal projection covering what the v1 CLI / MCP
// surface needs. Live-validated via E2E (`32-payments-methods.e2e.test.ts`).
//
// Per CLAUDE.md § Schema/contract validation rule, this operation is
// hand-authored → mandatory live E2E coverage. The `paymentOptions`
// field on `Viewer` exists in the synthesized SDL via portal capture;
// the empirical question is whether the mobile-gateway endpoint serves
// it (the assumption is yes since portal + mobile share the same
// backend per `08-portal-api.md`).
const PAYMENT_OPTIONS_QUERY = `query PaymentOptions { viewer { __typename id paymentOptions { __typename id paymentMethod preferredOption fullName payoneerId comment toptalPaymentsPending } } }`;

// Verbatim from `../research/graphql/gateway/operations/portal/GetTalentRate.graphql`
// (#447). Trusted catalog: `GetTalentRateQuery` lives in
// `__generated__/gateway.ts` because the operation is NOT in
// `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`. Wired via `callGateway` against
// the mobile-gateway surface (portal and mobile share the same gateway
// backend; the operation document classifies as portal-side per its
// research-repo location). The T2 wire-validation schema below
// (`GET_TALENT_RATE_RESPONSE_SCHEMA`) mirrors the trivial 5-field
// selection set and follows the Z-4 (#288) beachhead pattern for
// inline-composed Zod schemas at trusted-op call sites.
const GET_TALENT_RATE_QUERY = `query GetTalentRate { viewer { id viewerRole { roleId hourlyRate { verbose } } } }`;

// Verbatim from `../research/graphql/gateway/operations/portal/GetTalentPaymentSummary.graphql`
// (#448). Untrusted catalog: `GetTalentPaymentSummary` is listed in
// `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` (`codegen.config.ts`), so no
// `GetTalentPaymentSummaryQuery` type is generated — the op takes the T1
// (wire-snapshot) disposition rather than #447's T2 (codegen-Zod) one.
// Dispatched via `callGateway` against the mobile-gateway surface with
// EMPTY variables `{}`: all three filter variables (`$status` /
// `$createdOn` / `$clientIds`) are optional, so an unset call yields the
// all-time aggregate — the `ttctl payments summary` scope. Date / client
// filtering is a deliberate v1 non-goal; the variable declarations are
// retained verbatim so a future filtered leaf needs no query rewrite.
const GET_TALENT_PAYMENT_SUMMARY_QUERY = `query GetTalentPaymentSummary($status: PaymentStatusFilter, $createdOn: DateFilter, $clientIds: [ID!]) { viewer { id payments(filters: {status: $status, createdOn: $createdOn, clientIds: $clientIds}) { summary { totalDisputed totalDue totalOnHold totalOutstanding totalOverdue totalPaid } } } }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/LastRateChangeRequest.graphql`.
const LAST_RATE_CHANGE_REQUEST_QUERY = `query LastRateChangeRequest { viewer { __typename id ...lastRateChangeRequestData } }  fragment rateInsightForCommitmentData on TalentRateInsightForCommitment { __typename currentRateCompetitive recentApplicationRate recommendedRate }  fragment profileRatesData on ViewerRole { __typename rates { __typename hourly } rateInsight { __typename hourly { __typename ...rateInsightForCommitmentData } } }  fragment lastRateChangeRequestData on Viewer { __typename id lastRateChangeRequest { __typename id createdAt desiredRate engagement { __typename id job { __typename id title client { __typename id fullName } } currentAgreement { __typename commitment { __typename slug } } } outcomeRate requestType status talentComment } viewerRole { __typename ...profileRatesData } }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/RateChangeFormDetails.graphql`.
const RATE_CHANGE_FORM_DETAILS_QUERY = `query RateChangeFormDetails { viewer { __typename id ...marketConditionData viewerRole { __typename ...profileRatesData } } platformConfiguration { __typename ...rateValidationRulesData } }  fragment marketConditionData on Viewer { __typename viewerRole { __typename vertical { __typename name marketCondition { __typename condition } globalMarketCondition { __typename condition conditionColor conditionVerbose reportUrl } } } }  fragment rateInsightForCommitmentData on TalentRateInsightForCommitment { __typename currentRateCompetitive recentApplicationRate recommendedRate }  fragment profileRatesData on ViewerRole { __typename rates { __typename hourly } rateInsight { __typename hourly { __typename ...rateInsightForCommitmentData } } }  fragment talentRateValidationRuleData on TalentRateValidationRule { __typename minRate rateStep }  fragment rateValidationRulesData on PlatformConfiguration { __typename id rateValidationRules { __typename hourly { __typename ...talentRateValidationRuleData } } }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/RateChangeRequestQuestions.graphql`.
const RATE_CHANGE_QUESTIONS_QUERY = `query RateChangeRequestQuestions { viewer { id rateChangeRequestQuestions { id ...RateChangeRequestQuestion } } }  fragment RateChangeRequestQuestion on RateChangeRequestQuestion { id kind label options { commentRequired label } }`;

// Verbatim from `../research/graphql/gateway/operations/mobile/CreateRateChangeRequest.graphql`.
const CREATE_RATE_CHANGE_REQUEST_MUTATION = `mutation CreateRateChangeRequest($desiredRate: BigDecimal, $engagementId: ID, $requestType: RateChangeRequestTypeEnum!, $talentComment: String, $answers: [RateChangeRequestAnswerInput!]!) { viewerRole { __typename createRateChangeRequest(input: { answers: $answers desiredRate: $desiredRate engagementId: $engagementId requestType: $requestType talentComment: $talentComment } ) { __typename ...mutationResultFields notice viewer { __typename id ...lastRateChangeRequestData } } } }  fragment mutationResultFields on MutationResult { __typename errors { __typename key message code } success }  fragment rateInsightForCommitmentData on TalentRateInsightForCommitment { __typename currentRateCompetitive recentApplicationRate recommendedRate }  fragment profileRatesData on ViewerRole { __typename rates { __typename hourly } rateInsight { __typename hourly { __typename ...rateInsightForCommitmentData } } }  fragment lastRateChangeRequestData on Viewer { __typename id lastRateChangeRequest { __typename id createdAt desiredRate engagement { __typename id job { __typename id title client { __typename id fullName } } currentAgreement { __typename commitment { __typename slug } } } outcomeRate requestType status talentComment } viewerRole { __typename ...profileRatesData } }`;

// ---------------------------------------------------------------------
// Wire-shape interfaces (private)
// ---------------------------------------------------------------------

interface MutationResultErrors {
  key?: string | null;
  message?: string | null;
  code?: string | null;
}

interface MutationResultShape {
  success: boolean;
  errors?: MutationResultErrors[] | null;
}

interface WirePaymentJobClient {
  id: string;
  fullName: string | null;
}

interface WirePaymentJob {
  id: string;
  title: string | null;
  client: WirePaymentJobClient | null;
}

interface WirePaymentBillingCycle {
  id: string;
  startDate: string;
  endDate: string;
}

interface WirePaymentMemorandumNode {
  id: string;
  amount: string;
  balance: string;
  downloadPdfUrl: string | null;
  effectiveDate: string | null;
}

interface WirePaymentMemorandums {
  nodes: (WirePaymentMemorandumNode | null)[] | null;
}

interface WirePayment {
  id: string;
  number: number;
  amount: string;
  correctionAmount: string;
  description: string | null;
  status: string;
  kindCategory: string;
  paymentGroupId: string | null;
  billingCycle: WirePaymentBillingCycle | null;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  downloadPdfUrl: string | null;
  job: WirePaymentJob | null;
  memorandums: WirePaymentMemorandums | null;
}

interface WirePaymentsConnection {
  nodes: (WirePayment | null)[] | null;
  summary: PayoutsSummary | null;
  // `ids: [ID]!` is in the captured mobile `paymentsData` fragment — the
  // full id list across ALL pages (offset-pagination prefetch handle,
  // per research/notes/03-applications.md §86). Non-inferred; used as the
  // grounded `totalCount` fallback when the connection omits `totalCount`.
  ids?: (string | null)[] | null;
  // `totalCount` is NOT in the synthesized SDL's `PaymentsConnection`
  // (schema.graphql) but IS selected by the captured portal op
  // `GetTalentPayments`. INFERRED for the mobile op until E2E confirms —
  // optional + nullable so a server omission degrades to the `ids`
  // fallback rather than throwing.
  totalCount?: number | null;
}

interface PaymentsListResponse {
  viewer: {
    id: string;
    payments: WirePaymentsConnection | null;
  } | null;
}

interface PaymentShowResponse {
  node: WirePayment | null;
}

/**
 * Wire response for `GetTalentPaymentSummary` (#448). The op selects the
 * `summary` aggregate block on `viewer.payments` — the SAME six-total
 * shape {@link WirePaymentsConnection.summary} carries on the heavier
 * `Payments` list op. `viewer` / `payments` / `summary` are each
 * independently nullable (mirrors {@link PaymentsListResponse}).
 */
interface PaymentSummaryResponse {
  viewer: {
    id: string;
    payments: { summary: PayoutsSummary | null } | null;
  } | null;
}

interface WirePaymentOption {
  id: string;
  paymentMethod: string;
  preferredOption: boolean;
  fullName: string | null;
  payoneerId: string | null;
  comment: string | null;
  toptalPaymentsPending: boolean | null;
}

interface PaymentOptionsResponse {
  viewer: {
    id: string;
    paymentOptions: (WirePaymentOption | null)[] | null;
  } | null;
}

interface WireRateChangeEngagementCurrentAgreement {
  commitment: { slug: string } | null;
}

interface WireRateChangeEngagementJob {
  id: string;
  title: string | null;
  client: { id: string; fullName: string | null } | null;
}

interface WireRateChangeEngagement {
  id: string;
  job: WireRateChangeEngagementJob | null;
  currentAgreement: WireRateChangeEngagementCurrentAgreement | null;
}

interface WireRateChangeRequest {
  id: string;
  createdAt: string;
  desiredRate: string;
  outcomeRate: string;
  requestType: string;
  status: string;
  talentComment: string;
  engagement: WireRateChangeEngagement | null;
}

interface WireRateInsightForCommitment {
  currentRateCompetitive: boolean | null;
  recentApplicationRate: string | null;
  recommendedRate: string | null;
}

interface WireViewerRoleRates {
  hourly: string | null;
}

interface WireViewerRoleRateInsight {
  hourly: WireRateInsightForCommitment | null;
}

interface WireViewerRole {
  rates: WireViewerRoleRates | null;
  rateInsight: WireViewerRoleRateInsight | null;
  hourlyRate?: { verbose: string | null } | null;
}

interface WireViewer {
  id: string;
  lastRateChangeRequest: WireRateChangeRequest | null;
  viewerRole: WireViewerRole | null;
}

interface LastRateChangeRequestResponse {
  viewer: WireViewer | null;
}

interface WireTalentRateValidationRule {
  minRate: string | null;
  rateStep: number | null;
}

interface WirePlatformConfigurationRateRules {
  hourly: WireTalentRateValidationRule | null;
}

interface WirePlatformConfiguration {
  id: string;
  rateValidationRules: WirePlatformConfigurationRateRules | null;
}

/**
 * Z-4 (#288) beachhead schema — first production wire-up of the
 * runtime-validation seam built in Z-3 (#286). Validates the
 * `RateChangeFormDetails` mobile-gateway response against the
 * structural shape `rate.show()` depends on.
 *
 * Beachhead choice rationale:
 *   - `RateChangeFormDetails` is the SOLE existing `callGateway` site
 *     in the codebase using a TRUSTED operation (i.e., NOT in
 *     `GATEWAY_{MOBILE,PORTAL}_KNOWN_UNTRUSTED_OPS` per
 *     `codegen.config.ts`). The codegen emits a
 *     `RateChangeFormDetailsQuery` type in `gateway.ts`, confirming
 *     the operation passes SDL validation end-to-end.
 *   - The query text in `RATE_CHANGE_FORM_DETAILS_QUERY` above is
 *     verbatim from `../research/graphql/gateway/operations/mobile/
 *     RateChangeFormDetails.graphql`, so the wire response is exactly
 *     what the SDL declares.
 *
 * Generated zod sub-schemas used directly:
 *   - {@link VerticalMarketConditionSchema} — the wire's
 *     `viewerRole.vertical.marketCondition` selection (`{ condition }`)
 *     matches the SDL type `VerticalMarketCondition` exactly. No
 *     `__typename` mismatch risk for the inner type because the
 *     selection includes `__typename` per the verbatim query.
 *   - {@link VerticalGlobalMarketConditionSchema} — the wire's
 *     `viewerRole.vertical.globalMarketCondition` selection
 *     (`{ condition, conditionColor, conditionVerbose, reportUrl }`)
 *     matches the SDL type `VerticalGlobalMarketCondition` exactly
 *     (4 string fields).
 *
 * Inline (NOT-from-codegen) sub-schemas used elsewhere:
 *   - `viewer` / `viewerRole` / `vertical` / `platformConfiguration`
 *     envelopes — partial selections of larger SDL types; the
 *     auto-generated `ViewerSchema` etc. require every SDL-declared
 *     field, which the operation does not select. An inline shape
 *     matches the actual selection set.
 *   - `rates`, `rateInsight.hourly`, and
 *     `platformConfiguration.rateValidationRules.hourly` — the SDL
 *     declares `TalentRate.hourly: String!` (non-null),
 *     `TalentRateInsightForCommitment.currentRateCompetitive: Boolean!`
 *     (boolean), and `TalentRateValidationRule.rateStep: Int!`
 *     (number). The hand-rolled service-layer types
 *     (`WireViewerRoleRates`, `WireRateInsightForCommitment`,
 *     `WireTalentRateValidationRule`) declare `hourly` as
 *     `string | null` (defensive null tolerance) and now declare
 *     `currentRateCompetitive` as `boolean | null` and `rateStep` as
 *     `number | null` (SDL-aligned per #319 — pre-#319 they were
 *     widened to `string | null`, the T2 Zod validator caught the
 *     drift on the live wire on 2026-05-15).
 *
 * Schema/contract rule disposition: NOT triggered. The wire shape
 * being validated is the SAME shape the hand-rolled types now
 * encode; the schema is a structural mirror. Issue #319 reconciled
 * the `currentRateCompetitive` / `rateStep` types with the SDL truth
 * and the live wire (post-Z-4 beachhead follow-up).
 *
 * Vertical is `.optional()` because the existing in-tree unit
 * fixtures for `rate.show` don't carry it (the hand-rolled
 * `WireViewerRole` doesn't declare `vertical` either). The live wire
 * does include it per the verbatim query selection — `.optional()`
 * keeps the schema compatible with both shapes.
 */
const RATE_CHANGE_FORM_DETAILS_RESPONSE_SCHEMA = z.object({
  viewer: z
    .object({
      id: z.string(),
      viewerRole: z
        .object({
          vertical: z
            .object({
              name: z.string(),
              marketCondition: VerticalMarketConditionSchema(),
              globalMarketCondition: VerticalGlobalMarketConditionSchema(),
            })
            .optional(),
          rates: z
            .object({
              hourly: z.string().nullable(),
            })
            .nullable(),
          rateInsight: z
            .object({
              hourly: z
                .object({
                  // `Boolean!` per SDL; live wire returns JSON boolean (#319).
                  currentRateCompetitive: z.boolean().nullable(),
                  recentApplicationRate: z.string().nullable(),
                  recommendedRate: z.string().nullable(),
                })
                .nullable(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
  platformConfiguration: z
    .object({
      id: z.string(),
      rateValidationRules: z
        .object({
          hourly: z
            .object({
              minRate: z.string().nullable(),
              // `Int!` per SDL; live wire returns JSON number (#319).
              rateStep: z.number().nullable(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

/**
 * T2 wire-validation schema for `GetTalentRate` (#447). Follows the
 * Z-4 (#288) beachhead pattern: hand-composed Zod schema mirroring the
 * verbatim operation's selection set; passed as the optional `schema`
 * argument to `callGateway` so a `ZodError` at the wire boundary
 * surfaces as `PaymentsError("WIRE_SHAPE_ERROR")` rather than slipping
 * past as an `as`-cast.
 *
 * The schema is inline rather than generated because:
 *   - The operation has a trivial 5-field selection (no fragments, no
 *     polymorphism). The full SDL types (`Viewer`, `ViewerRole`,
 *     `TalentHourlyRate`) declare many more fields than this selection
 *     reads; importing the generated `ViewerSchema` etc. would fail
 *     `.strict()` validation against the actual partial response.
 *   - No reusable sub-schemas in `__generated__/zod-schemas.ts` happen
 *     to match this exact selection's nested shape.
 *
 * Generated TS type (`GetTalentRateQuery` in `__generated__/gateway.ts`)
 * is the structural reference; this schema is its runtime mirror.
 */
const GET_TALENT_RATE_RESPONSE_SCHEMA = z.object({
  viewer: z
    .object({
      id: z.string(),
      viewerRole: z.object({
        roleId: z.number(),
        hourlyRate: z.object({
          verbose: z.string(),
        }),
      }),
    })
    .nullable(),
});

interface WireRateChangeQuestionOption {
  label: string;
  commentRequired: boolean;
}

interface WireRateChangeQuestion {
  id: string;
  kind: string;
  label: string;
  options: (WireRateChangeQuestionOption | null)[] | null;
}

interface RateChangeQuestionsResponse {
  viewer: {
    id: string;
    rateChangeRequestQuestions: (WireRateChangeQuestion | null)[] | null;
  } | null;
}

interface CreateRateChangeRequestResponse {
  viewerRole: {
    createRateChangeRequest:
      | (MutationResultShape & {
          notice: string | null;
          viewer: WireViewer | null;
        })
      | null;
  } | null;
}

// Wire pattern: bad Relay ID returns `Node id "<id>" resolves to ...`
// per memory `project_toptal_wire_quirks.md`. Used by `payouts.show()`
// to remap the wire-level decode error to a typed NOT_FOUND.
const NODE_NOT_FOUND_PATTERN = /Node id .* resolves to/i;

// ---------------------------------------------------------------------
// Transport helper (mirrors the engagements/applications pattern)
// ---------------------------------------------------------------------

/**
 * Thin per-service wrapper around {@link callGatewayShared} (issue
 * #329). Pins the mobile-gateway surface and the {@link PaymentsError}
 * domain class.
 */
async function callGateway<T>(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  schema?: z.ZodType<T>,
): Promise<T> {
  return callGatewayShared<T, PaymentsError>("mobile-gateway", token, operationName, query, variables, PaymentsError, {
    schema,
  });
}

function formatMutationErrors(prefix: string, errors: MutationResultErrors[] | null | undefined): string {
  if (errors == null || errors.length === 0) {
    return `${prefix}: no error detail returned.`;
  }
  const parts = errors.map((e) => {
    const fields: string[] = [];
    if (e.code != null) fields.push(`code=${e.code}`);
    if (e.key != null) fields.push(`key=${e.key}`);
    const head = fields.length > 0 ? `[${fields.join(", ")}] ` : "";
    return `${head}${e.message ?? "(no message)"}`;
  });
  return `${prefix}: ${parts.join("; ")}`;
}

// ---------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------

function emptyPayoutsSummary(): PayoutsSummary {
  return {
    totalDisputed: "0",
    totalDue: "0",
    totalOnHold: "0",
    totalOutstanding: "0",
    totalOverdue: "0",
    totalPaid: "0",
  };
}

function projectMemorandum(wire: WirePaymentMemorandumNode): PayoutMemorandum {
  return {
    id: wire.id,
    amount: wire.amount,
    balance: wire.balance,
    downloadPdfUrl: wire.downloadPdfUrl,
    effectiveDate: wire.effectiveDate,
  };
}

function projectPayout(wire: WirePayment): Payout {
  const memos = (wire.memorandums?.nodes ?? []).filter((m): m is WirePaymentMemorandumNode => m !== null);
  return {
    id: wire.id,
    number: wire.number,
    amount: wire.amount,
    correctionAmount: wire.correctionAmount,
    description: wire.description,
    status: wire.status,
    kindCategory: wire.kindCategory,
    paymentGroupId: wire.paymentGroupId,
    billingCycle: wire.billingCycle,
    dueDate: wire.dueDate,
    paidAt: wire.paidAt,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
    downloadPdfUrl: wire.downloadPdfUrl,
    job: wire.job,
    memorandums: memos.map(projectMemorandum),
  };
}

function projectPaymentMethod(wire: WirePaymentOption): PaymentMethod {
  return {
    id: wire.id,
    paymentMethod: wire.paymentMethod,
    preferredOption: wire.preferredOption,
    fullName: wire.fullName,
    payoneerId: wire.payoneerId,
    comment: wire.comment,
    toptalPaymentsPending: wire.toptalPaymentsPending,
  };
}

function projectRateChangeRequest(wire: WireRateChangeRequest): RateChangeRequest {
  const job = wire.engagement?.job ?? null;
  return {
    id: wire.id,
    createdAt: wire.createdAt,
    desiredRate: wire.desiredRate,
    outcomeRate: wire.outcomeRate,
    requestType: wire.requestType,
    status: wire.status,
    statusVerbose: RATE_CHANGE_STATUS_VERBOSE[wire.status] ?? wire.status,
    talentComment: wire.talentComment,
    engagementId: wire.engagement?.id ?? null,
    engagementTitle: job?.title ?? null,
    clientName: job?.client?.fullName ?? null,
  };
}

function projectRateQuestion(wire: WireRateChangeQuestion): RateQuestion {
  const opts = (wire.options ?? []).filter((o): o is WireRateChangeQuestionOption => o !== null);
  return {
    id: wire.id,
    kind: wire.kind,
    label: wire.label,
    options: opts.map((o) => ({ label: o.label, commentRequired: o.commentRequired })),
  };
}

// ---------------------------------------------------------------------
// Payouts namespace
// ---------------------------------------------------------------------

/**
 * Payouts — historical `TalentPayment` events. Read-only in v1.
 */
export const payouts = {
  /**
   * List historical payouts (paginated, #373). `opts.page` (1-indexed)
   * and `opts.perPage` translate to the wire's `offsetPagination: {
   * offset: (page-1)*perPage, limit: perPage }`. Defaults `page: 1,
   * perPage: 20` reproduce the pre-#373 hard-coded `offset: 0, limit:
   * 20` behavior exactly, so existing callers see no behavioral change.
   *
   * Filter map: `fromDate` / `toDate` flow into the wire's
   * `filters.createdOn` field, which expects an inclusive-on-both-ends
   * `DateFilter` shape `{from?: Date, to?: Date}`. Empty filter object
   * (no date fields) sends `filters: null` per Toptal convention.
   *
   * Returns the projected {@link Payout} rows, the server-provided
   * {@link PayoutsSummary} aggregates for the same filter window, AND
   * the offset-style pagination metadata (`totalCount`, `page`,
   * `perPage`) so the CLI / MCP layer can render `pageInfo` without a
   * second round-trip.
   *
   * `totalCount` derivation (the wire's synthesized SDL omits it on
   * `PaymentsConnection`, but the captured portal op selects it — see
   * `PAYMENTS_QUERY` note): prefer the connection's `totalCount`; fall
   * back to the captured `ids` array length (the full cross-page id
   * list); final fallback to the current page's item count.
   */
  async list(token: string, opts: ListPayoutsOptions = {}): Promise<PayoutsListResult> {
    const page = opts.page ?? DEFAULT_PAGE;
    const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
    const hasFilter = opts.fromDate !== undefined || opts.toDate !== undefined;
    const variables: Record<string, unknown> = {
      filters: hasFilter ? { createdOn: { from: opts.fromDate ?? null, to: opts.toDate ?? null } } : null,
      offset: (page - 1) * perPage,
      limit: perPage,
    };
    const data = await callGateway<PaymentsListResponse>(token, "Payments", PAYMENTS_QUERY, variables);
    if (data.viewer === null) {
      throw new PaymentsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
    }
    if (data.viewer.payments === null) {
      return { items: [], summary: emptyPayoutsSummary(), totalCount: 0, page, perPage };
    }
    const conn = data.viewer.payments;
    const nodes = (conn.nodes ?? []).filter((n): n is WirePayment => n !== null);
    const items = nodes.map(projectPayout);
    const totalCount =
      typeof conn.totalCount === "number" ? conn.totalCount : conn.ids != null ? conn.ids.length : items.length;
    return {
      items,
      summary: conn.summary ?? emptyPayoutsSummary(),
      totalCount,
      page,
      perPage,
    };
  },

  /**
   * Fetch a single payout's detail by `TalentPayment.id`.
   *
   * Throws `PaymentsError("NOT_FOUND")` when the id doesn't resolve
   * (two wire shapes both fold here: the Relay `node` returning `null`,
   * AND the gateway returning a `Node id "<id>" resolves to ...` decode
   * error in `errors[]`).
   */
  async show(token: string, id: string): Promise<Payout> {
    let data: PaymentShowResponse;
    try {
      data = await callGateway<PaymentShowResponse>(token, "Payment", PAYMENT_QUERY, { id });
    } catch (err) {
      if (err instanceof PaymentsError && err.code === "GRAPHQL_ERROR" && NODE_NOT_FOUND_PATTERN.test(err.message)) {
        throw new PaymentsError("NOT_FOUND", `No payout found with id "${id}" (or you don't have access to it).`, {
          cause: err,
        });
      }
      throw err;
    }
    if (data.node === null) {
      throw new PaymentsError("NOT_FOUND", `No payout found with id "${id}" (or you don't have access to it).`);
    }
    return projectPayout(data.node);
  },
};

// ---------------------------------------------------------------------
// Methods namespace
// ---------------------------------------------------------------------

/**
 * Payment methods — `PaymentOption` records configured by the talent.
 * Read-only in v1; mutations (create / update / mark-as-preferred /
 * remove) are explicitly out of scope per #149.
 */
export const methods = {
  /**
   * List configured payment methods. No filter args on the wire — the
   * full list is small (typically 1-3 entries).
   *
   * `preferredOption: true` marks the active method; the CLI / MCP
   * surface annotates this in the rendered output.
   */
  async list(token: string): Promise<PaymentMethod[]> {
    const data = await callGateway<PaymentOptionsResponse>(token, "PaymentOptions", PAYMENT_OPTIONS_QUERY, {});
    if (data.viewer === null) {
      throw new PaymentsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
    }
    const wires = (data.viewer.paymentOptions ?? []).filter((p): p is WirePaymentOption => p !== null);
    return wires.map(projectPaymentMethod);
  },

  /**
   * Fetch a single payment method by id. The wire has no per-id query;
   * this client-side filter on {@link methods.list} is the API reality.
   * Adds one round-trip cost relative to a hypothetical
   * `paymentOption(id)` query — acceptable given the list is small.
   *
   * Throws `PaymentsError("NOT_FOUND")` when no entry matches.
   */
  async show(token: string, id: string): Promise<PaymentMethod> {
    const list = await methods.list(token);
    const found = list.find((m) => m.id === id);
    if (found === undefined) {
      throw new PaymentsError("NOT_FOUND", `No payment method found with id "${id}".`);
    }
    return found;
  },
};

// ---------------------------------------------------------------------
// Rate namespace
// ---------------------------------------------------------------------

function projectViewerRoleRate(role: WireViewerRole | null): { decimal: string | null; verbose: string | null } {
  if (role === null) return { decimal: null, verbose: null };
  const decimal = role.rates?.hourly ?? null;
  const verbose = role.hourlyRate?.verbose ?? null;
  return { decimal, verbose };
}

function projectMarketInsight(role: WireViewerRole | null): RateMarketInsight | null {
  const insight = role?.rateInsight?.hourly;
  if (insight == null) return null;
  return {
    currentRateCompetitive: insight.currentRateCompetitive,
    recentApplicationRate: insight.recentApplicationRate,
    recommendedRate: insight.recommendedRate,
  };
}

function projectValidation(config: WirePlatformConfiguration | null): RateValidation | null {
  const hourly = config?.rateValidationRules?.hourly;
  if (hourly == null) return null;
  return { minRate: hourly.minRate, rateStep: hourly.rateStep };
}

function classifyOngoing(req: WireRateChangeRequest | null): RateChangeRequest | null {
  if (req === null) return null;
  if (req.status !== "PENDING" && req.status !== "CLAIMED") return null;
  return projectRateChangeRequest(req);
}

/**
 * Rate management — show the current rate + change history; submit a
 * rate-change request.
 */
export const rate = {
  /**
   * Read the talent's current hourly rate via a single lightweight
   * `GetTalentRate` query (#447). Returns the server-formatted verbose
   * string plus the active `viewerRole.roleId`.
   *
   * Strictly faster than {@link rate.show}: one query, three nested
   * fields, no parallel composition. Use this for "what's my rate"
   * answers; use {@link rate.show} when you also need market insight,
   * validation rules, or change history.
   *
   * T2 wire-validation: passes the inline-composed
   * `GET_TALENT_RATE_RESPONSE_SCHEMA` (mirrors the operation's
   * verbatim selection) as the `schema:` argument to `callGateway`. A
   * wire-shape drift surfaces as `PaymentsError("WIRE_SHAPE_ERROR")`
   * per `docs/wire-validation-error-format.md`.
   */
  async current(token: string): Promise<RateCurrent> {
    const data = await callGateway(token, "GetTalentRate", GET_TALENT_RATE_QUERY, {}, GET_TALENT_RATE_RESPONSE_SCHEMA);
    if (data.viewer === null) {
      throw new PaymentsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
    }
    return {
      verbose: data.viewer.viewerRole.hourlyRate.verbose,
      roleId: data.viewer.viewerRole.roleId,
    };
  },

  /**
   * Show the talent's current rate + most-recent rate-change request
   * + market insight + validation rules. Issues TWO parallel queries:
   *   - `LastRateChangeRequest` — carries the most-recent change AND
   *     the current rates / market insight on the viewerRole side.
   *   - `RateChangeFormDetails` — carries the rate-validation rules
   *     (minRate / rateStep) the server enforces on `rate.change`.
   *
   * Both queries return overlapping viewerRole / rateInsight projections;
   * we prefer the `LastRateChangeRequest` shape for those fields (its
   * projection is denser) and fall back to `RateChangeFormDetails` for
   * the validation rules (only this query exposes them).
   *
   * The wire's `ongoingRateChangeRequest` field is `Unknown`-typed and
   * not exposed on `lastRateChangeRequest`; this projection classifies
   * the returned `lastRateChangeRequest` by status — `PENDING` /
   * `CLAIMED` count as "ongoing"; `COMPLETED` counts only as "last".
   * If the wire shape ever grows a separate `ongoingRateChangeRequest`
   * field that can be projected, swap the classification here for a
   * direct read.
   */
  async show(token: string): Promise<RateProjection> {
    const [lastData, formData] = await Promise.all([
      callGateway<LastRateChangeRequestResponse>(token, "LastRateChangeRequest", LAST_RATE_CHANGE_REQUEST_QUERY, {}),
      // Z-4 (#288) beachhead: the only `callGateway` site that passes
      // a schema. See `RATE_CHANGE_FORM_DETAILS_RESPONSE_SCHEMA` for
      // the audit transcript and the SDL-vs-hand-rolled disposition.
      callGateway(
        token,
        "RateChangeFormDetails",
        RATE_CHANGE_FORM_DETAILS_QUERY,
        {},
        RATE_CHANGE_FORM_DETAILS_RESPONSE_SCHEMA,
      ),
    ]);
    if (lastData.viewer === null) {
      throw new PaymentsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
    }
    const lastWire = lastData.viewer.lastRateChangeRequest;
    const last = lastWire !== null ? projectRateChangeRequest(lastWire) : null;
    const ongoing = classifyOngoing(lastWire);
    const role = lastData.viewer.viewerRole ?? formData.viewer?.viewerRole ?? null;
    const rates = projectViewerRoleRate(role);
    return {
      currentRateVerbose: rates.verbose,
      currentRateDecimal: rates.decimal,
      lastChange: last,
      ongoingChange: ongoing,
      marketInsight: projectMarketInsight(role),
      validation: projectValidation(formData.platformConfiguration ?? null),
    };
  },

  /**
   * Fetch the rate-change form's question catalog. Answers to these
   * questions are required as the `answers[]` input to
   * {@link rate.change}. Mirrors the discovery pattern of
   * `engagements.breaks.reasonsList()`.
   */
  async questions(token: string): Promise<RateQuestion[]> {
    const data = await callGateway<RateChangeQuestionsResponse>(
      token,
      "RateChangeRequestQuestions",
      RATE_CHANGE_QUESTIONS_QUERY,
      {},
    );
    if (data.viewer === null) {
      throw new PaymentsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
    }
    const wires = (data.viewer.rateChangeRequestQuestions ?? []).filter((q): q is WireRateChangeQuestion => q !== null);
    return wires.map(projectRateQuestion);
  },

  /**
   * Submit a rate-change request. Client-side validation:
   *   - `kind === "current-engagement"` requires `engagementId`.
   *   - Other kinds reject `engagementId`.
   *   - `desiredRate` and `answers` are passed verbatim to the wire.
   *
   * Dry-run path: when `dryRunOpts.dryRun === true`, short-circuit
   * before any transport call and return a {@link DryRunPreview}-bearing
   * outcome. No prefetch is required (the mutation has no implicit
   * read).
   *
   * Apply path: invokes `CreateRateChangeRequest`. On `success: false`,
   * throws `PaymentsError("MUTATION_ERROR")` with formatted per-field
   * errors.
   */
  async change(token: string, opts: RateChangeOptions, dryRunOpts: DryRunOptions = {}): Promise<RateChangeOutcome> {
    // Client-side validation — surface BEFORE any transport call.
    if (opts.kind === "current-engagement" && (opts.engagementId === undefined || opts.engagementId === "")) {
      throw new PaymentsError("MISSING_INPUT", "`rate change --kind=current-engagement` requires `--engagement <id>`.");
    }
    if (opts.kind !== "current-engagement" && opts.engagementId !== undefined && opts.engagementId !== "") {
      throw new PaymentsError(
        "MISSING_INPUT",
        `\`rate change --kind=${opts.kind}\` rejects \`--engagement <id>\` — drop the flag (the change is account-wide for this kind).`,
      );
    }

    const wireAnswers = opts.answers.map((a) => {
      const wire: Record<string, unknown> = { questionId: a.questionId, value: a.value };
      if (a.comment !== undefined) wire["comment"] = a.comment;
      return wire;
    });
    const variables: Record<string, unknown> = {
      desiredRate: opts.desiredRate,
      engagementId: opts.engagementId ?? null,
      requestType: RATE_CHANGE_KIND_TO_WIRE[opts.kind],
      talentComment: opts.talentComment ?? null,
      answers: wireAnswers,
    };

    if (dryRunOpts.dryRun === true) {
      return {
        kind: "preview",
        preview: buildDryRunPreview({
          surface: "mobile-gateway",
          authToken: token,
          body: {
            operationName: "CreateRateChangeRequest",
            query: CREATE_RATE_CHANGE_REQUEST_MUTATION,
            variables,
          },
        }),
      };
    }

    const data = await callGateway<CreateRateChangeRequestResponse>(
      token,
      "CreateRateChangeRequest",
      CREATE_RATE_CHANGE_REQUEST_MUTATION,
      variables,
    );
    if (data.viewerRole === null) {
      throw new PaymentsError("UNKNOWN", "CreateRateChangeRequest response had no `viewerRole`.");
    }
    const result = data.viewerRole.createRateChangeRequest;
    if (result === null) {
      throw new PaymentsError("UNKNOWN", "CreateRateChangeRequest returned a null payload.");
    }
    if (!result.success) {
      throw new PaymentsError("MUTATION_ERROR", formatMutationErrors("CreateRateChangeRequest failed", result.errors));
    }
    const wire = result.viewer?.lastRateChangeRequest ?? null;
    if (wire === null) {
      throw new PaymentsError(
        "UNKNOWN",
        "CreateRateChangeRequest reported success but the returned `viewer.lastRateChangeRequest` was null.",
      );
    }
    return { kind: "applied", result: projectRateChangeRequest(wire), notice: result.notice };
  },
};

// ---------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------

/**
 * Read the talent's aggregate payment summary via a single lightweight
 * `GetTalentPaymentSummary` query (#448) — six server-computed totals
 * (paid / due / outstanding / overdue / on-hold / disputed) spanning the
 * talent's entire payment history.
 *
 * Sibling to {@link payouts.list}: where `payouts.list` returns the
 * individual {@link Payout} rows (paginated) PLUS the same
 * {@link PayoutsSummary} aggregate for the queried window, `summary()`
 * answers "what are my totals" in one round trip with no row payload.
 * Use it for an at-a-glance financial overview; reach for `payouts.list`
 * when the individual payment events matter.
 *
 * Called with empty variables — the op's three filter variables
 * (`$status` / `$createdOn` / `$clientIds`) are all optional, so an
 * unset call returns the all-time aggregate. Date / client filtering is
 * a deliberate v1 non-goal.
 *
 * T1 wire-validation (#448): `GetTalentPaymentSummary` is in
 * `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` (no generated type), so there is
 * no `schema:` argument — the wire shape is pinned by the committed
 * `GetTalentPaymentSummary.snapshot.json` and asserted on every
 * `TTCTL_E2E=1` run via `assertWireShapeStable`.
 *
 * Returns the server's {@link PayoutsSummary}; falls back to the
 * all-zero summary when `viewer.payments` (or its `summary` block) is
 * `null`, mirroring {@link payouts.list}.
 */
export async function summary(token: string): Promise<PayoutsSummary> {
  const data = await callGateway<PaymentSummaryResponse>(
    token,
    "GetTalentPaymentSummary",
    GET_TALENT_PAYMENT_SUMMARY_QUERY,
    {},
  );
  if (data.viewer === null) {
    throw new PaymentsError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
  }
  return data.viewer.payments?.summary ?? emptyPayoutsSummary();
}
