// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type {
  Certification,
  Education,
  Employment,
  IndustryProfile,
  PortfolioItem,
  ProfileSkillSet,
  TravelVisa,
} from "./types.js";

/**
 * Realistic senior-developer fixture data, deliberately fixed (no
 * `new Date()` calls — every date is a hard-coded ISO 8601 string or
 * integer year/month) so snapshot diffs stay deterministic across runs
 * and CI hosts. IDs follow `<entity>_test_<NNN>` so a snapshot diff
 * reads cleanly.
 *
 * No PII: every URL points at the IANA-reserved `example.com` test
 * domain; every company / institution name is a fictitious placeholder
 * (`Acme Financial`, `Mercury Health`, `Stellar Logistics`,
 * `Test Institution`). The fixture entities don't carry email or
 * person-name fields directly — those live on shapes outside this
 * fixture's scope (e.g., the GraphQL `Viewer` type used by
 * `services/profile/__tests__/fixtures.ts`).
 *
 * The persona is loosely modeled on a Toptal-eligible senior backend
 * engineer — enough domain detail (TypeScript / PostgreSQL / Kubernetes
 * stack, distributed-systems portfolio, Stanford CS degree, AWS
 * certifications, fintech/healthtech industry tags) that table-format
 * rendering tests exercise realistic column widths instead of toy data
 * like `"foo"` / `"bar"`.
 */

// -----------------------------------------------------------------------
// Skills
// -----------------------------------------------------------------------

// `experience` is a count of months on the wire (see `ProfileSkillSet` —
// the CLI converts a duration string like `"5y"` to months before
// calling `set()`). The trailing `// N years` comments below name the
// month count's intent so readers don't have to divide by 12.

export const SKILL_TYPESCRIPT: ProfileSkillSet = {
  id: "sk_test_001",
  experience: 96, // 8 years
  rating: "EXPERT",
  public: true,
  position: 1,
  skill: { id: "skill_cat_ts", name: "TypeScript" },
  connectionsCount: 4,
};

export const SKILL_POSTGRES: ProfileSkillSet = {
  id: "sk_test_002",
  experience: 84, // 7 years
  rating: "EXPERT",
  public: true,
  position: 2,
  skill: { id: "skill_cat_pg", name: "PostgreSQL" },
  connectionsCount: 3,
};

export const SKILL_KUBERNETES: ProfileSkillSet = {
  id: "sk_test_003",
  experience: 48, // 4 years
  rating: "STRONG",
  public: true,
  position: 3,
  skill: { id: "skill_cat_k8s", name: "Kubernetes" },
  connectionsCount: 2,
};

export const SKILL_GRAPHQL: ProfileSkillSet = {
  id: "sk_test_004",
  experience: 60, // 5 years
  rating: "STRONG",
  public: true,
  position: 4,
  skill: { id: "skill_cat_gql", name: "GraphQL" },
  connectionsCount: 2,
};

// -----------------------------------------------------------------------
// Portfolio — paragraph-bearing entities (description + accomplishment)
// -----------------------------------------------------------------------

export const PORTFOLIO_DISTRIBUTED_LEDGER: PortfolioItem = {
  id: "port_test_001",
  title: "Distributed transaction ledger",
  description:
    "Designed and shipped a multi-region transaction ledger handling 12k writes/sec at p99 latency under 35ms. " +
    "Built on PostgreSQL logical replication with a custom conflict-resolution layer and an audit trail wired " +
    "into Kafka. Stack: TypeScript, Node 20, PostgreSQL 15, Kafka, Kubernetes on AWS EKS.",
  link: "https://example.com/case-studies/ledger",
  highlight: true,
  coverImage: "https://example.com/covers/ledger.png",
  accomplishment:
    "Cut reconciliation lead time from 18 hours to under 4 minutes; eliminated a recurring weekend on-call class.",
  publicationPermit: true,
  clientOrCompanyName: "Acme Financial",
  websiteUrl: "https://example.com/acme",
  toptalRelated: true,
  showViaToptal: true,
  kind: "classic",
  skills: [{ id: "sk_test_typescript", name: "TypeScript" }],
  industries: [{ id: "ind_test_finance", name: "Financial Software" }],
  details: null,
  files: [],
  kpis: [],
  quotes: [],
};

