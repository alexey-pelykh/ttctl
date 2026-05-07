// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { DateInputError, parseDateInput } from "../date.js";

describe("parseDateInput", () => {
  describe("ISO-8601 (YYYY-MM-DD)", () => {
    it("parses a valid ISO-8601 date", () => {
      expect(parseDateInput("2023-01-15", "from")).toEqual({ year: 2023, month: 1, day: 15 });
    });

    it("parses December 31", () => {
      expect(parseDateInput("2023-12-31", "from")).toEqual({ year: 2023, month: 12, day: 31 });
    });

    it("parses Feb 29 in a leap year", () => {
      expect(parseDateInput("2024-02-29", "from")).toEqual({ year: 2024, month: 2, day: 29 });
    });

    it("rejects Feb 29 in a non-leap year", () => {
      expect(() => parseDateInput("2023-02-29", "from")).toThrow(DateInputError);
    });

    it("rejects Feb 30", () => {
      expect(() => parseDateInput("2023-02-30", "from")).toThrow(DateInputError);
    });

    it("rejects month 13", () => {
      expect(() => parseDateInput("2023-13-01", "from")).toThrow(DateInputError);
    });

    it("rejects day 0", () => {
      expect(() => parseDateInput("2023-01-00", "from")).toThrow(DateInputError);
    });
  });

  describe("year-only (YYYY)", () => {
    it("parses a valid year and defaults to January 1st", () => {
      expect(parseDateInput("2023", "from")).toEqual({ year: 2023, month: 1, day: 1 });
    });

    it("parses 1900 (lower edge)", () => {
      expect(parseDateInput("1900", "from")).toEqual({ year: 1900, month: 1, day: 1 });
    });

    it("rejects years before 1900", () => {
      expect(() => parseDateInput("1899", "from")).toThrow(DateInputError);
    });

    it("rejects 5-digit year", () => {
      expect(() => parseDateInput("20230", "from")).toThrow(DateInputError);
    });

    it("rejects 3-digit year", () => {
      expect(() => parseDateInput("203", "from")).toThrow(DateInputError);
    });
  });

  describe("malformed input", () => {
    it("rejects empty string", () => {
      expect(() => parseDateInput("", "from")).toThrow(DateInputError);
    });

    it("rejects non-numeric input", () => {
      expect(() => parseDateInput("yesterday", "from")).toThrow(DateInputError);
    });

    it("rejects date with month/day but missing year", () => {
      expect(() => parseDateInput("01-15", "from")).toThrow(DateInputError);
    });

    it("rejects date with single-digit month", () => {
      expect(() => parseDateInput("2023-1-15", "from")).toThrow(DateInputError);
    });

    it("accepts surrounding whitespace via trim-before-regex", () => {
      // Trim happens before regex, so "  2023  " becomes "2023" and parses fine.
      expect(parseDateInput("  2023  ", "from")).toEqual({ year: 2023, month: 1, day: 1 });
    });
  });

  describe("error code + message", () => {
    it("throws DateInputError with code INVALID_DATE", () => {
      try {
        parseDateInput("bad", "from");
      } catch (err) {
        expect(err).toBeInstanceOf(DateInputError);
        expect((err as DateInputError).code).toBe("INVALID_DATE");
        expect((err as DateInputError).message).toContain("--from");
      }
    });

    it("includes flag name in error message", () => {
      try {
        parseDateInput("bad", "issued");
      } catch (err) {
        expect((err as DateInputError).message).toContain("--issued");
      }
    });
  });

  describe("year boundary", () => {
    it("accepts current year + 30", () => {
      const farFuture = new Date().getUTCFullYear() + 30;
      expect(parseDateInput(farFuture.toString(), "from").year).toBe(farFuture);
    });

    it("rejects current year + 31", () => {
      const tooFar = new Date().getUTCFullYear() + 31;
      expect(() => parseDateInput(tooFar.toString(), "from")).toThrow(DateInputError);
    });
  });
});
