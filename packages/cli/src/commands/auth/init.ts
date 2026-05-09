// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as p from "@clack/prompts";
import { z } from "zod";

import { writeNewConfig } from "@ttctl/core";

/**
 * Outcome shape for `runAuthInit`. The discriminated union lets unit tests
 * assert specific terminal states (refusal kinds, abort kinds, success
 * shape) without pattern-matching prose. The CLI surface turns this into
 * stdout/stderr + an exit code via `formatInitOutput` + `exitCodeForInitResult`.
 */
export type AuthInitResult =
  | { status: "written"; path: string; form: "A" | "B" }
  | { status: "refused"; reason: "non-tty" | "exists" | "cancelled"; message: string }
  | { status: "error"; message: string };

export interface AuthInitOptions {
  config?: string;
  force?: boolean;
}

/**
 * Regex for a 1Password item reference. Matches the `OnePasswordReferenceSchema`
 * in `packages/core/src/config.ts` line-for-line — accepts both
 * `op://VAULT/ITEM` (2-segment) and `op://ACCOUNT/VAULT/ITEM` (3-segment)
 * forms; rejects 4+ segments (per-field references). Duplicated here rather
 * than imported from core to avoid pulling the entire schema into the
 * interactive flow's validation closure.
 */
const OP_REF_REGEX = /^op:\/\/(?:[^/]+\/)?[^/]+\/[^/]+$/;
const OP_REF_HINT = "Expected op://[account/]vault/item — no /field suffix";

/**
 * Email regex for Form B username validation. Permissive — matches what a
 * Toptal email address looks like without enforcing RFC-5321 strictness.
 * Form B is a discouraged path; the EmailPasswordSignIn mutation will
 * reject malformed values at signin time.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Shape of `op vault list --format json` output (subset). The op CLI
 * returns more fields per vault; we only consume `id` and `name`.
 */
const OpVaultListSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
  }),
);

/**
 * Shape of `op item list --vault <V> --categories Login --format json`
 * output (subset). The op CLI returns more fields per item; we only
 * consume `id` and `title`.
 */
const OpItemListSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
  }),
);

/**
 * Probe whether the `op` CLI is installed and reachable on PATH. Light
 * `op --version` invocation — fails fast on `ENOENT` (not installed) and
 * any other launch failure (signed-out, broken install, etc). Output is
 * discarded; the only signal is whether the call returned successfully.
 */
