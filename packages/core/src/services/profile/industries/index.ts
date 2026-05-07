// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ProfileError } from "../basic/index.js";
import { applyUserErrorsAndSuccess, callTalentProfile, ensureNoTopLevelErrors, extractProfileId } from "../shared.js";
import type { GraphQLErrorEntry, UserError } from "../shared.js";

/**
 * `IndustryProfile` row as ttctl exposes it. Mirrors the read-side
 * `IndustryProfile` GraphQL fragment (see
 * `research/graphql/talent_profile/fragments/IndustryProfile.graphql`)
 * trimmed to identity fields. The richer relational fields (`employments`,
 * `educations`, `certifications`, `portfolioItems`, `highlights`) are
 * exposed as raw `unknown` for now — callers who need them can deserialize
 * via the generated GraphQL types.
 */
export interface IndustryProfile {
  id: string;
  title: string;
  about: string | null;
  domainArea: string | null;
}

/**
 * Fields editable on an `IndustryProfile` row. Mirrors the inferred
 * `IndustryProfileInput` shape per Pattern 1/2 in
 * `research/notes/10-mutation-input-patterns.md`. The CLI exposes
 * `--name` (→ title) and `--connection` (→ domainArea) plus `--about` for
 * an optional description.
 */
export interface IndustryProfileFields {
  title?: string;
  about?: string | null;
  domainArea?: string | null;
}

/**
 * Catalog `Industry` entry returned by `industriesAutocomplete`. Light —
 * just the catalog ID (used to wire connections later) and the display
 * name.
 */
export interface IndustryCatalogEntry {
  id: string;
  name: string;
}

const INDUSTRY_PROFILE_FRAGMENT = `fragment IndustryProfile on IndustryProfile {
  id
  title
  about
  domainArea
}`;

const GET_INDUSTRY_PROFILE_QUERY = `query GetIndustryProfile($id: ID!) {
  node(id: $id) { ...IndustryProfile }
}
${INDUSTRY_PROFILE_FRAGMENT}`;

const CREATE_INDUSTRY_PROFILE_MUTATION = `mutation CreateIndustryProfile($input: CreateIndustryProfileInput!) {
  createIndustryProfile(input: $input) {
    success
    notice
    errors { message field }
    industryProfile { ...IndustryProfile }
  }
}
${INDUSTRY_PROFILE_FRAGMENT}`;

const UPDATE_INDUSTRY_PROFILE_MUTATION = `mutation UpdateIndustryProfile($input: UpdateIndustryProfileInput!) {
  updateIndustryProfile(input: $input) {
    success
    notice
    errors { message field }
    industryProfile { ...IndustryProfile }
  }
}
${INDUSTRY_PROFILE_FRAGMENT}`;

const REMOVE_INDUSTRY_PROFILE_MUTATION = `mutation RemoveIndustryProfile($input: RemoveIndustryProfileInput!) {
  removeIndustryProfile(input: $input) {
    success
    notice
    errors { message field }
  }
}`;

const INDUSTRIES_AUTOCOMPLETE_QUERY = `query GET_INDUSTRIES_FOR_AUTOCOMPLETE($search: String!, $limit: Int!, $withoutIds: [ID!]) {
  industriesAutocomplete(search: $search, limit: $limit, withoutIds: $withoutIds) {
    id
    name
  }
}`;

const LIST_INDUSTRY_PROFILES_QUERY = `query ListIndustryProfiles($profileId: ID!) {
  profile(id: $profileId) {
    id
    industryProfiles { nodes { ...IndustryProfile } }
  }
}
${INDUSTRY_PROFILE_FRAGMENT}`;

