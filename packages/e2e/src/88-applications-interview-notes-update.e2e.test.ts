// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications interview notes update <interviewId>`
 * (#441) — the `UpdateInterviewTalentNotes` (`interview.changeTalentNotes`)
 * gateway-portal mutation.
 *
 * STATUS: write side PAUSED pending active-interview reverse-engineering.
 * Live runs against a real (passed) interview disproved the inferred model:
 *
 *   - The mutation APPENDS — it does not replace. `notes: []` is a no-op.
 *   - The `section` input is NOT honored as a guide-section selector: a
 *     guide-section note (the 6-member enum) is created once when its section
 *     is empty; subsequent writes redirect into a freeform `RICH_TEXT_NOTES`
 *     bucket, HTML-wrapped (`<p>…</p>`). Only `RICH_TEXT_NOTES` is upsert-able.
 *   - There is NO delete mutation, and a guide-section note, once created,
 *     could not be removed via the API or the Toptal UI — it is permanent.
 *
 * HAZARD: every write creates unremovable state on a real account. The
 * destructive round-trip below is `it.skip` and MUST stay skipped until the
 * write is rebuilt against an ACTIVE interview from captured web traffic.
 * Only the consent-gate probe (which makes no wire call) is safe to run.
 *
 * The shape that IS verified: input `{ notes: [{ section, note }] }` (the
 * `{ talentNotes: [...] }` guess 400'd). Disposition T1; the snapshot at
 * `wire-snapshots/UpdateInterviewTalentNotes.snapshot.json` records the
 * captured response shape. Input is the INTERVIEW id, not the job id.
 */

// e2e-covers: UpdateInterviewTalentNotes

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, applications } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

const CONSENT_ENV_VAR = "TTCTL_ALLOW_INFERRED_DESTRUCTIVE";

/** Sentinel appended during the round-trip; removed by the restore step. */
const SENTINEL_NOTE = "[ttctl e2e #441] sentinel note — safe to delete";

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
 * Echo note (nullable `section`/`note`) → write-input shape: keep a known
 * guide-section else drop to unsectioned; coerce a null body to "".
 */
function toInputNote(n: applications.InterviewTalentNote): applications.InterviewTalentNoteInput {
  const isKnownSection = (applications.INTERVIEW_NOTE_SECTIONS as readonly string[]).includes(n.section ?? "");
  return isKnownSection
    ? { section: n.section as applications.InterviewNoteSection, note: n.note ?? "" }
    : { note: n.note ?? "" };
}

/**
 * Find an interview to round-trip: scan `applications list` for a row with
 * an interview, then `interview notes show <jobId>` for its interview id +
 * current notes (which MAY be empty — the round-trip then writes just the
 * sentinel and restores to empty). `null` when no interview exists or
 * discovery fails.
 */
async function discoverInterview(
  cli: CliClient,
): Promise<{ interviewId: string; original: applications.InterviewTalentNoteInput[] } | null> {
  const listed = await cli.run(["applications", "list", "-o", "json"]);
  if (listed.exitCode !== 0) {
    process.stdout.write(
      `[88-applications-interview-notes-update] discovery via applications list failed (exitCode=${listed.exitCode.toString()}); round-trip will skip.\n`,
    );
    return null;
  }
  const payload = JSON.parse(listed.stdout) as {
    items: Array<{ job?: { id?: string } | null; interview?: { id?: string } | null }>;
  };
  for (const item of payload.items) {
    const jobId = item.job?.id;
    if (item.interview == null || typeof jobId !== "string" || jobId === "") continue;
    const shown = await cli.run(["applications", "interview", "notes", "show", jobId, "-o", "json"]);
    if (shown.exitCode !== 0) continue;
    const proj = JSON.parse(shown.stdout) as {
      interviewId?: string | null;
      notes?: applications.InterviewTalentNote[];
    };
    if (typeof proj.interviewId === "string" && proj.interviewId !== "" && Array.isArray(proj.notes)) {
      return { interviewId: proj.interviewId, original: proj.notes.map(toInputNote) };
    }
  }
  return null;
}

describe("applications interview notes update (live mobile-gateway)", () => {
  let cli: CliClient;
  let sandboxConfigPath: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const session = getSharedSession();
    sandboxConfigPath = session.sandboxConfigPath;
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  // Always-runnable proof of the consent ceremony — the gate fires before
  // any wire call, so it needs no discovered interview and mutates nothing.
  // Robust against `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` (which an E2E wave
  // may export to satisfy OTHER destructive ops): the gate reads the env
  // var live, so it is cleared for the span of this assertion only.
  it.skipIf(!e2eEnabled)("refuses the mutation without consent (gate fires before any wire call)", async () => {
    const token = loadSandboxBearer(sandboxConfigPath);
    // Empty (not "1") forces the gate enforced regardless of an ambient
    // bypass an E2E wave may have exported for OTHER destructive ops.
    vi.stubEnv(CONSENT_ENV_VAR, "");
    try {
      await expect(
        applications.interviews.notes.update(token, "int_consent_probe", { notes: [{ note: "x" }] }),
      ).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // HAZARD — permanently `it.skip`. Live runs proved this mutation APPENDS
  // and that guide-section notes are UNREMOVABLE (API + UI) once created, so
  // the "restore the original set" cleanup below CANNOT work: a run leaves
  // permanent debris on the interview. Kept (skipped) as the resume blueprint
  // for when the write is rebuilt against an ACTIVE interview from captured
  // web traffic (#441). Do NOT convert back to `skipIf(!e2eEnabled)`.
  it.skip("round-trips UpdateInterviewTalentNotes (append sentinel, verify echo, restore) + wire snapshot", async () => {
    const discovered = await discoverInterview(cli);
    if (discovered === null) {
      process.stdout.write(
        "[88-applications-interview-notes-update] No interview on this account; skipping round-trip + snapshot.\n",
      );
      return;
    }
    const { interviewId, original } = discovered;
    process.stdout.write(
      `[88-applications-interview-notes-update] interview ${interviewId} has ${original.length.toString()} existing note(s); appending sentinel to capture wire.\n`,
    );
    const token = loadSandboxBearer(sandboxConfigPath);
    const writeSet: applications.InterviewTalentNoteInput[] = [
      ...original,
      { section: "STRENGTHS", note: SENTINEL_NOTE },
    ];

    try {
      const outcome = await applications.interviews.notes.update(token, interviewId, {
        notes: writeSet,
        interviewActionConsentIssued: true,
      });
      expect(outcome.kind).toBe("applied");
      if (outcome.kind !== "applied") return;
      const applied = outcome.result;

      // Persisted check: the live echo carries the sentinel body.
      expect(applied.interviewId).toBe(interviewId);
      expect(applied.notes.some((n) => n.note === SENTINEL_NOTE)).toBe(true);

      // T1 wire-shape snapshot of the mutation response (the consumer
      // shape). Captured on the first `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` run.
      expect(() =>
        assertWireShapeStable({
          operationName: "UpdateInterviewTalentNotes",
          surface: "mobile-gateway",
          transport: "stock",
          response: applied,
        }),
      ).not.toThrow();
    } finally {
      // Resume-blueprint cleanup (DEAD on a real account — see the file
      // header HAZARD: this restore CANNOT work, since the mutation appends
      // and guide-section notes are unremovable). Retained to document the
      // intended round-trip for when the write is rebuilt against an active
      // interview. LOUD on failure so a stray sentinel never goes unnoticed.
      try {
        const restored = await applications.interviews.notes.update(token, interviewId, {
          notes: original,
          interviewActionConsentIssued: true,
        });
        const sentinelRemains =
          restored.kind === "applied" && restored.result.notes.some((n) => n.note === SENTINEL_NOTE);
        process.stdout.write(
          sentinelRemains
            ? `[88-applications-interview-notes-update] WARNING: restore left the sentinel on interview ${interviewId} — remove it manually.\n`
            : `[88-applications-interview-notes-update] restored interview ${interviewId} to ${original.length.toString()} note(s); sentinel cleared.\n`,
        );
      } catch (restoreErr) {
        process.stdout.write(
          `[88-applications-interview-notes-update] WARNING: failed to restore original notes for interview ${interviewId}: ${String(restoreErr)}. The sentinel note may remain — remove it manually.\n`,
        );
      }
    }
  });
});
