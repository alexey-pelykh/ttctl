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

/**
 * Resolve credentials from a 1Password item reference of the form
 * `op://VAULT/ITEM`.
 *
 * Mechanism: shells out to `op item get ITEM --vault VAULT --format json`,
 * then matches credential fields by `purpose` (`USERNAME` / `PASSWORD`) — the
 * canonical semantic identifier 1Password sets automatically for LOGIN-category
 * items. The 1Password Desktop app brokers authentication (typically via
 * biometric prompt) — no service-account token is required.
 *
 * Field-matching by `purpose` rather than `label` is necessary because
 * browser-autosaved items inherit their `label` from the HTML form input name
 * (e.g. `user[email]`, `user[password]`) — only `purpose` is canonical. The
 * item must be a LOGIN-category item (any item with both USERNAME and PASSWORD
 * purposes set).
 */
export function resolveOnePasswordReference(ref: string): Credentials {
  const match = /^op:\/\/([^/]+)\/([^/]+)$/.exec(ref);
  const vault = match?.[1];
  const item = match?.[2];
  if (!vault || !item) {
    throw new OnePasswordError(`Invalid reference: ${ref}. Expected op://VAULT/ITEM.`);
  }

  let raw: string;
  try {
    raw = execFileSync("op", ["item", "get", item, "--vault", vault, "--format", "json"], {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OnePasswordError(`op returned non-JSON output: ${(err as Error).message}`);
  }

  // `op item get --format json` returns the full item object with a `fields`
  // array. Older `op` CLI versions returned a bare fields array instead;
  // normalize both shapes into the wrapped form before schema validation.
  const normalized = Array.isArray(parsed) ? { fields: parsed } : parsed;
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