interface NodeResponse {
  data?: { node?: IndustryProfile | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface MutationPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
  industryProfile?: IndustryProfile | null;
}

interface MutationResponse {
  data?: Record<string, MutationPayload | null> | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface AutocompleteResponse {
  data?: { industriesAutocomplete?: IndustryCatalogEntry | IndustryCatalogEntry[] | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * List the signed-in user's `IndustryProfile` rows.
 *
 * The talent-profile surface exposes per-id `GetIndustryProfile` but no
 * per-profile list endpoint that matches the wave-3 CLI shape. As a
 * pragmatic approximation we fetch the profile via `extractProfileId()`
 * and read its industry-profiles via the same `node()` mechanism — this
 * relies on `node(id: $profileId)` returning a `Profile` whose
 * `industryProfiles` selection lists the user's authored entries.
 *
 * If the live API rejects this shape (the schema surfaces are
 * `IndustryProfile`-typed but the query path may differ), the throw
 * surfaces as `ProfileError("GRAPHQL_ERROR")` with the underlying message
 * so the user can file an issue. See the troubleshooting section in
 * project CLAUDE.md.
 */
export async function list(token: string): Promise<IndustryProfile[]> {
  const profileId = await extractProfileId(token);
  const res = await callTalentProfile(
    token,
    "ListIndustryProfiles",
    LIST_INDUSTRY_PROFILES_QUERY,
    { profileId },
    "industries list",
  );
  const body = res.body as {
    data?: { profile?: { id: string; industryProfiles: { nodes: (IndustryProfile | null)[] } } | null } | null;
    errors?: GraphQLErrorEntry[] | null;
  } | null;
  ensureNoTopLevelErrors(body, "industries list");
  const nodes = body?.data?.profile?.industryProfiles.nodes ?? [];
  return nodes.filter((n): n is IndustryProfile => n !== null);
}

/**
 * Fetch a single `IndustryProfile` by id via the schema's `node()`
 * resolver.
 */
export async function show(token: string, id: string): Promise<IndustryProfile> {
  const res = await callTalentProfile(
    token,
    "GetIndustryProfile",
    GET_INDUSTRY_PROFILE_QUERY,
    { id },
    "industries show",
  );
  const body = res.body as NodeResponse | null;
  ensureNoTopLevelErrors(body, "industries show");
  const node = body?.data?.node;
  if (!node) {
    throw new ProfileError("VALIDATION_ERROR", `IndustryProfile with id "${id}" not found.`);
  }
  return node;
}

/**
 * Create a new `IndustryProfile` row. Wire format per Pattern 2:
 * `{ profileId, industryProfile: IndustryProfileInput }`.
 *
 * `--name` (→ `title`) is required. `--connection` (→ `domainArea`)
 * is optional and represents the user's domain expertise modifier
 * (e.g., "Healthcare" + connection "Backend").
 */
export async function add(token: string, fields: IndustryProfileFields): Promise<IndustryProfile> {
  if (!fields.title) {
    throw new ProfileError("VALIDATION_ERROR", "industries add requires <name> (mapped to title).");
  }
  const profileId = await extractProfileId(token);
  const res = await callTalentProfile(
    token,
    "CreateIndustryProfile",
    CREATE_INDUSTRY_PROFILE_MUTATION,
    { input: { profileId, industryProfile: fields } },
    "industries add",
  );
  const payload = unwrapMutation(res, "createIndustryProfile", "industries add");
  if (!payload.industryProfile) {
    throw new ProfileError("UNKNOWN", "industries add returned success but no industryProfile in the response.");
  }
  return payload.industryProfile;
}

/**
 * Update an existing `IndustryProfile`. Wire format per Pattern 1:
 * `{ industryProfileId, industryProfile: IndustryProfileInput }`.
 */
export async function update(token: string, id: string, fields: IndustryProfileFields): Promise<IndustryProfile> {
  if (Object.keys(fields).length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "industries update requires at least one field flag.");
  }
  const res = await callTalentProfile(
    token,
    "UpdateIndustryProfile",
    UPDATE_INDUSTRY_PROFILE_MUTATION,
    { input: { industryProfileId: id, industryProfile: fields } },
    "industries update",
  );
  const payload = unwrapMutation(res, "updateIndustryProfile", "industries update");
  if (!payload.industryProfile) {
    throw new ProfileError("UNKNOWN", "industries update returned success but no industryProfile in the response.");
  }
  return payload.industryProfile;
}

/**
 * Remove an `IndustryProfile` row. Wire format per Pattern 3:
 * `{ industryProfileId }`.
 *
 * Note: the synthesized SDL does not declare a `removeIndustryProfile`
 * mutation, but the CLI surface promises a `remove` leaf for industries.
 * The mutation is sent under the assumed name; a top-level GraphQL error
 * (e.g. "Cannot find mutation `removeIndustryProfile`") surfaces as
 * `ProfileError("GRAPHQL_ERROR")` so the user can file an issue with the
 * captured response.
 */
export async function remove(token: string, id: string): Promise<string> {
  const res = await callTalentProfile(
    token,
    "RemoveIndustryProfile",
    REMOVE_INDUSTRY_PROFILE_MUTATION,
    { input: { industryProfileId: id } },
    "industries remove",
  );
  unwrapMutation(res, "removeIndustryProfile", "industries remove");
  return id;
}

/**
 * Search the industry catalog for known industry names.
 *
 * Issues `industriesAutocomplete($search, $limit, $withoutIds)` against
 * the talent-profile surface. Schema-typed return is a single `Industry`
 * but real responses are list-shaped — accepting either keeps callers
 * stable.
 *
 * `withoutIds` excludes industries the user already has on their profile;
 * leave undefined for "any match". `limit` defaults to `10` (mirrors the
 * web client).
 */
export async function autocomplete(
  token: string,
  search: string,
  options: { limit?: number; withoutIds?: string[] } = {},
): Promise<IndustryCatalogEntry[]> {
  if (!search) {
    throw new ProfileError("VALIDATION_ERROR", "industries autocomplete requires a non-empty search query.");
  }
  const limit = options.limit ?? 10;
  const variables: Record<string, unknown> = { search, limit };
  if (options.withoutIds !== undefined) variables["withoutIds"] = options.withoutIds;
  const res = await callTalentProfile(
    token,
    "GET_INDUSTRIES_FOR_AUTOCOMPLETE",
    INDUSTRIES_AUTOCOMPLETE_QUERY,
    variables,
    "industries autocomplete",
  );
  const body = res.body as AutocompleteResponse | null;
  ensureNoTopLevelErrors(body, "industries autocomplete");
  const raw = body?.data?.industriesAutocomplete;
  if (raw === null || raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function unwrapMutation(
  res: { body: unknown },
  payloadKey: "createIndustryProfile" | "updateIndustryProfile" | "removeIndustryProfile",
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
