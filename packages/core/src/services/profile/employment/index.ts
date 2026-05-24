// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { DRY_RUN_PROFILE_ID_PLACEHOLDER, ProfileError } from "../basic/index.js";
import { applyUserErrorsAndSuccess, callTalentProfile, ensureNoTopLevelErrors, extractProfileId } from "../shared.js";
import type { GraphQLErrorEntry, UserError } from "../shared.js";
import { buildDryRunPreview } from "../../../transport.js";
import type { DryRunPreview } from "../../../transport.js";

/**
 * `Employment` row as ttctl exposes it. Trimmed read-side projection of
 * the `Employment` GraphQL fragment (see
 * `research/graphql/talent_profile/fragments/Employment.graphql`). Years
 * are integers (`startDate`, `endDate`) per the empirical capture
 * `research/captures/web/inputs/UpdateEmploymentInput.json` and the
 * `GET_WORK_EXPERIENCE.snapshot.json` wire-shape snapshot (`startDate:
 * number`, `endDate: number | null`). `endDate` is `null` for current
 * positions.
 *
 * **Date-precision contract (#527)**: the wire type is `Int (year)`, NOT
 * a calendar date. The CLI/MCP tool surfaces accept ISO-8601 (YYYY-MM-DD)
 * as a convenience and normalize to year client-side via
 * `parseDateInput(...).year` — sub-year precision (month/day) is silently
 * dropped before the mutation. The public Toptal resume renders year
 * only, matching the stored value. This typing reflects what the wire
 * stores; callers passing YYYY-MM-DD on the surface see year-only behavior.
 *
 * The last four fields close the #344 read/write asymmetry; see
 * {@link mapEmploymentNode} for why the read shape uses nested
 * `industries` / `primaryGeography` rather than the scalar write-input
 * names.
 */
export interface Employment {
  id: string;
  company: string;
  position: string;
  companyWebsite: string | null;
  noWebsite: boolean;
  startDate: number | null;
  endDate: number | null;
  experienceItems: string[] | null;
  highlight: boolean;
  showViaToptal: boolean;
  toptalRelated: boolean;
  /** Whether the talent permits this row to be shown publicly (#344). */
  publicationPermit: boolean | null;
  /** Free-text reporting-line description (#344). */
  reportingTo: string | null;
  /** Catalog industries assigned to this row (#344). */
  industries: { id: string; name: string }[];
  /** The role's primary geography; `null` when unset (#344). */
  primaryGeography: { id: string; code: string | null; name: string | null } | null;
  /**
   * The catalog id of the resolved employer (#394 — surfaced read-side so
   * `update()` can echo it back through the merge; the wire's
   * `UpdateEmploymentInput` requires `employerId` even when the caller
   * only supplies `position`, and the read-side previously hid the id).
   */
  employerId: string | null;
  /**
   * Catalog skills attached to the row (#394 — surfaced read-side so
   * `update()` can preserve them through the merge; the wire requires
   * `skills` to be non-empty on update).
   */
  skills: { id: string; name: string }[];
  /** Management experience descriptor; force-echoed on UPDATE per #508. */
  managementExperience: { isLeadPosition: boolean; reportsRange: string | null } | null;
  /**
   * Link to a `TalentEngagement` when this employment row was logged
   * against a Toptal engagement (#554). `null` for rows that are not
   * tied to a Toptal engagement (the common case for pre-Toptal work
   * history). The wire selects `engagement { id }` only — additional
   * `TalentEngagement` fields (clientName, jobTitle, startDate, endDate,
   * status, jobPlainId) are NOT projected here; consumers wanting to
   * hydrate the engagement should fetch it explicitly via the
   * engagements surface. Schema-synth marked the field `Unknown`; the
   * shape `{ id: string }` is INFERRED from the canonical upstream
   * fragment at `research/graphql/talent_profile/fragments/Employment.graphql`
   * and validated by the `GET_WORK_EXPERIENCE` wire-shape snapshot (T1).
   */
  engagement: { id: string } | null;
  /**
   * Whether the role was enterprise-scoped at Toptal's tier-classification
   * level (#554). Schema-synth marked the field `Unknown`; treated as
   * `boolean | null` to accommodate rows where the server omits the flag
   * (older entries, non-Toptal-engagement rows). The boolean kind is
   * INFERRED from the canonical fragment selection (a primitive scalar
   * with no sub-selection), validated by the `GET_WORK_EXPERIENCE`
   * wire-shape snapshot (T1).
   */
  isEnterpriseExperience: boolean | null;
  /**
   * Hydrated employer-catalog card for the resolved employer (#555).
   * `null` for custom (non-catalog) workplaces — the same rows where
   * {@link Employment.employerId} is `null`. The wire selects a curated
   * subset of the canonical `Employer` fragment
   * (`research/graphql/talent_profile/fragments/Employer.graphql`):
   * `name`, `city`, `country`, `logoUrl`, `employeeCount`, and
   * `industries`. The remaining `Employer` fields (`revenue`,
   * `otherNames`, `otherUrls`, `lastSyncedAt`, `website`) are NOT
   * projected — deferred as a lower-priority follow-up per #555.
   *
   * Schema-synth marked every `Employer` field `Unknown`
   * (`research/graphql/talent_profile/schema.graphql`); the shapes are
   * INFERRED — `name` is a non-null display string, `city` / `country` /
   * `logoUrl` are nullable strings (matching the {@link EmployerSuggestion}
   * autocomplete shape), `employeeCount` is a nullable number (the web
   * app renders it through the same numeric formatter as the sibling
   * numeric `revenue` field), and `industries` is the same `{ id, name }[]`
   * connection projection used at the employment level. Validated by the
   * `GET_WORK_EXPERIENCE` wire-shape snapshot (T1).
   *
   * `employer.id` equals the flat {@link Employment.employerId} (both
   * derive from the single `employer { id … }` selection); `employerId`
   * remains the field consumed by the update-merge path (#394), while
   * `employer` is the display-side hydration. Consumers wanting `revenue`
   * or the other employer fields should fetch them via
   * `employersAutocomplete` or a future dedicated employer query.
   */
  employer: {
    id: string;
    name: string;
    city: string | null;
    country: string | null;
    logoUrl: string | null;
    employeeCount: number | null;
    industries: { id: string; name: string }[];
  } | null;
}

