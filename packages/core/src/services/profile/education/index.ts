// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ProfileError } from "../basic/index.js";
import { applyUserErrorsAndSuccess, callTalentProfile, ensureNoTopLevelErrors, extractProfileId } from "../shared.js";
import type { GraphQLErrorEntry, UserError } from "../shared.js";

/**
 * `Education` row as ttctl exposes it. Mirrors the read-side
 * `Education` GraphQL fragment (see
 * `research/graphql/talent_profile/fragments/Education.graphql`) trimmed to
 * the fields ttctl currently surfaces. Years are integers (`yearFrom`,
 * `yearTo`) per the empirical capture
 * `research/captures/web/inputs/UpdateEducationInput.json`.
 *
 * `skills` carries the talent's self-attested skill links per education
 * record (#556). Wire shape is the connection `skills { nodes { id name } }`
 * per the upstream fragment; ttctl flattens it to `SkillRef[]` (mirrors
 * `Employment.skills` and `Certification.skills`). Writable via the merge
 * helper {@link buildUpdateEducationInput}; not yet exposed as a CLI / MCP
 * writable flag.
 */
export interface Education {
  id: string;
  institution: string;
  degree: string;
  fieldOfStudy: string | null;
  location: string | null;
  title: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  highlight: boolean;
  skills: { id: string; name: string }[];
}

/**
 * Fields editable on an Education row from the ttctl surface. The wire
 * `EducationInput` shape (capture
 * `research/captures/web/inputs/UpdateEducationInput.json`) has no
 * `institution` slot — the school name lives in wire `title`. ttctl
 * surfaces `institution` here (matching the read-side and what users
 * type for `--institution`) and maps it to wire `title` inside
 * {@link toEducationWireInput}.
 *
 * `skills` is wire-required non-null (mirrors the #605 cert finding on
 * CREATE; preserved through `update` via {@link buildUpdateEducationInput}).
 */
export interface EducationFields {
  /** School name. Sent as wire `title`; echoed back on read as `Education.institution`. */
  institution?: string;
  degree?: string;
  fieldOfStudy?: string;
  location?: string;
  yearFrom?: number;
  yearTo?: number;
  highlight?: boolean;
  skills?: { id: string; name: string }[];
}

/**
 * Wire-side shape of `EducationInput` per the capture
 * `research/captures/web/inputs/UpdateEducationInput.json`. Exposed so
 * the MCP layer can build wire-honest dry-run previews; production code
 * should prefer {@link EducationFields} and let {@link toEducationWireInput}
 * translate. The only divergence is the `institution` (ttctl)
 * ↔ `title` (wire) rename.
 */
export interface EducationWireInput {
  title?: string;
  location?: string;
  fieldOfStudy?: string;
  degree?: string;
  yearFrom?: number;
  yearTo?: number;
  highlight?: boolean;
  skills?: { id: string; name: string }[];
}

/**
 * Translate caller-supplied {@link EducationFields} to the wire-side
 * {@link EducationWireInput} shape. The only divergence is
 * `EducationFields.institution` → wire `title`. Pure — no I/O.
 */
export function toEducationWireInput(fields: EducationFields): EducationWireInput {
  const out: EducationWireInput = {};
  if (fields.institution !== undefined) out.title = fields.institution;
  if (fields.degree !== undefined) out.degree = fields.degree;
  if (fields.fieldOfStudy !== undefined) out.fieldOfStudy = fields.fieldOfStudy;
  if (fields.location !== undefined) out.location = fields.location;
  if (fields.yearFrom !== undefined) out.yearFrom = fields.yearFrom;
  if (fields.yearTo !== undefined) out.yearTo = fields.yearTo;
  if (fields.highlight !== undefined) out.highlight = fields.highlight;
  if (fields.skills !== undefined) out.skills = fields.skills;
  return out;
}

const EDUCATION_FRAGMENT = `fragment Education on Education {
  id
  institution
  degree
  fieldOfStudy
  location
  title
  yearFrom
  yearTo
  highlight
  skills { nodes { id name } }
}`;

