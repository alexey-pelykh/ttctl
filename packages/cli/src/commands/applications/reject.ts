// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { applications } from "@ttctl/core";

import { getCliDryRun } from "../../lib/dry-run.js";
import { emitDryRunSuccess, emitUpdateSuccess } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";
import { formatRespondPayload } from "./confirm.js";
import { handleApplicationsError, loadAuthTokenOrExit } from "./shared.js";

/**
 * Options for `ttctl applications reject <id>` (#411). The `--reason`
 * key is required and corresponds to one of the `key` values from
 * {@link applications.rejectReasons}. Pre-validation against the
 * inventory is NOT performed at the CLI; the wire is the authority
 * (unknown keys surface as `GRAPHQL_ERROR`).
 */
export interface ApplicationsRejectOptions {
  reason: string;
  comment?: string;
  output: OutputFormat;
}

/**
 * Action handler for `ttctl applications reject <id>` (#411).
 *
 * Rejects an Interest Request — the wire mutation
 * `RejectAvailabilityRequest` (mobile-gateway). The `<id>` is the
 * **AvailabilityRequest id**, NOT the activity-item id.
 *
 * The `--reason <key>` flag is REQUIRED — pass one of the `key` values
 * surfaced by `ttctl applications reject-reasons`. Some reasons require
 * an accompanying free-text comment (`isMandatory: true` on the
 * inventory row); the wire rejects with a validation error when a
 * mandatory reason is sent without `--comment`.
 *
 * **DESTRUCTIVE** — rejecting an IR transitions the AR to
 * `AVAILABILITY_REQUEST_REJECTED` (terminal, archived). No undo. Prefer
 * `--dry-run` to preview the wire payload first.
 */
export async function runApplicationsReject(id: string, opts: ApplicationsRejectOptions): Promise<void> {
  const token = await loadAuthTokenOrExit("applications reject", opts.output);
  const dryRun = getCliDryRun();

  const input: applications.RejectInput = { reason: opts.reason };
  if (opts.comment !== undefined) input.comment = opts.comment;

  let outcome: applications.RejectOutcome;
  try {
    outcome = await applications.reject(token, id, input, { dryRun });
  } catch (err) {
    handleApplicationsError("applications reject", err, opts.output);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: "applications.reject",
      format: opts.output,
      preview: outcome.preview,
    });
    return;
  }

  const result = outcome.result;
  const summaryParts: string[] = [`status=${result.statusV2.value}`, `reason=${opts.reason}`];
  if (result.answeredAt !== null) summaryParts.push(`answered=${result.answeredAt}`);

  emitUpdateSuccess({
    operation: "applications.reject",
    format: opts.output,
    updated: result,
    prettySummary: `Interest Request ${result.id} (${summaryParts.join(", ")})`,
    prettyEntity: (data) => formatRespondPayload(data),
  });
}
