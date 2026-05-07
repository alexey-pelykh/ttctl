// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError } from "@ttctl/core";

/**
 * Wrap a sync `resolveAuthTokenPath` call, routing `ConfigError` to a
 * stderr-and-exit path that surfaces the discriminator code (`NO_CREDS` /
 * `PARSE` / `VALIDATION` / `PERMISSION`) verbatim. Other errors propagate.
 * Shared by every leaf in the portfolio sub-tree to avoid duplicating the
 * boilerplate.
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