/**
 * Fields editable on an Employment row. Mirrors `EmploymentInput` per the
 * inferred shape in `research/notes/10-mutation-input-patterns.md`
 * (Pattern 1) and the live capture in
 * `research/captures/web/inputs/UpdateEmploymentInput.json`.
 *
 * The CLI exposes a curated subset: `--company`, `--role` (→ position),
 * `--from`, `--to`, `--current`, `--description` (→ experienceItems —
 * single-paragraph today; multi-paragraph splits on blank lines),
 * `--industry-id`, `--skill-id`, `--primary-geography-id` (#586 — the
 * role's primary geography; live-verified to persist on both the create
 * and update paths), and `--engagement-id` (#587 — the Toptal
 * engagement linkage; live-verified to persist on both the create and
 * update paths). The remaining fields (managementExperience,
 * reportingTo, …) are exposed at the type level so future leaves can
 * grow without churning callers.
 *
 * `employerId` is the server-side catalog identifier for the employer
 * record (e.g. "V1-Employer-1234"). `add()` requires EITHER an explicit
 * `employerId`, a `company` that resolves to exactly one autocomplete
 * match (see {@link add} for the resolution policy), OR the
 * {@link EmploymentFields.noEmployer} signal for a custom (non-catalog)
 * workplace — which sends `employerId: null` with the free-text
 * `company` verbatim. `employerId` and `noWebsite` are ORTHOGONAL axes
 * (#401): a custom workplace may still carry a website. The earlier
 * "nullable only when noWebsite" note was a single-capture
 * over-inference, not the wire contract.
 */
export interface EmploymentFields {
  company?: string;
  // write-only: catalog id consumed by autocomplete-resolution to materialize
  // the employer relationship; the resolved relationship is echoed via
  // company / companyWebsite / industries rather than the catalog id itself.
  employerId?: string;
  position?: string;
  companyWebsite?: string | null;
  noWebsite?: boolean;
  // #527: wire type is `Int (year)`. Callers using the CLI/MCP surface pass
  // YYYY-MM-DD or YYYY and `parseDateInput(...).year` strips month/day before
  // populating this field. Direct core consumers should pass a year integer.
  startDate?: number;
  // #527: wire type is `Int (year)` with `null` semantically meaning "current
  // role" (force-echo three-state, see {@link buildUpdateEmploymentInput} §
  // endDate force-echo). Sub-year precision is dropped client-side.
  endDate?: number | null;
  experienceItems?: string[];
  highlight?: boolean;
  publicationPermit?: boolean;
  showViaToptal?: boolean;
  toptalRelated?: boolean;
  industryIds?: string[];
  /**
   * Link this employment row to a Toptal **engagement**, as a
   * `TalentEngagement` catalog id (base64 `V1-TalentEngagement-<n>`).
   * Discover ids via `engagements.list()` — each list row's
   * `engagementId` field is exactly this value. Surfaced on
   * the CLI (`--engagement-id`) and MCP (`engagementId`) write paths in
   * #587; live-verified to accept + persist on BOTH `CreateEmployment`
   * and `UpdateEmployment` (round-trip in
   * `72-profile-employment-engagement.e2e.test.ts`). The
   * read echo is {@link Employment.engagement} (the nested `{ id }`
   * object, not the scalar write-input name) — the same field the
   * `employment_show` / `_list` surfaces have returned since #554.
   *
   * Relationship to {@link toptalRelated} (#402 / #587): the Toptal web
   * UI gates the "Is this experience related to a Toptal engagement?"
   * toggle on an engagement selection — setting `toptalRelated: true`
   * without a linkage leaves the row in the UI's "incomplete" state,
   * and `toptalRelated` reads back server-determined. Supplying
   * `engagementId` is the linkage half; the server owns the
   * `toptalRelated` read-state regardless (per #402). The surfaces
   * expose set-only (non-null) while the type permits `null`.
   */
  engagementId?: string | null;
  /**
   * The role's primary geography, as a Toptal **Country** catalog id
   * (base64 `V1-Country-<n>` — e.g. `VjEtQ291bnRyeS0yMzQ` = United States,
   * sourced from the `getCountries` query). Surfaced on the CLI
   * (`--primary-geography-id`) and MCP (`primaryGeographyId`) write paths
   * in #586; live-verified to accept + persist on BOTH `CreateEmployment`
   * and `UpdateEmployment` (round-trip in
   * `71-profile-employment-primary-geography.e2e.test.ts`). Setting it
   * satisfies the `EmploymentsMissingData` profile recommendation. The
   * read echo is {@link Employment.primaryGeography} (the nested
   * `{ id, code, name }` object, not the scalar write-input name). A
   * catalog-lookup command for discovering ids is tracked in #596; the
   * surfaces expose set-only (non-null) while the type permits `null`.
   */
  primaryGeographyId?: string | null;
  reportingTo?: string | null;
  /**
   * Catalog skill refs (wire shape: `SkillRefInput[]` = `{ id, name }[]`,
   * not the `string[]` originally declared — corrected #394 after the
   * live capture showed the live mutation accepts the object form and
   * rejects empty arrays on update).
   */
  skills?: { id: string; name: string }[];
  /** Wire: `ManagementExperienceInput { isLeadPosition: Boolean!, reportsRange: String }`. */
  managementExperience?: { isLeadPosition: boolean; reportsRange: string | null } | null;
  // write-only: request-shaping signal for the custom (non-catalog)
  // workplace path (#401). An add()-only signal: it selects
  // `employerId: null` + the free-text `company` verbatim and skips
  // employer-autocomplete; it is NOT an `EmploymentInput` wire field,
  // and `add()` strips it before the `CreateEmployment` mutation. It
  // has no meaning on the update path — `update()` /
  // `buildUpdateEmploymentInput` neither read nor strip it, so never
  // pass it there (the server would reject an unknown `EmploymentInput`
  // field). Not round-tripped: the resulting state is observable
  // read-side as `Employment.employerId === null`, never a field named
  // `noEmployer`. Orthogonal to `noWebsite` (a custom workplace may
  // still have a site).
  noEmployer?: boolean;
}

/**
 * Options accepted by {@link add}. `dryRun` mirrors the option-shape
 * established by `basic.set` (#393 / SetOptions) so the cross-service
 * surface stays uniform — callers that branch on the outcome's `kind`
 * discriminator can use the same code path regardless of which
 * mutation they're invoking.
 *
 * The `dryRun` path fires the employer autocomplete read so the preview
 * shows the resolved `employerId` (not the raw `company` string). This
 * departs from `basic.set`'s zero-network dry-run by design (#395):
 * the alternative — placeholder employerId — would misrepresent the
 * wire shape, since the server-side input requires the resolved id, not
 * the company name. EXCEPTION (#401): the custom-workplace path
 * (`fields.noEmployer === true`) skips resolution entirely, so dry-run
 * there fires ZERO network — `employerId: null` needs no lookup. The
 * mutation transport is still NEVER fired in `dryRun` mode.
 */
export interface AddOptions {
  dryRun?: boolean;
}

/**
 * Discriminated outcome of an {@link add} call when the apply-path
 * succeeded — the newly created {@link Employment} row.
 */
export interface AddOutcomeCreated {
  kind: "created";
  result: Employment;
}

