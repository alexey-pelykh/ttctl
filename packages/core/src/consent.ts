// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Per-domain consent gate for INFERRED-destructive mutations.
 *
 * Implements [ADR-009 (ttctl)](../../../hq/engineering/adr/ADR-009-per-domain-consent-vocabulary.md):
 * "Per-Domain Consent Vocabulary for INFERRED-Destructive Mutations". The
 * gate is a TTCtl-layer defense — orthogonal to wire-level consent fields
 * such as `JobApply.consentIssued: Boolean!` (ADR-008's apply-funnel
 * compliance signal). The TTCtl-layer gate sits at the Zod input boundary
 * of services that trigger irreversible platform-side state changes and
 * forces the caller (CLI flag, MCP input, agent loop) to explicitly opt in
 * before any wire call is issued.
 *
 * ## Five domains, five field names
 *
 * Per ADR-009 § Decision Part 1, each operational domain has a distinct
 * consent-field name so the consent ceremony is forensically distinct in
 * agent behaviour models, MCP tool descriptions, CLI `--help` text, and
 * audit logs:
 *
 * | Domain                 | Consent field                       | CLI flag                       |
 * | ---------------------- | ----------------------------------- | ------------------------------ |
 * | `interview-action`     | `interviewActionConsentIssued`      | `--consent-interview-action`   |
 * | `payment-routing`      | `paymentRoutingConsentIssued`       | `--consent-payment-routing`    |
 * | `profile-capability`   | `profileCapabilityConsentIssued`    | `--consent-profile-capability` |
 * | `timesheet-billing`    | `timesheetBillingConsentIssued`     | `--consent-timesheet-billing`  |
 * | `survey-submission`    | `surveySubmissionConsentIssued`     | `--consent-survey-submission`  |
 *
 * `survey-submission` (#673) was added after the original four-domain
 * lock: a survey submission is irreversible and routes the talent's
 * feedback to the recipient (employer / client / Toptal), so an agent
 * answering on the user's behalf warrants the ceremony. See the ADR-009
 * amendment.
 *
 * The Zod primitive is `z.literal(true)` across all domains (preserved
 * from ADR-008's precedent). What varies is the FIELD NAME — which is
 * what the agent's behaviour model and the audit log key off.
 *
 * ## Payment-routing CREATE_* — supplementary factors
 *
 * Per ADR-009 § Decision Part 2, payment-routing CREATE_* mutations (e.g.
 * `CREATE_PAYONEER_PAYMENT_OPTION`, `CREATE_TOPTAL_PAYMENT_ACCOUNT`)
 * create external account bindings that TTCtl cannot rescind from its
 * side once committed. `z.literal(true)` alone is insufficient. The gate
 * additionally requires:
 *
 *   1. `idempotencyKey: string` of length >= {@link IDEMPOTENCY_KEY_MIN_LENGTH}
 *      — operator-supplied UUID-or-similar. Collision = the same
 *      operation, idempotent.
 *   2. `accountIdentifierEcho: string` of length >= {@link ACCOUNT_ECHO_MIN_LENGTH}
 *      — operator re-states the account ID/email/handle. The gate
 *      compares the echo against the caller-supplied
 *      {@link PaymentRoutingCreateContext.expectedAccountIdentifier} —
 *      mismatch raises a `ConsentRequiredError` BEFORE any wire call.
 *
 * The caller (the payment-routing CREATE service function in #453 /
 * #454) supplies the `expectedAccountIdentifier` from its canonical
 * input field (e.g. the Payoneer email, the Toptal account ID).
 *
 * ## Env-var bypass for non-interactive contexts
 *
 * Setting `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` ({@link CONSENT_ENV_VAR})
 * bypasses the consent-LITERAL check for all domains. This is for
 * non-interactive CI / test contexts where the human-in-the-loop
 * ceremony is inappropriate. The bypass does NOT cover the
 * `idempotencyKey` + `accountIdentifierEcho` factors for payment-routing
 * CREATEs — those gates protect against bugs in any caller (agent or
 * human) regardless of interactivity, per ADR-009 § Decision Part 4.
 *
 * ## Why this is NOT integrated with `JobApply.consentIssued`
 *
 * `JobApply.consentIssued: Boolean!` (ADR-008) is a WIRE-level field
 * passed through to Toptal's mutation as a legal-compliance signal
 * (apply-terms acceptance). It is a passthrough constant, not a
 * TTCtl-layer gate field. The two are orthogonal:
 *
 *   - ADR-008's `consentIssued` (wire-level): `Boolean!` on `JobApply`.
 *     Stays as-is.
 *   - ADR-009's tokens (TTCtl-layer): per-domain Zod literals. Do not
 *     appear on the wire.
 *
 * ## Coexistence with `applications.apply()`'s inline gate
 *
 * `applications.apply()` (the ADR-008 site) keeps its own inline
 * literal-true check that throws
 * `ApplicationsError("CONSENT_REQUIRED")` — NOT
 * `ConsentRequiredError`. Two intentional differences from ADR-009:
 *
 *   1. **Error class**: `ApplicationsError` is the applications domain's
 *      taxonomy (extends `Error`); `ConsentRequiredError` is the
 *      cross-cutting consent taxonomy (extends `TtctlError`). The two
 *      error classes coexist by design — `apply()`'s gate predates the
 *      cross-cutting abstraction and is not refactored because the
 *      apply-funnel's `consentIssued` field name is also the wire field
 *      name (ADR-008), tying the gate's identity to the applications
 *      domain.
 *   2. **Gate location**: `apply()` keeps an inline check;
 *      `submitForReview()` and future ADR-009 consumers delegate to
 *      {@link ensureDestructiveConsent}. The error code
 *      (`CONSENT_REQUIRED`) is the same; the constructor wrapping it
 *      differs.
 *
 * Future ADR-009 consumers (the 17 mutations enumerated in ADR-009
 * § Context) all use this utility; the inline pattern in `apply()` is
 * not the canonical form going forward — it is the historical form
 * preserved for the apply-funnel only.
 */

import { TtctlError } from "./auth/errors.js";

/**
 * Operational domains for per-domain consent ceremonies, per
 * ADR-009 § Decision Part 1.
 *
 * The kebab-case form is what callers pass as `domain` to
 * {@link ensureDestructiveConsent}; it is also the CLI-flag suffix
 * (e.g. `--consent-profile-capability`). The corresponding Zod field
 * name (camelCase + `ConsentIssued`) is in {@link CONSENT_FIELD}.
 */
export type ConsentDomain =
  "interview-action" | "payment-routing" | "profile-capability" | "timesheet-billing" | "survey-submission";

/**
 * Per-domain Zod field name (camelCase). Maps {@link ConsentDomain} to
 * the input-field key the caller must set to `true` to satisfy the
 * gate. Per ADR-009 § Decision Part 1.
 */
export const CONSENT_FIELD: Readonly<Record<ConsentDomain, string>> = Object.freeze({
  "interview-action": "interviewActionConsentIssued",
  "payment-routing": "paymentRoutingConsentIssued",
  "profile-capability": "profileCapabilityConsentIssued",
  "timesheet-billing": "timesheetBillingConsentIssued",
  "survey-submission": "surveySubmissionConsentIssued",
});

/**
 * Environment-variable bypass for the consent-LITERAL check in
 * non-interactive contexts. Does NOT bypass the
 * `idempotencyKey` / `accountIdentifierEcho` factors for payment-routing
 * CREATEs — see ADR-009 § Decision Part 4.
 *
 * Set to the literal string `"1"` to enable. Any other value
 * (including empty string, `"0"`, `"true"`, unset) keeps the gate
 * enforced.
 */
export const CONSENT_ENV_VAR = "TTCTL_ALLOW_INFERRED_DESTRUCTIVE";

/**
 * Minimum length of the `idempotencyKey` field required for
 * payment-routing CREATE_* mutations. 16 chars accommodates a 128-bit
 * UUID v4 in canonical form (32 hex chars + 4 hyphens = 36 chars) and
 * a wide range of shorter operator-supplied tokens.
 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 16;

/**
 * Minimum length of the `accountIdentifierEcho` field required for
 * payment-routing CREATE_* mutations. Defensive minimum — most
 * canonical account identifiers (emails, account IDs, handles) are
 * comfortably above 4 chars.
 */
export const ACCOUNT_ECHO_MIN_LENGTH = 4;

/**
 * Cross-domain error class for consent-gate failures. Extends
 * {@link TtctlError} so it flows through CLI / MCP error handlers
 * uniformly (the CLI surfaces `code` + `message` + `recovery`; the MCP
 * tool wrapper surfaces a structured tool-error response).
 *
 * Carries:
 *   - `code: "CONSENT_REQUIRED"` — stable machine-readable identifier.
 *   - `domain: ConsentDomain` — programmatic discriminator for the
 *     specific consent ceremony that failed.
 *   - `opName: string` — the failing operation's wire name (e.g.
 *     `submitForReview`, `CREATE_PAYONEER_PAYMENT_OPTION`).
 *   - `recovery: string` — actionable user-facing guidance derived from
 *     the domain (mentions the CLI flag and the wire-level field name).
 */
export class ConsentRequiredError extends TtctlError {
  override readonly name = "ConsentRequiredError";
  readonly code = "CONSENT_REQUIRED";
  readonly recovery: string;
  readonly opName: string;
  readonly domain: ConsentDomain;

  constructor(opName: string, domain: ConsentDomain, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.opName = opName;
    this.domain = domain;
    this.recovery = `Pass the consent flag — \`--consent-${domain}\` on the CLI, or \`${CONSENT_FIELD[domain]}: true\` via MCP/API. See ADR-009 (ttctl) for the per-domain consent vocabulary.`;
  }
}

/**
 * Caller-supplied context required when invoking the gate for a
 * payment-routing CREATE_* mutation. Per ADR-009 § Decision Part 2,
 * the service that owns the CREATE operation passes its canonical
 * account-identifier input here; the gate uses it to verify the
 * `accountIdentifierEcho` field actually matches the intended account.
 */
export interface PaymentRoutingCreateContext {
  /**
   * The canonical account identifier (e.g. Payoneer email, Toptal
   * account ID, banking handle) the operator intends to bind. The gate
   * compares this against the `accountIdentifierEcho` field in
   * `input`; mismatch raises {@link ConsentRequiredError} BEFORE any
   * wire call.
   */
  expectedAccountIdentifier: string;
}

/**
 * Optional context for the gate. Currently only used by payment-routing
 * CREATEs (see {@link PaymentRoutingCreateContext}); reserved for
 * future per-domain extensions.
 */
export interface ConsentGateOptions {
  /**
   * Supplying this signals the gate is running for a payment-routing
   * CREATE_* mutation; the gate then enforces the supplementary
   * `idempotencyKey` + `accountIdentifierEcho` factors per ADR-009
   * § Decision Part 2.
   *
   * Omit (or pass `undefined`) for non-CREATE payment-routing
   * mutations (e.g. UPDATE_* / DELETE_*) — those get only the
   * consent-literal gate.
   */
  paymentRoutingCreate?: PaymentRoutingCreateContext;
}

/**
 * Verify the caller supplied the per-domain consent ceremony required
 * to invoke an INFERRED-destructive mutation. Throws
 * {@link ConsentRequiredError} BEFORE any wire call when the ceremony
 * is incomplete.
 *
 * Per ADR-009 (ttctl) § Decision:
 *
 *   - Part 1: the `input` object must carry the per-domain consent
 *     field (see {@link CONSENT_FIELD}) set to the literal `true`.
 *     The {@link CONSENT_ENV_VAR} env-var bypasses this for
 *     non-interactive contexts.
 *   - Part 2: payment-routing CREATEs (`options.paymentRoutingCreate`
 *     supplied) additionally require `idempotencyKey` (string, length
 *     >= {@link IDEMPOTENCY_KEY_MIN_LENGTH}) and
 *     `accountIdentifierEcho` (string, length >=
 *     {@link ACCOUNT_ECHO_MIN_LENGTH}) — and the echo MUST equal
 *     {@link PaymentRoutingCreateContext.expectedAccountIdentifier}.
 *     These factors are NOT env-var-bypassable.
 *
 * @param opName — the wire operation name (e.g. `submitForReview`).
 *   Used in the error message and in `ConsentRequiredError.opName` for
 *   auditing.
 * @param domain — the operational domain that determines the
 *   consent-field name.
 * @param input — the caller-supplied input object. The gate reads
 *   `input[CONSENT_FIELD[domain]]` (and, for payment-routing CREATEs,
 *   `input.idempotencyKey` + `input.accountIdentifierEcho`).
 * @param options — optional context. Currently only
 *   `paymentRoutingCreate` is used.
 */
export function ensureDestructiveConsent(
  opName: string,
  domain: ConsentDomain,
  input: { readonly [key: string]: unknown },
  options: ConsentGateOptions = {},
): void {
  const fieldName = CONSENT_FIELD[domain];
  const envBypass = readEnvBypass();

  // Consent-literal check. Env-var bypass applies here ONLY — the
  // payment-routing CREATE_* factors below are NOT bypassable.
  if (!envBypass && input[fieldName] !== true) {
    throw new ConsentRequiredError(
      opName,
      domain,
      `${opName} requires explicit consent: \`${fieldName}: true\` is mandatory before any wire call. See ADR-009 (ttctl) for the per-domain consent vocabulary.`,
    );
  }

  // Payment-routing CREATE_* supplementary factors per ADR-009 § Part 2.
  if (domain === "payment-routing" && options.paymentRoutingCreate !== undefined) {
    const ctx = options.paymentRoutingCreate;

    const idemKey = input["idempotencyKey"];
    if (typeof idemKey !== "string" || idemKey.length < IDEMPOTENCY_KEY_MIN_LENGTH) {
      throw new ConsentRequiredError(
        opName,
        domain,
        `${opName} (payment-routing CREATE) requires \`idempotencyKey: string\` of length >= ${IDEMPOTENCY_KEY_MIN_LENGTH.toString()}. See ADR-009 (ttctl) § Decision Part 2.`,
      );
    }

    const echo = input["accountIdentifierEcho"];
    if (typeof echo !== "string" || echo.length < ACCOUNT_ECHO_MIN_LENGTH) {
      throw new ConsentRequiredError(
        opName,
        domain,
        `${opName} (payment-routing CREATE) requires \`accountIdentifierEcho: string\` of length >= ${ACCOUNT_ECHO_MIN_LENGTH.toString()}. See ADR-009 (ttctl) § Decision Part 2.`,
      );
    }

    if (echo !== ctx.expectedAccountIdentifier) {
      throw new ConsentRequiredError(
        opName,
        domain,
        `${opName} (payment-routing CREATE): \`accountIdentifierEcho\` does not match the intended account identifier — possible misbinding. Re-confirm the account ID/email/handle and pass the matching echo. See ADR-009 (ttctl) § Decision Part 2.`,
      );
    }
  }
}

function readEnvBypass(): boolean {
  return process.env[CONSENT_ENV_VAR] === "1";
}
