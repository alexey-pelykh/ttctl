// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import * as p from "@clack/prompts";
import { timesheet } from "@ttctl/core";

import { getCliDryRun } from "../../lib/dry-run.js";
import { emitDryRunSuccess, emitErrorAndExit, emitUpdateSuccess } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleTimesheetError, loadAuthTokenOrExit } from "./shared.js";
import { formatTimesheetDetail } from "./show.js";

/**
 * Action handler for `ttctl timesheet submit [id]`.
 *
 * Per #13 spec, submit is destructive (one-way on the wire). The
 * action is gated behind one of:
 *
 *   - `--confirm` flag (script-safe, no prompt)
 *   - Interactive TTY confirm via `@clack/prompts` (non-TTY without
 *     `--confirm` refuses with a clear error envelope)
 *
 * `<id>` is a positional BillingCycle.id. When omitted, the runner
 * calls {@link timesheet.resolveCurrentCycle} to auto-resolve the
 * single cycle whose submission window contains "now". Optional
 * `--engagement <id>` scopes the resolve to one engagement (uses the
 * `JobActivityItem.id` from `engagements list`).
 *
 * Auto-resolve outcomes:
 *
 *   - `kind: "found"`     → proceed to confirm + submit
 *   - `kind: "none"`      → error envelope with code `NO_CURRENT_CYCLE`
 *   - `kind: "multiple"`  → error envelope with code
 *                            `MULTIPLE_CURRENT_CYCLES` listing candidate
 *                            ids in `errors[0].hint` so scripts can
 *                            disambiguate.
 *
 * Success returns the write-success envelope per #128:
 * `{ok: true, version: "1.0", operation: "timesheet.submit", updated: <detail>}`.
 *
 * Dry-run path: when `getCliDryRun()` is true (the CLI-global
 * `--dry-run` flag was passed), the destructive mutation is replaced
 * by a {@link DryRunPreview}. The confirm gate AND the auto-resolve
 * read are BOTH skipped — auto-resolve uses the placeholder string
 * `<auto-resolved-at-apply-time>` for the id, surfaced via the
 * envelope `notice` so machine consumers don't mistake it for a real
 * cycle id. See {@link DRY_RUN_PLACEHOLDER_NOTICE}.
 */
export interface TimesheetSubmitOptions {
  confirm: boolean;
  engagement?: string;
  output: OutputFormat;
}

/**
 * Notice surfaced on the dry-run envelope when the caller omitted the
 * positional `<id>` AND the apply path would have auto-resolved the
 * current cycle. The preview's `variables.id` carries the placeholder
 * string `<auto-resolved-at-apply-time>`; the real BillingCycle.id is
 * resolved at apply time via `PendingTimesheets` (skipped on dry-run).
 */
const DRY_RUN_PLACEHOLDER_NOTICE =
  "id in the preview is the placeholder string `<auto-resolved-at-apply-time>`; the apply path resolves the real BillingCycle.id via a PendingTimesheets query before issuing the mutation — this read is skipped on dry-run.";

/**
 * Internal seam: `runTimesheetSubmit` decides whether to prompt based
 * on a deterministic predicate. Exported via `isStdinTty` so tests can
 * stub it cleanly without poking `process.stdin.isTTY`.
 */
export function isStdinTty(): boolean {
  return (process.stdin.isTTY as unknown) === true;
}