export const PORTFOLIO_EHR_GATEWAY: PortfolioItem = {
  id: "port_test_002",
  title: "FHIR-compliant EHR gateway",
  description:
    "Built a HIPAA-compliant gateway exposing a subset of FHIR R4 resources to third-party clinical apps. " +
    "Authentication via SMART-on-FHIR (OAuth 2 + OIDC); per-resource consent enforcement at the API gateway. " +
    "Operated 99.97% uptime over 14 months across three AWS regions.",
  link: "https://example.com/case-studies/fhir-gateway",
  highlight: true,
  coverImage: null,
  accomplishment: "Onboarded 11 partner clinics in the first quarter; passed an external HIPAA audit on first attempt.",
  publicationPermit: true,
  clientOrCompanyName: "Mercury Health",
  websiteUrl: "https://example.com/mercury",
  toptalRelated: false,
  showViaToptal: true,
  kind: "code_base",
  skills: [{ id: "sk_test_typescript", name: "TypeScript" }],
  industries: [{ id: "ind_test_healthcare", name: "Healthcare Software" }],
  details: null,
  files: [],
  kpis: [],
  quotes: [],
};

export const PORTFOLIO_OBSERVABILITY: PortfolioItem = {
  id: "port_test_003",
  title: "Internal observability platform",
  description:
    "Replaced a legacy logging stack with an OpenTelemetry-native observability platform for a 200-engineer org. " +
    "Unified logs, metrics, and traces under a single retention policy; reduced infra spend by 38% while " +
    "doubling cardinality.",
  link: "https://example.com/case-studies/observability",
  highlight: false,
  coverImage: null,
  accomplishment: "MTTR for production incidents dropped from 47 minutes to 11 minutes within two quarters of rollout.",
  publicationPermit: true,
  clientOrCompanyName: "Stellar Logistics",
  websiteUrl: null,
  toptalRelated: false,
  showViaToptal: false,
  kind: "basic",
  skills: [{ id: "sk_test_typescript", name: "TypeScript" }],
  industries: [{ id: "ind_test_software", name: "Software" }],
  details: null,
  files: [],
  kpis: [],
  quotes: [],
};

// -----------------------------------------------------------------------
// Employment — paragraph-bearing experienceItems
// -----------------------------------------------------------------------

export const EMPLOYMENT_PRINCIPAL_ENGINEER: Employment = {
  id: "emp_test_001",
  company: "Acme Financial",
  position: "Principal Engineer",
  companyWebsite: "https://example.com/acme",
  noWebsite: false,
  startDate: 2021,
  endDate: null, // current role
  experienceItems: [
    "Owned the architecture of the multi-region transaction ledger from prototype to production at 12k writes/sec.",
    "Mentored a team of 6 engineers; ran weekly architecture-review forums and pairing sessions on hard-to-debug latency tails.",
    "Drove the migration off a hand-rolled ORM onto Drizzle, removing ~14k lines of bespoke SQL plumbing.",
  ],
  highlight: true,
  showViaToptal: true,
  toptalRelated: false,
  publicationPermit: true,
  reportingTo: "VP of Engineering",
  industries: [{ id: "ind_test_software", name: "Software" }],
  primaryGeography: { id: "geo_test_us", code: "US", name: "United States" },
  employerId: "V1-Employer-test-001",
  employer: {
    id: "V1-Employer-test-001",
    name: "Acme Financial",
    city: "New York",
    country: "United States",
    logoUrl: "https://example.com/acme/logo.png",
    employeeCount: 5000,
    industries: [{ id: "ind_test_software", name: "Software" }],
  },
  skills: [{ id: "sk_test_typescript", name: "TypeScript" }],
  managementExperience: null,
  engagement: null,
  isEnterpriseExperience: false,
};

