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

/**
 * `CreateIndustryProfile` mutation. The payload shape per the synthesized
 * schema (`packages/core/src/__generated__/talent-profile.ts`,
 * `CreateIndustryProfilePayload`) AND the live capture in
 * `research/graphql/talent_profile/operations/CreateIndustryProfile.graphql`
 * is `{ success, errors }` ONLY — neither `notice` nor `industryProfile`
 * are members. Selecting either field causes the live API to reject the
 * entire document with "Field 'X' doesn't exist on type
 * 'CreateIndustryProfilePayload'" before the resolver runs, which is the
 * #321 originating incident.
 *
 * The mutation therefore does NOT echo the created entity. {@link add}
 * compensates by reading the row back via `list()` after the mutation
 * succeeds — see that function for the `pre-list → mutate → post-list`
 * diff pattern.
 */
const CREATE_INDUSTRY_PROFILE_MUTATION = `mutation CreateIndustryProfile($input: CreateIndustryProfileInput!) {
  createIndustryProfile(input: $input) {
    success
    errors { code key message }
  }
}`;

/**
 * `UpdateIndustryProfile` mutation. Same payload-shape constraint as
 * {@link CREATE_INDUSTRY_PROFILE_MUTATION} per the synthesized schema +
 * live capture. {@link update} reads the row back via `show(id)` after
 * the mutation since the payload does not echo the updated entity.
 */
const UPDATE_INDUSTRY_PROFILE_MUTATION = `mutation UpdateIndustryProfile($input: UpdateIndustryProfileInput!) {
  updateIndustryProfile(input: $input) {
    success
    errors { code key message }
  }
}`;

/**
 * `RemoveIndustryProfile` mutation. Wire format per Pattern 3:
 * `{ industryProfileId }`. The synthesized schema does NOT declare a
 * `removeIndustryProfile` mutation (gap region per `research/notes/11`);
 * the mutation is sent under the assumed name and a top-level GraphQL
 * error from the server (e.g. "Cannot find mutation
 * `removeIndustryProfile`") surfaces as `ProfileError("GRAPHQL_ERROR")`
 * so the user can file an issue with the captured response.
 */
const REMOVE_INDUSTRY_PROFILE_MUTATION = `mutation RemoveIndustryProfile($input: RemoveIndustryProfileInput!) {
  removeIndustryProfile(input: $input) {
    success
    errors { code key message }
  }
}`;

const INDUSTRIES_AUTOCOMPLETE_QUERY = `query GET_INDUSTRIES_FOR_AUTOCOMPLETE($search: String!, $limit: Int!, $withoutIds: [ID!]) {
  industriesAutocomplete(search: $search, limit: $limit, withoutIds: $withoutIds) {
    id
    name
  }
}`;

/**
 * `ListIndustryProfiles` query. Walks the profile's authored industry
 * rows via `profile(id) { industryProfiles { nodes } }`. The synthesized
 * `Profile` type in `__generated__/talent-profile.ts` does NOT declare
 * an `industryProfiles` field (schema-synthesis gap), so this query is
 * hand-authored against the inferred live shape. The wire validation
 * happens at runtime: {@link list} explicitly verifies the response
 * has the expected `nodes` array and throws `GRAPHQL_ERROR` otherwise
 * — no silent-empty defaulting (AC #6 of #321).
 */
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
  errors?: UserError[] | null;
}

