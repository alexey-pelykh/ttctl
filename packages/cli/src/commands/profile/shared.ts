// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../errors.js";
import { resolveConfigForCli } from "../../lib/config-context.js";
import { emitErrorAndExit } from "../../lib/envelopes.js";
import type { EnvelopeError } from "../../lib/envelopes.js";
import type { OutputFormat } from "../../lib/output.js";

/**
 * Translate the user-visible command label (`profile skills add`) into
 * the canonical envelope `operation` value (`profile.skills.add`) used
 * as a stable machine-readable discriminator across all envelopes for
 * the affected verb.
 */
function operationFor(commandLabel: string): string {
  return commandLabel.replace(/ /g, ".");
}

/**
 * Load the persisted auth token from the user's `.ttctl.yaml` (in-memory
 * read of `config.auth.token` after `resolveConfigForCli`). Exits with a
 * uniform `UNAUTHENTICATED` stderr message when no token is present —
 * Form A / B configs that haven't been signed-in yet, or post-signout
 * Form A / Form C configs where the token field was removed.
 *
 * Single-arg signature post-#107 — the prior dual-arg form
 * (`loadAuthTokenOrExit(label, tokenPath)`) is gone because the token
 * no longer lives in a separate file. Callers that need the in-memory
 * config object alongside the token can use `resolveConfigForCli()` directly.
 *
 * `commandLabel` is the user-visible prefix used in the error line (e.g.
 * `"profile education add"`); pick the leaf-verb pair that triggered the
 * call so the user maps the error back to their command.
 *
 * Async signature is preserved (returns `Promise<string>`) for source-
 * compatibility with the pre-#107 callers — every leaf already `await`s
 * this function, and downgrading to sync would mean ~50 callers also
 * change shape. The actual work is synchronous after `loadAuthToken` was
 * removed alongside the separate token file.
 */
export async function loadAuthTokenOrExit(commandLabel: string, format: OutputFormat = "pretty"): Promise<string> {
  let config: ReturnType<typeof resolveConfigForCli>["config"];
  try {
    ({ config } = resolveConfigForCli());
  } catch (err) {
    if (err instanceof ConfigError) {
      emitErrorAndExit({
        operation: operationFor(commandLabel),
        format,
        errors: [{ code: err.code, message: err.message }],
        prettySummary: `${commandLabel} failed (${err.code}): ${err.message}`,
      });
    }
    throw err;
  }
  const token = config.auth.token;
  if (token === undefined) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [
        {
          code: "UNAUTHENTICATED",
          message: "No auth token found in config. Run `ttctl auth signin` to sign in.",
          hint: "ttctl auth signin",
        },
      ],
      prettySummary: `${commandLabel} failed (UNAUTHENTICATED): No auth token found in config. Run \`ttctl auth signin\` to sign in.`,
    });
  }
  return Promise.resolve(token);
}

/**
 * Render a domain error from any of the four sub-domain services
 * (education, certifications, employment, industries). All four reuse
 * `profile.basic.ProfileError` for domain errors and pass `TtctlError`
 * subclasses through verbatim — the rendering is therefore identical
 * across sub-domains.
 *
 * Post-#128 the function routes through the envelope ABI: `json`/`yaml`
 * land on STDOUT; `pretty` lands on STDERR with a one-line summary plus
 * the multi-line block. `TtctlError` subclasses keep their dedicated
 * 3-block pretty rendering (Recovery, Code) on `pretty` for backward
 * UX continuity with #77; on `json`/`yaml` they flow through the
 * envelope so machine consumers see the stable wire shape.
 *
 * `commandLabel` is the user-facing leaf-verb pair (e.g.
 * `"profile education add"`). Returns `never` (always exits).
 */
export function presentSubDomainError(commandLabel: string, err: unknown, format: OutputFormat = "pretty"): never {
  if (err instanceof TtctlError) {
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.basic.ProfileError) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${commandLabel} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: operationFor(commandLabel),
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${commandLabel} failed: ${message}`,
  });
}

/**
 * Parse the `--limit` flag for autocomplete-style sub-commands. Rejects
 * non-integers and values outside `1..50` via the envelope ABI (#128).
 *
 * `commandLabel` is the user-facing leaf-verb pair (e.g.
 * `"profile industries autocomplete"`). Returns the parsed integer.
 */
export function parseLimitOrExit(raw: string, commandLabel: string, format: OutputFormat = "pretty"): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [
        {
          code: "VALIDATION_ERROR",
          field: "limit",
          message: `--limit must be an integer between 1 and 50; got "${raw}"`,
        },
      ],
      prettySummary: `${commandLabel} failed (VALIDATION_ERROR): --limit must be an integer between 1 and 50; got "${raw}"`,
    });
  }
  return n;
}
