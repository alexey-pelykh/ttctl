// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Stable error code carried by {@link DateInputError}. Script consumers
 * branch on `error.code` rather than parsing the user-facing prose.
 */
export type DateInputErrorCode = "INVALID_DATE";

/**
 * Typed error thrown by {@link parseDateInput} for malformed user input.
 * Callers render the standard `<command> failed (<code>): <message>` shape
 * and exit non-zero before any network call is made.
 */
export class DateInputError extends Error {
  override readonly name = "DateInputError";
  constructor(
    public readonly code: DateInputErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Parsed date: year, optional month, optional day.
 *
 * Sub-domains pick the granularity they need:
 * - Education / Employment use `year` only (the GraphQL fields are
 *   `yearFrom` / `yearTo` and `startDate` / `endDate` typed as `Int`,
 *   year-only per `research/captures/web/inputs/UpdateEducationInput.json`
 *   and `UpdateEmploymentInput.json`).
 * - Certification uses `year` + `month` (the GraphQL fields are
 *   `validFromMonth` / `validFromYear` / `validToMonth` / `validToYear`).
 *
 * `month` and `day` are 1-indexed (1 = January, 1 = the first day).
 */
export interface ParsedDate {
  year: number;
  month: number;
  day: number;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_ONLY_RE = /^(\d{4})$/;

/**
 * Parse a free-form date flag value into a {@link ParsedDate}.
 *
 * Accepts:
 * - **ISO-8601 date** (`YYYY-MM-DD`, e.g. `2023-01-15`) — preserves all three
 *   fields. Validates the date is a real calendar date (rejects 2023-02-30,
 *   2023-13-01, etc.).
 * - **Year-only** (`YYYY`, e.g. `2023`) — defaults `month` and `day` to `1`
 *   per issue #74's "internally treated as January 1st" rule.
 *
 * Throws {@link DateInputError} with code `INVALID_DATE` on:
 * - Empty / non-string input
 * - Format that matches neither shape
 * - Out-of-range year (rejects years before 1900 or after the current year + 30
 *   to catch obvious typos like `203` or `20230` being written as a YYYY)
 * - Out-of-range month or day for a real calendar date
 *
 * The helper is pure — no I/O — so it can be unit-tested directly.
 *
 * @param raw - the raw flag value as supplied by the user
 * @param flagName - the user-facing flag name (e.g. `"from"`, `"issued"`),
 *   surfaced in error messages so the user knows which flag is wrong
 */
export function parseDateInput(raw: string, flagName: string): ParsedDate {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new DateInputError(
      "INVALID_DATE",
      `--${flagName}: expected ISO-8601 date (YYYY-MM-DD) or year (YYYY); got empty input`,
    );
  }

  const trimmed = raw.trim();

  const isoMatch = ISO_DATE_RE.exec(trimmed);
  if (isoMatch !== null) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    validateYear(year, flagName, trimmed);
    validateMonth(month, flagName, trimmed);
    validateDay(year, month, day, flagName, trimmed);
    return { year, month, day };
  }

  const yearMatch = YEAR_ONLY_RE.exec(trimmed);
  if (yearMatch !== null) {
    const year = Number(yearMatch[1]);
    validateYear(year, flagName, trimmed);
    return { year, month: 1, day: 1 };
  }

  throw new DateInputError(
    "INVALID_DATE",
    `--${flagName}: expected ISO-8601 date (YYYY-MM-DD) or year (YYYY); got "${trimmed}"`,
  );
}

/**
 * Year sanity check. The issue spec says "ISO-8601 (`2023-01-15`) or
 * year-only (`2023`)" — anything dramatically before or after the
 * professional-history range is almost certainly a typo. We use a loose
 * 1900..(currentYear+30) window so the helper isn't a maintenance burden
 * but still catches `203` (a typo for `2023`) and `20230` (a typo too).
 */
function validateYear(year: number, flagName: string, raw: string): void {
  const currentYear = new Date().getUTCFullYear();
  if (year < 1900 || year > currentYear + 30) {
    throw new DateInputError(
      "INVALID_DATE",
      `--${flagName}: year ${year.toString()} is out of plausible range (1900..${(currentYear + 30).toString()}); got "${raw}"`,
    );
  }
}

function validateMonth(month: number, flagName: string, raw: string): void {
  if (month < 1 || month > 12) {
    throw new DateInputError(
      "INVALID_DATE",
      `--${flagName}: month ${month.toString()} is out of range (1..12); got "${raw}"`,
    );
  }
}

/**
 * Validate `day` falls within the given `month` of the given `year`. Uses
 * `Date` round-tripping rather than a hand-rolled days-per-month table so
 * leap-year edge cases (Feb 29 of a leap year, NOT of a non-leap year) are
 * handled correctly.
 *
 * `Date.UTC(year, monthZeroIndexed, day)` returns NaN for impossible dates
 * but more importantly silently rolls over (e.g. `Date.UTC(2023, 1, 30)` =
 * March 2). The reconstruction check catches the rollover.
 */
function validateDay(year: number, month: number, day: number, flagName: string, raw: string): void {
  if (day < 1 || day > 31) {
    throw new DateInputError(
      "INVALID_DATE",
      `--${flagName}: day ${day.toString()} is out of range (1..31); got "${raw}"`,
    );
  }
  const utc = Date.UTC(year, month - 1, day);
  const reconstructed = new Date(utc);
  if (
    reconstructed.getUTCFullYear() !== year ||
    reconstructed.getUTCMonth() !== month - 1 ||
    reconstructed.getUTCDate() !== day
  ) {
    throw new DateInputError("INVALID_DATE", `--${flagName}: ${raw} is not a real calendar date`);
  }
}
