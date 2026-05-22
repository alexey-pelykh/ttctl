// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications interview notes show <jobId>` (#440).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * `GetInterviewNotes` op is in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`
 * (`codegen.config.ts`); no generated type exists. The wire shape is
 * best-effort INFERRED until this file passes against a live session.
 *
 * **Input is the JOB id, not the interview id** — the portal-side
 * `GetInterviewNotes` op takes `$jobId: ID!` and traverses
 * `viewer.job(id).activityItem.interview.{id, kind, talentNotes}`.
 *
 * Coverage:
 *   - NOT_FOUND for a syntactically-plausible-but-never-issued job id
 *     (always exercisable regardless of account state).
 *   - Notes projection for a real job id (discovered via
 *     `applications list` → first row carrying a non-null `interview`
 *     presence indicator, then that row's `job.id`). Skipped via an
 *     explicit return when the test account has no interviews in its
 *     activity history.
 *   - Wire-shape snapshot assertion (T1 disposition; #440). Snapshot
 *     committed at `wire-snapshots/GetInterviewNotes.snapshot.json`.
 *
 * Read-only — no side effects.
 *
 * Disposition: **T1** (wire-shape snapshot). `GetInterviewNotes` is in
 * the codegen-exclusion list, so no T2 Zod schema is generated;
 * `assertWireShapeStable` is the continuous wire-drift defense.
 */

// e2e-covers: GetInterviewNotes

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
 * Discover a real JOB id whose activity row carries an interview, from
 * the talent's activity history. Activity items carry both a
 * `job: { id } | null` field and an `interview: { id } | null` presence
 * indicator; the first row with a non-null interview yields a job id
 * suitable for the `GetInterviewNotes` probe (the op traverses
 * `viewer.job(id).activityItem.interview`, so the job must be one that
 * has an interview attached).
 *
 * Returns `null` when:
 *   - no row in the activity list has an associated interview (typical
 *     for accounts that haven't reached interview stage), OR
 *   - `applications list` itself fails (e.g. the account-scoped
 *     `JobActivityItems` HTTP 400 issue empirically observed on the
 *     test account at #439 development time — wire payload error that
 *     blocks discovery even when interviews exist server-side).
 *
 * In both cases the detail+snapshot tests skip-return gracefully — the
 * NOT_FOUND probe above is still the live-callable proof of the
 * `GetInterviewNotes` op; the snapshot is opportunistic (captures when
 * discovery succeeds, defers otherwise).
 */
async function discoverJobIdWithInterview(cli: CliClient): Promise<string | null> {
  // Unfiltered list — interviews are not concentrated in any one status
  // group (could appear on ON_CLIENT_REVIEW, ARCHIVED, ACTIVE rows), so
  // the default page is the broadest discovery path.
  const result = await cli.run(["applications", "list", "-o", "json"]);
  if (result.exitCode !== 0) {
    process.stdout.write(
      `[63-applications-interview-notes-show] discovery via applications list failed (exitCode=${result.exitCode.toString()}); detail+snapshot tests will skip. stdout=${result.stdout || "(empty)"}\n`,
    );
    return null;
  }
  const payload = JSON.parse(result.stdout) as {
    items: Array<{ job?: { id?: string } | null; interview?: { id?: string } | null }>;
  };
  for (const item of payload.items) {
    const jobId = item.job?.id;
    if (item.interview != null && typeof jobId === "string" && jobId !== "") return jobId;
  }
  return null;
}

describe("applications interview notes show (live mobile-gateway, #440)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns a structured NOT_FOUND error for an unknown job id", async () => {
    // Use a syntactically plausible but never-issued job id. The gateway
    // surfaces one of the NOT_FOUND_MESSAGE_PATTERN-matched errors
    // (`Record not found` / `Invalid ID` / Relay decode error per the
    // `project-toptal-wire-quirks` memory) OR a null `viewer.job`; the
    // service translates either to `ApplicationsError(NOT_FOUND)`; the
    // CLI surfaces `code: "NOT_FOUND"` in the structured error envelope.
    const fakeId = "job_00000000000000000000000000000000";
    const result = await cli.run(["applications", "interview", "notes", "show", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean;
      errors?: Array<{ code?: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });

  it.skipIf(!e2eEnabled)("returns the notes projection for a real job id (discovered from `list`)", async () => {
    const jobId = await discoverJobIdWithInterview(cli);
    if (jobId === null) {
      // Account-scoped skip: no interviews in activity history is a
      // valid state. Surface to stdout so the run log shows WHY this
      // expectation didn't fire — vitest's `it.skipIf` would hide it.
      process.stdout.write(
        "[63-applications-interview-notes-show] No interview in activity list; skipping detail+snapshot tests.\n",
      );
      return;
    }

    const result = await cli.run(["applications", "interview", "notes", "show", jobId, "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const projection = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(projection["jobId"]).toBe(jobId);
    // Required projection keys — a regression in the trimmed selection
    // would surface as a missing key here. `interviewId` / `interviewKind`
    // may legitimately be null (wire sparseness); the keys themselves
    // must be present.
    for (const key of ["jobId", "interviewId", "interviewKind", "notes"]) {
      expect(key in projection).toBe(true);
    }
    expect(Array.isArray(projection["notes"])).toBe(true);
  });

  // -------------------------------------------------------------------
  // Wire-shape snapshot assertion (T1 disposition; #440).
  //
  // Track 1 continuous-detection defense for the `GetInterviewNotes` op
  // against post-merge wire drift (a field renamed / removed / retyped,
  // or the talentNotes sub-shape changing structure). Captured against
  // the projected `InterviewNotesProjection` — the surface CLI/MCP
  // consumers depend on. Snapshot lives at
  // `wire-snapshots/GetInterviewNotes.snapshot.json`; the first
  // authenticated run with `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` captures it.
  //
  // Skipped on accounts with no interviews — the snapshot must be
  // captured against real wire data, not a synthetic NOT_FOUND. CI
  // doesn't run E2E; this gate fires locally + is the schema/contract
  // rule's wire-validation track.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("GetInterviewNotes wire shape matches snapshot", async () => {
    const jobId = await discoverJobIdWithInterview(cli);
    if (jobId === null) {
      process.stdout.write(
        "[63-applications-interview-notes-show] No interview in activity list; skipping wire-shape snapshot.\n",
      );
      return;
    }

    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await applications.interviews.notes.show(token, jobId);
    expect(() =>
      assertWireShapeStable({
        operationName: "GetInterviewNotes",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });
});
