// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  CERT_AWS_PRO,
  CERT_CKAD,
  EDUCATION_STANFORD_BS,
  EMPLOYMENT_PRINCIPAL_ENGINEER,
  EMPLOYMENT_SENIOR_ENGINEER,
  INDUSTRY_FINTECH,
  INDUSTRY_HEALTHTECH,
  PORTFOLIO_DISTRIBUTED_LEDGER,
  PORTFOLIO_EHR_GATEWAY,
  PORTFOLIO_OBSERVABILITY,
  SKILL_GRAPHQL,
  SKILL_KUBERNETES,
  SKILL_POSTGRES,
  SKILL_TYPESCRIPT,
  VISA_US,
} from "./data.js";
import type {
  Certification,
  Education,
  Employment,
  IndustryProfile,
  PortfolioItem,
  ProfileFixture,
  ProfileSkillSet,
  TravelVisa,
} from "./types.js";

/**
 * Map of `ProfileFixture` keys to the entity element type they hold. Keeps
 * `buildSingleItemList` strongly typed — the `overrides` parameter is
 * narrowed to the right partial shape per `name`.
 */
interface FixtureElementMap {
  skills: ProfileSkillSet;
  portfolio: PortfolioItem;
  employment: Employment;
  education: Education;
  certifications: Certification;
  industries: IndustryProfile;
  visas: TravelVisa;
}

/**
 * Default seed picked when `buildSingleItemList(name)` is called without
 * an explicit element. Each value is the canonical "first item" sample
 * for the named list (e.g., the TypeScript skill, the distributed-ledger
 * portfolio item) so the same fixture data drives both single-item and
 * full-profile snapshots.
 */
const DEFAULT_SEEDS: { [K in keyof FixtureElementMap]: FixtureElementMap[K] } = {
  skills: SKILL_TYPESCRIPT,
  portfolio: PORTFOLIO_DISTRIBUTED_LEDGER,
  employment: EMPLOYMENT_PRINCIPAL_ENGINEER,
  education: EDUCATION_STANFORD_BS,
  certifications: CERT_AWS_PRO,
  industries: INDUSTRY_FINTECH,
  visas: VISA_US,
};

/**
 * Empty-list fixture — every per-domain list resolves to `[]`. Drives the
 * empty-state rendering tests across the CLI / MCP formatter suite (`(no
 * skills)`, the empty-state wrapper from issue #122, etc.).
 *
 * Returns a fresh object on every call so test mutation in one suite cannot
 * leak into another.
 */
export function buildEmptyProfile(): ProfileFixture {
  return {
    skills: [],
    portfolio: [],
    employment: [],
    education: [],
    certifications: [],
    industries: [],
    visas: [],
  };
}

/**
 * Single-item-list fixture — populates exactly one item in the named
 * list, with every other list empty. Drives single-row rendering tests
 * where table format must not look ridiculous for a 1-row collection
 * (per issue body's edge-case enumeration).
 *
 * The element is shallow-merged from the canonical seed for `name` with
 * the caller-supplied `overrides`. Pass an empty object to use the seed
 * verbatim; pass partial overrides to pin specific fields (e.g.,
 * `{ highlight: false }`) without rebuilding the whole entity.
 */
export function buildSingleItemList<K extends keyof FixtureElementMap>(
  name: K,
  overrides?: Partial<FixtureElementMap[K]>,
): ProfileFixture {
  const seed = DEFAULT_SEEDS[name];
  const item = { ...seed, ...(overrides ?? {}) } as FixtureElementMap[K];
  const fixture = buildEmptyProfile();
  // The cast is necessary because TypeScript cannot statically prove that
  // `fixture[name]` accepts a `FixtureElementMap[K]`-typed array — but it
  // does: `ProfileFixture[K]` is `FixtureElementMap[K][]` for every K.
  (fixture[name] as FixtureElementMap[K][]) = [item];
  return fixture;
}

/**
 * Paragraph-bearing fixture — populates `portfolio` with three items,
 * each carrying a multi-sentence `description` (200-400 chars) plus an
 * `accomplishment` line. Drives the `reviews list`-style rendering tests
 * where table truncation must not destroy paragraph content (per parent
 * epic #121).
 *
 * Note on naming: the issue body referenced a `reviews` list, but the
 * production `reviews` domain (`profile.reviews`) is the admin
 * section-review queue (`SectionReview`) which has no prose body. The
 * paragraph-bearing entities in production are `PortfolioItem.description`
 * / `.accomplishment` and `Employment.experienceItems`. This builder uses
 * `portfolio` because it is the canonical paragraph-per-row shape for
 * list-format rendering. See `README.md` for the full rationale.
 */