/**
 * Discriminated outcome of an {@link add} call invoked with
 * `dryRun: true` — the structured preview of the request that WOULD
 * have been sent. The `employersAutocomplete` read query MAY have been
 * fired during dry-run to resolve `employerId`; the `CreateEmployment`
 * mutation transport was NOT fired.
 */
export interface AddOutcomePreview {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link add}. Apply-path callers
 * branch on `outcome.kind === "created"`; dry-run callers branch on
 * `"preview"`. Symmetric with `basic.set`'s {@link SetOutcome} (#393).
 */
export type AddOutcome = AddOutcomeCreated | AddOutcomePreview;

/**
 * Lightweight `Employer` reference returned by
 * `employer-autocomplete`. Mirrors the read-side `Employer` fragment
 * trimmed to the fields that matter at the catalog layer.
 */
export interface EmployerSuggestion {
  id: string;
  name: string;
  city: string | null;
  country: string | null;
  logoUrl: string | null;
  website: string | null;
}

const EMPLOYMENT_FRAGMENT = `fragment Employment on Employment {
  id
  company
  position
  companyWebsite
  noWebsite
  startDate
  endDate
  experienceItems
  highlight
  showViaToptal
  toptalRelated
  publicationPermit
  reportingTo
  industries { nodes { id name } }
  primaryGeography { id code name }
  employer { id name city country logoUrl employeeCount industries { nodes { id name } } }
  skills { nodes { id name } }
  managementExperience { isLeadPosition reportsRange }
  engagement { id }
  isEnterpriseExperience
}`;

const GET_WORK_EXPERIENCE_QUERY = `query GET_WORK_EXPERIENCE($profileId: ID!) {
  profile(id: $profileId) {
    id
    employments { nodes { ...Employment } }
  }
}
${EMPLOYMENT_FRAGMENT}`;

const CREATE_EMPLOYMENT_MUTATION = `mutation CreateEmployment($input: CreateEmploymentInput!) {
  createEmployment(input: $input) {
    success
    notice
    errors { code key message }
    profile { id employments { nodes { ...Employment } } }
  }
}
${EMPLOYMENT_FRAGMENT}`;

const UPDATE_EMPLOYMENT_MUTATION = `mutation UpdateEmployment($input: UpdateEmploymentInput!) {
  updateEmployment(input: $input) {
    success
    notice
    errors { code key message }
    profile { id employments { nodes { ...Employment } } }
  }
}
${EMPLOYMENT_FRAGMENT}`;

const REMOVE_EMPLOYMENT_MUTATION = `mutation RemoveEmployment($input: RemoveEmploymentInput!) {
  removeEmployment(input: $input) {
    success
    notice
    errors { code key message }
    profile { id employments { nodes { ...Employment } } }
  }
}
${EMPLOYMENT_FRAGMENT}`;

const HIGHLIGHT_EMPLOYMENT_MUTATION = `mutation highlightEmployment($id: ID!, $highlight: Boolean!) {
  highlightEmployment(input: { employmentId: $id, highlight: $highlight }) {
    success
    notice
    errors { code key message }
    employment { id highlight }
  }
}`;

const EMPLOYERS_AUTOCOMPLETE_QUERY = `query GET_EMPLOYERS_AUTOCOMPLETE($search: String!, $limit: Int!) {
  employersAutocomplete(search: $search, limit: $limit) {
    id
    name
    city
    country
    logoUrl
    website
  }
}`;

interface ListResponse {
  data?: { profile?: { id: string; employments: { nodes: (Record<string, unknown> | null)[] } } | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface MutationPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
  profile?: { id: string; employments: { nodes: (Record<string, unknown> | null)[] } } | null;
}

/**
 * Project a GraphQL `{ nodes }` connection of `{ id, name }` objects to a
 * flat `{ id: string; name: string }[]`, dropping any node whose `id` or
 * `name` is not a string. Shared by the three `{ id name }` connections
 * the employment read shape projects: the row-level `industries`,
 * `skills`, and the hydrated `employer.industries` (#555). Extracted from
 * the previously-inline industries/skills projections so the new
 * employer-card path reuses the identical defensive logic.
 */
function projectIdNameNodes(
  conn: { nodes?: { id?: unknown; name?: unknown }[] } | null | undefined,
): { id: string; name: string }[] {
  return Array.isArray(conn?.nodes)
    ? conn.nodes.flatMap((n) =>
        typeof n.id === "string" && typeof n.name === "string" ? [{ id: n.id, name: n.name }] : [],
      )
    : [];
}

/**
 * Map an Employment fragment node from the raw wire shape to the typed
 * {@link Employment}. Mirrors `mapPortfolioNode` in the portfolio
 * service — the wire surfaces `industries` / `primaryGeography` as a
 * nested connection / object, NOT the scalar `industryIds` /
 * `primaryGeographyId` of the write input, so a projection step (rather
 * than a direct cast) is required. Introduced for #344.
 */
function mapEmploymentNode(node: Record<string, unknown>): Employment {
  const industries = projectIdNameNodes(
    node["industries"] as { nodes?: { id?: unknown; name?: unknown }[] } | null | undefined,
  );
  const geoRaw = node["primaryGeography"] as { id?: unknown; code?: unknown; name?: unknown } | null | undefined;
  const primaryGeography =
    geoRaw && typeof geoRaw.id === "string"
      ? {
          id: geoRaw.id,
          code: typeof geoRaw.code === "string" ? geoRaw.code : null,
          name: typeof geoRaw.name === "string" ? geoRaw.name : null,
        }
      : null;
  const employerRaw = node["employer"] as
    | {
        id?: unknown;
        name?: unknown;
        city?: unknown;
        country?: unknown;
        logoUrl?: unknown;
        employeeCount?: unknown;
        industries?: { nodes?: { id?: unknown; name?: unknown }[] } | null;
      }
    | null
    | undefined;
  const employerId = employerRaw && typeof employerRaw.id === "string" ? employerRaw.id : null;
  // #555 — hydrated employer card. Built only when the wire returned an
  // employer object carrying a string `id` (catalog-resolved rows); the
  // custom-workplace rows where `employerId` is null collapse the whole
  // card to null (the gate mirrors the `engagement { id }` projection
  // below). Each scalar is independently typeof-guarded — synth SDL marks
  // every Employer field Unknown, so a wire drift collapses the individual
  // field to its null/empty default rather than fabricating a mistyped
  // value (`name` falls back to "" like the row-level `company`).
  const employer =
    employerRaw && typeof employerRaw.id === "string"
      ? {
          id: employerRaw.id,
          name: typeof employerRaw.name === "string" ? employerRaw.name : "",
          city: typeof employerRaw.city === "string" ? employerRaw.city : null,
          country: typeof employerRaw.country === "string" ? employerRaw.country : null,
          logoUrl: typeof employerRaw.logoUrl === "string" ? employerRaw.logoUrl : null,
          employeeCount: typeof employerRaw.employeeCount === "number" ? employerRaw.employeeCount : null,
          industries: projectIdNameNodes(employerRaw.industries),
        }
      : null;
  const skills = projectIdNameNodes(
    node["skills"] as { nodes?: { id?: unknown; name?: unknown }[] } | null | undefined,
  );
  const meRaw = node["managementExperience"] as { isLeadPosition?: unknown; reportsRange?: unknown } | null | undefined;
  const managementExperience =
    meRaw && typeof meRaw.isLeadPosition === "boolean"
      ? {
          isLeadPosition: meRaw.isLeadPosition,
          reportsRange: typeof meRaw.reportsRange === "string" ? meRaw.reportsRange : null,
        }
      : null;
  // #554 — engagement projection. The wire selects `engagement { id }`
  // only (no scalar fields beyond the id); when the row is not linked
  // to a Toptal engagement the field comes back `null`. Defensive shape
  // check mirrors the employer card's `id`-gate above — a missing or
  // string-less `id` collapses to `null` rather than fabricating a
  // partial-shape object.
  const engagementRaw = node["engagement"] as { id?: unknown } | null | undefined;
  const engagement = engagementRaw && typeof engagementRaw.id === "string" ? { id: engagementRaw.id } : null;
  // #554 — isEnterpriseExperience: synth-SDL `Unknown`; runtime branch
  // accepts boolean (the canonical fragment shape) and falls through
  // to `null` for any non-boolean / missing value.
  const isEnterpriseExperience =
    typeof node["isEnterpriseExperience"] === "boolean" ? node["isEnterpriseExperience"] : null;
  const rawItems = node["experienceItems"];
  return {
    id: typeof node["id"] === "string" ? node["id"] : "",
    company: typeof node["company"] === "string" ? node["company"] : "",
    position: typeof node["position"] === "string" ? node["position"] : "",
    companyWebsite: (node["companyWebsite"] as string | null | undefined) ?? null,
    noWebsite: Boolean(node["noWebsite"]),
    startDate: (node["startDate"] as number | null | undefined) ?? null,
    endDate: (node["endDate"] as number | null | undefined) ?? null,
    experienceItems: Array.isArray(rawItems)
      ? (rawItems as unknown[]).filter((x): x is string => typeof x === "string")
      : null,
    highlight: Boolean(node["highlight"]),
    showViaToptal: Boolean(node["showViaToptal"]),
    toptalRelated: Boolean(node["toptalRelated"]),
    publicationPermit: (node["publicationPermit"] as boolean | null | undefined) ?? null,
    reportingTo: typeof node["reportingTo"] === "string" ? node["reportingTo"] : null,
    industries,
    primaryGeography,
    employerId,
    employer,
    skills,
    managementExperience,
    engagement,
    isEnterpriseExperience,
  };
}

interface HighlightPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
  employment?: { id: string; highlight: boolean } | null;
}