const GET_EDUCATION_QUERY = `query GET_EDUCATION($profileId: ID!) {
  profile(id: $profileId) {
    id
    educations { nodes { ...Education } }
  }
}
${EDUCATION_FRAGMENT}`;

const CREATE_EDUCATION_MUTATION = `mutation CREATE_EDUCATION($input: CreateEducationInput!) {
  createEducation(input: $input) {
    success
    notice
    errors { code key message }
    profile { id educations { nodes { ...Education } } }
  }
}
${EDUCATION_FRAGMENT}`;

const UPDATE_EDUCATION_MUTATION = `mutation UPDATE_EDUCATION($input: UpdateEducationInput!) {
  updateEducation(input: $input) {
    success
    notice
    errors { code key message }
    profile { id educations { nodes { ...Education } } }
  }
}
${EDUCATION_FRAGMENT}`;

const REMOVE_EDUCATION_MUTATION = `mutation REMOVE_EDUCATION($input: RemoveEducationInput!) {
  removeEducation(input: $input) {
    success
    notice
    errors { code key message }
    profile { id educations { nodes { ...Education } } }
  }
}
${EDUCATION_FRAGMENT}`;

const HIGHLIGHT_EDUCATION_MUTATION = `mutation highlightEducation($id: ID!, $highlight: Boolean!) {
  highlightEducation(input: { educationId: $id, highlight: $highlight }) {
    success
    notice
    errors { code key message }
    education { id highlight }
  }
}`;

interface ListResponse {
  data?: { profile?: { id: string; educations: { nodes: (Record<string, unknown> | null)[] } } | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface MutationPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
  profile?: { id: string; educations: { nodes: (Record<string, unknown> | null)[] } } | null;
}

interface HighlightPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
  education?: { id: string; highlight: boolean } | null;
}

