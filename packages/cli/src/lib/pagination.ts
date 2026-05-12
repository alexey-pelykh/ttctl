// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { InvalidArgumentError } from "commander";

/**
 * Pagination flag values as parsed off a Commander leaf. Both fields
 * are independent — one may be passed without the other (the server
 * fills the missing one with its default). User-facing values are
 * 1-indexed; service-layer translation to wire-indexing happens inside
 * the per-service `list()` adapter, not here.
 *
 * Declared per paginating leaf (#183, follow-up to #138). Action
 * handlers read these directly off their Commander `opts()` payload —
 * no module-scoped capture, no global enforcement. Leaves whose wire
 * operation does not paginate simply do not declare the flags; Commander
 * emits its standard `error: unknown option '--page'` (exit 1) when a
 * user passes the flag to such a leaf, which is the right error
 * pedagogy (a global advertisement followed by a per-command refusal
 * was an architectural category error — see #183 deliberation).
 *
 * `exactOptionalPropertyTypes` is enabled, so absent fields are
 * literally missing rather than `undefined`.
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
 * positive integers — so the parser is reused via `Option.argParser`
 * on each paginating leaf.
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
 * AC contract ("--page <number>", 1-indexed) and the wire constraint.
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
