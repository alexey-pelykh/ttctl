// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Unit tests for the per-domain consent gate (#258, ADR-009 (ttctl)).
 *
 * Covers:
 *   - Per-domain consent-literal check throws when missing / wrong type
 *   - Per-domain consent-literal check passes when set to `true`
 *   - Env-var bypass (`TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1`) covers the
 *     consent-literal check for all four domains
 *   - Payment-routing CREATE_* additional factors (idempotencyKey +
 *     accountIdentifierEcho) are enforced
 *   - Env-var bypass does NOT cover the payment-routing CREATE_*
 *     additional factors
 *   - `ConsentRequiredError` is a `TtctlError` and exposes `code`,
 *     `domain`, `opName`, `recovery`
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TtctlError } from "../auth/errors.js";
import {
  ACCOUNT_ECHO_MIN_LENGTH,
  CONSENT_ENV_VAR,
  CONSENT_FIELD,
  ConsentRequiredError,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  ensureDestructiveConsent,
} from "../consent.js";
import type { ConsentDomain } from "../consent.js";

const ALL_DOMAINS: readonly ConsentDomain[] = [
  "interview-action",
  "payment-routing",
  "profile-capability",
  "timesheet-billing",
];

const ORIGINAL_ENV: string | undefined = process.env[CONSENT_ENV_VAR];

beforeEach(() => {
  Reflect.deleteProperty(process.env, CONSENT_ENV_VAR);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    Reflect.deleteProperty(process.env, CONSENT_ENV_VAR);
  } else {
    process.env[CONSENT_ENV_VAR] = ORIGINAL_ENV;
  }
});

// ---------------------------------------------------------------------------
// ConsentRequiredError shape
// ---------------------------------------------------------------------------

describe("ConsentRequiredError", () => {
  it("extends TtctlError and Error", () => {
    const err = new ConsentRequiredError("op", "profile-capability", "msg");
    expect(err).toBeInstanceOf(TtctlError);
    expect(err).toBeInstanceOf(Error);
  });

  it("exposes stable code, opName, domain, and a recovery hint", () => {
    const err = new ConsentRequiredError("submitForReview", "profile-capability", "msg");
    expect(err.code).toBe("CONSENT_REQUIRED");
    expect(err.opName).toBe("submitForReview");
    expect(err.domain).toBe("profile-capability");
    expect(err.recovery).toContain("--consent-profile-capability");
    expect(err.recovery).toContain(CONSENT_FIELD["profile-capability"]);
    expect(err.recovery).toContain("ADR-009");
  });

  it("autoRecover defaults to false (consent always needs user action)", () => {
    const err = new ConsentRequiredError("op", "interview-action", "msg");
    expect(err.autoRecover).toBe(false);
  });

  it("name is ConsentRequiredError", () => {
    expect(new ConsentRequiredError("op", "timesheet-billing", "msg").name).toBe("ConsentRequiredError");
  });
});

// ---------------------------------------------------------------------------
// CONSENT_FIELD mapping
// ---------------------------------------------------------------------------

