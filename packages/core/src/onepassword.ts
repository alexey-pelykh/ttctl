// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { execFileSync } from "node:child_process";

import { z } from "zod";

import type { Credentials } from "./types.js";

/**
 * Shape of `op item get --format json` output (subset; only fields we use).
 */
const OpItemSchema = z.object({
  fields: z.array(
    z.object({
      id: z.string().optional(),
      label: z.string().optional(),
      value: z.string().optional(),
      purpose: z.string().optional(),
    }),
  ),
});

export class OnePasswordError extends Error {
  override readonly name = "OnePasswordError";
}

interface ParsedReference {
  account?: string;
  vault: string;
  item: string;
}

/**
 * Parse `op://[ACCOUNT/]VAULT/ITEM` into its components. Returns `null` for any
 * shape outside the 2- or 3-segment grammar (matches `OnePasswordItemRefSchema`
 * in `config.ts`).
 *
 * Splitting on `/` after stripping the `op://` prefix avoids regex capture-group
 * contortions and produces clear branching on segment count.
 */
function parseReference(ref: string): ParsedReference | null {
  if (!ref.startsWith("op://")) return null;
  const segments = ref.slice("op://".length).split("/");
  if (segments.some((s) => s.length === 0)) return null;
  if (segments.length === 2) {
    const [vault, item] = segments as [string, string];
    return { vault, item };
  }
  if (segments.length === 3) {
    const [account, vault, item] = segments as [string, string, string];
    return { account, vault, item };
  }
  return null;
}

/**
 * Resolve credentials from a 1Password item reference.
 *
 * Accepted forms:
 *   - `op://VAULT/ITEM` (2-segment) — `op` CLI uses its default account or
 *     `OP_ACCOUNT` env.
 *   - `op://ACCOUNT/VAULT/ITEM` (3-segment) — `--account ACCOUNT` is forwarded
 *     to `op item get` so users with multiple configured accounts can select
 *     one explicitly. ACCOUNT may be a UUID, shorthand, or sign-in email; `op`
 *     itself validates the value.
 *
 * Mechanism: shells out to `op item get ITEM --vault VAULT [--account ACCOUNT]
 * --format json`, then matches credential fields by `purpose` (`USERNAME` /
 * `PASSWORD`) — the canonical semantic identifier 1Password sets automatically
 * for LOGIN-category items. The 1Password Desktop app brokers authentication
 * (typically via biometric prompt) — no service-account token is required.
 *
 * Field-matching by `purpose` rather than `label` is necessary because
 * browser-autosaved items inherit their `label` from the HTML form input name
 * (e.g. `user[email]`, `user[password]`) — only `purpose` is canonical. The
 * item must be a LOGIN-category item (any item with both USERNAME and PASSWORD
 * purposes set).
 */
export function resolveOnePasswordReference(ref: string): Credentials {
  const parsed = parseReference(ref);
  if (!parsed) {
    throw new OnePasswordError(`Invalid reference: ${ref}. Expected op://[account/]vault/item.`);
  }
  const { account, vault, item } = parsed;

  const args = ["item", "get", item, "--vault", vault];
  if (account !== undefined) args.push("--account", account);
  args.push("--format", "json");

  let raw: string;
  try {
    raw = execFileSync("op", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new OnePasswordError(
        "1Password CLI (`op`) not found. Install: https://developer.1password.com/docs/cli/get-started/",
      );
    }
    throw new OnePasswordError(`op item get failed: ${e.message}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new OnePasswordError(`op returned non-JSON output: ${(err as Error).message}`);
  }

  // `op item get --format json` returns the full item object with a `fields`
  // array. Older `op` CLI versions returned a bare fields array instead;
  // normalize both shapes into the wrapped form before schema validation.
  const normalized = Array.isArray(parsedJson) ? { fields: parsedJson } : parsedJson;
  const result = OpItemSchema.safeParse(normalized);
  if (!result.success) {
    throw new OnePasswordError(`Unexpected op output shape: ${result.error.message}`);
  }

  const username = result.data.fields.find((f) => f.purpose === "USERNAME")?.value;
  const password = result.data.fields.find((f) => f.purpose === "PASSWORD")?.value;

  if (!username || !password) {
    throw new OnePasswordError(
      `Item ${vault}/${item} must have fields with USERNAME and PASSWORD purposes (LOGIN-category items have these by default).`,
    );
  }

  return { email: username, password };
}