export function buildParagraphBearingList(): ProfileFixture {
  return {
    ...buildEmptyProfile(),
    portfolio: [PORTFOLIO_DISTRIBUTED_LEDGER, PORTFOLIO_EHR_GATEWAY, PORTFOLIO_OBSERVABILITY],
  };
}

/**
 * Maximally-populated fixture — every list carries every sample item from
 * `data.ts` with every optional field set to a realistic, non-null value.
 * Drives the "complete profile" rendering tests where formatters must show
 * every column populated (no `(unset)` placeholders).
 */
export function buildFullProfile(): ProfileFixture {
  return {
    skills: [SKILL_TYPESCRIPT, SKILL_POSTGRES, SKILL_KUBERNETES, SKILL_GRAPHQL],
    portfolio: [PORTFOLIO_DISTRIBUTED_LEDGER, PORTFOLIO_EHR_GATEWAY, PORTFOLIO_OBSERVABILITY],
    employment: [EMPLOYMENT_PRINCIPAL_ENGINEER, EMPLOYMENT_SENIOR_ENGINEER],
    education: [EDUCATION_STANFORD_BS],
    certifications: [CERT_AWS_PRO, CERT_CKAD],
    industries: [INDUSTRY_FINTECH, INDUSTRY_HEALTHTECH],
    visas: [VISA_US],
  };
}

/**
 * Minimal-required-fields fixture — every list carries one entity with
 * only the production type's required (non-nullable) fields populated;
 * every nullable / optional field is set to `null` or omitted. Drives the
 * `(unset)` rendering tests where formatters must collapse missing
 * optional fields cleanly.
 *
 * The "required" set is determined by the production type definition:
 * any field typed `T` (without `| null` or `?`) is required. For example,
 * on `ProfileSkillSet`: `id`, `public`, `skill`, `connectionsCount` are
 * required; `experience`, `rating`, `position` are nullable.
 */
export function buildMinimalProfile(): ProfileFixture {
  const minimalSkill: ProfileSkillSet = {
    id: "sk_test_min_001",
    experience: null,
    rating: null,
    public: false,
    position: null,
    skill: { id: "skill_cat_min", name: "Test Skill" },
    connectionsCount: 0,
  };

  const minimalPortfolio: PortfolioItem = {
    id: "port_test_min_001",
    title: null,
    description: null,
    link: null,
    highlight: false,
    coverImage: null,
    accomplishment: null,
    publicationPermit: null,
    clientOrCompanyName: null,
    websiteUrl: null,
    toptalRelated: null,
    showViaToptal: null,
    kind: null,
    skills: [],
    industries: [],
  };

  const minimalEmployment: Employment = {
    id: "emp_test_min_001",
    company: "Test Company",
    position: "Test Role",
    companyWebsite: null,
    noWebsite: false,
    startDate: null,
    endDate: null,
    experienceItems: null,
    highlight: false,
    showViaToptal: false,
    toptalRelated: false,
    publicationPermit: null,
    reportingTo: null,
    industries: [],
    primaryGeography: null,
    employerId: null,
    skills: [],
    managementExperience: null,
  };

  const minimalEducation: Education = {
    id: "edu_test_min_001",
    institution: "Test Institution",
    degree: "Test Degree",
    fieldOfStudy: null,
    location: null,
    title: null,
    yearFrom: null,
    yearTo: null,
    highlight: false,
  };

  const minimalCertification: Certification = {
    id: "cert_test_min_001",
    certificate: "Test Certificate",
    institution: "Test Institution",
    link: null,
    number: null,
    validFromMonth: null,
    validFromYear: null,
    validToMonth: null,
    validToYear: null,
    highlight: false,
    status: null,
  };

  const minimalIndustry: IndustryProfile = {
    id: "ind_test_min_001",
    title: "Test Industry",
    about: null,
    domainArea: null,
    employments: [],
    educations: [],
    certifications: [],
    portfolioItems: [],
    highlights: [],
  };

  const minimalVisa: TravelVisa = {
    id: "visa_test_min_001",
    countryId: "country_test",
    countryName: "Testland",
    visaType: "Test",
    expiryDate: null,
  };

  return {
    skills: [minimalSkill],
    portfolio: [minimalPortfolio],
    employment: [minimalEmployment],
    education: [minimalEducation],
    certifications: [minimalCertification],
    industries: [minimalIndustry],
    visas: [minimalVisa],
  };
}
