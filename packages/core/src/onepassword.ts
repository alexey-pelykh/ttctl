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
 * Mechanism: shells out to `op item get ITEM --vault VAULT --fields
 * username,password --format json`. The 1Password Desktop app brokers
 * authentication (typically via biometric prompt) — no service-account token
 * is required.
 *
 * The item must have both `username` and `password` fields populated.
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
    raw = execFileSync(
      "op",
      ["item", "get", item, "--vault", vault, "--fields", "label=username,label=password", "--format", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
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

  // op may return either a single field array (when `--fields` selects fields)
  // or a wrapped object — normalize.
  const fieldsArray = Array.isArray(parsed) ? { fields: parsed } : parsed;
  const result = OpItemSchema.safeParse(fieldsArray);
  if (!result.success) {
    throw new OnePasswordError(`Unexpected op output shape: ${result.error.message}`);
  }

  const username = result.data.fields.find((f) => f.label === "username")?.value;
  const password = result.data.fields.find((f) => f.label === "password")?.value;

  if (!username || !password) {
    throw new OnePasswordError(`Item ${vault}/${item} must have both 'username' and 'password' fields populated.`);
  }

  return { email: username, password };
}
