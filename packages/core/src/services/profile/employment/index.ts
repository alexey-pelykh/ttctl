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
 *
 * `employerId` is the server-side catalog identifier for the employer
 * record (e.g. "V1-Employer-1234"). `add()` requires either an explicit
 * `employerId` or a `company` that resolves to exactly one
 * autocomplete match — see {@link add} for the resolution policy. Per
 * the captured input shape, `employerId` is nullable only when
 * `noWebsite: true` (which TTCtl does not currently surface on `add`).
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
  skills?: string[];
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
 * the company name. The mutation transport is still NEVER fired in
 * `dryRun` mode.
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
 * `employerId` is absent) so the preview's `variables.input.employment`
 * carries the resolved `employerId`, matching the wire shape the live
 * mutation would transmit. The `CreateEmployment` mutation transport
 * is NOT invoked. The placeholder
 * {@link DRY_RUN_PROFILE_ID_PLACEHOLDER} stands in for `profileId`
 * (which the apply-path resolves via `extractProfileId`).
 */
export async function add(token: string, fields: EmploymentFields, options: AddOptions = {}): Promise<AddOutcome> {
  if (!fields.company || !fields.position) {
    throw new ProfileError("VALIDATION_ERROR", "employment add requires --company and --role.");
  }

  // Resolve employerId BEFORE branching on dryRun so the preview's
  // wire shape matches what the live mutation would transmit (#395
  // explicit AC). The autocomplete query is a read, not a mutation —
  // it fires in both dry-run and apply paths.
  const employerId = await resolveEmployerId(token, fields);

  // The wire requires several non-null fields on `CreateEmployment`
  // (live API rejects with "Expected value to not be null" / "You can't
  // leave this empty" otherwise). The defaults below were established
  // empirically through E2E iteration — DO NOT add pre-emptive defaults
  // for fields the server hasn't explicitly demanded, since
  // `CreateEmploymentInput` rejects unknown fields with
  // "Field is not defined on EmploymentInput" (e.g. `toptalRelated`,
  // `highlight` are valid on `UpdateEmploymentInput` but NOT on
  // `CreateEmploymentInput`).
  //   - `experienceItems`, `skills`, `showViaToptal` — via the #344 E2E
  //   - `publicationPermit` — via the #395 live capture (2026-05-19)
  // Callers may still override.
  const employment: EmploymentFields = {
    experienceItems: [],
    skills: [],
    showViaToptal: true,
    publicationPermit: false,
    ...fields,
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
