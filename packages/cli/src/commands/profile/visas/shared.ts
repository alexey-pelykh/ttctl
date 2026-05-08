// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";

export { loadAuthTokenOrExit } from "../shared.js";

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
