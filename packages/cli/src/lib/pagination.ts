// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";

/**
 * Process-scoped holder for the global `--page` / `--per-page` flags
 * (issue #138).
 *
 * Captured once by the root program's `preAction` hook (see
 * `program.ts`) before any sub-command's action handler runs; read by
 * list-bearing action handlers that thread the values through the
 * service-layer `list()` methods, which translate to per-operation
 * GraphQL pagination input variables (per-op shape may differ — Toptal
 * uses page-based `eligibleJobs(page, pageSize)`, offset wrapped
 * `gigs(pagination: {limit, offset})`, and cursor `payments(pagination:
 * {limit, after})` across surfaces; the CLI surface is uniformly
 * offset-style per spec).
 *
 * Mirrors the pattern established by `cliDryRun` in `lib/dry-run.ts`
 * and `cliConfigPath` in `lib/config-context.ts`: a module-scoped
 * holder keeps each handler's signature focused on its domain (no
 * `cmd: Command` parameter threading) while exposing a single place to
 * test the captured value.
 *
 * Tests must call `resetCliPagination()` in `beforeEach` to avoid
 * bleeding state across cases.
 */
let cliPagination: PaginationOptions = {};

/**
 * Captured pagination flags. Both fields are independent — one may be
 * passed without the other (the server fills the missing one with its
 * default). The user-facing values are 1-indexed; service-layer
 * translation to wire-indexing (e.g., 0-indexed `eligibleJobs.page`)
 * happens inside the per-service `list()` adapter, not here.
 *
 * `exactOptionalPropertyTypes` is enabled, so absent fields are
 * literally missing rather than `undefined` — callers that check
 * `opts.page === undefined` and callers that check `"page" in opts`
 * both see consistent behavior.
 */
export interface PaginationOptions {
  /** 1-indexed page number; must be ≥ 1. */
  page?: number;
  /** Items per page; must be ≥ 1. Upper bound is server-enforced. */
  perPage?: number;
}

/**
 * Custom Commander argument parser for `--page <number>` and
 * `--per-page <number>`. Both flags share the same constraint set —
 * positive integers — so the parser is reused via `Option.argParser`.
 *
 * Rejects:
 *
 * - empty strings (`""`)
 * - non-numeric input (`"abc"`, `"1.5"`, `"1e3"`, `"0x10"`)
 * - non-finite values (`NaN`, `Infinity`)
 * - zero or negative values (`"0"`, `"-1"`)
 *
 * Returns the parsed integer on success. Throws
 * `InvalidArgumentError` (Commander surfaces it as a parse-time error
 * before any sub-command action runs).
 *
 * The strict regex (`^[1-9][0-9]*$`) is the gating check — `Number()`
 * alone would accept `"1.5"`, `"1e3"`, `"0x10"`, leading/trailing
 * whitespace, signs, etc. The integer-shape constraint is part of the
 * AC contract ("--page <number>", 1-indexed) and the wire constraint
 * (`Int!` in GraphQL).
 */
export function parsePaginationFlag(name: string, raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new InvalidArgumentError(`${name} must be a positive integer (got: ${JSON.stringify(raw)})`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError(`${name} must be a positive integer (got: ${JSON.stringify(raw)})`);
  }
  return n;
}

/**
 * Capture the global `--page` / `--per-page` values from the root
 * program's `preAction` hook. Either field may be absent — the
 * service-layer adapter passes the captured field through and lets the
 * server apply its default for the missing field.
 *
 * Replaces the current captured options wholesale — partial updates
 * are NOT supported (the preAction hook runs once per invocation, so
 * stale partial state cannot occur at runtime).
 */
export function setCliPagination(opts: PaginationOptions): void {
  cliPagination = opts;
}

/**
 * Read the captured pagination options. Returns an empty object when
 * neither flag was passed (the no-pagination default — the server's
 * own default page applies).
 *
 * List-bearing action handlers call this directly when wiring
 * `--page` / `--per-page` through to the service layer. The empty-
 * object return is intentional: `{...emptyPagination}` is a no-op
 * spread, so handlers can blend the captured values into their
 * service-call options without conditionals.
 */
export function getCliPagination(): PaginationOptions {
  return cliPagination;
}

/**
 * Reset the captured value. Tests call this in `beforeEach` to avoid
 * bleeding state across cases. Not used in production — the program's
 * `preAction` hook calls `setCliPagination` once per invocation.
 */
export function resetCliPagination(): void {
  cliPagination = {};
}

/**
 * Symbol-keyed marker used by {@link markPaginated} and {@link
 * isPaginatedCommand} to tag Commander `Command` instances as
 * pagination-supporting leaves. Mirrors the `MUTATION_MARKER` pattern
 * in `lib/dry-run.ts`: symbol-keyed so the marker cannot collide with
 * any future Commander internal field, `Symbol.for(...)` (cross-realm
 * registry) so the same marker resolves identically across module
 * boundaries when Vitest re-evaluates modules in fresh realms.
 */
const PAGINATED_MARKER = Symbol.for("ttctl.cli.command.isPaginated");

/**
 * Tag `cmd` as a pagination-supporting leaf. Commands so tagged accept
 * the global `--page` / `--per-page` flags; commands NOT tagged are
 * REFUSED by the program's `preAction` hook with a non-zero exit when
 * either flag is set.
 *
 * Refusal semantics (per #138 user decision): the wire-pagination
 * support is heterogeneous across Toptal surfaces — some operations
 * accept `page`/`pageSize`, some accept `pagination: {limit, offset}`,
 * some accept `pagination: {limit, after}`, and some have no
 * pagination args at all. Rather than silently no-op the flags on
 * non-paginating leaves (which would mislead users into thinking the
 * flag worked), the CLI explicitly refuses with:
 *
 *     Error: --page / --per-page not supported by '<command>' (wire operation does not paginate)
 *
 * Tagging happens once at command construction (in the
 * `build*Command` factories). Returns the same `Command` so call
 * sites can chain:
 *
 *   markPaginated(jobsCmd.command("list").description(...).action(...));
 *
 * Future paginated surfaces MUST call this when they ship — forgetting
 * to mark fires the refusal error instead of routing the flags
 * through. Program-level tests are the safety net for that contract.
 */
export function markPaginated(cmd: Command): Command {
  (cmd as unknown as Record<symbol, unknown>)[PAGINATED_MARKER] = true;
  return cmd;
}

/**
 * True when `cmd` was previously tagged via {@link markPaginated}.
 * Used by the program's `preAction` hook to decide whether the
 * `--page` / `--per-page` flags should route through to action
 * handlers or refuse with a non-zero exit.
 *
 * Returns `false` for any Commander Command that was not tagged —
 * including paginated leaves whose authors forgot to call
 * `markPaginated`. Such commands will refuse with the error message;
 * program-level tests catch this regression.
 */
export function isPaginatedCommand(cmd: Command): boolean {
  return (cmd as unknown as Record<symbol, unknown>)[PAGINATED_MARKER] === true;
}

/**
 * Render the verbatim refusal message emitted by the program's
 * `preAction` hook when `--page` / `--per-page` is set on a leaf that
 * has NOT been tagged via {@link markPaginated}. The message names the
 * offending command via its full Commander name path (e.g.,
 * `applications list`) so users can correlate with `ttctl --help`.
 *
 * The exact wording is shared between the hook and unit tests so the
 * assertion target and the runtime emission stay in lockstep.
 */
export function formatPaginationRefusal(commandName: string): string {
  return `Error: --page / --per-page not supported by '${commandName}' (wire operation does not paginate)\n`;
}
