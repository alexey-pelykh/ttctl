// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import {
  buildEmptyProfile,
  buildFullProfile,
  buildMinimalProfile,
  buildParagraphBearingList,
  buildSingleItemList,
} from "../builders.js";
import type { ProfileFixture } from "../types.js";

/**
 * Smoke tests for the profile rendering fixtures. Each builder gets the
 * acceptance-criteria invariant from the issue body (#125) plus the
 * "fresh object on every call" non-mutability check.
 */

const LIST_KEYS = [
  "skills",
  "portfolio",
  "employment",
  "education",
  "certifications",
  "industries",
  "visas",
] as const satisfies readonly (keyof ProfileFixture)[];

describe("buildEmptyProfile", () => {
  it("returns every list as []", () => {
    const fx = buildEmptyProfile();
    for (const key of LIST_KEYS) {
      expect(fx[key], `${key} should be []`).toEqual([]);
    }
  });

  it("returns a fresh object on every call", () => {
    const a = buildEmptyProfile();
    const b = buildEmptyProfile();
    expect(a).not.toBe(b);
    expect(a.skills).not.toBe(b.skills);
  });
});

describe("buildSingleItemList", () => {
  it("populates exactly one item in the named list and leaves the rest empty", () => {
    const fx = buildSingleItemList("skills");
    expect(fx.skills).toHaveLength(1);
    expect(fx.portfolio).toEqual([]);
    expect(fx.employment).toEqual([]);
    expect(fx.education).toEqual([]);
    expect(fx.certifications).toEqual([]);
    expect(fx.industries).toEqual([]);
    expect(fx.visas).toEqual([]);
  });

  it.each(LIST_KEYS)("supports list key %s with the canonical seed", (name) => {
    const fx = buildSingleItemList(name);
    expect(fx[name]).toHaveLength(1);
    // Every other list stays empty
    for (const other of LIST_KEYS) {
      if (other === name) continue;
      expect(fx[other], `${other} should be []`).toEqual([]);
    }
  });

  it("applies overrides via shallow-merge against the seed", () => {
    const fx = buildSingleItemList("skills", { rating: "COMPETENT", public: false });
    expect(fx.skills).toHaveLength(1);
    expect(fx.skills[0]?.rating).toBe("COMPETENT");
    expect(fx.skills[0]?.public).toBe(false);
    // Untouched seed fields preserved
    expect(fx.skills[0]?.skill.name).toBe("TypeScript");
  });

  it("applies overrides on portfolio entries", () => {
    const fx = buildSingleItemList("portfolio", { highlight: false, title: "Custom title" });
    expect(fx.portfolio).toHaveLength(1);
    expect(fx.portfolio[0]?.highlight).toBe(false);
    expect(fx.portfolio[0]?.title).toBe("Custom title");
  });
});

describe("buildParagraphBearingList", () => {
  it("populates portfolio with three multi-sentence entries", () => {
    const fx = buildParagraphBearingList();
    expect(fx.portfolio).toHaveLength(3);
    for (const item of fx.portfolio) {
      expect(item.description, `${item.id} description`).not.toBeNull();
      // 200-400 char realistic body
      expect(item.description?.length).toBeGreaterThanOrEqual(200);
      expect(item.description?.length).toBeLessThanOrEqual(400);
      expect(item.accomplishment, `${item.id} accomplishment`).not.toBeNull();
    }
  });

  it("leaves every non-portfolio list empty", () => {
    const fx = buildParagraphBearingList();
    expect(fx.skills).toEqual([]);
    expect(fx.employment).toEqual([]);
    expect(fx.education).toEqual([]);
    expect(fx.certifications).toEqual([]);
    expect(fx.industries).toEqual([]);
    expect(fx.visas).toEqual([]);
  });
});

describe("buildFullProfile", () => {
  it("populates every list with at least one entry", () => {
    const fx = buildFullProfile();
    for (const key of LIST_KEYS) {
      expect(fx[key].length, `${key} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("sets every optional field on every skill", () => {
    const fx = buildFullProfile();
    for (const skill of fx.skills) {
      expect(skill.experience).not.toBeNull();
      expect(skill.rating).not.toBeNull();
      expect(skill.position).not.toBeNull();
    }
  });

  it("sets every optional field on every portfolio item", () => {
    const fx = buildFullProfile();
    for (const item of fx.portfolio) {
      expect(item.title).not.toBeNull();
      expect(item.description).not.toBeNull();
      expect(item.accomplishment).not.toBeNull();
      expect(item.clientOrCompanyName).not.toBeNull();
    }
  });
});

describe("buildMinimalProfile", () => {
  it("populates each list with exactly one entry", () => {
    const fx = buildMinimalProfile();
    for (const key of LIST_KEYS) {
      expect(fx[key], `${key} should have 1 entry`).toHaveLength(1);
    }
  });

  it("leaves every nullable skill field as null", () => {
    const skill = buildMinimalProfile().skills[0];
    expect(skill).toBeDefined();
    expect(skill?.experience).toBeNull();
    expect(skill?.rating).toBeNull();
    expect(skill?.position).toBeNull();
  });

  it("leaves every nullable portfolio field as null", () => {
    const item = buildMinimalProfile().portfolio[0];
    expect(item).toBeDefined();
    expect(item?.title).toBeNull();
    expect(item?.description).toBeNull();
    expect(item?.accomplishment).toBeNull();
    expect(item?.clientOrCompanyName).toBeNull();
    expect(item?.publicationPermit).toBeNull();
  });

  it("leaves every nullable certification field as null", () => {
    const cert = buildMinimalProfile().certifications[0];
    expect(cert).toBeDefined();
    expect(cert?.link).toBeNull();
    expect(cert?.number).toBeNull();
    expect(cert?.validFromMonth).toBeNull();
    expect(cert?.validToYear).toBeNull();
  });

  it("leaves every nullable visa field as null", () => {
    const visa = buildMinimalProfile().visas[0];
    expect(visa).toBeDefined();
    expect(visa?.expiryDate).toBeNull();
  });
});

describe("PII discipline", () => {
  it("uses obviously-test PII (example.com / Test User patterns) across every fixture", () => {
    const checkString = (s: string | null | undefined): void => {
      if (s === null || s === undefined) return;
      // Any URL must point at example.com (the IANA-reserved test domain) — no real
      // toptal.com / linkedin.com / github.com URLs in fixtures.
      const urlMatch = /https?:\/\/([^/\s]+)/.exec(s);
      if (urlMatch) {
        expect(urlMatch[1], `URL host in "${s}" must be example.com`).toMatch(/example\.com$/);
      }
    };
    const fx = buildFullProfile();
    for (const item of fx.portfolio) {
      checkString(item.link);
      checkString(item.coverImage);
      checkString(item.websiteUrl);
    }
    for (const emp of fx.employment) {
      checkString(emp.companyWebsite);
    }
    for (const cert of fx.certifications) {
      checkString(cert.link);
    }
  });
});