interface MutationResponse {
  data?: Record<string, MutationPayload | HighlightPayload | null> | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface AutocompleteResponse {
  data?: { employersAutocomplete?: EmployerSuggestion | EmployerSuggestion[] | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * List the signed-in user's employment rows.
 *
 * Issues `GET_WORK_EXPERIENCE` against the talent-profile surface; keyed
 * by the user's `profileId`. The read-side query also returns `countries`
 * — ttctl ignores it for now.
 */
export async function list(token: string): Promise<Employment[]> {
  const profileId = await extractProfileId(token);
  return listByProfileId(token, profileId);
}

/**
 * Internal helper: list employment rows when the caller has already
 * resolved `profileId` (used by `add()` to avoid double-round-tripping).
 */
async function listByProfileId(token: string, profileId: string): Promise<Employment[]> {
  const res = await callTalentProfile(
    token,
    "GET_WORK_EXPERIENCE",
    GET_WORK_EXPERIENCE_QUERY,
    { profileId },
    "employment list",
  );
  const body = res.body as ListResponse | null;
  ensureNoTopLevelErrors(body, "employment list");
  const profile = body?.data?.profile;
  if (!profile) throw new ProfileError("UNKNOWN", "employment list response had no `data.profile` field");
  return profile.employments.nodes.filter((n): n is Record<string, unknown> => n !== null).map(mapEmploymentNode);
}

/**
 * Look up a single employment row by id. Throws `VALIDATION_ERROR` when
 * no matching row exists.
 */
export async function show(token: string, id: string): Promise<Employment> {
  const all = await list(token);
  const found = all.find((e) => e.id === id);
  if (!found) {
    throw new ProfileError("VALIDATION_ERROR", `Employment with id "${id}" not found on this profile.`);
  }
  return found;
}

/**
 * Create a new employment row. Wire format per Pattern 2: `{ profileId,
 * employment: EmploymentInput }`.
 *
 * **employerId resolution (#395)**: the live `talent_profile/graphql`
 * server requires `employment.employerId` (the catalog identifier),
 * NOT the free-text `company` string. Pre-#395, `add({company, role,
 * …})` sent only the company string and was rejected with
 * `USER_ERROR: employment add rejected (employerId): You can't leave
 * this empty`. The fix:
 *
 *   1. If `fields.employerId` is supplied → use it verbatim. This is
 *      the explicit-bypass path (`--employer-id` on CLI,
 *      `employerId` on MCP) — useful for replay scripts, the
 *      disambiguation fallback, or known-good ids.
 *   2. Otherwise, fire {@link employerAutocomplete} against
 *      `fields.company`. Toptal's autocomplete is fuzzy / prefix-
 *      search (typing "Anthropic" returns 10 partial matches), so the
 *      practical cardinality is on EXACT NAME MATCH (case-insensitive
 *      trim):
 *        - exactly 1 exact match → use its id transparently
 *        - 2+ exact matches (catalog duplicates — e.g. multiple
 *          regional subsidiaries with the same display name) →
 *          `VALIDATION_ERROR` listing the duplicates + `--employer-id`
 *          nudge
 *        - 0 exact, 0 fuzzy → `VALIDATION_ERROR` nudging to the
 *          autocomplete CLI command or `--employer-id` bypass
 *        - 0 exact, ≥1 fuzzy → `VALIDATION_ERROR` listing the top-N
 *          closest candidates with `--employer-id` nudge (the user
 *          typed a prefix; surface the catalog's actual names)
 *
 * The static defaults at `experienceItems: []`, `skills: []`,
 * `showViaToptal: true` are retained pre-#395 — they were established
 * empirically via the #344 E2E to satisfy "Expected value to not be
 * null" on those required fields. Reviewing them in this PR would
 * be premature without a fresh live capture; they may be revisited in
 * a follow-up that mirrors the basic.set #393 read-merge pattern for
 * employment.add.
 *
 * **Dry-run path (#395)**: when `options.dryRun === true`, the
 * employer resolution still runs (fires `employersAutocomplete` if
 * `employerId` is absent — except on the #401 custom-workplace path;
 * see **Custom-workplace path (#401)** below) so the preview's
 * `variables.input.employment`
 * carries the resolved `employerId`, matching the wire shape the live
 * mutation would transmit. The `CreateEmployment` mutation transport
 * is NOT invoked. The placeholder
 * {@link DRY_RUN_PROFILE_ID_PLACEHOLDER} stands in for `profileId`
 * (which the apply-path resolves via `extractProfileId`).
 *
 * **Custom-workplace path (#401)**: when `fields.noEmployer === true`,
 * `resolveEmployerId()` is skipped entirely — NO `employersAutocomplete`
 * call in EITHER the apply or dry-run path — and `employerId: null` is
 * sent with the free-text `company`. Mutually exclusive with an explicit
 * `fields.employerId` (→ `VALIDATION_ERROR`). Orthogonal to `noWebsite`.
 */
export async function add(token: string, fields: EmploymentFields, options: AddOptions = {}): Promise<AddOutcome> {
  if (!fields.company || !fields.position) {
    throw new ProfileError("VALIDATION_ERROR", "employment add requires --company and --role.");
  }

  // Custom (non-catalog) workplace path (#401): when `noEmployer` is
  // set, the Toptal "Add as new: <name>" behaviour applies — the wire
  // takes `employerId: null` with the free-text `company` verbatim
  // (there is no `CreateEmployer` mutation anywhere in the schema). It
  // is orthogonal to `noWebsite` (a custom workplace may still have a
  // website) and mutually exclusive with an explicit `employerId` (a
  // catalog id and "not in the catalog" are contradictory).
  if (fields.noEmployer === true && fields.employerId !== undefined && fields.employerId !== "") {
    throw new ProfileError(
      "VALIDATION_ERROR",
      "employment add: a custom workplace (--no-employer) cannot also pass --employer-id (a catalog id). Use one or the other.",
    );
  }

  // CREATE-side anchor contract (#484, live-settled 2026-05-20): on the
  // `noEmployer:true` path the Rails server's `employer_id` `.blank?`
  // validator runs unless the row carries an anchor — either (a) a
  // `companyWebsite` URL signal OR (b) an explicit `noWebsite:true`
  // "intentionally no website" signal. With neither, the server falls
  // through to demanding `employer_id` and returns the confusing
  // `USER_ERROR: employment add rejected (employerId): You can't leave
  // this empty` — which is the SAME wire signature as the #401 / WORM
  // gate on UPDATE, but the cause is different (the CREATE path can be
  // satisfied with `noWebsite:true`; the UPDATE path on a null-
  // employerId row CANNOT — see WORM note). Refuse client-side with an
  // actionable message instead of letting the wire produce that error.
  // Settled by E2E #484 (`45-profile-employment-add.e2e.test.ts`).
  if (
    fields.noEmployer === true &&
    (fields.companyWebsite === undefined || fields.companyWebsite === null || fields.companyWebsite === "") &&
    fields.noWebsite !== true
  ) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      "employment add: a custom workplace (--no-employer) requires either --website <url> (the company's website) OR --no-website (explicit no-website signal). Without either, the Toptal server rejects the row with a misleading `employerId: You can't leave this empty` error. See research/notes/15-employment-custom-workplace-worm.md § CREATE-side anchor contract.",
    );
  }

  // #492 — server-side 50-250 char/item gate. Validate client-side
  // before EITHER the apply or dryRun path so the dryRun preview is a
  // trustworthy pre-flight gate. (Fires after the anchor / contradiction
  // guards above so the more-specific shape errors still surface first.)
  if (fields.experienceItems !== undefined) {
    validateExperienceItems(fields.experienceItems);
  }

  // Resolve employerId BEFORE branching on dryRun so the preview's wire
  // shape matches what the live mutation would transmit (#395 explicit
  // AC). The autocomplete query is a read, not a mutation — it fires in
  // both dry-run and apply paths. The custom-workplace path (#401) skips
  // resolution entirely: NO autocomplete network call in EITHER path
  // (apply or dry-run), and `employerId: null` goes on the wire.
  const { noEmployer, ...wireFields } = fields;
  const employerId: string | null = noEmployer === true ? null : await resolveEmployerId(token, wireFields);

  // The wire requires several non-null fields on `CreateEmployment`
  // (live API rejects with "Expected value to not be null" / "You can't
  // leave this empty" otherwise). The defaults below were established
  // empirically through E2E iteration — DO NOT add pre-emptive defaults
  // for fields the server hasn't explicitly demanded, since
  // `CreateEmploymentInput` rejects unknown fields with
  // "Field is not defined on EmploymentInput" (e.g. `toptalRelated`,
  // `highlight` are valid on `UpdateEmploymentInput` but NOT on
  // `CreateEmploymentInput`). The request-shaping `noEmployer` signal is
  // destructured out above for the same reason — it is not an
  // `EmploymentInput` field.
  //   - `experienceItems`, `skills`, `showViaToptal` — via the #344 E2E
  //   - `publicationPermit` — server treats Boolean `false` as blank
  //     (USER_ERROR "publicationPermit: You can't leave this empty");
  //     default to `true` to satisfy the Rails `.blank?` gate. Mirrors the
  //     `buildUpdateEmploymentInput` fallback (`current.publicationPermit
  //     ?? true`) so add/update agree on the no-caller-input semantics.
  //     NOTE (#488): the field's PERSISTED-state on update is server-
  //     controlled (sending `true` does NOT guarantee a `false`-current
  //     row flips to `true`, mirroring `toptalRelated`); the create-side
  //     default here only satisfies the input-side `.blank?` gate. The
  //     field does NOT gate public resume listing.
  // Callers may still override.
  const employment: Omit<EmploymentFields, "noEmployer" | "employerId"> & { employerId: string | null } = {
    experienceItems: [],
    skills: [],
    showViaToptal: true,
    publicationPermit: true,
    ...wireFields,
    employerId,
  };

  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "talent-profile",
        authToken: token,
        body: {
          operationName: "CreateEmployment",
          query: CREATE_EMPLOYMENT_MUTATION,
          variables: { input: { profileId: DRY_RUN_PROFILE_ID_PLACEHOLDER, employment } },
        },
      }),
    };
  }

  const profileId = await extractProfileId(token);
  const before = await listByProfileId(token, profileId);
  const beforeIds = new Set(before.map((e) => e.id));
  const res = await callTalentProfile(
    token,
    "CreateEmployment",
    CREATE_EMPLOYMENT_MUTATION,
    { input: { profileId, employment } },
    "employment add",
  );
  const payload = unwrapMutation(res, "createEmployment", "employment add");
  const after =
    payload.profile?.employments.nodes.filter((n): n is Record<string, unknown> => n !== null).map(mapEmploymentNode) ??
    [];
  const created = after.find((e) => !beforeIds.has(e.id));
  if (!created) {
    throw new ProfileError("UNKNOWN", "employment add returned success but no new row was found in the response.");
  }
  return { kind: "created", result: created };
}

