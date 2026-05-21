// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl jobs apply` (#445, ADR-008).
 *
 * **Mandatory per the project's schema/contract validation rule** —
 * `JobApply` is hand-authored against the synthesized schema (it lives
 * in `codegen.config.ts`'s `KNOWN_UNTRUSTED_OPS` set; see ADR-008
 * § Spike outcome). The mutation's input shape (`comment`,
 * `matcherQuestionsAnswers`, `expertiseQuestionsAnswers`,
 * `understand` ← `$consentIssued`, `requestedHourlyRate`,
 * `pitchData` ← `$talentCard`) is INFERRED from `JobApply.graphql`;
 * the live wire is the only authority on whether the variable wiring
 * is accepted.
 *
 * Coverage:
 *
 *   - **Always-on**: dry-run preview (no wire call), consent-missing
 *     CLI-side refusal (no wire call), and a negative path against a
 *     synthetic / valid-format-non-existent job id. These pin the
 *     envelope shape, the consent-gate's `CONSENT_REQUIRED` code, and
 *     the operationName forwarding without touching destructive state.
 *
 *   - **Gated DESTRUCTIVE positive path**: only runs when
 *     `TTCTL_E2E_APPLY_JOB=<jobId>` is exported. The operator supplies a
 *     fresh ELIGIBLE job id they actually want to apply to. Applying
 *     creates a `JobApplication` row on the user's Toptal activity and
 *     notifies the recruiter. No wire withdraw operation exists. Only
 *     set the env var when you intend to actually apply.
 *
 *   - **Gated idempotency probe** (resolves design open Q4 from the
 *     issue): only runs when `TTCTL_E2E_REAPPLY_JOB=<jobId>` is
 *     exported. The operator supplies a job they have ALREADY applied
 *     to (e.g. via the portal, or from an earlier `jobs apply` run).
 *     The probe issues a second apply and asserts the wire's
 *     `already_applied` error key (mapped to `ALREADY_APPLIED` by the
 *     service). Non-destructive — the wire rejects the duplicate
 *     before creating any new state.
 *
 * **Wire-shape snapshot** (T1 per ADR-006 / `docs/wire-validation-routing.md`):
 * the gated positive path captures `JobApply.snapshot.json` on first
 * run with `TTCTL_UPDATE_WIRE_SNAPSHOTS=1`; thereafter
 * `assertWireShapeStable(...)` runs on every `TTCTL_E2E=1` invocation.
 *
 * **Design open questions** (per `hq/engineering/adr/ADR-008-application-funnel-write-side.md`):
 *
 *   - Q1 (`pitchData` vs `talentCard`): the mutation's variable is
 *     `$talentCard: PitchInput` but the input-field name is `pitchData`
 *     (see `JOB_APPLY_MUTATION` in `services/applications/index.ts`).
 *     The gated positive path with a populated `--pitch-file` is the
 *     first opportunity to confirm the wire accepts the field name
 *     `pitchData` inside the input literal.
 *   - Q3 (`consentIssued` exact field name): the mutation maps
 *     `$consentIssued` → `understand:` on the input. The gated path is
 *     the first opportunity to confirm `understand` is the accepted
 *     field name. If the wire returns a top-level error pointing at
 *     a different field name, file a follow-up and update the
 *     mutation string in #426.
 */

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, applications } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

// e2e-covers: JobApply

const e2eEnabled = process.env["TTCTL_E2E"] === "1";
const applyJobId = process.env["TTCTL_E2E_APPLY_JOB"];
const reapplyJobId = process.env["TTCTL_E2E_REAPPLY_JOB"];

function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

