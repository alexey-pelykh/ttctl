// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl applications interview notes update <interviewId>`
 * (#441) — the `UpdateInterviewTalentNotes` gateway-portal mutation.
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * input shape `{ talentNotes: [{ section, note }] }` is INFERRED from the
 * `GetInterviewNotes` response echo (section = guide-section identifier).
 * No generated type exists (the op is gateway-portal, codegen-excluded).
 * The wire format is best-effort until this file passes against a live
 * session; merge is gated on a passing local `TTCTL_E2E=1` run.
 *
 * **DESTRUCTIVE full-replace** — the supplied note set REPLACES the
 * interview's entire note set. The round-trip test below appends a
 * clearly-marked sentinel to the talent's existing notes, asserts the
 * mutation persisted (the response echo carries the sentinel), then
 * RESTORES the original notes in a `finally` so the account is left as
 * found. The round-trip only runs when a discovered interview already
 * carries ≥1 note (so the restore set is never empty — the wire's
 * handling of an empty `talentNotes` array is itself unverified).
 *
 * **Input is the INTERVIEW id**, not the job id — discovered here via
 * `applications list` → `interview notes show <jobId>` → `interviewId`.
 *
 * Disposition: **T1** (wire-shape snapshot). `UpdateInterviewTalentNotes`
 * is codegen-excluded, so no T2 Zod schema is generated; the snapshot at
 * `wire-snapshots/UpdateInterviewTalentNotes.snapshot.json` is the
 * continuous wire-drift defense. The first authenticated run with
 * `TTCTL_UPDATE_WIRE_SNAPSHOTS=1` captures it.
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
 * Find an interview carrying ≥1 prep note: scan `applications list` for a
 * row with an interview, then `interview notes show <jobId>` for its
 * interview id + current notes. `null` when none exists or discovery fails.
 */
async function discoverInterviewWithNotes(
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
    if (
      typeof proj.interviewId === "string" &&
      proj.interviewId !== "" &&
      Array.isArray(proj.notes) &&
      proj.notes.length >= 1
    ) {
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

  // Destructive round-trip + wire snapshot. Appends a sentinel, asserts
  // the live response echoes it (persisted), captures the T1 snapshot of
  // the mutation response, then restores the original notes. Skips when
  // the account has no interview carrying ≥1 note.
  it.skipIf(!e2eEnabled)(
    "round-trips UpdateInterviewTalentNotes (append sentinel, verify echo, restore) + wire snapshot",
    async () => {
      const discovered = await discoverInterviewWithNotes(cli);
      if (discovered === null) {
        process.stdout.write(
          "[88-applications-interview-notes-update] No interview with ≥1 note on this account; skipping round-trip + snapshot.\n",
        );
        return;
      }
      const { interviewId, original } = discovered;
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
        // Restore the original note set so the account is left as found.
        // Best-effort — a restore failure must not mask the round-trip
        // result, but it MUST be loud so the operator can clean up.
        try {
          await applications.interviews.notes.update(token, interviewId, {
            notes: original,
            interviewActionConsentIssued: true,
          });
        } catch (restoreErr) {
          process.stdout.write(
            `[88-applications-interview-notes-update] WARNING: failed to restore original notes for interview ${interviewId}: ${String(restoreErr)}. The sentinel note may remain — remove it manually.\n`,
          );
        }
      }
    },
  );
});
