// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { contracts } from "@ttctl/core";

import { activeMarker, formatContractDetail, formatContractsTable, formatDate } from "../index.js";

const CONTRACT: contracts.Contract = {
  id: "ct-1",
  kind: "TOPTAL_DIRECT",
  provider: "TOPTAL",
  status: "SIGNED",
  billingType: "HOURLY",
  signedAt: "2025-12-01T10:00:00Z",
  sentAt: "2025-11-20T09:00:00Z",
  isActive: true,
  verificationDeadline: null,
  title: "Toptal Direct Contract",
};

const CONTRACT_MSA: contracts.Contract = {
  id: "ct-2",
  kind: "MASTER_SERVICE_AGREEMENT",
  provider: "Acme Inc.",
  status: "PENDING",
  billingType: null,
  signedAt: null,
  sentAt: "2026-04-15T08:00:00Z",
  isActive: false,
  verificationDeadline: "2026-06-15T00:00:00Z",
  title: "MSA — Acme Inc.",
};

describe("formatDate", () => {
  it("trims an ISO 8601 string to the YYYY-MM-DD prefix", () => {
    expect(formatDate("2025-12-01T10:00:00Z")).toBe("2025-12-01");
    expect(formatDate("2025-12-01T10:00:00+02:00")).toBe("2025-12-01");
  });

  it("returns '—' for null and empty string", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
  });

  it("returns the input unchanged when it does not start with a date", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });
});

describe("activeMarker", () => {
  it("returns ★ for active, empty for inactive, ? for null", () => {
    expect(activeMarker(true)).toBe("★");
    expect(activeMarker(false)).toBe("");
    expect(activeMarker(null)).toBe("?");
  });
});

describe("formatContractsTable", () => {
  it("renders an empty table when there are no items", () => {
    const out = formatContractsTable([]);
    expect(out).toContain("id");
    expect(out).toContain("kind");
    expect(out).toContain("provider");
    expect(out).toContain("status");
    expect(out).toContain("signed");
    expect(out).toContain("active");
  });

  it("renders rows with kind, provider, status, and trimmed signed date", () => {
    const out = formatContractsTable([CONTRACT]);
    expect(out).toContain("ct-1");
    expect(out).toContain("TOPTAL_DIRECT");
    expect(out).toContain("TOPTAL");
    expect(out).toContain("SIGNED");
    expect(out).toContain("2025-12-01");
    expect(out).toContain("★"); // active marker
  });

  it("renders '—' for null kind/provider/status and unsigned contracts", () => {
    const blank: contracts.Contract = {
      ...CONTRACT,
      id: "ct-blank",
      kind: null,
      provider: null,
      status: null,
      signedAt: null,
    };
    const out = formatContractsTable([blank]);
    expect(out).toContain("ct-blank");
    // The em-dash placeholder is shared across kind / provider / status / date
    // when the upstream value is null.
    expect(out).toContain("—");
  });

  it("renders multiple rows preserving order", () => {
    const out = formatContractsTable([CONTRACT, CONTRACT_MSA]);
    const idxFirst = out.indexOf("ct-1");
    const idxSecond = out.indexOf("ct-2");
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
  });
});

describe("formatContractDetail", () => {
  it("renders a full contract with all sections", () => {
    const out = formatContractDetail(CONTRACT);
    expect(out).toContain("Contract ct-1");
    expect(out).toContain("Title: Toptal Direct Contract");
    expect(out).toContain("Kind: TOPTAL_DIRECT");
    expect(out).toContain("Provider: TOPTAL");
    expect(out).toContain("Status: SIGNED");
    expect(out).toContain("Billing type: HOURLY");
    expect(out).toContain("Active: yes");
    expect(out).toContain("Sent at: 2025-11-20T09:00:00Z");
    expect(out).toContain("Signed at: 2025-12-01T10:00:00Z");
    // verificationDeadline is null on this fixture — line omitted
    expect(out).not.toContain("Verification deadline:");
  });

  it("renders a pending MSA: shows verification deadline, hides signedAt", () => {
    const out = formatContractDetail(CONTRACT_MSA);
    expect(out).toContain("Contract ct-2");
    expect(out).toContain("Title: MSA — Acme Inc.");
    expect(out).toContain("Status: PENDING");
    expect(out).toContain("Active: no");
    expect(out).toContain("Verification deadline: 2026-06-15T00:00:00Z");
    // signedAt and billingType are null on this fixture — lines omitted
    expect(out).not.toContain("Signed at:");
    expect(out).not.toContain("Billing type:");
  });

  it("renders a minimal contract with only id (all other fields null)", () => {
    const minimal: contracts.Contract = {
      id: "ct-min",
      kind: null,
      provider: null,
      status: null,
      billingType: null,
      signedAt: null,
      sentAt: null,
      isActive: null,
      verificationDeadline: null,
      title: null,
    };
    const out = formatContractDetail(minimal);
    expect(out).toContain("Contract ct-min");
    // No subsequent lines — every field is null
    expect(out.split("\n").length).toBe(1);
  });
});
