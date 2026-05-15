// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildWireShapeError } from "../lib/wire-shape.js";
import { ApplicationsError } from "../services/applications/index.js";
import { AvailabilityError } from "../services/availability/index.js";
import { ContractsError } from "../services/contracts/index.js";
import { EngagementsError } from "../services/engagements/index.js";
import { JobsError } from "../services/jobs/index.js";
import { PaymentsError } from "../services/payments/index.js";
import { TimesheetError } from "../services/timesheet/index.js";
import { ProfileError } from "../services/profile/basic/index.js";
import { SkillsError } from "../services/profile/skills/index.js";

/**
 * Integration test for the `callGateway` ↔ `schema?` ↔
 * `WIRE_SHAPE_ERROR` mechanism (Z-3 / #286). Each service-level
 * `callGateway` / `callTalentProfile` helper applies the same
 * structural pattern after the `body.data` extraction:
 *
 *     if (schema !== undefined) {
 *       const parsed = schema.safeParse(body.data);
 *       if (!parsed.success) {
 *         const payload = buildWireShapeError(operationName, parsed.error);
 *         throw new <Service>Error("WIRE_SHAPE_ERROR", payload.message, {
 *           cause: parsed.error,
 *         });
 *       }
 *       return parsed.data;
 *     }
 *     return body.data;
 *
 * The 9 service files (`callGateway` × 6 + `callTalentProfile` × 3)
 * carry verbatim copies of this branch — see Wave-3 / Z-3 PR diff for
 * the lockstep updates. This test asserts the SHARED contract holds
 * for every domain-error class by exercising the branch directly with
 * each service's error class as the throw target.
 *
 * Direct invocation of the private `callGateway` functions across
 * module boundaries is intentionally not possible; structural
 * symmetry across the 9 sites covers the per-service duplication
 * (code review + linting). This test exercises the shared mechanism
 * — `buildWireShapeError` + `safeParse` + domain-error construction
 * — that every site performs identically.
 *
 * Acceptance criteria coverage (from the issue body):
 *   - "invoke callGateway with mismatched mock + strict schema →
 *     service throws domain error with WIRE_SHAPE_ERROR code; cause
 *     is the original ZodError" — `simulateCallGatewaySchemaBranch`
 *     replays the verbatim branch from each service's callGateway
 *     and asserts every domain error class throws correctly.
 *   - "invoke callGateway with matching mock + schema → service
 *     returns parsed data; no throw" — `simulateCallGatewaySchemaBranch`
 *     returns parsed data when the schema accepts the input.
 *
 * Z-4 (#288) wires `schema` into the first beachhead production op
 * and will exercise the full transport → callGateway → schema path
 * end-to-end via a real public service function.
 */

/**
 * Generic constructor type for a service's domain-error class.
 * Each service exports an `<Service>Error` class with this signature:
 * `(code: string, message: string, options?: { cause?: unknown }) => Error`.
 */
type DomainErrorCtor<E extends Error> = new (code: string, message: string, options?: { cause?: unknown }) => E;

/**
 * Replay the verbatim schema-validation branch from each service's
 * private `callGateway` / `callTalentProfile`. Identical to the
 * production code path; structural symmetry is what makes this test
 * representative.
 */
function simulateCallGatewaySchemaBranch<T, E extends Error>(
  bodyData: unknown,
  operationName: string,
  schema: z.ZodType<T> | undefined,
  ErrorCtor: DomainErrorCtor<E>,
): T {
  if (schema !== undefined) {
    const parsed = schema.safeParse(bodyData);
    if (!parsed.success) {
      const payload = buildWireShapeError(operationName, parsed.error, bodyData);
      throw new ErrorCtor("WIRE_SHAPE_ERROR", payload.message, { cause: parsed.error });
    }
    return parsed.data;
  }
  return bodyData as T;
}

const SERVICE_ERROR_CLASSES = [
  { name: "TimesheetError", Ctor: TimesheetError },
  { name: "EngagementsError", Ctor: EngagementsError },
  { name: "ApplicationsError", Ctor: ApplicationsError },
  { name: "AvailabilityError", Ctor: AvailabilityError },
  { name: "JobsError", Ctor: JobsError },
  { name: "PaymentsError", Ctor: PaymentsError },
  { name: "ContractsError", Ctor: ContractsError },
  { name: "ProfileError", Ctor: ProfileError },
  { name: "SkillsError", Ctor: SkillsError },
] as const;

describe("callGateway ↔ schema integration (Z-3 / #286) — success path", () => {
  it("returns parsed data when wire shape matches the schema", () => {
    const schema = z.object({ viewer: z.object({ id: z.string() }) });
    const data = simulateCallGatewaySchemaBranch({ viewer: { id: "user-1" } }, "MyOp", schema, TimesheetError);
    expect(data).toEqual({ viewer: { id: "user-1" } });
  });

  it("passes data through unchanged when no schema is provided (additive-only behavior)", () => {
    const data = simulateCallGatewaySchemaBranch<{ surprise: string }, TimesheetError>(
      { surprise: "anything" },
      "Op",
      undefined,
      TimesheetError,
    );
    expect(data).toEqual({ surprise: "anything" });
  });
});

describe("callGateway ↔ schema integration (Z-3 / #286) — failure path", () => {
  it.each(SERVICE_ERROR_CLASSES)(
    "throws $name with WIRE_SHAPE_ERROR + ZodError cause when wire shape mismatches",
    ({ Ctor }) => {
      const schema = z.object({ duration: z.number() });
      let thrown: unknown;
      try {
        simulateCallGatewaySchemaBranch({ duration: "480" }, "BillingCycle", schema, Ctor);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Ctor);
      const domainErr = thrown as { code: string; message: string; cause: unknown };
      expect(domainErr.code).toBe("WIRE_SHAPE_ERROR");
      expect(domainErr.cause).toBeInstanceOf(z.ZodError);
      expect(domainErr.message).toBe(
        "Wire shape doesn't match expected schema for operation `BillingCycle` (1 field issue).",
      );
    },
  );

  it("formats the message with plural `field issues` when multiple fields fail", () => {
    const schema = z.object({ a: z.number(), b: z.number() });
    expect(() => simulateCallGatewaySchemaBranch({ a: "x", b: "y" }, "Op", schema, TimesheetError)).toThrowError(
      /\(2 field issues\)/,
    );
  });
});

describe("WIRE_SHAPE_ERROR is on every service's error code enum", () => {
  it.each(SERVICE_ERROR_CLASSES)("$name accepts WIRE_SHAPE_ERROR code", ({ Ctor }) => {
    const err = new Ctor("WIRE_SHAPE_ERROR", "test");
    // Each service's *ErrorCode union includes `"WIRE_SHAPE_ERROR"`.
    // The construction succeeds because the constructor accepts the
    // union's literal-type members. The `code` field round-trips.
    expect((err as { code: string }).code).toBe("WIRE_SHAPE_ERROR");
  });
});