function detectOpCli(): boolean {
  try {
    execFileSync("op", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shell out to `op vault list --format json`. Returns the parsed,
 * zod-validated list; throws on any failure (non-zero exit, parse
 * failure, schema mismatch). Caller should catch and fall back to
 * freeform prompt with a stderr warning.
 */
function listOpVaults(): { id: string; name: string }[] {
  const raw = execFileSync("op", ["vault", "list", "--format", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsedJson: unknown = JSON.parse(raw);
  return OpVaultListSchema.parse(parsedJson);
}

/**
 * Shell out to `op item list --vault <vault> --categories Login --format json`.
 * Filters server-side to LOGIN-category items so the picker only shows
 * relevant candidates. Returns parsed + zod-validated list; throws on
 * failure (caller falls back to freeform).
 */
function listOpItems(vault: string): { id: string; title: string }[] {
  const raw = execFileSync("op", ["item", "list", "--vault", vault, "--categories", "Login", "--format", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsedJson: unknown = JSON.parse(raw);
  return OpItemListSchema.parse(parsedJson);
}

/**
 * Map an `AuthInitResult` to a process exit code.
 *
 *   - `written`           → 0 (success)
 *   - `refused`/anything  → 1 (non-TTY, exists-without-force, cancelled)
 *   - `error`             → 1 (any unexpected failure)
 *
 * The cancelled / refused-form-B paths are intentionally non-zero — the
 * shell convention is "exit 0 only on success." A user who hits Ctrl-C
 * mid-prompt has not bootstrapped a config; subsequent commands assuming
 * one exists would fail, so signaling success here would mislead scripts.
 */
export function exitCodeForInitResult(result: AuthInitResult): number {
  return result.status === "written" ? 0 : 1;
}

/**
 * Render an `AuthInitResult` for stdout/stderr. Written → confirmation on
 * stdout naming the path AND the form chosen (per AC). Refusals + errors
 * → message on stderr.
 */
export function formatInitOutput(result: AuthInitResult): string {
  if (result.status === "written") {
    const formLabel = result.form === "A" ? "1Password reference" : "literal credentials";
    return `Wrote config to ${result.path} (form ${result.form}: ${formLabel})`;
  }
  return result.message;
}

/**
 * Determine whether the current process has an interactive TTY on stdin.
 * `@clack/prompts` produces undefined behavior when piped; we refuse
 * cleanly BEFORE any prompt runs (FR-3.10 / non-TTY refusal AC).
 *
 * Exposed for unit tests that can't trivially set the TTY bit on stdin —
 * tests stub this function to assert both branches deterministically.
 */
export function isStdinTty(): boolean {
  // Node typings declare `process.stdin.isTTY?: true` — TS narrows the
  // value to `true | undefined` and ESLint's
  // `no-unnecessary-boolean-literal-compare` would object to `=== true`.
  // Coercing through `unknown` lets us perform the strict equality (the
  // ONLY check that's safe under runtime test mocks that may set the
  // property to literal `false`) without tripping the lint rule.
  return (process.stdin.isTTY as unknown) === true;
}

/**
 * Detection-and-listing surface, exposed for unit tests so they can stub
 * the op CLI presence and listing results without spawning a real
 * subprocess. Production callers use the default implementation
 * (`detectOpCli` + `listOpVaults` + `listOpItems`).
 */
export interface OpCliInterface {
  detect: () => boolean;
  listVaults: () => { id: string; name: string }[];
  listItems: (vault: string) => { id: string; title: string }[];
}

/**
 * Default op CLI interface — shells out via `execFileSync`. Tests inject
 * an alternative implementation via the second argument to `runAuthInit`.
 */
export const defaultOpCli: OpCliInterface = {
  detect: detectOpCli,
  listVaults: listOpVaults,
  listItems: listOpItems,
};

/**
 * Resolve the target output path:
 *   - Explicit `--config <path>` → used verbatim
 *   - Otherwise → `~/.ttctl.yaml` (POSIX home dotfile, matches the
 *     resolution chain's only fallback)
 *
 * Parent directories are created by `writeNewConfig` (via `mkdir -p`); no
 * pre-existence check on the parent.
 */
function resolveTargetPath(options: AuthInitOptions): string {
  if (options.config !== undefined) return options.config;
  return join(homedir(), ".ttctl.yaml");
}

/**
 * Compose the YAML content for Form A (1Password reference). Quoted op://
 * string preserves the canonical scalar style and disambiguates the value
 * from any future YAML grammar expansion.
 */
function composeFormAYaml(ref: string): string {
  return `auth:\n  credentials: "${ref}"\n`;
}

/**
 * Compose the YAML content for Form B (literal credentials). `username`
 * and `password` are double-quoted to keep YAML's special-character
 * grammar from interfering with anything that might appear in a real
 * credential string. Backslashes / double-quotes are escaped with
 * defensive replacement.
 */
function composeFormBYaml(username: string, password: string): string {
  const escape = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `auth:\n  credentials:\n    username: "${escape(username)}"\n    password: "${escape(password)}"\n`;
}

/**
 * Run the `auth init` interactive flow:
 *
 *   1. TTY gate — refuse non-TTY stdin BEFORE any prompt (CI safety).
 *   2. Resolve target path; refuse pre-existing files unless `--force`.
 *   3. Form selector (A / B).
 *   4. Form A: detect `op` CLI; on present → vault picker, item picker,
 *      confirm → compose YAML. On absent OR list-failure → freeform
 *      `op://` text prompt with regex validation.
 *   5. Form B: explicit confirmation gate (default `N` aborts cleanly);
 *      on `Y` → username (email) + password (masked) → compose YAML.
 *   6. Persist via `writeNewConfig` — atomic temp+rename, mode 0o600,
 *      sync-root + symlink refusal applies.
 *   7. Confirmation message names path AND form.
 *
 * Cancellation: `@clack/prompts` returns its `isCancel` symbol on
 * Ctrl-C / Esc at any prompt; we intercept and produce a `cancelled`
 * result so the user sees an "Aborted" line and exits non-zero (vs. a
 * silently truncated write).
 *
 * Inputs: `options` from commander; `opCli` is dependency-injected so
 * tests can inject a stubbed implementation without spawning real
 * `op` subprocesses.
 */
export async function runAuthInit(
  options: AuthInitOptions,
  opCli: OpCliInterface = defaultOpCli,
): Promise<AuthInitResult> {
  // 1. Non-TTY refusal — first thing, before we touch the prompt library.
  if (!isStdinTty()) {
    return {
      status: "refused",
      reason: "non-tty",
      message:
        "ttctl auth init is interactive; pipe stdin or a TTY is required. " +
        "Hand-author the config or run on a terminal.",
    };
  }

  const targetPath = resolveTargetPath(options);
  const force = options.force === true;

  // 2. Pre-existence gate — surfaced BEFORE any prompt so the user
  // doesn't waste time entering credentials only to be refused at write
  // time. `writeNewConfig` re-checks atomically (defense-in-depth
  // against a TOCTOU window between this check and the open() call), so
  // the refusal here is purely UX.
  if (!force && existsSync(targetPath)) {
    const message =
      `Refusing to overwrite existing config at ${targetPath}. ` + `Use --force to replace, or edit the file manually.`;
    return { status: "refused", reason: "exists", message };
  }

  p.intro("ttctl auth init");

  // 3. Form selector. clack returns either Value | Symbol(cancel); we
  // narrow via isCancel before consuming.
  const form = await p.select<"A" | "B">({
    message: "Choose credentials source",
    options: [
      { value: "A", label: "1Password reference (recommended)" },
      { value: "B", label: "Literal username/password (discouraged)" },
    ],
    initialValue: "A",
  });
  if (p.isCancel(form)) {
    p.cancel("Aborted (no file written).");
    return { status: "refused", reason: "cancelled", message: "Aborted (no file written)." };
  }

  let yaml: string;
  let chosenForm: "A" | "B";

  if (form === "A") {
    chosenForm = "A";
    const ref = await collectFormARef(opCli);
    if (ref === undefined) {
      p.cancel("Aborted (no file written).");
      return { status: "refused", reason: "cancelled", message: "Aborted (no file written)." };
    }
    yaml = composeFormAYaml(ref);
  } else {
    chosenForm = "B";
    const literal = await collectFormBLiteral();
    if (literal === undefined) {
      p.cancel("Aborted (no file written).");
      return { status: "refused", reason: "cancelled", message: "Aborted (no file written)." };
    }
    yaml = composeFormBYaml(literal.username, literal.password);
  }

  // 4. Persist via writeNewConfig — atomic temp+rename. The
  // `assertSafePath` gate (sync-root, symlink) and the defense-in-depth
  // existence re-check live inside writeNewConfig; surface any failure
  // verbatim.
  try {
    await writeNewConfig(targetPath, yaml, { force });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.cancel(`Failed to write config: ${message}`);
    return { status: "error", message: `Failed to write config: ${message}` };
  }

  const successLine = formatInitOutput({ status: "written", path: targetPath, form: chosenForm });
  p.outro(successLine);
  return { status: "written", path: targetPath, form: chosenForm };
}

/**
 * Form A flow: collect a 1Password reference from either the vault/item
 * picker (when `op` is installed and the listings parse cleanly) or a
 * freeform text prompt.
 *
 * Returns `undefined` on cancellation at any sub-prompt.
 */
async function collectFormARef(opCli: OpCliInterface): Promise<string | undefined> {
  const opAvailable = opCli.detect();

  if (!opAvailable) {
    p.log.info("1Password CLI (`op`) not installed; falling back to freeform reference.");
    return promptFreeformOpRef();
  }

  // Vault list — fall back to freeform on any failure (op signed-out,
  // JSON shape drift, network etc.). The user sees a clear stderr-style
  // warning before the prompt to explain the fallback.
  let vaults: { id: string; name: string }[];
  try {
    vaults = opCli.listVaults();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    p.log.warn(`op vault list failed (${reason}); falling back to freeform reference.`);
    return promptFreeformOpRef();
  }
  if (vaults.length === 0) {
    p.log.warn("op vault list returned no vaults; falling back to freeform reference.");
    return promptFreeformOpRef();
  }

  const vault = await p.select<string>({
    message: "Pick a 1Password vault",
    options: vaults.map((v) => ({ value: v.name, label: v.name })),
  });
  if (p.isCancel(vault)) return undefined;

  let items: { id: string; title: string }[];
  try {
    items = opCli.listItems(vault);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    p.log.warn(`op item list failed (${reason}); falling back to freeform reference.`);
    return promptFreeformOpRef();
  }
  if (items.length === 0) {
    p.log.warn(`No LOGIN-category items in vault "${vault}"; falling back to freeform reference.`);
    return promptFreeformOpRef();
  }

  const item = await p.select<string>({
    message: `Pick a LOGIN item from ${vault}`,
    options: items.map((i) => ({ value: i.title, label: i.title })),
  });
  if (p.isCancel(item)) return undefined;

  const ref = `op://${vault}/${item}`;
  const confirmed = await p.confirm({
    message: `Confirm: write ${ref} to config?`,
    initialValue: true,
  });
  if (p.isCancel(confirmed) || !confirmed) return undefined;

  return ref;
}

/**
 * Freeform `op://` reference fallback prompt. Validates input against the
 * same regex as `OnePasswordReferenceSchema` in core; rejects until the
 * user enters a valid value or cancels.
 */
async function promptFreeformOpRef(): Promise<string | undefined> {
  const ref = await p.text({
    message: "1Password reference (op://[account/]vault/item)",
    placeholder: "op://Personal/ttctl",
    validate: (value: string | undefined) => {
      if (value === undefined || value.length === 0) return "Reference is required.";
      if (!OP_REF_REGEX.test(value)) return OP_REF_HINT;
      return undefined;
    },
  });
  if (p.isCancel(ref)) return undefined;
  return ref;
}

/**
 * Form B flow: warn-and-confirm gate, then prompt for username (email
 * regex) and password (masked). Returns `undefined` on any
 * cancellation OR explicit `N` at the warn-and-confirm gate.
 */
async function collectFormBLiteral(): Promise<{ username: string; password: string } | undefined> {
  const proceed = await p.confirm({
    message: "Plaintext credentials in config are discouraged. Prefer Form A (1Password) when possible. Continue?",
    initialValue: false,
  });
  if (p.isCancel(proceed) || !proceed) return undefined;

  const username = await p.text({
    message: "Username (Toptal email)",
    validate: (value: string | undefined) => {
      if (value === undefined || value.length === 0) return "Username is required.";
      if (!EMAIL_REGEX.test(value)) return "Expected an email address.";
      return undefined;
    },
  });
  if (p.isCancel(username)) return undefined;

  const password = await p.password({
    message: "Password",
    validate: (value: string | undefined) => {
      if (value === undefined || value.length === 0) return "Password is required.";
      return undefined;
    },
  });
  if (p.isCancel(password)) return undefined;

  return { username, password };
}