interface MutationResponse {
  data?: Record<string, MutationPayload | null> | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface AutocompleteResponse {
  data?: { industriesAutocomplete?: IndustryCatalogEntry | IndustryCatalogEntry[] | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface ListResponse {
  data?: {
    profile?: {
      id?: unknown;
      industryProfiles?: { nodes?: (IndustryProfile | null)[] | null } | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * List the signed-in user's `IndustryProfile` rows.
 *
 * Walks `profile(id: $profileId) { industryProfiles { nodes { ... } } }`
 * — the document hand-authored against the inferred live wire (see
 * {@link LIST_INDUSTRY_PROFILES_QUERY}). The synthesized `Profile` type
 * has no `industryProfiles` field, so structural validation is done at
 * runtime: if the response does not carry a `profile.industryProfiles.nodes`
 * array, the helper throws `GRAPHQL_ERROR` rather than silently defaulting
 * to `[]` (AC #6 of #321 — optional-chain defaults are forbidden where
 * the chain hides a wire-shape mismatch).
 *
 * An empty array (`nodes: []`) is the legitimate "user has zero industry
 * rows" return and is propagated as `[]`. Only structural absence —
 * `profile` null or `industryProfiles` missing — produces a thrown
 * `GRAPHQL_ERROR`.
 *
 * `options.profileId` lets callers (notably {@link add}) reuse an already-
 * resolved profile id and avoid the duplicate `basic.show` round-trip
 * implicit in `extractProfileId`. When omitted, `extractProfileId` runs.
 */
export async function list(token: string, options?: { profileId?: string }): Promise<IndustryProfile[]> {
  const profileId = options?.profileId ?? (await extractProfileId(token));
  const res = await callTalentProfile(
    token,
    "ListIndustryProfiles",
    LIST_INDUSTRY_PROFILES_QUERY,
    { profileId },
    "industries list",
  );
  const body = res.body as ListResponse | null;
  ensureNoTopLevelErrors(body, "industries list");
  const profile = body?.data?.profile;
  if (profile === undefined || profile === null) {
    throw new ProfileError(
      "GRAPHQL_ERROR",
      `industries list returned no \`data.profile\` for the signed-in user (wire shape mismatch).`,
    );
  }
  const industryProfiles = profile.industryProfiles;
  if (industryProfiles === undefined || industryProfiles === null) {
    throw new ProfileError(
      "GRAPHQL_ERROR",
      `industries list returned no \`data.profile.industryProfiles\` (wire shape mismatch — \`industryProfiles\` field absent on Profile).`,
    );
  }
  const nodes = industryProfiles.nodes;
  if (!Array.isArray(nodes)) {
    throw new ProfileError(
      "GRAPHQL_ERROR",
      `industries list returned non-array \`data.profile.industryProfiles.nodes\` (wire shape mismatch).`,
    );
  }
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
 * Construct the FLAT wire-input for Create / Update mutations per the
 * live `CreateIndustryProfileInput` shape verified empirically
 * 2026-05-16 against `talent-profile/graphql`:
 *
 *     { profileId, title, about, domainArea,
 *       highlights, educations, employments, certifications, portfolioItems }
 *
 * The server is strict about presence + non-null on every field — a
 * missing or explicit-null `about` / `domainArea` produces a
 * `Variable $input ... Expected value to not be null` GraphQL error
 * before the resolver runs. The five list-typed fields
 * (`highlights` / `educations` / `employments` / `certifications` /
 * `portfolioItems`) are connection arrays; for a brand-new industry
 * they must be present as empty arrays.
 *
 * The `industryProfile` wrapper key from `research/notes/10` Pattern 2
 * is NOT used by this mutation — the inferred Pattern was wrong for
 * `CreateIndustryProfile` (#321 originating bug). The wire input is
 * flat. This helper centralizes the defaulting so `add()` and
 * `update()` stay narrow.
 */
function buildIndustryProfileInputBody(fields: IndustryProfileFields): Record<string, unknown> {
  return {
    title: fields.title ?? "",
    about: fields.about ?? "",
    domainArea: fields.domainArea ?? "",
    highlights: [],
    educations: [],
    employments: [],
    certifications: [],
    portfolioItems: [],
  };
}

/**
 * Create a new `IndustryProfile` row. Wire format (verified live
 * 2026-05-16, #321): FLAT input with `profileId` plus the
 * `IndustryProfile` field set; see {@link buildIndustryProfileInputBody}.
 * The mutation payload is `{ success, errors }` only — it does NOT
 * echo the created entity (#321: a prior implementation selected a
 * non-existent `industryProfile` field on the payload, which the live
 * API rejected at document-validation time).
 *
 * To return the created entity, this function reads the row back via
 * `list()` after the mutation succeeds, using a pre/post id-set diff
 * to identify the new row reliably even when the user has duplicate
 * titles. The diff approach costs one extra wire round-trip but
 * survives the "two rows with the same title" failure mode that a
 * title-match strategy would mis-attribute.
 *
 * `--name` (→ `title`) is required. `--connection` (→ `domainArea`)
 * is optional and represents the user's domain expertise modifier
 * (e.g., "Healthcare" + connection "Backend"); when omitted, the
 * server-required non-null is satisfied with an empty string.
 */
export async function add(token: string, fields: IndustryProfileFields): Promise<IndustryProfile> {
  if (!fields.title) {
    throw new ProfileError("VALIDATION_ERROR", "industries add requires <name> (mapped to title).");
  }
  const profileId = await extractProfileId(token);
  const beforeIds = new Set((await list(token, { profileId })).map((row) => row.id));

  const res = await callTalentProfile(
    token,
    "CreateIndustryProfile",
    CREATE_INDUSTRY_PROFILE_MUTATION,
    { input: { profileId, ...buildIndustryProfileInputBody(fields) } },
    "industries add",
  );
  unwrapMutation(res, "createIndustryProfile", "industries add");

  const after = await list(token, { profileId });
  const newRow = after.find((row) => !beforeIds.has(row.id));
  if (newRow === undefined) {
    throw new ProfileError(
      "UNKNOWN",
      "industries add reported success but no new row appeared in the post-mutation list (wire-shape regression or server-side filter).",
    );
  }
  return newRow;
}

/**
 * Update an existing `IndustryProfile`. Wire format (verified live
 * 2026-05-16, #321): FLAT input with `industryProfileId` plus the same
 * field set used by Create — see {@link buildIndustryProfileInputBody}.
 * The mutation payload is `{ success, errors }` only — it does NOT
 * echo the updated entity. The updated entity is read back via
 * `show(id)` after the mutation succeeds.
 *
 * `update()` does a partial-update over a server-side full-replace
 * shape: it `show()`s the current row, merges the user-supplied
 * fields, and sends the merged shape so unspecified fields preserve
 * their current values rather than being clobbered to empty.
 */
export async function update(token: string, id: string, fields: IndustryProfileFields): Promise<IndustryProfile> {
  if (Object.keys(fields).length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "industries update requires at least one field flag.");
  }
  const current = await show(token, id);
  const merged: IndustryProfileFields = {
    title: fields.title ?? current.title,
    about: fields.about !== undefined ? fields.about : current.about,
    domainArea: fields.domainArea !== undefined ? fields.domainArea : current.domainArea,
  };
  const res = await callTalentProfile(
    token,
    "UpdateIndustryProfile",
    UPDATE_INDUSTRY_PROFILE_MUTATION,
    { input: { industryProfileId: id, ...buildIndustryProfileInputBody(merged) } },
    "industries update",
  );
  unwrapMutation(res, "updateIndustryProfile", "industries update");
  return show(token, id);
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