/**
 * Resolve `fields.employerId` for the create-employment flow (#395).
 *
 *   - Explicit `fields.employerId` → returned verbatim (bypass).
 *   - Otherwise call {@link employerAutocomplete}; Toptal's autocomplete
 *     is fuzzy / prefix-search, so the practical cardinality is on
 *     **exact name match** (case-insensitive, trimmed):
 *       - 1 exact match → transparent use
 *       - 0 exact, 0 fuzzy → "No employer matched" nudge
 *       - 0 exact, ≥1 fuzzy → "No exact match; closest candidates"
 *         listing + `--employer-id` nudge (the user typed a prefix /
 *         substring; we surface the catalog's actual names so they can
 *         pick an id)
 *       - 2+ exact → disambiguation listing of the duplicates (the
 *         catalog has multiple records with the same display name —
 *         common for companies with city subsidiaries; the user must
 *         pick one)
 *
 * Errors all surface as `VALIDATION_ERROR` with actionable recovery
 * text so the CLI / MCP layer can render them as user-facing
 * messages without further classification.
 */
async function resolveEmployerId(token: string, fields: EmploymentFields): Promise<string> {
  if (fields.employerId !== undefined && fields.employerId !== "") {
    return fields.employerId;
  }
  // `fields.company` is asserted non-empty by the caller (the add()
  // pre-flight rejects an empty company / position).
  const company = fields.company ?? "";
  const matches = await employerAutocomplete(token, company);
  const norm = company.trim().toLowerCase();
  const exact = matches.filter((m) => m.name.trim().toLowerCase() === norm);

  if (exact.length === 1) {
    const only = exact[0];
    if (only === undefined) {
      // Defensive: exact.length === 1 but indexed read is undefined —
      // a TypeScript noUncheckedIndexedAccess guard. Unreachable at
      // runtime.
      throw new ProfileError(
        "UNKNOWN",
        "employer-autocomplete returned 1 exact match but indexing it yielded undefined.",
      );
    }
    return only.id;
  }

  if (exact.length >= 2) {
    // Multiple catalog records share the user-supplied exact name
    // (common for global companies with regional subsidiaries listed
    // separately). Surface only the exact-name duplicates — the fuzzy
    // siblings would just add noise.
    const list = exact.map(formatCandidate).join("\n");
    throw new ProfileError(
      "VALIDATION_ERROR",
      `Multiple employers matched "${company}" exactly (${exact.length.toString()} duplicates in the catalog):\n` +
        `${list}\n` +
        `Pass \`--employer-id <id>\` to disambiguate.`,
    );
  }

  // exact.length === 0
  if (matches.length === 0) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      `No employer matched "${company}". Use ` +
        `\`ttctl profile employment employer-autocomplete <query>\` to search the catalog, ` +
        `or pass \`--employer-id <id>\` to bypass autocomplete.`,
    );
  }

  // 0 exact, ≥1 fuzzy. Surface the catalog's actual names so the user
  // can refine (or pick an id directly).
  const top = matches.slice(0, 5);
  const list = top.map(formatCandidate).join("\n");
  throw new ProfileError(
    "VALIDATION_ERROR",
    `No exact match for "${company}" in the employer catalog ` +
      `(${matches.length.toString()} fuzzy match${matches.length === 1 ? "" : "es"}; showing top ${top.length.toString()}):\n` +
      `${list}\n` +
      `Refine the company string to the exact catalog name, or pass \`--employer-id <id>\` to bypass autocomplete.`,
  );
}

