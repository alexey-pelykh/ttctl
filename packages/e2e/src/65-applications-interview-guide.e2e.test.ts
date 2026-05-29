// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications interview guide show <interviewId>` (#470).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * `InterviewGuide` op is in `GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS`
 * (`codegen.config.ts`); no generated type exists. The wire shape is
 * best-effort INFERRED until this file passes against a live session.
 *
 * **Input is the INTERVIEW id**, not the guide id. The wire op takes
 * `$interviewId: ID!` and traverses `viewer.interview(id).guide.{id,
 * sections[...]}`. Sibling of #440's `notes.show(jobId)` — the
 * `interviews` namespace's sub-sub-namespace pattern (`notes.show` +
 * `guide.show`).
 *
 * Coverage:
 *   - NOT_FOUND for a syntactically-plausible-but-never-issued
 *     interview id (always exercisable regardless of account state).
 *   - Guide projection for a real interview id (discovered via
 *     `applications list` → first row carrying a non-null `interview`
 *     presence indicator). Skipped via an explicit return when the test
 *     account has no interviews in its activity history.
 *   - Wire-shape snapshot assertion (T1 disposition; #470). Snapshot
 *     committed at `wire-snapshots/InterviewGuide.snapshot.json` once
 *     discovery succeeds on the seeded account.
 *
 * Read-only — no side effects.
 *
 * Disposition: **T1** (wire-shape snapshot). `InterviewGuide` is in the
 * codegen-exclusion list, so no T2 Zod schema is generated;
 * `assertWireShapeStable` is the continuous wire-drift defense.
 */

// e2e-covers: InterviewGuide

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
 * Mirrors `62-applications-interview-show.e2e.test.ts` /
 * `63-applications-interview-notes-show.e2e.test.ts` — used by the
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
 * Discover a real interview id from the talent's activity history.
 * Mirrors the discovery path in `62-applications-interview-show.e2e.test.ts`
 * — activity items carry an `interview: { id } | null` presence
 * indicator; the first non-null id yields an interview suitable for the
 * `InterviewGuide` probe.
 *
 * Returns `null` when:
 *   - no row in the activity list has an associated interview (typical
 *     for accounts that haven't reached interview stage), OR
 *   - `applications list` itself fails (e.g. the account-scoped
 *     `JobActivityItems` HTTP 400 issue empirically observed on the
 *     test account — wire payload error that blocks discovery even
 *     when interviews exist server-side, see memory note
 *     `project_e2e_op_account_scoped`).
 *
 * In both cases the detail+snapshot tests skip-return gracefully — the
 * NOT_FOUND probe above is still the live-callable proof of the
 * `InterviewGuide` op; the snapshot is opportunistic (captures when
 * discovery succeeds, defers otherwise).
 */
async function discoverInterviewId(cli: CliClient): Promise<string | null> {
  // Unfiltered list — interviews are not concentrated in any one status
  // group (could appear on ON_CLIENT_REVIEW, ARCHIVED, ACTIVE rows), so
  // the default page is the broadest discovery path.
  const result = await cli.run(["applications", "list", "-o", "json"]);
  if (result.exitCode !== 0) {
    process.stdout.write(
      `[65-applications-interview-guide] discovery via applications list failed (exitCode=${result.exitCode.toString()}); detail+snapshot tests will skip. stdout=${result.stdout || "(empty)"}\n`,
    );
    return null;
  }
  const payload = JSON.parse(result.stdout) as {
    items: Array<{ id?: string; interview?: { id?: string } | null }>;
  };
  for (const item of payload.items) {
    const id = item.interview?.id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

describe("applications interview guide show (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("returns a structured NOT_FOUND error for an unknown interview id", async () => {
    // Use a syntactically plausible but never-issued id. The gateway
    // surfaces one of the NOT_FOUND_MESSAGE_PATTERN-matched errors
    // (`Record not found` / `Invalid ID` / Relay decode error per the
    // `project-toptal-wire-quirks` memory); the service translates that
    // to `ApplicationsError(NOT_FOUND)`; the CLI surfaces `code:
    // "NOT_FOUND"` in the structured error envelope.
    const fakeId = "int_00000000000000000000000000000000";
    const result = await cli.run(["applications", "interview", "guide", "show", fakeId, "-o", "json"]);
    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean;
      errors?: Array<{ code?: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.errors?.[0]?.code).toBe("NOT_FOUND");
  });

  it.skipIf(!e2eEnabled)("returns the guide projection for a real interview id (discovered from `list`)", async () => {
    const id = await discoverInterviewId(cli);
    if (id === null) {
      // Account-scoped skip: no interviews in activity history is a
      // valid state. Surface to stdout so the run log shows WHY this
      // expectation didn't fire — vitest's `it.skipIf` would hide it.
      process.stdout.write(
        "[65-applications-interview-guide] No interview in activity list; skipping projection+snapshot tests.\n",
      );
      return;
    }

    const result = await cli.run(["applications", "interview", "guide", "show", id, "-o", "json"]);
    expect(result.exitCode).toBe(0);

    const projection = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(projection["interviewId"]).toBe(id);
    // Required projection keys — a regression in the trimmed selection
    // would surface as a missing key here. Values may legitimately be
    // null on the wire (interview without an attached guide); the keys
    // themselves must be present.
    for (const key of ["interviewId", "guideId", "sections"]) {
      expect(key in projection).toBe(true);
    }
    expect(Array.isArray(projection["sections"])).toBe(true);

    // When the interview has a guide, validate the section/tip shape.
    const sections = projection["sections"] as unknown[];
    if (sections.length > 0) {
      const section = sections[0] as Record<string, unknown>;
      for (const key of ["identifier", "title", "subtitle", "tips"]) {
        expect(key in section).toBe(true);
      }
      expect(Array.isArray(section["tips"])).toBe(true);
      const tips = section["tips"] as unknown[];
      if (tips.length > 0) {
        const tip = tips[0] as Record<string, unknown>;
        for (const key of ["identifier", "title", "content", "hardcodedContent"]) {
          expect(key in tip).toBe(true);
        }
      }
    }
  });

  // -------------------------------------------------------------------
  // Wire-shape snapshot assertion (T1 disposition; #470).
  //
  // Track 1 continuous-detection defense for the `InterviewGuide` op
  // against post-merge wire drift (a field renamed / removed / retyped,
  // or the section/tip sub-shapes changing structure). Captured against
  // the projected `InterviewGuideProjection` — the surface CLI/MCP
  // consumers depend on. Snapshot lives at
  // `wire-snapshots/InterviewGuide.snapshot.json`; the first
  // authenticated run with `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` captures it.
  //
  // Skipped on accounts with no interviews — the snapshot must be
  // captured against real wire data, not a synthetic NOT_FOUND. CI
  // doesn't run E2E; this gate fires locally + is the schema/contract
  // rule's wire-validation track.
  // -------------------------------------------------------------------
  it.skipIf(!e2eEnabled)("InterviewGuide wire shape matches snapshot", async () => {
    const id = await discoverInterviewId(cli);
    if (id === null) {
      process.stdout.write(
        "[65-applications-interview-guide] No interview in activity list; skipping wire-shape snapshot.\n",
      );
      return;
    }

    const token = loadSandboxBearer(sandboxConfigPath);
    const response = await applications.interviews.guide.show(token, id);
    expect(() =>
      assertWireShapeStable({
        operationName: "InterviewGuide",
        surface: "mobile-gateway",
        transport: "stock",
        response,
      }),
    ).not.toThrow();
  });
});
