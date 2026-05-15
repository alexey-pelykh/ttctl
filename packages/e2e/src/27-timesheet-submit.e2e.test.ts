// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl timesheet submit` (#13).
 *
 * Mandatory per the project's schema/contract validation rule. The
 * `SubmitTimesheet($id)` mutation is hand-authored and not in
 * `codegen.config.ts`; live-API verification is the only authority
 * on whether the wire contract is intact.
 *
 * **Safety**: this file does NOT actually submit any real timesheet.
 * Submission is one-way at the wire level — once submitted, the
 * timesheet enters Toptal's billing pipeline. Real-submission
 * verification per AC #3 ("verified manually against a real session")
 * is a MANUAL step the PR author runs against their own account and
 * pastes a transcript into the PR body.
 *
 * Automated coverage here exercises the wire contract via the ERROR
 * paths, which prove the request actually reaches the gateway and
 * the response shape is intact without ever sending a real submission:
 *
 *   - `--confirm` with a non-existent BillingCycle id → NOT_FOUND
 *     error envelope. Proves the mutation document parses, the bearer
 *     authenticates, and the server's "Record not found" surface is
 *     mapped correctly into our envelope. The wire mutation IS sent,
 *     but it can't submit a non-existent cycle.
 *   - non-TTY stdin without `--confirm` → CONFIRMATION_REQUIRED
 *     refusal BEFORE any wire call (defense-in-depth).
 *   - Auto-resolve dry probe (no id, `--confirm`): the resolver runs
 *     `PendingTimesheets` and falls through to NO_CURRENT_CYCLE or
 *     MULTIPLE_CURRENT_CYCLES depending on the test account's state.
 *     We assert ONLY that the exit code is 1 and the error envelope
 *     carries one of those two codes — to avoid clobbering the real
 *     account.
 *
 * **Skip conditions** (silent — emit stderr warning, do not fail):
 *   - Test account has exactly one current pending cycle → the
 *     auto-resolve dry probe would refuse to run because submit would
 *     succeed. We refuse to invoke submit without an id in that case.
 *
 * **Wire-shape snapshot** (WS-3 / #285): the committed snapshot at
 * `wire-snapshots/SubmitTimesheet.snapshot.json` is a STATIC reference
 * — derived from the 2026-05-14 manual real-submit transcript at
 * `.tmp/timesheet-submit-e2e-20260514/03-submit.json`. No live assertion
 * runs in this file because no automated successful submission path
 * exists (refusing to clobber the real account). When a future
 * end-to-end real-submit is performed, the snapshot may be refreshed
 * by running `captureWireShape` on the SubmitOutcome.applied value and
 * committing the result.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("timesheet submit (live mobile-gateway)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "--confirm with non-existent BillingCycle id → GRAPHQL_ERROR envelope (mutation wire-contract intact)",
    async () => {
      // Empirically (E2E 2026-05-12), Toptal's `SubmitTimesheet` returns
      // `"500: Internal Server Error"` for syntactically valid but
      // non-existent BillingCycle ids — the gateway does not pre-validate
      // the id, so the 500 surfaces as a top-level GraphQL error. The
      // CLI presents this as `GRAPHQL_ERROR` (NOT `NOT_FOUND`) to avoid
      // misleading the caller into thinking the id was definitively absent
      // vs. the server genuinely failed. The wire contract is:
      //   1. SubmitTimesheet mutation IS issued (no client-side validation
      //      bypass — schema/contract rule trigger satisfied)
      //   2. The error envelope is well-formed and exit code is non-zero
      //   3. The message carries the verbatim 500 text so operators can
      //      grep for incidents.
      // If Toptal ever returns the Relay-style decode error instead, the
      // service's NOT_FOUND remap will pick it up and this assertion needs
      // to switch to NOT_FOUND.
      const result = await cli.run([
        "timesheet",
        "submit",
        "VjEtTm9uZXhpc3RlbnRDeWNsZUlkLTA",
        "--confirm",
        "-o",
        "json",
      ]);
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        errors: Array<{ code: string; message?: string }>;
      };
      expect(payload.ok).toBe(false);
      // Accept either NOT_FOUND (the Relay decode-failure remap) OR
      // GRAPHQL_ERROR (the empirically observed 500-on-bad-id case).
      // Both are valid wire-contract surfaces; documenting the union is
      // the honest spec.
      expect(["NOT_FOUND", "GRAPHQL_ERROR"]).toContain(payload.errors[0]?.code);
    },
  );

  it.skipIf(!e2eEnabled)("non-TTY stdin without --confirm → CONFIRMATION_REQUIRED refusal (no wire call)", async () => {
    // The CLI harness spawns the subprocess with piped stdin (non-TTY by
    // default); no need to override.
    const result = await cli.run(["timesheet", "submit", "VjEtQW55Q3ljbGUtMA", "-o", "json"]);
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as { ok: boolean; errors: Array<{ code: string }> };
    expect(payload.ok).toBe(false);
    expect(payload.errors[0]?.code).toBe("CONFIRMATION_REQUIRED");
  });

  it.skipIf(!e2eEnabled)(
    "no id + --confirm: auto-resolve outcome is one of NO_CURRENT_CYCLE / MULTIPLE_CURRENT_CYCLES (refuses to submit real cycle)",
    async () => {
      // First check if exactly-one pending cycle is in its submission
      // window. If yes, we would submit a real timesheet — refuse.
      const pendingResult = await cli.run(["timesheet", "list", "-o", "json"]);
      expect(pendingResult.exitCode).toBe(0);
      const pending = JSON.parse(pendingResult.stdout) as {
        items: Array<{
          timesheetSubmissionOpenDatetime: string | null;
          timesheetSubmissionDeadlineDatetime: string | null;
          timesheetSubmitted: boolean;
        }>;
      };
      const now = Date.now();
      const inWindow = pending.items.filter((c) => {
        if (c.timesheetSubmitted) return false;
        if (c.timesheetSubmissionOpenDatetime === null) return false;
        if (c.timesheetSubmissionDeadlineDatetime === null) return false;
        const open = Date.parse(c.timesheetSubmissionOpenDatetime);
        const deadline = Date.parse(c.timesheetSubmissionDeadlineDatetime);
        return now >= open && now <= deadline;
      });
      if (inWindow.length === 1) {
        process.stderr.write(
          "warning: test account has exactly one current pending cycle — refusing to run auto-resolve probe to avoid real submission.\n",
        );
        return;
      }
      // 0 or >=2 — auto-resolve will refuse with NO_CURRENT_CYCLE or
      // MULTIPLE_CURRENT_CYCLES respectively. Either is a successful
      // wire-contract verification.
      const result = await cli.run(["timesheet", "submit", "--confirm", "-o", "json"]);
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { ok: boolean; errors: Array<{ code: string }> };
      expect(payload.ok).toBe(false);
      expect(["NO_CURRENT_CYCLE", "MULTIPLE_CURRENT_CYCLES"]).toContain(payload.errors[0]?.code);
    },
  );
});