function formatCandidate(m: EmployerSuggestion): string {
  const loc = [m.city, m.country].filter((v): v is string => v !== null && v !== "").join(", ");
  return `  - ${m.id}  ${m.name}${loc ? ` (${loc})` : ""}`;
}

/**
 * Server-side length bounds on each `experienceItem` paragraph (#492).
 *
 * Toptal's `talent_profile/graphql` server enforces a per-paragraph
 * length rule on `employment.experienceItems`: each item must be
 * **between 50 and 250 characters** (inclusive lower bound, exclusive
 * upper bound — empirically the server message reads "at least 50 and
 * less than 250 characters"). Violating it returns:
 *
 *   `employment add rejected (experienceItems): Each item must have at
 *    least 50 and less than 250 characters`
 *
 * The constraint is server-side, so pre-#492 it surfaced only on live
 * mutations — the dryRun preview passed, the live call rejected. This
 * gives false confidence on agentic / batch flows that compose
 * descriptions from prose. Validating client-side closes that gap for
 * both apply and dryRun.
 */
const EXPERIENCE_ITEM_MIN_CHARS = 50;
const EXPERIENCE_ITEM_MAX_CHARS = 250;

/**
 * Validate each `experienceItem` paragraph against the server's
 * 50–250 char/item rule (#492). Throws `ProfileError(VALIDATION_ERROR)`
 * on the first offender, naming its index, length, and a truncated
 * preview so the caller can locate the offending paragraph.
 *
 * Empty arrays pass silently (the server accepts `experienceItems: []`
 * — the wire-required-non-null gate is on the FIELD's presence, not on
 * any per-item content). Whitespace-only items are out of band — the
 * `splitParagraphs` helper drops them upstream; this validator does NOT
 * re-trim before measuring (the wire shape captures whatever the caller
 * passed verbatim, modulo the splitter).
 *
 * Exported so the MCP `update` tool can run the same gate before
 * building its dryRun preview (the dryRun branch in the MCP layer does
 * NOT route through `buildUpdateEmploymentInput`, so the core's
 * embedded check would not fire there).
 */
export function validateExperienceItems(items: readonly string[]): void {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue; // noUncheckedIndexedAccess guard; unreachable.
    const len = item.length;
    if (len < EXPERIENCE_ITEM_MIN_CHARS || len >= EXPERIENCE_ITEM_MAX_CHARS) {
      const preview = item.length > 40 ? `${item.slice(0, 37)}...` : item;
      throw new ProfileError(
        "VALIDATION_ERROR",
        `experienceItems[${i.toString()}] is ${len.toString()} characters; ` +
          `each paragraph must be between ${EXPERIENCE_ITEM_MIN_CHARS.toString()} and ${EXPERIENCE_ITEM_MAX_CHARS.toString()} characters ` +
          `(the Toptal server rejects out-of-range items with USER_ERROR on the live wire). ` +
          `Offending paragraph: "${preview}"`,
      );
    }
  }
}

