// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ProfileError } from "../basic/index.js";
import { applyUserErrorsAndSuccess, callTalentProfile, ensureNoTopLevelErrors, extractProfileId } from "../shared.js";
import type { GraphQLErrorEntry, UserError } from "../shared.js";

/**
 * `Employment` row as ttctl exposes it. Trimmed read-side projection of
 * the `Employment` GraphQL fragment (see
 * `research/graphql/talent_profile/fragments/Employment.graphql`). Years
 * are integers (`startDate`, `endDate`) per the empirical capture
 * `research/captures/web/inputs/UpdateEmploymentInput.json`. `endDate` is
 * `null` for current positions.
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
}

/**
 * Fields editable on an Employment row. Mirrors `EmploymentInput` per the
 * inferred shape in `research/notes/10-mutation-input-patterns.md`
 * (Pattern 1) and the live capture in
 * `research/captures/web/inputs/UpdateEmploymentInput.json`.
 *
 * The CLI exposes a curated subset: `--company`, `--role` (→ position),
 * `--from`, `--to`, `--current`, `--description` (→ experienceItems —
 * single-paragraph today; multi-paragraph splits on blank lines). Other
 * fields (employerId, engagementId, industryIds, managementExperience,
 * primaryGeographyId, reportingTo, skills, …) are exposed at the type
 * level so future leaves can grow without churning callers.
 */
export interface EmploymentFields {
  company?: string;
  position?: string;
  companyWebsite?: string | null;
  noWebsite?: boolean;
  startDate?: number;
  endDate?: number | null;
  experienceItems?: string[];
  highlight?: boolean;
  publicationPermit?: boolean;
  showViaToptal?: boolean;
  toptalRelated?: boolean;
  industryIds?: string[];
  primaryGeographyId?: string | null;
  reportingTo?: string | null;
}

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
 * Map an Employment fragment node from the raw wire shape to the typed
 * {@link Employment}. Mirrors `mapPortfolioNode` in the portfolio
 * service — the wire surfaces `industries` / `primaryGeography` as a
 * nested connection / object, NOT the scalar `industryIds` /
 * `primaryGeographyId` of the write input, so a projection step (rather
 * than a direct cast) is required. Introduced for #344.
 */
function mapEmploymentNode(node: Record<string, unknown>): Employment {
  const industriesConn = node["industries"] as { nodes?: { id?: unknown; name?: unknown }[] } | null | undefined;
  const industries: { id: string; name: string }[] = Array.isArray(industriesConn?.nodes)
    ? industriesConn.nodes.flatMap((i) =>
        typeof i.id === "string" && typeof i.name === "string" ? [{ id: i.id, name: i.name }] : [],
      )
    : [];
  const geoRaw = node["primaryGeography"] as { id?: unknown; code?: unknown; name?: unknown } | null | undefined;
  const primaryGeography =
    geoRaw && typeof geoRaw.id === "string"
      ? {
          id: geoRaw.id,
          code: typeof geoRaw.code === "string" ? geoRaw.code : null,
          name: typeof geoRaw.name === "string" ? geoRaw.name : null,
        }
      : null;
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
    reportingTo: (node["reportingTo"] as string | null | undefined) ?? null,
    industries,
    primaryGeography,
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
 * employment: EmploymentInput }`. `company` and `position` are required.
 */
export async function add(token: string, fields: EmploymentFields): Promise<Employment> {
  if (!fields.company || !fields.position) {
    throw new ProfileError("VALIDATION_ERROR", "employment add requires --company and --role.");
  }
  const profileId = await extractProfileId(token);
  const before = await listByProfileId(token, profileId);
  const beforeIds = new Set(before.map((e) => e.id));
  const res = await callTalentProfile(
    token,
    "CreateEmployment",
    CREATE_EMPLOYMENT_MUTATION,
    { input: { profileId, employment: fields } },
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
  return created;
}

/**
 * Update an existing employment row. Wire format per Pattern 1:
 * `{ employmentId, employment: EmploymentInput }`.
 */
export async function update(token: string, id: string, fields: EmploymentFields): Promise<Employment> {
  if (Object.keys(fields).length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "employment update requires at least one field flag.");
  }
  const res = await callTalentProfile(
    token,
    "UpdateEmployment",
    UPDATE_EMPLOYMENT_MUTATION,
    { input: { employmentId: id, employment: fields } },
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
