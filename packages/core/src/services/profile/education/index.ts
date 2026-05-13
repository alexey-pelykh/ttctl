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
}

/**
 * Fields editable on an Education row. All optional — `update()` rejects an
 * empty object. Mirrors `EducationInput` per the inferred shape in
 * `research/notes/10-mutation-input-patterns.md` (Pattern 1) and the live
 * capture in `research/captures/web/inputs/UpdateEducationInput.json`.
 */
export interface EducationFields {
  institution?: string;
  degree?: string;
  fieldOfStudy?: string;
  location?: string;
  title?: string;
  yearFrom?: number;
  yearTo?: number;
  highlight?: boolean;
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
  data?: { profile?: { id: string; educations: { nodes: (Education | null)[] } } | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface MutationPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
  profile?: { id: string; educations: { nodes: (Education | null)[] } } | null;
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
  return profile.educations.nodes.filter((n): n is Education => n !== null);
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
 * education: EducationInput }`.
 */
export async function add(token: string, fields: EducationFields): Promise<Education> {
  if (!fields.institution || !fields.degree) {
    throw new ProfileError("VALIDATION_ERROR", "education add requires --institution and --degree.");
  }
  const profileId = await extractProfileId(token);
  const before = await listByProfileId(token, profileId);
  const beforeIds = new Set(before.map((e) => e.id));
  const res = await callTalentProfile(
    token,
    "CREATE_EDUCATION",
    CREATE_EDUCATION_MUTATION,
    { input: { profileId, education: fields } },
    "education add",
  );
  const payload = unwrapMutation(res, "createEducation", "education add");
  const after = payload.profile?.educations.nodes.filter((n): n is Education => n !== null) ?? [];
  const created = after.find((e) => !beforeIds.has(e.id));
  if (!created) {
    throw new ProfileError("UNKNOWN", "education add returned success but no new row was found in the response.");
  }
  return created;
}

/**
 * Update an existing education row. Wire format per Pattern 1:
 * `{ educationId, education: EducationInput }`.
 */
export async function update(token: string, id: string, fields: EducationFields): Promise<Education> {
  if (Object.keys(fields).length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "education update requires at least one field flag.");
  }
  const res = await callTalentProfile(
    token,
    "UPDATE_EDUCATION",
    UPDATE_EDUCATION_MUTATION,
    { input: { educationId: id, education: fields } },
    "education update",
  );
  const payload = unwrapMutation(res, "updateEducation", "education update");
  const updated = payload.profile?.educations.nodes.filter((n): n is Education => n !== null).find((e) => e.id === id);
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
