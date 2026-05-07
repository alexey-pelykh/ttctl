// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";

/**
 * Wrap a sync `resolveAuthTokenPath` call, routing `ConfigError` to a
 * stderr-and-exit path that surfaces the discriminator code (`NO_CREDS` /
 * `PARSE` / `VALIDATION` / `PERMISSION`) verbatim.
 */
export function handleConfigError<T>(commandLabel: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${commandLabel} failed (${err.code}): ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Map service errors to actionable stderr messages and exit code 1.
 * `TtctlError` subclasses route through `presentTtctlError`; domain
 * `VisasError` codes keep the CLI's `(CODE): message` rendering.
 */
export function handleVisasError(commandLabel: string, err: unknown): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.visas.VisasError) {
    process.stderr.write(`${commandLabel} failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${commandLabel} failed: ${message}\n`);
  process.exit(1);
}