/**
 * Placeholder string substituted into a dry-run `UpdateEmployment`
 * preview's variables payload for fields that the apply-path resolves by
 * reading the current row (`experienceItems`, `position`, `skills`,
 * `showViaToptal`, `startDate` — the five required-non-null fields
 * injected by the read-current+merge logic, #394 + #407 for `position`).
 * Surfaced verbatim so MCP consumers can
 * see the structural shape of what will be sent without TTCtl having
 * fired the read transport. Same posture as `basic.set`'s
 * {@link DRY_RUN_PROFILE_ID_PLACEHOLDER} — preserves the zero-transport-
 * in-dry-run invariant (#165 / #379) while honoring #394's AC that the
 * preview shows the full merged shape.
 */
export const DRY_RUN_EMPLOYMENT_MERGE_PLACEHOLDER = "<resolved at send-time by reading current state>" as const;

/**
 * Build the merged `EmploymentInput` to send for an `UpdateEmployment`
 * mutation by reading the current row and overlaying user-supplied fields.
 *
 * The `talent_profile/graphql` server treats five `EmploymentInput` fields
 * as required non-null on `UpdateEmployment` and rejects the whole
 * variables payload with `"Expected value to not be null"` when they are
 * absent (#394 + #407 for `position` — wire-broke meta-class #392). The
 * five fields are `experienceItems`, `position`, `showViaToptal`,
 * `startDate`, and `skills`. This helper injects them from the current
 * state where the EMPLOYMENT_FRAGMENT surfaces them (`experienceItems`,
 * `position`, `showViaToptal`, `startDate`) and defaults `skills: []`
 * because the fragment does not currently select the read-side `skills`
 * connection.
 *
 * **endDate force-echo (#487)**: `endDate` is NOT a wire-required-non-
 * null field (the schema declares it nullable), but the Rails server
 * treats absence of `endDate` from `UpdateEmploymentInput` as `null`
 * — NOT as "preserve current". Live-confirmed (#487, 2026-05-21):
 * partial updates on closed roles silently wiped the stored end date,
 * converting "Year – Year" to "Year – Present" on the public profile.
 * Fix: force-echo `endDate` symmetric to `startDate`, with a three-
 * state semantic (caller `undefined` → preserve current; `null` →
 * clear / mark as current role; `number` → set to year). The
 * explicit identity check (not `??`) is required because `null` is
 * a meaningful intentional value here.
 *
 * **Per-field caution on the broader force-echo class**: a tempting
 * generalization is "echo every read-side-surfaced field from
 * current state" as a defense-in-depth invariant. Empirically this
 * was attempted and rolled back during #487's PR cycle on the
 * CATALOG-employer branch: echoing `(companyWebsite, noWebsite)` on
 * a catalog-employer row triggers a Rails anchor gate (same class
 * as the #484 CREATE-side anchor contract): `(employerId): You
 * should specify either employer or company website` — observed
 * against tests 46 / 52 sentinels using a real catalog employer.
 * The wire treats explicit-null/false on those fields differently
 * from absence on catalog rows. `highlight` and `toptalRelated`
 * were rolled back at the same time, pending per-field live
 * verification (untested individually). The "echo everything"
 * invariant is therefore NOT universal on this surface; the per-
 * field empirical evidence matters. Other nullable optionals on
 * this surface may exhibit the same #487 omission-is-null wire
 * semantic; if reported, treat each as a separate live-capture
 * regression.
 *
 * **#508 noEmployer branch**: on `current.employerId === null` rows the
 * `(noWebsite, companyWebsite)` anchor pair MUST be echoed — otherwise
 * the Rails apply path emits the misleading
 * `(employerId): You can't leave this empty`. `employerId` stays
 * omitted on this branch (per captured 2026-05-21 payload).
 * `toptalRelated` and `managementExperience` are force-echoed
 * unconditionally for the same captured-payload reason.
 *
 * **Known limitation (#394)**: `skills` defaults to `[]` because the
 * current read fragment does not surface skills. Calling `update()` on a
 * row that has skills will reset them to empty. A follow-up will extend
 * the fragment to read skills and preserve them through the merge; for
 * the test-account this is acceptable, and the bug fix here is for the
 * minimal `{id, role}` repro that previously failed at the wire layer
 * regardless of skills state.
 *
 * Exported so the MCP layer can build the same merged input for the
 * dry-run preview (AC: "Dry-run preview shows the full merged input").
 *
 * @throws `ProfileError("VALIDATION_ERROR")` when `fields` is empty.
 * @throws `ProfileError("VALIDATION_ERROR")` when `current.startDate` is
 *   `null` and the caller did not supply a `startDate` override — the
 *   wire requires a non-null `startDate` and we have nothing to send.
 */