describe("CONSENT_FIELD", () => {
  it("maps each domain to its ADR-009-mandated field name", () => {
    expect(CONSENT_FIELD).toEqual({
      "interview-action": "interviewActionConsentIssued",
      "payment-routing": "paymentRoutingConsentIssued",
      "profile-capability": "profileCapabilityConsentIssued",
      "timesheet-billing": "timesheetBillingConsentIssued",
    });
  });

  it("is frozen — runtime mutations are silently rejected (strict mode would throw)", () => {
    expect(Object.isFrozen(CONSENT_FIELD)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Consent-literal gate (per-domain)
// ---------------------------------------------------------------------------

describe("ensureDestructiveConsent: consent-literal gate", () => {
  for (const domain of ALL_DOMAINS) {
    const field = CONSENT_FIELD[domain];

    describe(`domain="${domain}"`, () => {
      it("throws CONSENT_REQUIRED when the consent field is absent", () => {
        expect(() => {
          ensureDestructiveConsent("opX", domain, {});
        }).toThrowError(ConsentRequiredError);
      });

      it("throws CONSENT_REQUIRED when the consent field is `false`", () => {
        expect(() => {
          ensureDestructiveConsent("opX", domain, { [field]: false });
        }).toThrowError(ConsentRequiredError);
      });

      it("throws CONSENT_REQUIRED when the consent field is a non-boolean truthy value", () => {
        // The gate requires the LITERAL `true` — truthy strings / 1s do not count.
        expect(() => {
          ensureDestructiveConsent("opX", domain, { [field]: 1 });
        }).toThrowError(ConsentRequiredError);
        expect(() => {
          ensureDestructiveConsent("opX", domain, { [field]: "true" });
        }).toThrowError(ConsentRequiredError);
      });

      it("passes (no throw) when the consent field is the literal `true`", () => {
        expect(() => {
          ensureDestructiveConsent("opX", domain, { [field]: true });
        }).not.toThrow();
      });

      it("attaches the failing domain and opName to the thrown error", () => {
        try {
          ensureDestructiveConsent("MY_OP", domain, {});
          expect.fail("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(ConsentRequiredError);
          const cre = err as ConsentRequiredError;
          expect(cre.domain).toBe(domain);
          expect(cre.opName).toBe("MY_OP");
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Env-var bypass for consent-literal
// ---------------------------------------------------------------------------

describe(`ensureDestructiveConsent: ${CONSENT_ENV_VAR} env-var bypass`, () => {
  for (const domain of ALL_DOMAINS) {
    it(`bypasses the consent-literal check for domain="${domain}" when env is set to "1"`, () => {
      process.env[CONSENT_ENV_VAR] = "1";
      expect(() => {
        ensureDestructiveConsent("opX", domain, {});
      }).not.toThrow();
    });

    it(`does NOT bypass when env is set to a non-"1" value (domain="${domain}")`, () => {
      // Common false-positives that should NOT engage bypass — only literal "1" engages it.
      for (const value of ["0", "true", "yes", "", "TTCTL_ALLOW_INFERRED_DESTRUCTIVE"]) {
        process.env[CONSENT_ENV_VAR] = value;
        expect(() => {
          ensureDestructiveConsent("opX", domain, {});
        }).toThrowError(ConsentRequiredError);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Payment-routing CREATE_* supplementary factors (ADR-009 § Decision Part 2)
// ---------------------------------------------------------------------------

describe("ensureDestructiveConsent: payment-routing CREATE_* additional factors", () => {
  const VALID_IDEM_KEY = "x".repeat(IDEMPOTENCY_KEY_MIN_LENGTH);
  const ACCOUNT_ID = "user@example.com";
  const CONSENT_INPUT = {
    paymentRoutingConsentIssued: true,
    idempotencyKey: VALID_IDEM_KEY,
    accountIdentifierEcho: ACCOUNT_ID,
  };

  it("passes when consent + valid idempotency key + matching echo are all present", () => {
    expect(() => {
      ensureDestructiveConsent("CREATE_PAYONEER_PAYMENT_OPTION", "payment-routing", CONSENT_INPUT, {
        paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID },
      });
    }).not.toThrow();
  });

  it("throws when `idempotencyKey` is absent", () => {
    expect(() => {
      ensureDestructiveConsent(
        "CREATE_PAYONEER_PAYMENT_OPTION",
        "payment-routing",
        {
          paymentRoutingConsentIssued: true,
          accountIdentifierEcho: ACCOUNT_ID,
        },
        { paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID } },
      );
    }).toThrowError(/idempotencyKey/);
  });

  it("throws when `idempotencyKey` is too short", () => {
    expect(() => {
      ensureDestructiveConsent(
        "CREATE_PAYONEER_PAYMENT_OPTION",
        "payment-routing",
        {
          paymentRoutingConsentIssued: true,
          idempotencyKey: "x".repeat(IDEMPOTENCY_KEY_MIN_LENGTH - 1),
          accountIdentifierEcho: ACCOUNT_ID,
        },
        { paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID } },
      );
    }).toThrowError(/idempotencyKey/);
  });

  it("throws when `idempotencyKey` is not a string", () => {
    expect(() => {
      ensureDestructiveConsent(
        "CREATE_PAYONEER_PAYMENT_OPTION",
        "payment-routing",
        {
          paymentRoutingConsentIssued: true,
          idempotencyKey: 12345678901234567890n,
          accountIdentifierEcho: ACCOUNT_ID,
        },
        { paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID } },
      );
    }).toThrowError(/idempotencyKey/);
  });

  it("throws when `accountIdentifierEcho` is absent", () => {
    expect(() => {
      ensureDestructiveConsent(
        "CREATE_PAYONEER_PAYMENT_OPTION",
        "payment-routing",
        {
          paymentRoutingConsentIssued: true,
          idempotencyKey: VALID_IDEM_KEY,
        },
        { paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID } },
      );
    }).toThrowError(/accountIdentifierEcho/);
  });

  it("throws when `accountIdentifierEcho` is too short", () => {
    expect(() => {
      ensureDestructiveConsent(
        "CREATE_PAYONEER_PAYMENT_OPTION",
        "payment-routing",
        {
          paymentRoutingConsentIssued: true,
          idempotencyKey: VALID_IDEM_KEY,
          accountIdentifierEcho: "x".repeat(ACCOUNT_ECHO_MIN_LENGTH - 1),
        },
        { paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID } },
      );
    }).toThrowError(/accountIdentifierEcho/);
  });

  it("rejects on echo-mismatch (operator typo'd the account identifier)", () => {
    expect(() => {
      ensureDestructiveConsent(
        "CREATE_PAYONEER_PAYMENT_OPTION",
        "payment-routing",
        {
          paymentRoutingConsentIssued: true,
          idempotencyKey: VALID_IDEM_KEY,
          accountIdentifierEcho: "wrong@example.com",
        },
        { paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID } },
      );
    }).toThrowError(/does not match the intended account identifier/);
  });

  it("does NOT apply the additional factors when `paymentRoutingCreate` context is omitted", () => {
    // Non-CREATE payment-routing op (e.g. UPDATE_PAYONEER_PAYMENT_OPTION):
    // consent literal is sufficient; no idempotency / echo required.
    expect(() => {
      ensureDestructiveConsent("UPDATE_PAYONEER_PAYMENT_OPTION", "payment-routing", {
        paymentRoutingConsentIssued: true,
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Env-var bypass interaction with payment-routing CREATE_*
// ---------------------------------------------------------------------------

describe(`ensureDestructiveConsent: ${CONSENT_ENV_VAR} does NOT bypass payment-routing CREATE_* factors`, () => {
  const ACCOUNT_ID = "user@example.com";
  const VALID_IDEM_KEY = "x".repeat(IDEMPOTENCY_KEY_MIN_LENGTH);

  it("env-var bypass still requires idempotencyKey for payment-routing CREATE_*", () => {
    process.env[CONSENT_ENV_VAR] = "1";
    expect(() => {
      ensureDestructiveConsent(
        "CREATE_PAYONEER_PAYMENT_OPTION",
        "payment-routing",
        {
          // No consent literal — env bypasses that.
          // But idempotencyKey + echo are MANDATORY.
          accountIdentifierEcho: ACCOUNT_ID,
        },
        { paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID } },
      );
    }).toThrowError(/idempotencyKey/);
  });

  it("env-var bypass still requires accountIdentifierEcho for payment-routing CREATE_*", () => {
    process.env[CONSENT_ENV_VAR] = "1";
    expect(() => {
      ensureDestructiveConsent(
        "CREATE_PAYONEER_PAYMENT_OPTION",
        "payment-routing",
        {
          idempotencyKey: VALID_IDEM_KEY,
        },
        { paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID } },
      );
    }).toThrowError(/accountIdentifierEcho/);
  });

  it("env-var bypass still rejects echo-mismatch for payment-routing CREATE_*", () => {
    process.env[CONSENT_ENV_VAR] = "1";
    expect(() => {
      ensureDestructiveConsent(
        "CREATE_PAYONEER_PAYMENT_OPTION",
        "payment-routing",
        {
          idempotencyKey: VALID_IDEM_KEY,
          accountIdentifierEcho: "wrong@example.com",
        },
        { paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID } },
      );
    }).toThrowError(/does not match the intended account identifier/);
  });

  it("env-var bypass DOES bypass consent-literal but factors are correct → passes", () => {
    process.env[CONSENT_ENV_VAR] = "1";
    expect(() => {
      ensureDestructiveConsent(
        "CREATE_PAYONEER_PAYMENT_OPTION",
        "payment-routing",
        {
          // No paymentRoutingConsentIssued — env bypasses it.
          idempotencyKey: VALID_IDEM_KEY,
          accountIdentifierEcho: ACCOUNT_ID,
        },
        { paymentRoutingCreate: { expectedAccountIdentifier: ACCOUNT_ID } },
      );
    }).not.toThrow();
  });
});
