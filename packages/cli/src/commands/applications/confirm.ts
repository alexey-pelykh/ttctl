// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications } from "@ttctl/core";

import { getCliDryRun } from "../../lib/dry-run.js";
import { emitDryRunSuccess, emitUpdateSuccess } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";
import { handleApplicationsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Options for `ttctl applications confirm <id>` (#411). Mirrors the
 * service-layer {@link applications.ConfirmInput} shape with CLI-side
 * argument validation.
 */
export interface ApplicationsConfirmOptions {
  message?: string;
  rate?: string;
  kind?: applications.AvailabilityRequestKind;
  output: OutputFormat;
}

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Action handler for `ttctl applications confirm <id>` (#411).
 *
 * Confirms an Interest Request — the wire mutation
 * `ConfirmAvailabilityRequest` (mobile-gateway). The `<id>` is the
 * **AvailabilityRequest id**, NOT the activity-item id; discover it via
 * `ttctl applications show <activityId>` (look for the "Availability
 * request: <id>" line) or read it from the activity row directly.
 *
 * When `--rate` and `--kind` are both omitted, the service issues a
 * `GetAvailabilityRequestKind($id)` pre-fetch and auto-fills both:
 *
 *   - `kind` from the AR's `metadata.__typename`
 *   - `rate` from `metadata.offeredHourlyRate` (Fixed-kind only)
 *
 * Flexible-kind ARs have no recruiter-pinned rate, so callers MUST
 * pass `--rate <decimal>` when the AR is FLEXIBLE / MARKETPLACE_FLEXIBLE.
 *
 * **DESTRUCTIVE** — confirming an IR transitions the AR to
 * `AVAILABILITY_REQUEST_CONFIRMED` and creates a `JobApplication`. No
 * withdraw operation is available on the wire. Prefer `--dry-run` to
 * preview the wire payload first.
 */
export async function runApplicationsConfirm(id: string, opts: ApplicationsConfirmOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("applications confirm", opts.output);
  const dryRun = getCliDryRun();

  const input: applications.ConfirmInput = {};
  if (opts.message !== undefined) input.comment = opts.message;
  if (opts.rate !== undefined) {
    if (!DECIMAL_PATTERN.test(opts.rate)) {
      handleApplicationsError(
        "applications confirm",
        new applications.ApplicationsError(
          "MUTATION_ERROR",
          `--rate must be a non-negative decimal (got "${opts.rate}").`,
        ),
        opts.output,
      );
    }
    input.requestedHourlyRate = opts.rate;
  }
  if (opts.kind !== undefined) input.kind = opts.kind;

  let outcome: applications.ConfirmOutcome;
  try {
    outcome = await applications.confirm(token, id, input, { dryRun });
  } catch (err) {
    handleApplicationsError("applications confirm", err, opts.output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "applications.confirm",
      format: opts.output,
      preview: outcome.preview,
    });
    return;
  }

  const result = outcome.result;
  const summaryParts: string[] = [`status=${result.statusV2.value}`];
  if (result.requestedHourlyRate !== null) summaryParts.push(`rate=${result.requestedHourlyRate.decimal}`);
  if (result.answeredAt !== null) summaryParts.push(`answered=${result.answeredAt}`);

  emitUpdateSuccess({
    operation: "applications.confirm",
    format: opts.output,
    updated: result,
    prettySummary: `Interest Request ${result.id} (${summaryParts.join(", ")})`,
    prettyEntity: (data) => formatRespondPayload(data),
  });
}

/**
 * Render the post-confirm/reject AR projection as the indented entity
 * preview inside the success-update envelope's pretty block. Shared
 * with `applications reject`. Pure — directly unit-testable.
 */
export function formatRespondPayload(result: applications.AvailabilityRequestRespondPayload): string {
  const lines: string[] = [];
  lines.push(`Status: ${result.statusV2.verbose} (${result.statusV2.value})`);
  if (result.answeredAt !== null) lines.push(`Answered: ${result.answeredAt}`);
  if (result.requestedHourlyRate !== null) {
    lines.push(`Rate: ${result.requestedHourlyRate.verbose} (${result.requestedHourlyRate.decimal})`);
  }
  if (result.talentComment !== null && result.talentComment !== "") {
    lines.push(`Comment: ${result.talentComment}`);
  }
  if (result.rejectReason !== null && result.rejectReason !== "") {
    lines.push(`Reject reason: ${result.rejectReason}`);
  }
  return lines.join("\n");
}