export function buildUpdateEmploymentInput(current: Employment, fields: EmploymentFields): EmploymentFields {
  if (Object.keys(fields).length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "employment update requires at least one field flag.");
  }
  // #492 — same server-side 50-250 char/item gate that applies to add().
  // Catches mistakes before the wire so the live mutation is not the
  // first place a too-long paragraph surfaces. Caller-supplied items
  // only — the read-current echo path is server-vetted state already.
  if (fields.experienceItems !== undefined) {
    validateExperienceItems(fields.experienceItems);
  }
  const startDate = fields.startDate ?? current.startDate;
  if (startDate === null) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      `Cannot update employment "${current.id}": startDate is required and current value is null. Supply --from to set a year.`,
    );
  }
  // #487 — endDate three-state merge. Explicit identity check (not
  // `??`) because `null` is an intentional value (mark a closed role
  // as current). Echoed unconditionally below.
  const endDate = fields.endDate === undefined ? current.endDate : fields.endDate;
  // Server-side Rails `.blank?` gates (USER_ERROR "You can't leave this
  // empty") — surfaced by the #394 live capture (2026-05-19): when the
  // caller omits these, the wire layer accepts the partial input but
  // the Rails apply path rejects it. Inject from the current row so
  // user-supplied fields can still override. Optional pass-throughs
  // (employerId / engagementId / primaryGeographyId / reportingTo) are
  // only set when the current row has a non-null value — sending an
  // explicit null would change the row's state, which would defeat "merge".
  //
  const merged: EmploymentFields = {
    // Wire-required non-null (GraphQL `Expected value to not be null`):
    experienceItems: current.experienceItems ?? [],
    // #407 — same wire-required non-null class: server rejects with
    // `Expected value to not be null` for `employment.position` on any
    // partial update that omits it. EMPLOYMENT_FRAGMENT selects `position`
    // so `current.position` is always available to thread through.
    position: current.position,
    // Preserve current row's skills through the merge — server rejects
    // `skills: []` with "is too short (minimum is 1 character)" on
    // update (#394 live-capture finding 2026-05-19). The EMPLOYMENT_FRAGMENT
    // now selects `skills { nodes { id name } }` so `current.skills` is
    // populated; pre-#394 it was always `[]` and update() defaulted to
    // empty, which is what the live wire was rejecting.
    skills: current.skills,
    showViaToptal: current.showViaToptal,
    // #508 — echoed; see helper-doc § #508 noEmployer branch.
    toptalRelated: current.toptalRelated,
    startDate,
    // #487 — force-echoed because the wire treats omission as null-set
    // (NOT preservation). See helper-doc § endDate force-echo. Other
    // nullable optionals on this surface intentionally NOT echoed per
    // the per-field caution noted in the helper-doc.
    endDate,
    // Rails `.blank?` gates:
    company: current.company,
    publicationPermit: current.publicationPermit ?? true,
    // industryIds: catalog refs the wire requires present and non-empty
    // on the apply path.
    industryIds: current.industries.map((i) => i.id),
  };
  // #508 — branch on current.employerId:
  //   catalog rows  → echo employerId, OMIT anchor pair (echoing trips
  //                   "either employer or company website" gate, #487).
  //   noEmployer rows → OMIT employerId, echo anchor pair (captured
  //                   2026-05-21 payload — needed to satisfy the
  //                   inverted .blank? on employer_id Rails gate).
  if (current.employerId !== null) {
    merged.employerId = current.employerId;
  } else {
    merged.noWebsite = current.noWebsite;
    merged.companyWebsite = current.companyWebsite;
  }
  merged.managementExperience = current.managementExperience;
  if (current.primaryGeography !== null) {
    merged.primaryGeographyId = current.primaryGeography.id;
  }
  // #587 — echo the engagement linkage from current so a partial update
  // preserves it. Mirrors the primaryGeography echo above: the read shape
  // surfaces the nested `engagement { id }` (#554) while the write input
  // is the scalar `engagementId`. Only set when the row is actually
  // linked — omitting it (engagement === null) keeps an unlinked row
  // unlinked, and sending an explicit null is unnecessary on the
  // already-null case.
  if (current.engagement !== null) {
    merged.engagementId = current.engagement.id;
  }
  if (typeof current.reportingTo === "string") {
    merged.reportingTo = current.reportingTo;
  }
  return { ...merged, ...fields };
}

/**
 * Update an existing employment row. Wire format per Pattern 1:
 * `{ employmentId, employment: EmploymentInput }`.
 *
 * Reads the current row first and merges the five required-non-null
 * fields onto the wire input (see {@link buildUpdateEmploymentInput} for
 * the merge contract and #394 + #407 for the originating wire-broke incidents).
 */
export async function update(token: string, id: string, fields: EmploymentFields): Promise<Employment> {
  if (Object.keys(fields).length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "employment update requires at least one field flag.");
  }
  const current = await show(token, id);
  const employment = buildUpdateEmploymentInput(current, fields);
  const res = await callTalentProfile(
    token,
    "UpdateEmployment",
    UPDATE_EMPLOYMENT_MUTATION,
    { input: { employmentId: id, employment } },
    "employment update",
  );
  const payload = unwrapMutation(res, "updateEmployment", "employment update");
  const updated = payload.profile?.employments.nodes
    .filter((n): n is Record<string, unknown> => n !== null)
    .map(mapEmploymentNode)
    .find((e) => e.id === id);
  if (!updated) {
    throw new ProfileError("UNKNOWN", `employment update returned success but row "${id}" was not in the response.`);
  }
  return updated;
}

/**
 * Remove an employment row. Wire format per Pattern 3: `{ employmentId }`.
 */
export async function remove(token: string, id: string): Promise<string> {
  const res = await callTalentProfile(
    token,
    "RemoveEmployment",
    REMOVE_EMPLOYMENT_MUTATION,
    { input: { employmentId: id } },
    "employment remove",
  );
  unwrapMutation(res, "removeEmployment", "employment remove");
  return id;
}

/**
 * Toggle the `highlight` flag on an employment row. Wire format per
 * Pattern 4: `{ employmentId, highlight: Boolean }`.
 */
export async function highlight(token: string, id: string, value = true): Promise<{ id: string; highlight: boolean }> {
  const res = await callTalentProfile(
    token,
    "highlightEmployment",
    HIGHLIGHT_EMPLOYMENT_MUTATION,
    { id, highlight: value },
    "employment highlight",
  );
  const body = res.body as MutationResponse | null;
  ensureNoTopLevelErrors(body, "employment highlight");
  const payload = body?.data?.highlightEmployment as HighlightPayload | undefined;
  if (!payload) throw new ProfileError("UNKNOWN", "employment highlight response had no payload.");
  applyUserErrorsAndSuccess(payload, "employment highlight");
  if (!payload.employment) {
    throw new ProfileError("UNKNOWN", "employment highlight response had no `employment` field.");
  }
  return payload.employment;
}

/**
 * Search the employer catalog for a known employer name (e.g. "Google").
 *
 * Issues `GET_EMPLOYERS_AUTOCOMPLETE($search, $limit)` against the
 * talent-profile surface. The schema types the return as a single
 * `Employer` but real responses are a list — accepting either shape
 * keeps callers from crashing if Toptal swings the cardinality.
 *
 * The `limit` argument bounds the suggestion count; default `10` mirrors
 * the React app.
 */
export async function employerAutocomplete(token: string, search: string, limit = 10): Promise<EmployerSuggestion[]> {
  if (!search) {
    throw new ProfileError("VALIDATION_ERROR", "employer-autocomplete requires a non-empty search query.");
  }
  const res = await callTalentProfile(
    token,
    "GET_EMPLOYERS_AUTOCOMPLETE",
    EMPLOYERS_AUTOCOMPLETE_QUERY,
    { search, limit },
    "employer-autocomplete",
  );
  const body = res.body as AutocompleteResponse | null;
  ensureNoTopLevelErrors(body, "employer-autocomplete");
  const raw = body?.data?.employersAutocomplete;
  if (raw === null || raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function unwrapMutation(
  res: { body: unknown },
  payloadKey: "createEmployment" | "updateEmployment" | "removeEmployment",
  verb: string,
): MutationPayload {
  const body = res.body as MutationResponse | null;
  ensureNoTopLevelErrors(body, verb);
  const payload = body?.data?.[payloadKey] as MutationPayload | undefined;
  if (!payload) {
    throw new ProfileError("UNKNOWN", `${verb} response had no \`data.${payloadKey}\` field`);
  }
  applyUserErrorsAndSuccess(payload, verb);
  return payload;
}