export const EMPLOYMENT_SENIOR_ENGINEER: Employment = {
  id: "emp_test_002",
  company: "Mercury Health",
  position: "Senior Software Engineer",
  companyWebsite: "https://example.com/mercury",
  noWebsite: false,
  startDate: 2017,
  endDate: 2021,
  experienceItems: [
    "Built the FHIR-compliant EHR gateway from green field to 11 partner clinics in production.",
    "Led the SMART-on-FHIR auth integration; co-authored an internal RFC adopted across two sister product teams.",
  ],
  highlight: true,
  showViaToptal: true,
  toptalRelated: false,
  publicationPermit: true,
  reportingTo: "Director of Engineering",
  industries: [{ id: "ind_test_health", name: "Healthcare" }],
  primaryGeography: { id: "geo_test_us", code: "US", name: "United States" },
  employerId: "V1-Employer-test-002",
  employer: {
    id: "V1-Employer-test-002",
    name: "Mercury Health",
    city: "Boston",
    country: "United States",
    logoUrl: "https://example.com/mercury/logo.png",
    employeeCount: 1200,
    industries: [{ id: "ind_test_health", name: "Healthcare" }],
  },
  skills: [{ id: "sk_test_typescript", name: "TypeScript" }],
  managementExperience: null,
  engagement: null,
  isEnterpriseExperience: false,
};

// -----------------------------------------------------------------------
// Education
// -----------------------------------------------------------------------

export const EDUCATION_STANFORD_BS: Education = {
  id: "edu_test_001",
  institution: "Stanford University",
  degree: "Bachelor of Science",
  fieldOfStudy: "Computer Science",
  location: "Stanford, CA",
  title: "BS, Computer Science",
  yearFrom: 2010,
  yearTo: 2014,
  highlight: true,
  skills: [],
};

// -----------------------------------------------------------------------
// Certifications
// -----------------------------------------------------------------------

export const CERT_AWS_PRO: Certification = {
  id: "cert_test_001",
  certificate: "AWS Certified Solutions Architect — Professional",
  institution: "Amazon Web Services",
  link: "https://example.com/cert/aws-pro",
  number: "AWS-SAP-12345",
  validFromMonth: 3,
  validFromYear: 2023,
  validToMonth: 3,
  validToYear: 2026,
  highlight: true,
  status: "valid",
  skills: [
    { id: "skill_test_aws_pro_1", name: "AWS" },
    { id: "skill_test_aws_pro_2", name: "Cloud Architecture" },
  ],
};

export const CERT_CKAD: Certification = {
  id: "cert_test_002",
  certificate: "Certified Kubernetes Application Developer",
  institution: "Cloud Native Computing Foundation",
  link: "https://example.com/cert/ckad",
  number: "CKAD-67890",
  validFromMonth: 6,
  validFromYear: 2022,
  validToMonth: 6,
  validToYear: 2025,
  highlight: false,
  status: "expired",
  skills: [],
};

// -----------------------------------------------------------------------
// Industries
// -----------------------------------------------------------------------

export const INDUSTRY_FINTECH: IndustryProfile = {
  id: "ind_test_001",
  title: "Financial services",
  about: "8 years building ledger, payments, and reconciliation systems for B2B fintech.",
  domainArea: "Payments and ledger",
  employments: [],
  educations: [],
  certifications: [],
  portfolioItems: [],
  highlights: [],
};

export const INDUSTRY_HEALTHTECH: IndustryProfile = {
  id: "ind_test_002",
  title: "Healthcare",
  about: "4 years on HIPAA-compliant clinical-data infrastructure and FHIR integrations.",
  domainArea: "Clinical data exchange",
  employments: [],
  educations: [],
  certifications: [],
  portfolioItems: [],
  highlights: [],
};

// -----------------------------------------------------------------------
// Travel visas
// -----------------------------------------------------------------------

export const VISA_US: TravelVisa = {
  id: "visa_test_001",
  countryId: "country_us",
  countryName: "United States",
  visaType: "B1/B2",
  expiryDate: "2030-06-15",
};