interface MutationResponse {
  data?: Record<string, MutationPayload | HighlightPayload | null> | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Map an Education fragment node from the raw wire shape to the typed
 * {@link Education}. The wire surfaces `skills` as a nested connection
 * (`skills { nodes [{ id, name }] }`), not the flat `SkillRef[]` ttctl
 * exposes — so a projection step is required. Mirrors
 * `mapCertificationNode` in the certifications service and
 * `mapEmploymentNode` in the employment service. Introduced for #556.
 */
function mapEducationNode(node: Record<string, unknown>): Education {
  const skillsConn = node["skills"] as { nodes?: { id?: unknown; name?: unknown }[] } | null | undefined;
  const skills: { id: string; name: string }[] = Array.isArray(skillsConn?.nodes)
    ? skillsConn.nodes.flatMap((s) =>
        typeof s.id === "string" && typeof s.name === "string" ? [{ id: s.id, name: s.name }] : [],
      )
    : [];
  return {
    id: typeof node["id"] === "string" ? node["id"] : "",
    institution: typeof node["institution"] === "string" ? node["institution"] : "",
    degree: typeof node["degree"] === "string" ? node["degree"] : "",
    fieldOfStudy: typeof node["fieldOfStudy"] === "string" ? node["fieldOfStudy"] : null,
    location: typeof node["location"] === "string" ? node["location"] : null,
    title: typeof node["title"] === "string" ? node["title"] : null,
    yearFrom: typeof node["yearFrom"] === "number" ? node["yearFrom"] : null,
    yearTo: typeof node["yearTo"] === "number" ? node["yearTo"] : null,
    highlight: Boolean(node["highlight"]),
    skills,
  };
}

/**
 * List the signed-in user's education rows.
 *
 * Issues `GET_EDUCATION` against the Cloudflare-protected talent-profile
 * surface. The query is keyed by the user's `profileId` — fetched lazily
 * via `extractProfileId()`.
 */
export async function list(token: string): Promise<Education[]> {
  const profileId = await extractProfileId(token);
  return listByProfileId(token, profileId);
}

/**
 * Internal helper: list education rows when the caller has already
 * resolved `profileId` (e.g. inside `add()` which extracts it once
 * up-front to avoid double-round-tripping the gateway).
 */
async function listByProfileId(token: string, profileId: string): Promise<Education[]> {
  const res = await callTalentProfile(token, "GET_EDUCATION", GET_EDUCATION_QUERY, { profileId }, "education list");
  const body = res.body as ListResponse | null;
  ensureNoTopLevelErrors(body, "education list");
  const profile = body?.data?.profile;
  if (!profile) throw new ProfileError("UNKNOWN", "education list response had no `data.profile` field");
  return profile.educations.nodes.filter((n): n is Record<string, unknown> => n !== null).map(mapEducationNode);
}

/**
 * Look up a single education row by id. Convenience wrapper around
 * {@link list} — the GraphQL query has no per-id selector. Throws
 * `ProfileError("VALIDATION_ERROR")` when no matching row is found.
 */
export async function show(token: string, id: string): Promise<Education> {
  const all = await list(token);
  const found = all.find((e) => e.id === id);
  if (!found) {
    throw new ProfileError("VALIDATION_ERROR", `Education with id "${id}" not found on this profile.`);
  }
  return found;
}

/**
 * Create a new education row. Wire format per Pattern 2: `{ profileId,
 * education: EducationInput }`. `skills` defaults to `[]` (mirrors #605
 * cert finding — the wire requires non-null on CREATE).
 */
export async function add(token: string, fields: EducationFields): Promise<Education> {
  // CreateEducationInput declares institution(→title) / degree / fieldOfStudy /
  // location / yearFrom / yearTo non-null on the wire — a CREATE omitting any
  // is rejected with "Expected value to not be null" (#803, live-confirmed).
  // Gate client-side (the single source of truth for CLI + MCP) so the failure
  // is an upfront VALIDATION_ERROR rather than a late, cryptic wire error.
  const missing: string[] = [];
  if (!fields.institution) missing.push("institution");
  if (!fields.degree) missing.push("degree");
  if (!fields.fieldOfStudy) missing.push("fieldOfStudy");
  if (!fields.location) missing.push("location");
  if (fields.yearFrom === undefined) missing.push("yearFrom");
  if (fields.yearTo === undefined) missing.push("yearTo");
  if (missing.length > 0) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      `education add requires non-empty ${missing.join(", ")} — the Toptal API rejects these as null on create.`,
    );
  }
  const profileId = await extractProfileId(token);
  const before = await listByProfileId(token, profileId);
  const beforeIds = new Set(before.map((e) => e.id));
  const wire: EducationWireInput = { ...toEducationWireInput(fields), skills: fields.skills ?? [] };
  const res = await callTalentProfile(
    token,
    "CREATE_EDUCATION",
    CREATE_EDUCATION_MUTATION,
    { input: { profileId, education: wire } },
    "education add",
  );
  const payload = unwrapMutation(res, "createEducation", "education add");
  const after =
    payload.profile?.educations.nodes.filter((n): n is Record<string, unknown> => n !== null).map(mapEducationNode) ??
    [];
  const created = after.find((e) => !beforeIds.has(e.id));
  if (!created) {
    throw new ProfileError("UNKNOWN", "education add returned success but no new row was found in the response.");
  }
  return created;
}

/**
 * Build the merged `EducationInput` for an `update()` call by reading the
 * current row's writable fields and layering caller-supplied `fields` on
 * top. Pure — no I/O.
 *
 * `UpdateEducation` treats `EducationInput` as a full replacement (#612,
 * same posture as `UpdateCertification` per #605 and `UpdateBasicInfo`
 * per #604) — every writable field omitted from the input is NULLed
 * server-side.
 *
 * The merge translates ttctl-surface `institution` → wire `title` (the
 * wire has no `institution` slot). The read-side `Education.title` has
 * no matching write slot — it is server-populated and round-trips via
 * server state, not via the merge input.
 *
 * Echoed unconditionally: `title` (from `current.institution`), `degree`,
 * `skills`. Echoed only when the current value is non-null: `fieldOfStudy`,
 * `location`, `yearFrom`, `yearTo` (wire input is non-nullable per the
 * capture; sending `null` would be rejected).
 *
 * Exported so the MCP layer can build the same merged input for the
 * dry-run preview's placeholder field set.
 *
 * @throws `ProfileError("VALIDATION_ERROR")` when `fields` is empty.
 */
