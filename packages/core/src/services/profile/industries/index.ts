// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ensureDestructiveConsent } from "../../../consent.js";
import { stockTransport } from "../../../transport.js";
import { ProfileError } from "../basic/index.js";
import { applyUserErrorsAndSuccess, callTalentProfile, ensureNoTopLevelErrors, extractProfileId } from "../shared.js";
import type { GraphQLErrorEntry, UserError } from "../shared.js";

/**
 * `IndustryProfile` row as ttctl exposes it. Mirrors the read-side
 * `IndustryProfile` GraphQL fragment (see
 * `research/graphql/talent_profile/fragments/IndustryProfile.graphql`) —
 * the four identity columns (`id`, `title`, `about`, `domainArea`) plus
 * the five **curated cross-reference arrays** (`employments`,
 * `educations`, `certifications`, `portfolioItems`, `highlights`) that
 * encode the user's per-industry curation. Per-industry curation is
 * the entire point of having industry profiles — without these arrays
 * the read is decorative. Each cross-reference is a bare `{ id }`
 * pointing back into the matching per-resource service:
 *
 *   - `employments[].id` → `profile.employment.show(id)`
 *   - `educations[].id` → `profile.education.show(id)`
 *   - `certifications[].id` → `profile.certifications.show(id)`
 *   - `portfolioItems[].id` → `profile.portfolio.show(id)`
 *   - `highlights[].id` → highlighted entity's per-resource show (kind
 *     not yet surfaced; future expansion if/when the wire surfaces it)
 *
 * The IDs are projected from a connection-shape sub-field
 * (`{ nodes: [{ id }] }`) — see {@link projectCurationRefs} for the
 * defensive parse. Missing or shape-mismatched sub-fields collapse to
 * `[]` (graceful degradation — silently absent curation, not a wire
 * regression). The fragment itself is the contract: if the server
 * rejects the selection (`Field 'X' doesn't exist on type
 * 'IndustryProfile'`), `ensureNoTopLevelErrors` throws and the failure
 * is loud.
 */
export interface IndustryProfile {
  id: string;
  title: string;
  about: string | null;
  domainArea: string | null;
  employments: IndustryCurationRef[];
  educations: IndustryCurationRef[];
  certifications: IndustryCurationRef[];
  portfolioItems: IndustryCurationRef[];
  highlights: IndustryCurationRef[];
}

/**
 * Cross-reference to a profile row curated under this industry. Bare
 * `{ id }` shape — chase the matching per-resource `show()` for full
 * detail. Issued per #553 to surface the IDs that
 * `addProfileIndustryConnections` (and its UI siblings) wire up.
 */
