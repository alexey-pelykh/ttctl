// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { Command } from "commander";

/**
 * Process-scoped holder for the global `--dry-run` flag (issue #52).
 *
 * Set once by the root program's `preAction` hook (see `program.ts`)
 * before any sub-command's action handler runs; read by mutation
 * handlers that need to route through the core layer's `dryRun` option
 * to short-circuit before transport. Mirrors the pattern established by
 * `cliConfigPath` in `lib/config-context.ts`: a module-scoped variable
 * keeps each handler's signature focused on its domain (no `cmd:
 * Command` parameter threading) while exposing a single place to test
 * the captured value.
 *
 * Tests must call `resetCliDryRun()` in `beforeEach` to avoid bleeding
 * state across cases — the module-scoped variable persists across
 * Vitest's `vi.resetModules` only when the module under test is the
 * one importing this file.
 */
let cliDryRun = false;

/**
 * Capture the global `--dry-run` value from the root program's
 * `preAction` hook. Pass `false` when the flag was omitted (Commander's
 * default for boolean Options is `undefined`, which the hook normalises
 * to `false` before invoking this setter).
 */
export function setCliDryRun(value: boolean): void {
  cliDryRun = value;
}

/**
 * Read the captured `--dry-run` value. Returns `false` when the flag
 * was not passed (the apply-path default).
 *
 * Mutation action handlers call this directly — when the leaf is marked
 * as a mutation (see {@link markMutation}), the global flag has been
 * captured and the handler is responsible for routing through the
 * core's `dryRun` option.
 */
export function getCliDryRun(): boolean {
  return cliDryRun;
}

/**
 * Reset the captured value. Tests call this in `beforeEach` to avoid
 * bleeding state across cases. Not used in production — the program's
 * `preAction` hook calls `setCliDryRun` once per invocation, so stale
 * values are not possible at runtime.
 */
export function resetCliDryRun(): void {
  cliDryRun = false;
}

/**
 * Symbol-keyed marker used by {@link markMutation} and {@link
 * isMutationCommand} to tag Commander `Command` instances as mutation
 * entry points. Symbol-keyed (rather than a string property) so the
 * marker cannot collide with any future Commander internal field, and
 * cannot be reached via accidental `for-in` iteration on the command.
 *
 * `Symbol.for` (the cross-realm registry) instead of a fresh `Symbol`
 * so the same marker resolves identically across module boundaries —
 * Vitest's module isolation occasionally re-evaluates this file in a
 * fresh realm, and a non-registered symbol would silently lose the
 * tag on Command instances built by the production program.
 */
const MUTATION_MARKER = Symbol.for("ttctl.cli.command.isMutation");

/**
 * Tag `cmd` as a mutation entry point. Mutation commands are responsible
 * for routing the `--dry-run` flag through to the core layer's `dryRun`
 * option; commands NOT tagged are treated as read-only / unsupported by
 * the program's `preAction` hook (which emits a stderr no-op note when
 * `--dry-run` is set on a non-mutation leaf).
 *
 * Tagging happens once at command construction (in the `build*Command`
 * functions). Returns the same `Command` so call sites can chain:
 *
 *   markMutation(profile.command("update").description(...).action(...));
 *
 * Future mutation surfaces (timesheet submit per #13, additional
 * profile-domain updates per #74-76) MUST call this when they ship —
 * forgetting to mark fires the read-no-op note instead of routing
 * through the dry-run path. Lint / test coverage at the program level
 * is the safety net for that contract.
 */
export function markMutation(cmd: Command): Command {
  (cmd as unknown as Record<symbol, unknown>)[MUTATION_MARKER] = true;
  return cmd;
}

/**
 * True when `cmd` was previously tagged via {@link markMutation}. Used
 * by the program's `preAction` hook to decide whether the `--dry-run`
 * flag should route through the handler's dry-run path or fire the
 * read-no-op stderr note.
 *
 * Returns `false` for any Commander Command that was not tagged —
 * including mutations whose authors forgot to call `markMutation`. Such
 * commands will silently fall into the read-no-op path; tests at the
 * program level catch this regression.
 */
export function isMutationCommand(cmd: Command): boolean {
  return (cmd as unknown as Record<symbol, unknown>)[MUTATION_MARKER] === true;
}

/**
 * Verbatim stderr text emitted by the program's `preAction` hook when
 * `--dry-run` is set on a leaf that has NOT been tagged via {@link
 * markMutation}. The exact wording is locked by the AC for issue #52
 * ("`--dry-run` is a no-op for read commands") — pinning it as a
 * constant lets tests assert against the same string the production
 * code emits without duplicating it.
 *
 * The trailing newline is part of the constant so callers writing to
 * stderr with `process.stderr.write` can pass it directly without
 * appending `"\n"`.
 */
export const DRY_RUN_NO_OP_STDERR_NOTE = "note: `--dry-run` is a no-op for read commands\n" as const;
