// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { me } from "@ttctl/core";

import { formatActionsTable, formatTimestamp } from "../index.js";

const ACTION: me.PerformedAction = {
  id: "act-1",
  category: "APPLICATION",
  description: { template: "You applied to {{job}}", variables: [{ name: "job", text: "Senior Engineer" }] },
  occurredAt: "2026-05-01T12:34:56Z",
};

const ACTION_SPARSE: me.PerformedAction = {
  id: "act-2",
  category: null,
  description: null,
  occurredAt: null,
};

describe("formatTimestamp", () => {
  it("trims an ISO 8601 string to YYYY-MM-DD HH:MM", () => {
    expect(formatTimestamp("2026-05-01T12:34:56Z")).toBe("2026-05-01 12:34");
    expect(formatTimestamp("2026-05-01 12:34:56")).toBe("2026-05-01 12:34");
  });

  it("returns '—' for null and empty string", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp("")).toBe("—");
  });

  it("returns the input unchanged when it does not start with a date", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("formatActionsTable", () => {
  it("renders an empty table (header only) when there are no items", () => {
    const out = formatActionsTable([]);
    expect(out).toContain("occurred");
    expect(out).toContain("category");
    expect(out).toContain("description");
  });

  it("renders a row with trimmed timestamp, category, and the raw template", () => {
    const out = formatActionsTable([ACTION], 120);
    expect(out).toContain("2026-05-01 12:34");
    expect(out).toContain("APPLICATION");
    expect(out).toContain("You applied to");
  });

  it("renders '—' placeholders for null category, description, and occurredAt", () => {
    const out = formatActionsTable([ACTION_SPARSE], 120);
    expect(out).toContain("—");
  });
});