export function buildUpdateEducationInput(current: Education, fields: EducationFields): EducationWireInput {
  if (Object.keys(fields).length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "education update requires at least one field flag.");
  }
  const merged: EducationWireInput = {
    title: current.institution,
    degree: current.degree,
    highlight: current.highlight,
    skills: current.skills,
  };
  if (current.fieldOfStudy !== null) merged.fieldOfStudy = current.fieldOfStudy;
  if (current.location !== null) merged.location = current.location;
  if (current.yearFrom !== null) merged.yearFrom = current.yearFrom;
  if (current.yearTo !== null) merged.yearTo = current.yearTo;
  return { ...merged, ...toEducationWireInput(fields) };
}

/**
 * Sentinel surfaced in the MCP dry-run preview for fields that the apply
 * path injects from the current row at send-time (read-current+merge per
 * {@link buildUpdateEducationInput}). Mirrors the cert / basic /
 * employment merge-placeholder pattern.
 */
export const DRY_RUN_EDUCATION_FIELD_PLACEHOLDER = "<preserved from current education state>" as const;

/**
 * Update an existing education row. Wire format per Pattern 1:
 * `{ educationId, education: EducationInput }`. Reads the current row
 * first (via `show()`) and merges the writable fields per
 * {@link buildUpdateEducationInput} — `UpdateEducation` treats the
 * input as a full replacement (#612).
 *
 * @throws `ProfileError("VALIDATION_ERROR")` when `fields` is empty or
 *   when the `id` does not resolve to an existing row.
 */
export async function update(token: string, id: string, fields: EducationFields): Promise<Education> {
  if (Object.keys(fields).length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "education update requires at least one field flag.");
  }
  const current = await show(token, id);
  const merged = buildUpdateEducationInput(current, fields);
  const res = await callTalentProfile(
    token,
    "UPDATE_EDUCATION",
    UPDATE_EDUCATION_MUTATION,
    { input: { educationId: id, education: merged } },
    "education update",
  );
  const payload = unwrapMutation(res, "updateEducation", "education update");
  const updated = payload.profile?.educations.nodes
    .filter((n): n is Record<string, unknown> => n !== null)
    .map(mapEducationNode)
    .find((e) => e.id === id);
  if (!updated) {
    throw new ProfileError("UNKNOWN", `education update returned success but row "${id}" was not in the response.`);
  }
  return updated;
}

/**
 * Remove an education row. Wire format per Pattern 3: `{ educationId }`.
 */
export async function remove(token: string, id: string): Promise<string> {
  const res = await callTalentProfile(
    token,
    "REMOVE_EDUCATION",
    REMOVE_EDUCATION_MUTATION,
    { input: { educationId: id } },
    "education remove",
  );
  unwrapMutation(res, "removeEducation", "education remove");
  return id;
}

/**
 * Toggle the `highlight` flag on an education row. Wire format per
 * Pattern 4: `{ educationId, highlight: Boolean }`. Default `value` is
 * `true`; pass `false` to un-highlight.
 */
export async function highlight(token: string, id: string, value = true): Promise<{ id: string; highlight: boolean }> {
  const res = await callTalentProfile(
    token,
    "highlightEducation",
    HIGHLIGHT_EDUCATION_MUTATION,
    { id, highlight: value },
    "education highlight",
  );
  const body = res.body as MutationResponse | null;
  ensureNoTopLevelErrors(body, "education highlight");
  const payload = body?.data?.highlightEducation as HighlightPayload | undefined;
  if (!payload) throw new ProfileError("UNKNOWN", "education highlight response had no payload.");
  applyUserErrorsAndSuccess(payload, "education highlight");
  if (!payload.education) {
    throw new ProfileError("UNKNOWN", "education highlight response had no `education` field.");
  }
  return payload.education;
}

function unwrapMutation(
  res: { body: unknown },
  payloadKey: "createEducation" | "updateEducation" | "removeEducation",
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