export interface IndustryCurationRef {
  id: string;
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

/**
 * `IndustryProfile` fragment selection set. Identity columns plus the
 * five curation cross-references introduced in #553. The five
 * connection-shape sub-fields (`{ nodes { id } }`) are INFERRED — the
 * synthesized SDL types every IndustryProfile column as `Maybe<Scalars
 * ['Unknown']['output']>` (gappy schema region per `research/notes/11`),
 * so the only authority for the wire is the live API. The connection
 * shape is extrapolated from `addProfileIndustryConnections` which
 * already selects `profile.{portfolioItems,employments} { nodes { id, … } }`
 * — see this file's `ADD_PROFILE_INDUSTRY_CONNECTIONS_MUTATION` and the
 * captured portal document at
 * `research/graphql/gateway/operations/portal/AddProfileIndustryConnections.graphql`.
 * Wire-shape mismatches throw `GRAPHQL_ERROR` at the document-validation
 * layer (before the resolver runs), so a wrong shape surfaces loudly
 * rather than silently.
 *
 * **T1 wire-shape snapshot disposition** (per `docs/wire-validation-routing.md`):
 * the post-projection `IndustryProfile` shape is captured by the
 * existing snapshot infrastructure at
 * `packages/e2e/src/41-profile-industries.e2e.test.ts` (assertWireShapeStable
 * over `ListIndustryProfiles` / `GetIndustryProfile`). The maintainer's
 * test account cannot seed IndustryProfile rows
 * (auto-memory `project_test_account_industries_disabled`), so the
 * round-trip + snapshot capture gracefully skip — when/if a seedable
 * account exercises the path, the snapshot lands.
 */
const INDUSTRY_PROFILE_FRAGMENT = `fragment IndustryProfile on IndustryProfile {
  id
  title
  about
  domainArea
  employments { nodes { id } }
  educations { nodes { id } }
  certifications { nodes { id } }
  portfolioItems { nodes { id } }
  highlights { nodes { id } }
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

/**
 * Wire-shape baseline for a raw `IndustryProfile` row before
 * projection. Identity columns are typed as the surface contract
 * promises; the five curation sub-fields are typed `unknown` because
 * the synthesized SDL types them as `Scalars['Unknown']['output']` and
 * the connection shape (`{ nodes: [{ id }] }`) is INFERRED. The
 * `projectIndustryProfile` helper walks each sub-field defensively
 * (graceful on null / missing / shape-mismatched payloads) and emits
 * the surface `IndustryProfile`.
 */
interface RawIndustryProfile {
  id: string;
  title: string;
  about: string | null;
  domainArea: string | null;
  employments?: unknown;
  educations?: unknown;
  certifications?: unknown;
  portfolioItems?: unknown;
  highlights?: unknown;
}

interface NodeResponse {
  data?: { node?: RawIndustryProfile | null } | null;
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
      industryProfiles?: { nodes?: (RawIndustryProfile | null)[] | null } | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Project a connection-shape sub-field (`{ nodes: [{ id }] }`) into a
 * flat array of `IndustryCurationRef`. Defensive against the three
 * documented degradation modes:
 *
 *   - `raw == null` (sub-field absent or null on the wire) → `[]`
 *   - `raw.nodes` missing / null / non-array → `[]`
 *   - per-node `id` missing / non-string → row filtered out
 *
 * The reason for the graceful degradation (rather than throwing) is
 * that the IndustryProfile sub-field shape is INFERRED — the
 * synthesized SDL types these as `Scalars['Unknown']['output']` and the
 * Connection wrapping is extrapolated from
 * `addProfileIndustryConnections`. A wrong shape from the server is
 * possible (per-account / per-feature-flag), and silently surfacing
 * `[]` lets the rest of the read still succeed while a follow-up E2E
 * (issue body acknowledges the test-account-state constraint) catches
 * the actual wire layout. The asymmetry vs the top-level `nodes` check
 * in `list()` (which throws on non-array) is intentional: top-level
 * structure is verified, sub-field projection is best-effort.
 */
function projectCurationRefs(raw: unknown): IndustryCurationRef[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "object") return [];
  const nodes = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const result: IndustryCurationRef[] = [];
  for (const n of nodes) {
    if (n === null || typeof n !== "object") continue;
    const id = (n as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) result.push({ id });
  }
  return result;
}

/**
 * Project a raw `IndustryProfile` wire-shape into the surface
 * `IndustryProfile` interface — the identity columns straight through,
 * the five curation sub-fields routed through
 * {@link projectCurationRefs}.
 */
function projectIndustryProfile(raw: RawIndustryProfile): IndustryProfile {
  return {
    id: raw.id,
    title: raw.title,
    about: raw.about,
    domainArea: raw.domainArea,
    employments: projectCurationRefs(raw.employments),
    educations: projectCurationRefs(raw.educations),
    certifications: projectCurationRefs(raw.certifications),
    portfolioItems: projectCurationRefs(raw.portfolioItems),
    highlights: projectCurationRefs(raw.highlights),
  };
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
  return nodes.filter((n): n is RawIndustryProfile => n !== null).map(projectIndustryProfile);
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
  return projectIndustryProfile(node);
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

// -----------------------------------------------------------------------
// addConnections — Pattern-6 industry ↔ {employment, portfolio} link
// -----------------------------------------------------------------------

/**
 * `AddProfileIndustryConnections` mutation document — gateway-portal
 * surface. Selection set mirrors the captured portal document at
 * `research/graphql/gateway/operations/portal/AddProfileIndustryConnections.graphql`.
 * The mutation returns the updated `profile` snapshot with each
 * `portfolioItems[].industries` and `employments[].industries` rebuilt
 * post-link, so the caller can verify the link landed without a
 * follow-up read.
 */
const ADD_PROFILE_INDUSTRY_CONNECTIONS_MUTATION = `mutation AddProfileIndustryConnections($input: AddProfileIndustryConnectionsInput!) {
  addProfileIndustryConnections(input: $input) {
    success
    notice
    errors { code key message }
    profile {
      id
      portfolioItems {
        nodes {
          id
          title
          industries { nodes { id name } }
        }
      }
      employments {
        nodes {
          id
          company
          industries { nodes { id name } }
        }
      }
    }
  }
}`;

/**
 * One link in an `industriesConnections` array. The `industryId` is the
 * CATALOG `Industry` id (`V1-Industry-<n>`) sourced via
 * {@link autocomplete}; `profileItems` is a mixed array of EITHER
 * `Employment` ids (`V1-Employment-<n>`) OR `PortfolioItem` ids
 * (`V1-PortfolioItem-<n>`). The server reads the entity type off the
 * Relay id prefix and routes each id to the matching join table.
 *
 * **Wire shape source**: the bundled portal call site at
 * `module-jobs.302f53cf.js` builds the wire payload as
 * `industriesConnections.map(({id, profileItemIds}) => ({ industryId: id, profileItems: profileItemIds }))`.
 * The issue body (#465) initially referenced `industryProfileId` +
 * `employmentIds[]`, which the decompile contradicts: the canonical
 * field is `industryId` (catalog id, not the `IndustryProfile` row id)
 * and `profileItems` is a mixed Employment/PortfolioItem array (not an
 * `employmentIds`-only field).
 */
export interface IndustryConnectionLink {
  /**
   * Catalog `Industry` id (`V1-Industry-<n>`). Sourced via
   * {@link autocomplete}.
   */
  // write-only: join-input catalog reference; round-tripped via
  // result.portfolioItems[].industries[].id / employments[].industries[].id
  // (the linked-tag echo), not as a top-level `industryId` field.
  industryId: string;
  /**
   * Mixed array of Relay ids — each one is either a
   * `V1-Employment-<n>` OR a `V1-PortfolioItem-<n>`. The server reads
   * the entity type off the Relay id prefix and routes accordingly.
   * Empty arrays are rejected server-side; supply at least one id.
   */
  // write-only: join-input — the post-link state echoes as
  // result.portfolioItems[].id + result.employments[].id (each row
  // carrying its updated industries[]), not as a `profileItems` field.
  profileItems: string[];
}

/**
 * Per-domain consent ceremony for {@link addConnections}. Per
 * ADR-009 (ttctl) § Decision Part 1, this mutation is in the
 * `profile-capability` domain (it modifies the recruiter-visible
 * industry-to-profile-item linkages — a capability claim on the
 * public profile). Static type narrows to compile-time-true; the
 * runtime check at {@link ensureDestructiveConsent} covers `as`-cast
 * bypasses and JSON-sourced inputs (CLI / MCP / agents).
 */
export interface AddIndustryConnectionsConsent {
  /**
   * MUST be `true` — acknowledges that this writes recruiter-visible
   * industry tags onto employment and/or portfolio rows. See
   * ADR-009 (ttctl) § Decision Part 1 for the per-domain consent
   * vocabulary.
   */
  // write-only: ADR-009 (ttctl) per-domain consent literal — TTCtl-layer
  // gate field, never echoed by the wire (does not appear on the
  // response).
  profileCapabilityConsentIssued: true;
}

/**
 * One row in the response's `profile.portfolioItems.nodes` /
 * `profile.employments.nodes` arrays after the link has landed. Each
 * node carries the post-link `industries.nodes[]` so the caller can
 * verify the connection materialized server-side.
 */
export interface IndustryConnectionsProfileNode {
  id: string;
  /** `title` for portfolio rows; `null` for employment rows. */
  title: string | null;
  /** `company` for employment rows; `null` for portfolio rows. */
  company: string | null;
  /** Post-link industry tags on this row. */
  industries: { id: string; name: string }[];
}

/**
 * Server-confirmed result of {@link addConnections}. Mirrors the
 * captured response selection. The two nodelists (`portfolioItems`,
 * `employments`) are surfaced normalised — each carrying the
 * post-link `industries[]` array — so the caller can branch by
 * `title` (portfolio row) vs `company` (employment row) without
 * re-reading.
 */
export interface AddIndustryConnectionsResult {
  notice: string | null;
  /** Updated portfolio rows with their post-link industry tags. */
  portfolioItems: IndustryConnectionsProfileNode[];
  /** Updated employment rows with their post-link industry tags. */
  employments: IndustryConnectionsProfileNode[];
}

interface AddProfileIndustryConnectionsResponse {
  data?: {
    addProfileIndustryConnections?: {
      success?: boolean | null;
      notice?: string | null;
      errors?: UserError[] | null;
      profile?: {
        id?: string | null;
        portfolioItems?: {
          nodes?:
            | ({
                id: string;
                title?: string | null;
                industries?: { nodes?: ({ id: string; name: string } | null)[] | null } | null;
              } | null)[]
            | null;
        } | null;
        employments?: {
          nodes?:
            | ({
                id: string;
                company?: string | null;
                industries?: { nodes?: ({ id: string; name: string } | null)[] | null } | null;
              } | null)[]
            | null;
        } | null;
      } | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Link an industry catalog entry to one or more profile rows
 * (employment and/or portfolio items). Pattern-6 connection helper
 * for industries.
 *
 * **Wire shape** (extracted from the portal bundle call site at
 * `module-jobs.302f53cf.js`):
 *
 * ```
 * input: {
 *   profileId: string,
 *   industriesConnections: [{ industryId, profileItems: string[] }]
 * }
 * ```
 *
 * The `industriesConnections` entries can mix targets — every id in
 * `profileItems` is either a `V1-Employment-<n>` or
 * `V1-PortfolioItem-<n>`; the server reads the Relay-id prefix and
 * routes to the matching join table.
 *
 * **INFERRED — UNVERIFIED**: the gateway-portal SDL declares
 * `AddProfileIndustryConnectionsInput { _placeholder: String }` (in
 * `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS`). The wire shape above is
 * recovered from the portal-bundle decompile, not from a live
 * payload capture. The schema/contract validation rule applies —
 * see {@link CLAUDE.md § Schema/contract validation rule}. T1 wire
 * snapshot at
 * `packages/e2e/src/wire-snapshots/AddProfileIndustryConnections.snapshot.json`
 * locks the response shape post-merge.
 *
 * **Consent gate** (ADR-009 (ttctl) § Decision Part 1 —
 * `profile-capability` domain): refuses the call with
 * `ConsentRequiredError("CONSENT_REQUIRED")` BEFORE any wire call
 * when `consent.profileCapabilityConsentIssued !== true`. The
 * compile-time literal narrows the static type; the runtime check
 * covers `as`-cast bypasses and JSON-sourced inputs from CLI / MCP /
 * agents. The `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` env-var bypasses
 * the literal check for non-interactive CI / test contexts.
 *
 * Errors:
 *   - `ConsentRequiredError("CONSENT_REQUIRED")` when consent is not
 *     supplied (and the env-var bypass is not set)
 *   - `ProfileError("VALIDATION_ERROR")` when `links` is empty or any
 *     entry has empty `industryId` / `profileItems`
 *   - `ProfileError("USER_ERROR")` when the server rejects the link
 *     (e.g. unknown industry id, unknown profile item id, ownership
 *     mismatch)
 *   - `ProfileError("GRAPHQL_ERROR")` on top-level wire errors
 *   - Standard auth-revoked / Cf403 / network paths via `stockTransport`
 */
export async function addConnections(
  token: string,
  links: IndustryConnectionLink[],
  consent: AddIndustryConnectionsConsent,
): Promise<AddIndustryConnectionsResult> {
  // Runtime consent gate — covers `as`-cast bypasses and JSON-sourced
  // inputs from CLI / MCP / agents. The static type
  // `profileCapabilityConsentIssued: true` narrows to compile-time-true,
  // which would otherwise make this check look like dead code; the
  // widening cast is load-bearing. See ADR-009 (ttctl) and
  // packages/core/src/consent.ts.
  ensureDestructiveConsent(
    "addProfileIndustryConnections",
    "profile-capability",
    consent as unknown as { readonly [key: string]: unknown },
  );

  if (!Array.isArray(links) || links.length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "industries add-connections requires at least one entry in `links`.");
  }
  for (const [i, link] of links.entries()) {
    if (typeof link.industryId !== "string" || link.industryId.trim().length === 0) {
      throw new ProfileError("VALIDATION_ERROR", `links[${i.toString()}].industryId is required.`);
    }
    if (!Array.isArray(link.profileItems) || link.profileItems.length === 0) {
      throw new ProfileError(
        "VALIDATION_ERROR",
        `links[${i.toString()}].profileItems must include at least one Employment or PortfolioItem id.`,
      );
    }
    for (const [j, pid] of link.profileItems.entries()) {
      if (typeof pid !== "string" || pid.trim().length === 0) {
        throw new ProfileError(
          "VALIDATION_ERROR",
          `links[${i.toString()}].profileItems[${j.toString()}] must be a non-empty id string.`,
        );
      }
    }
  }

  const profileId = await extractProfileId(token);

  // Pattern-6 wire shape recovered from
  // `module-jobs.302f53cf.js` call site. The portal bundle constructs
  // `industriesConnections.map(({id, profileItemIds}) => ({industryId: id, profileItems: profileItemIds}))`
  // — preserved here so the wire shape matches the live client
  // verbatim.
  const variables = {
    input: {
      profileId,
      industriesConnections: links.map((l) => ({
        industryId: l.industryId,
        profileItems: l.profileItems,
      })),
    },
  };

  const res = await stockTransport({
    surface: "mobile-gateway",
    authToken: token,
    body: {
      operationName: "AddProfileIndustryConnections",
      query: ADD_PROFILE_INDUSTRY_CONNECTIONS_MUTATION,
      variables,
    },
  });

  if (res.status === 401) {
    throw new ProfileError("USER_ERROR", "AddProfileIndustryConnections returned HTTP 401 (auth revoked).");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError("UNKNOWN", `AddProfileIndustryConnections returned HTTP ${res.status.toString()}.`);
  }

  const body = res.body as AddProfileIndustryConnectionsResponse | null;
  ensureNoTopLevelErrors(body, "industries add-connections");

  const payload = body?.data?.addProfileIndustryConnections;
  if (!payload) {
    throw new ProfileError(
      "UNKNOWN",
      "industries add-connections response had no `data.addProfileIndustryConnections` field.",
    );
  }
  applyUserErrorsAndSuccess(payload, "industries add-connections");

  const portfolioNodes = payload.profile?.portfolioItems?.nodes ?? [];
  const employmentNodes = payload.profile?.employments?.nodes ?? [];

  return {
    notice: payload.notice ?? null,
    portfolioItems: portfolioNodes
      .filter((n): n is NonNullable<typeof n> => n !== null)
      .map((n) => ({
        id: n.id,
        title: n.title ?? null,
        company: null,
        industries: (n.industries?.nodes ?? [])
          .filter((i): i is { id: string; name: string } => i !== null)
          .map((i) => ({ id: i.id, name: i.name })),
      })),
    employments: employmentNodes
      .filter((n): n is NonNullable<typeof n> => n !== null)
      .map((n) => ({
        id: n.id,
        title: null,
        company: n.company ?? null,
        industries: (n.industries?.nodes ?? [])
          .filter((i): i is { id: string; name: string } => i !== null)
          .map((i) => ({ id: i.id, name: i.name })),
      })),
  };
}