export async function runTimesheetSubmit(id: string | undefined, opts: TimesheetSubmitOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("timesheet submit", opts.output);
  const dryRun = getCliDryRun();

  // Step 1: resolve the cycle id (explicit positional OR auto-resolve).
  // Dry-run path: skip the auto-resolve read entirely and stamp the
  // placeholder. The destructive mutation is never sent.
  let cycleId: string;
  let usedPlaceholder = false;
  if (id !== undefined) {
    cycleId = id;
  } else if (dryRun) {
    cycleId = "<auto-resolved-at-apply-time>";
    usedPlaceholder = true;
  } else {
    const resolveOpts: timesheet.ResolveCurrentCycleOptions = {};
    if (opts.engagement !== undefined) resolveOpts.engagement = opts.engagement;
    let resolution: timesheet.CurrentCycleResolution;
    try {
      resolution = await timesheet.resolveCurrentCycle(token, resolveOpts);
    } catch (err) {
      handleTimesheetError("timesheet submit", err, opts.output);
    }
    if (resolution.kind === "none") {
      emitErrorAndExit({
        operation: "timesheet.submit",
        format: opts.output,
        errors: [
          {
            code: "NO_CURRENT_CYCLE",
            message:
              "No billing cycle is currently in its submission window. Either nothing is due, or every pending cycle is too early / past deadline.",
            hint: "Run `ttctl timesheet list` to see what's pending, or specify a cycle id explicitly.",
          },
        ],
        prettySummary: "timesheet submit failed (NO_CURRENT_CYCLE): no current pending timesheet.",
      });
    }
    if (resolution.kind === "multiple") {
      const candidateLines = resolution.candidates.map((c) => {
        const client = c.engagement.job.client?.fullName ?? "(no client)";
        const title = c.engagement.job.title ?? "(untitled)";
        return `  - ${c.id} (${client} — ${title}, ${c.startDate} → ${c.endDate})`;
      });
      emitErrorAndExit({
        operation: "timesheet.submit",
        format: opts.output,
        errors: [
          {
            code: "MULTIPLE_CURRENT_CYCLES",
            message: `${resolution.candidates.length.toString()} billing cycles match the current submission window — specify one explicitly.`,
            hint: `Candidates:\n${candidateLines.join("\n")}`,
          },
        ],
        prettySummary: `timesheet submit failed (MULTIPLE_CURRENT_CYCLES): ${resolution.candidates.length.toString()} candidates.`,
      });
    }
    cycleId = resolution.cycle.id;
  }

  // Step 2: --confirm OR interactive TTY confirm gate.
  // Dry-run path: skip the confirm gate entirely — there's nothing
  // destructive to confirm. The preview is emitted regardless of
  // --confirm / stdin TTY-ness.
  if (!dryRun && !opts.confirm) {
    if (!isStdinTty()) {
      emitErrorAndExit({
        operation: "timesheet.submit",
        format: opts.output,
        errors: [
          {
            code: "CONFIRMATION_REQUIRED",
            message:
              "timesheet submit is destructive (one-way) and requires explicit confirmation. Pass --confirm or run in an interactive terminal.",
            hint: "Add `--confirm` to the command, or run `ttctl timesheet submit` from a TTY.",
          },
        ],
        prettySummary: "timesheet submit refused: --confirm flag required (non-TTY stdin).",
      });
    }
    const proceed = await p.confirm({
      message: `Submit timesheet ${cycleId}? This is one-way and cannot be undone.`,
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      emitErrorAndExit({
        operation: "timesheet.submit",
        format: opts.output,
        errors: [
          {
            code: "CONFIRMATION_DECLINED",
            message: "Submission cancelled by user.",
          },
        ],
        prettySummary: "timesheet submit cancelled by user.",
        exitCode: 1,
      });
    }
  }

  // Step 3: perform the submission (or build the dry-run preview).
  let outcome: timesheet.SubmitOutcome;
  try {
    outcome = await timesheet.submit(token, cycleId, { dryRun });
  } catch (err) {
    handleTimesheetError("timesheet submit", err, opts.output);
  }

  // Step 4: branch on outcome — dry-run preview OR apply-path envelope.
  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "timesheet.submit",
      format: opts.output,
      preview: outcome.preview,
      ...(usedPlaceholder ? { notice: DRY_RUN_PLACEHOLDER_NOTICE } : {}),
    });
    return;
  }

  const { result: updated } = outcome;
  emitUpdateSuccess({
    operation: "timesheet.submit",
    format: opts.output,
    updated,
    prettySummary: `timesheet ${updated.id} submitted (${updated.startDate} → ${updated.endDate}, ${updated.hours}h)`,
    prettyEntity: (entity) => formatTimesheetDetail(entity),
  });
}
