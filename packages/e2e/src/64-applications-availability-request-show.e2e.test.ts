// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications availability-request show <id>`
 * (#442).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * `AvailabilityRequest` op is in `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`
 * (`codegen.config.ts`); no generated type exists. The wire shape is
 * best-effort INFERRED until this file passes against a live session.
 *
 * Coverage:
 *   - NOT_FOUND for a syntactically-plausible-but-never-issued id
 *     (always exercisable regardless of account state).
 *   - Detail projection for a real availability-request id (discovered
 *     via `applications list` → first row carrying a non-null
 *     `availabilityRequest` presence indicator). Skipped via an
 *     explicit return when the test account has no availability
 *     requests in its activity history.
 *   - **`matcherQuestions` (#585)** — the live-wire authority on the
 *     INFERRED `job.questions { options suggestedAnswer { answer } }`
 *     selection embedded under the AR's job (the shared #584 matcher
 *     seam). Asserts the universal `ApplicationQuestion` shape on every
 *     entry and the mechanically-derived `inputType` (`dropdown` iff
 *     `options` non-empty). Empty array is a valid state (job with no
 *     matcher questions). Schema/contract rule TRIGGERED by this
 *     selection-set change; this is its satisfying live test.
 *   - Wire-shape snapshot assertion (T1 disposition; #442 + #585). Snapshot
 *     committed at `wire-snapshots/AvailabilityRequest.snapshot.json`;
 *     the #585 selection extends it with the matcher-questions sub-shape.
 *
 * Read-only — no side effects.
 *
 * Disposition: **T1** (wire-shape snapshot). `AvailabilityRequest` is
 * in the codegen-exclusion list (its captured op selects subfields on
 * `Unknown`-typed positions via the `jobData` cascade), so no T2 Zod
 * schema is generated; `assertWireShapeStable` is the continuous
 * wire-drift defense.
 */

// e2e-covers: AvailabilityRequest

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, applications } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Load the bearer captured by `globalSetup` into the shared sandbox YAML.
 * Mirrors `62-applications-interview-show.e2e.test.ts` — used by the
 * snapshot test to call the service-layer fn directly (the CLI/MCP-level
 * invocation runs the same projection, so either path captures the same
 * shape; service-level call sidesteps the JSON envelope wrap).
 */
function loadSandboxBearer(sandboxConfigPath: string): string {
  const raw = readFileSync(sandboxConfigPath, "utf8");
  const parsed: unknown = parseYaml(raw);
  const validated = ConfigLoadSchema.parse(parsed);
  if (validated.auth.token === undefined || validated.auth.token === "") {
    throw new Error(`No auth.token in sandbox config at ${sandboxConfigPath}`);
  }
  return validated.auth.token;
}

/**
 * Discover a real availability-request id from the talent's activity
 * history. Activity items carry an `availabilityRequest: { id } | null`
 * field; the first non-null id is sufficient for the detail probe.
 *
 * Returns `null` when:
 *   - no row in the activity list has an associated AR (typical for
 *     accounts whose pipeline is past or before the IR stage), OR
 *   - `applications list` itself fails (e.g. the account-scoped
 *     `JobActivityItems` HTTP 400 issue empirically observed on the
 *     test account at #439 / #440 development time — wire payload
 *     error that blocks discovery even when ARs exist server-side).
 *
 * In both cases the snapshot test skip-returns gracefully — the
 * NOT_FOUND probe above is still the live-callable proof of the
 * `AvailabilityRequest` op; the snapshot is opportunistic (captures
 * when discovery succeeds, defers otherwise — same precedent as #439
 * / #440).
 */
async function discoverAvailabilityRequestId(cli: CliClient): Promise<string | null> {
  // Unfiltered list — ARs typically sit on the ON_RECRUITER_REVIEW
  // status group (the portal's "Interest Requests" tab), but historical
  // rows on ARCHIVED / ACTIVE_ENGAGEMENT may also carry an AR; the
  // default page is the broadest discovery path.
  const result = await cli.run(["applications", "list", "-o", "json"]);
  if (result.exitCode !== 0) {
    process.stdout.write(
      `[64-applications-availability-request-show] discovery via applications list failed (exitCode=${result.exitCode.toString()}); detail+snapshot tests will skip. stdout=${result.stdout || "(empty)"}\n`,
    );
    return null;
  }
  const payload = JSON.parse(result.stdout) as {
    items: Array<{ id?: string; availabilityRequest?: { id?: string } | null }>;
  };
  for (const item of payload.items) {
    const id = item.availabilityRequest?.id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

describe("applications availability-request show (live mobile-gateway, #442)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns a structured NOT_FOUND error for an unknown availability-request id", async () => {
    // Use a syntactically plausible but never-issued id. The gateway
    // surfaces one of the NOT_FOUND_MESSAGE_PATTERN-matched errors
    // (`Record not found` / `Invalid ID` / Relay decode error per the
    // `project-toptal-wire-quirks` memory); the service translates that
    // to `ApplicationsError(NOT_FOUND)`; the CLI surfaces `code:
    // "NOT_FOUND"` in the structured error envelope.
    const fakeId = "ar_00000000000000000000000000000000";
    const result = await cli.run(["applications", "availability-request", "show", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean;
      errors?: Array<{ code?: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });

  it.skipIf(!e2eEnabled)(
    "returns the detail projection for a real availability-request id (discovered from `list`)",
    async () => {
      const id = await discoverAvailabilityRequestId(cli);
      if (id === null) {
        // Account-scoped skip: no ARs in activity history is a valid
        // state. Surface to stdout so the run log shows WHY this
        // expectation didn't fire — vitest's `it.skipIf` would hide it.
        process.stdout.write(
          "[64-applications-availability-request-show] No availability request in activity list; skipping detail+snapshot tests.\n",
        );
        return;
      }

      const result = await cli.run(["applications", "availability-request", "show", id, "-o", "json"]);
      expect(result.exitCode).toBe(0);

      const detail = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(detail["id"]).toBe(id);
      // Required projection keys — a regression in the trimmed selection
      // would surface as a missing key here. Values may legitimately be
      // null on the wire (sparse AR row); the keys themselves must be
      // present. The #539 additions (talentComment / requestedHourlyRate
      // / rejectReason / recruiter) MUST be keys regardless of lifecycle
      // stage — pre-response ARs carry them as null.
      for (const key of [
        "id",
        "status",
        "kind",
        "fixedRate",
        "comment",
        "talentComment",
        "requestedHourlyRate",
        "rejectReason",
        "recruiter",
        "createdAt",
        "updatedAt",
        "answeredAt",
        "job",
        // #585 — matcher questions key MUST be present regardless of
        // whether the AR's job carries any (empty array otherwise).
        "matcherQuestions",
      ]) {
        expect(key in detail).toBe(true);
      }

      // #585 — matcherQuestions is always an array; each entry (when the
      // AR's job carries matcher questions) MUST carry the universal
      // ApplicationQuestion shape, including the choice metadata
      // (`options` / `suggestedAnswer` / `inputType`) needed to build a
      // valid `matcherAnswers` payload for the accept path. This is the
      // live-wire authority on the INFERRED `options` + `suggestedAnswer`
      // selection embedded under `job.questions` (schema/contract rule).
      const matcherQuestions = detail["matcherQuestions"];
      expect(Array.isArray(matcherQuestions)).toBe(true);
      for (const q of matcherQuestions as Array<Record<string, unknown>>) {
        expect(typeof q["identifier"]).toBe("string");
        expect(typeof q["prompt"]).toBe("string");
        expect(q["type"]).toBe("matcher");
        expect(typeof q["isMandatory"]).toBe("boolean");
        expect(Array.isArray(q["options"])).toBe(true);
        for (const opt of q["options"] as unknown[]) expect(typeof opt).toBe("string");
        expect(q["suggestedAnswer"] === null || typeof q["suggestedAnswer"] === "string").toBe(true);
        // inputType is mechanically derived from options-presence (#584).
        const opts = q["options"] as unknown[];
        expect(q["inputType"]).toBe(opts.length > 0 ? "dropdown" : "free-text");
      }
      process.stdout.write(
        `[64-applications-availability-request-show] AR ${id} carries ${String((matcherQuestions as unknown[]).length)} matcher question(s).\n`,
      );

      // #539 — shape assertions for the INFERRED fields when populated.
      // `requestedHourlyRate` (Money | null): non-null shape is
      // { decimal: string, verbose: string }.
      const reqRate = detail["requestedHourlyRate"];
      if (reqRate !== null) {
        expect(typeof reqRate).toBe("object");
        const r = reqRate as { decimal?: unknown; verbose?: unknown };
        expect(typeof r.decimal).toBe("string");
        expect(typeof r.verbose).toBe("string");
      }
      // `recruiter` (RecruiterRef | null): non-null carries the three
      // name fields (firstName / lastName INFERRED-present; fullName
      // String! in synth SDL). Each is string | null.
      const recruiter = detail["recruiter"];
      if (recruiter !== null) {
        expect(typeof recruiter).toBe("object");
        const rec = recruiter as Record<string, unknown>;
        for (const k of ["firstName", "lastName", "fullName"]) {
          expect(k in rec).toBe(true);
          const v = rec[k];
          expect(v === null || typeof v === "string").toBe(true);
        }
      }
      // `talentComment` / `rejectReason`: string | null (no shape beyond
      // the scalar). Assert the scalar-or-null contract.
      const talentComment = detail["talentComment"];
      expect(talentComment === null || typeof talentComment === "string").toBe(true);
      const rejectReason = detail["rejectReason"];
      expect(rejectReason === null || typeof rejectReason === "string").toBe(true);
    },
  );

  // -------------------------------------------------------------------
  // Wire-shape snapshot assertion (T1 disposition; #442).
  //
  // Track 1 continuous-detection defense for the `AvailabilityRequest`
  // op against post-merge wire drift (a field renamed / removed /
  // retyped, or the metadata / job sub-shapes changing structure).
  // Captured against the projected `AvailabilityRequestDetail` — the
  // surface CLI/MCP consumers depend on. Snapshot lives at
  // `wire-snapshots/AvailabilityRequest.snapshot.json`; the first
  // authenticated run with `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` captures it.
  //
  // Skipped on accounts with no ARs — the snapshot must be captured
  // against real wire data, not a synthetic NOT_FOUND. CI doesn't run
  // E2E; this gate fires locally + is the schema/contract rule's
  // wire-validation track.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("AvailabilityRequest wire shape matches snapshot", async () => {
    const id = await discoverAvailabilityRequestId(cli);
    if (id === null) {
      process.stdout.write(
        "[64-applications-availability-request-show] No availability request in activity list; skipping wire-shape snapshot.\n",
      );
      return;
    }

    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await applications.availabilityRequests.show(token, id);
    expect(() =>
      assertWireShapeStable({
        operationName: "AvailabilityRequest",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });
});