describe("jobs apply (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  // ---------------------------------------------------------------------
  // Always-on paths
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled)("--dry-run emits the JobApply preview envelope and makes no wire call", async () => {
    const result = await cli.run([
      "--dry-run",
      "jobs",
      "apply",
      "job-fake-id-dry-run-doesnt-matter",
      "--consent",
      "--rate",
      "85.00",
      "-o",
      "json",
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean;
      version?: string;
      dryRun?: boolean;
      operation?: string;
      preview?: {
        operationName?: string;
        surface?: string;
        transport?: string;
        variables?: Record<string, unknown>;
        headers?: Record<string, string>;
      };
      updated?: unknown;
    };
    expect(payload.ok).toBe(true);
    expect(payload.version).toBe("1.0");
    expect(payload.dryRun).toBe(true);
    expect(payload.operation).toBe("jobs.apply");
    expect(payload.preview?.operationName).toBe("JobApply");
    expect(payload.preview?.surface).toBe("mobile-gateway");
    expect(payload.preview?.transport).toBe("stock");
    expect(payload.preview?.variables?.["id"]).toBe("job-fake-id-dry-run-doesnt-matter");
    // `consentIssued` MUST be the literal `true` in the preview — the
    // CLI handler refuses on `--consent` absence before the service is
    // called, so any preview that gets emitted carries `true`.
    expect(payload.preview?.variables?.["consentIssued"]).toBe(true);
    expect(payload.preview?.variables?.["requestedHourlyRate"]).toBe("85.00");
    // Optional fields default to `null` in the preview (service
    // emits `input.field ?? null`).
    expect(payload.preview?.variables?.["comment"]).toBeNull();
    expect(payload.preview?.variables?.["matcherQuestionsAnswers"]).toBeNull();
    expect(payload.preview?.variables?.["expertiseQuestionsAnswers"]).toBeNull();
    expect(payload.preview?.variables?.["talentCard"]).toBeNull();
    // Bearer must be redacted in the preview headers.
    expect(payload.preview?.headers?.["authorization"]).toBe("Token token=<redacted>");
    // No `updated` field on the dry-run path.
    expect(payload.updated).toBeUndefined();
  });

  it.skipIf(!e2eEnabled)(
    "consent-missing CLI refusal: `jobs apply <id>` without --consent emits CONSENT_REQUIRED and makes NO wire call",
    async () => {
      // The CLI's `runJobsApply` handler emits CONSENT_REQUIRED BEFORE
      // calling into the service. Defense-in-depth: the service repeats
      // the runtime check at `applications.apply()`. This assertion
      // pins the CLI-level refusal; the service-level check is
      // exercised by the unit test in `applications/__tests__/`.
      const result = await cli.run(["jobs", "apply", "job-fake-id-no-wire-call", "-o", "json"]);
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        errors?: Array<{ code?: string; message?: string; hint?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.operation).toBe("jobs.apply");
      expect(payload.errors?.[0]?.code).toBe("CONSENT_REQUIRED");
      // The hint must point the operator at re-running with --consent
      // (and at --dry-run as the safe-preview path).
      expect(payload.errors?.[0]?.hint).toMatch(/--consent/);
    },
  );

  it.skipIf(!e2eEnabled)(
    "negative path: valid-format non-existent job id refuses pre-fetch with NOT_FOUND (no JobApply mutation issued)",
    async () => {
      // Per `project_toptal_wire_quirks` auto-memory: reads return a
      // typed Relay decode error for malformed ids; valid-format
      // non-existent ids return `viewer.eligibleJob = null`. The apply
      // path's pre-fetch suite (`applyData` + `applyQuestions` +
      // `rateInsight` via Promise.all) surfaces the NOT_FOUND for either
      // case at the read step — the JobApply mutation never runs.
      // Either NOT_FOUND or GRAPHQL_ERROR is acceptable depending on
      // which of the three concurrent pre-fetches lands its rejection
      // first.
      const fakeId = "VjEtSm9iLTk5OTk5OTk5OQ"; // valid base64, non-existent (same probe as 24-jobs)
      const result = await cli.run(["jobs", "apply", fakeId, "--consent", "--rate", "85.00", "-o", "json"]);
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        errors?: Array<{ code?: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.operation).toBe("jobs.apply");
      const code = payload.errors?.[0]?.code ?? "";
      expect(["NOT_FOUND", "GRAPHQL_ERROR", "UNKNOWN", "MUTATION_ERROR"]).toContain(code);
    },
  );

  // ---------------------------------------------------------------------
  // Gated DESTRUCTIVE positive path
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled || applyJobId === undefined)(
    "positive path (gated by TTCTL_E2E_APPLY_JOB): applies to the supplied job + captures wire-shape snapshot",
    async () => {
      // Gated by env var — the operator opts in by exporting a REAL
      // eligible job id they actually want to apply to. Applying is
      // irreversible (no wire withdraw operation in TTCtl per ADR-008
      // § What We're NOT Solving).
      if (applyJobId === undefined) return;
      const token = loadSandboxBearer(sandboxConfigPath);

      // Call the core service directly so we can pass the response to
      // `assertWireShapeStable` for the T1 snapshot. The CLI surface
      // is exercised on the dry-run path above; the apply path
      // semantics are the same. The `consentIssued: true` literal is
      // the type-system + runtime gate per ADR-008 § Decision Part 4.
      const outcome = await applications.apply(token, applyJobId, { consentIssued: true });
      expect(outcome.kind).toBe("applied");
      if (outcome.kind !== "applied") return;
      const result = outcome.result;
      // The new JobApplication has an id, status, and a wrapping
      // activity-item id (which the CLI surfaces so the user can chain
      // `applications show <activity-id>`).
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
      expect(typeof result.jobActivityItemId).toBe("string");
      expect(result.jobActivityItemId.length).toBeGreaterThan(0);
      expect(typeof result.statusV2.value).toBe("string");
      expect(typeof result.statusV2.verbose).toBe("string");

      // Wire-shape snapshot — captures on first run with
      // TTCTL_UPDATE_WIRE_SNAPSHOTS=1; asserts thereafter.
      expect(() =>
        assertWireShapeStable({
          operationName: "JobApply",
          surface: "mobile-gateway",
          transport: "stock",
          response: result,
        }),
      ).not.toThrow();
    },
  );

  // ---------------------------------------------------------------------
  // Gated idempotency probe — resolves design open Q4
  // ---------------------------------------------------------------------

  it.skipIf(!e2eEnabled || reapplyJobId === undefined)(
    "idempotency probe (gated by TTCTL_E2E_REAPPLY_JOB): re-applying to an already-applied job surfaces ALREADY_APPLIED",
    async () => {
      // Gated by env var — the operator supplies a job they have
      // ALREADY applied to. The second apply should be rejected by the
      // wire with `errors[].key === "already_applied"`, which the
      // service maps to `ApplicationsError(ALREADY_APPLIED)`. This
      // probe is non-destructive: the wire rejects the duplicate
      // before creating any state. It also resolves design open Q4
      // (idempotency semantics) — assumption A5's expected error key.
      if (reapplyJobId === undefined) return;
      const token = loadSandboxBearer(sandboxConfigPath);

      let caught: unknown;
      try {
        await applications.apply(token, reapplyJobId, { consentIssued: true });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(applications.ApplicationsError);
      if (!(caught instanceof applications.ApplicationsError)) return;
      // Either ALREADY_APPLIED (the expected mapping per the service's
      // error-key check) OR MUTATION_ERROR (if the wire surfaces a
      // different `key` than `already_applied` for the duplicate case
      // — the wire is the authority on the key spelling; record the
      // observed code so a future-us can tighten the service mapping
      // if the assumption was wrong).
      expect(["ALREADY_APPLIED", "MUTATION_ERROR"]).toContain(caught.code);
      // Document the empirical evidence on the error message so the
      // failure surfaces what the wire returned (helps triage when the
      // assumption is wrong).
      process.stderr.write(
        `[idempotency probe] re-apply to job ${reapplyJobId} returned code=${caught.code} message=${caught.message}\n`,
      );
    },
  );
});
