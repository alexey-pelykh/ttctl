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
  /**
   * Catalog skill refs (wire shape: `SkillRefInput[]` = `{ id, name }[]`,
   * not the `string[]` originally declared — corrected #394 after the
   * live capture showed the live mutation accepts the object form and
   * rejects empty arrays on update).
   */
  skills?: { id: string; name: string }[];
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
  employer { id }
  skills { nodes { id name } }
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
  const employerRaw = node["employer"] as { id?: unknown } | null | undefined;
  const employerId = employerRaw && typeof employerRaw.id === "string" ? employerRaw.id : null;
  const skillsConn = node["skills"] as { nodes?: { id?: unknown; name?: unknown }[] } | null | undefined;
  const skills: { id: string; name: string }[] = Array.isArray(skillsConn?.nodes)
    ? skillsConn.nodes.flatMap((s) =>
        typeof s.id === "string" && typeof s.name === "string" ? [{ id: s.id, name: s.name }] : [],
      )
    : [];
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
    employerId,
    skills,
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
  //   - `publicationPermit` — via the #395 live capture (2026-05-19)
  // Callers may still override.
  const employment: Omit<EmploymentFields, "noEmployer" | "employerId"> & { employerId: string | null } = {
    experienceItems: [],
    skills: [],
    showViaToptal: true,
    publicationPermit: false,
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
 * Placeholder string substituted into a dry-run `UpdateEmployment`
 * preview's variables payload for fields that the apply-path resolves by
 * reading the current row (`experienceItems`, `skills`, `showViaToptal`,
 * `startDate` — the four required-non-null fields injected by the
 * read-current+merge logic, #394). Surfaced verbatim so MCP consumers can
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
 * The `talent_profile/graphql` server treats four `EmploymentInput` fields
 * as required non-null on `UpdateEmployment` and rejects the whole
 * variables payload with `"Expected value to not be null"` when they are
 * absent (#394 — wire-broke meta-class #392). The four fields are
 * `experienceItems`, `showViaToptal`, `startDate`, and `skills`. This
 * helper injects them from the current state where the EMPLOYMENT_FRAGMENT
 * surfaces them (`experienceItems`, `showViaToptal`, `startDate`) and
 * defaults `skills: []` because the fragment does not currently select the
 * read-side `skills` connection. Other fields are left undefined and
 * omitted from the wire payload — the server keeps the existing value for
 * any field absent from the input (the omission-is-preservation half of
 * the merge contract; only the four required-non-null fields force-echo).
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
  const startDate = fields.startDate ?? current.startDate;
  if (startDate === null) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      `Cannot update employment "${current.id}": startDate is required and current value is null. Supply --from to set a year.`,
    );
  }
  // Server-side Rails `.blank?` gates (USER_ERROR "You can't leave this
  // empty") — surfaced by the #394 live capture (2026-05-19): when the
  // caller omits these, the wire layer accepts the partial input but
  // the Rails apply path rejects it. Inject from the current row so
  // user-supplied fields can still override. Optional pass-throughs
  // (primaryGeographyId / reportingTo) are only set when the current
  // row has a non-null value — sending an explicit null would change
  // the row's state, which would defeat "merge".
  const merged: EmploymentFields = {
    // Wire-required non-null (GraphQL `Expected value to not be null`):
    experienceItems: current.experienceItems ?? [],
    // Preserve current row's skills through the merge — server rejects
    // `skills: []` with "is too short (minimum is 1 character)" on
    // update (#394 live-capture finding 2026-05-19). The EMPLOYMENT_FRAGMENT
    // now selects `skills { nodes { id name } }` so `current.skills` is
    // populated; pre-#394 it was always `[]` and update() defaulted to
    // empty, which is what the live wire was rejecting.
    skills: current.skills,
    showViaToptal: current.showViaToptal,
    startDate,
    // Rails `.blank?` gates:
    company: current.company,
    publicationPermit: current.publicationPermit ?? true,
    // industryIds: catalog refs the wire requires present and non-empty
    // on the apply path.
    industryIds: current.industries.map((i) => i.id),
  };
  if (current.employerId !== null) {
    merged.employerId = current.employerId;
  }
  if (current.primaryGeography !== null) {
    merged.primaryGeographyId = current.primaryGeography.id;
  }
  if (current.reportingTo !== null) {
    merged.reportingTo = current.reportingTo;
  }
  return { ...merged, ...fields };
}

/**
 * Update an existing employment row. Wire format per Pattern 1:
 * `{ employmentId, employment: EmploymentInput }`.
 *
 * Reads the current row first and merges the four required-non-null
 * fields onto the wire input (see {@link buildUpdateEmploymentInput} for
 * the merge contract and #394 for the originating wire-broke incident).
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
