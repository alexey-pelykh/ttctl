// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ProfileError } from "../basic/index.js";
import { applyUserErrorsAndSuccess, callTalentProfile, ensureNoTopLevelErrors, extractProfileId } from "../shared.js";
import type { GraphQLErrorEntry, UserError } from "../shared.js";

/**
 * `Certification` row as ttctl exposes it. Mirrors the read-side
 * `Certification` GraphQL fragment (see
 * `research/graphql/talent_profile/fragments/Certification.graphql`)
 * trimmed to the fields ttctl currently surfaces. Validity dates are split
 * across `validFromMonth` / `validFromYear` (always set) and
 * `validToMonth` / `validToYear` (nullable for non-expiring certificates).
 *
 * `status` carries Toptal's verification / expiry state. Typed `string |
 * null` because the synthesized SDL types it `Unknown` (see #557) — the
 * concrete enum members (likely `valid` / `expired` / `pending-verification`
 * per the upstream fragment in
 * `research/graphql/talent_profile/fragments/Certification.graphql`) are
 * inferred from the wire and surfaced verbatim; the field is read-only
 * (not on `CertificationInput`).
 *
 * `skills` carries the talent's self-attested skill links per
 * certification (#558). Wire shape is the connection
 * `skills { nodes { id name } }` per the upstream fragment; ttctl
 * flattens it to `SkillRef[]` (mirrors `Employment.skills`). Read-only
 * (not on `CertificationInput`).
 */
export interface Certification {
  id: string;
  certificate: string;
  institution: string;
  link: string | null;
  number: string | null;
  validFromMonth: number | null;
  validFromYear: number | null;
  validToMonth: number | null;
  validToYear: number | null;
  highlight: boolean;
  status: string | null;
  skills: { id: string; name: string }[];
}

/**
 * Fields editable on a Certification row. Mirrors `CertificationInput` per
 * the inferred shape in `research/notes/10-mutation-input-patterns.md`
 * (Pattern 1) and the live capture in
 * `research/captures/web/inputs/UpdateCertificationInput.json`.
 */
export interface CertificationFields {
  certificate?: string;
  institution?: string;
  link?: string;
  number?: string;
  validFromMonth?: number;
  validFromYear?: number;
  validToMonth?: number | null;
  validToYear?: number | null;
  highlight?: boolean;
}

const CERTIFICATION_FRAGMENT = `fragment Certification on Certification {
  id
  certificate
  institution
  link
  number
  validFromMonth
  validFromYear
  validToMonth
  validToYear
  highlight
  status
  skills { nodes { id name } }
}`;

const GET_CERTIFICATION_QUERY = `query GET_CERTIFICATION($profileId: ID!) {
  profile(id: $profileId) {
    id
    certifications { nodes { ...Certification } }
  }
}
${CERTIFICATION_FRAGMENT}`;

const CREATE_CERTIFICATION_MUTATION = `mutation CREATE_CERTIFICATION($input: CreateCertificationInput!) {
  createCertification(input: $input) {
    success
    notice
    errors { code key message }
    profile { id certifications { nodes { ...Certification } } }
  }
}
${CERTIFICATION_FRAGMENT}`;

const UPDATE_CERTIFICATION_MUTATION = `mutation UPDATE_CERTIFICATION($input: UpdateCertificationInput!) {
  updateCertification(input: $input) {
    success
    notice
    errors { code key message }
    profile { id certifications { nodes { ...Certification } } }
  }
}
${CERTIFICATION_FRAGMENT}`;

const REMOVE_CERTIFICATION_MUTATION = `mutation REMOVE_CERTIFICATION($input: RemoveCertificationInput!) {
  removeCertification(input: $input) {
    success
    notice
    errors { code key message }
    profile { id certifications { nodes { ...Certification } } }
  }
}
${CERTIFICATION_FRAGMENT}`;

const HIGHLIGHT_CERTIFICATION_MUTATION = `mutation highlightCertification($id: ID!, $highlight: Boolean!) {
  highlightCertification(input: { certificationId: $id, highlight: $highlight }) {
    success
    notice
    errors { code key message }
    certification { id highlight }
  }
}`;

interface ListResponse {
  data?: { profile?: { id: string; certifications: { nodes: (Record<string, unknown> | null)[] } } | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

interface MutationPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
  profile?: { id: string; certifications: { nodes: (Record<string, unknown> | null)[] } } | null;
}

interface HighlightPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
  certification?: { id: string; highlight: boolean } | null;
}

interface MutationResponse {
  data?: Record<string, MutationPayload | HighlightPayload | null> | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Map a Certification fragment node from the raw wire shape to the typed
 * {@link Certification}. The wire surfaces `skills` as a nested
 * connection (`skills { nodes [{ id, name }] }`), not the flat
 * `SkillRef[]` ttctl exposes — so a projection step is required.
 * Mirrors `mapEmploymentNode` in the employment service. Introduced for
 * #558.
 */
function mapCertificationNode(node: Record<string, unknown>): Certification {
  const skillsConn = node["skills"] as { nodes?: { id?: unknown; name?: unknown }[] } | null | undefined;
  const skills: { id: string; name: string }[] = Array.isArray(skillsConn?.nodes)
    ? skillsConn.nodes.flatMap((s) =>
        typeof s.id === "string" && typeof s.name === "string" ? [{ id: s.id, name: s.name }] : [],
      )
    : [];
  return {
    id: typeof node["id"] === "string" ? node["id"] : "",
    certificate: typeof node["certificate"] === "string" ? node["certificate"] : "",
    institution: typeof node["institution"] === "string" ? node["institution"] : "",
    link: typeof node["link"] === "string" ? node["link"] : null,
    number: typeof node["number"] === "string" ? node["number"] : null,
    validFromMonth: typeof node["validFromMonth"] === "number" ? node["validFromMonth"] : null,
    validFromYear: typeof node["validFromYear"] === "number" ? node["validFromYear"] : null,
    validToMonth: typeof node["validToMonth"] === "number" ? node["validToMonth"] : null,
    validToYear: typeof node["validToYear"] === "number" ? node["validToYear"] : null,
    highlight: Boolean(node["highlight"]),
    status: typeof node["status"] === "string" ? node["status"] : null,
    skills,
  };
}

/**
 * List the signed-in user's certification rows.
 *
 * Issues `GET_CERTIFICATION` against the talent-profile surface; keyed by
 * the user's `profileId`.
 */
export async function list(token: string): Promise<Certification[]> {
  const profileId = await extractProfileId(token);
  return listByProfileId(token, profileId);
}

/**
 * Internal helper: list certification rows when the caller has already
 * resolved `profileId` (used by `add()` to avoid double-round-tripping).
 */
async function listByProfileId(token: string, profileId: string): Promise<Certification[]> {
  const res = await callTalentProfile(
    token,
    "GET_CERTIFICATION",
    GET_CERTIFICATION_QUERY,
    { profileId },
    "certifications list",
  );
  const body = res.body as ListResponse | null;
  ensureNoTopLevelErrors(body, "certifications list");
  const profile = body?.data?.profile;
  if (!profile) throw new ProfileError("UNKNOWN", "certifications list response had no `data.profile` field");
  return profile.certifications.nodes.filter((n): n is Record<string, unknown> => n !== null).map(mapCertificationNode);
}

/**
 * Look up a single certification row by id. Throws `VALIDATION_ERROR`
 * when no matching row exists.
 */
export async function show(token: string, id: string): Promise<Certification> {
  const all = await list(token);
  const found = all.find((c) => c.id === id);
  if (!found) {
    throw new ProfileError("VALIDATION_ERROR", `Certification with id "${id}" not found on this profile.`);
  }
  return found;
}

/**
 * Create a new certification row. Wire format per Pattern 2:
 * `{ profileId, certification: CertificationInput }`. `certificate` and
 * `institution` are required.
 */
export async function add(token: string, fields: CertificationFields): Promise<Certification> {
  if (!fields.certificate || !fields.institution) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      "certifications add requires --name (certificate) and --issuer (institution).",
    );
  }
  const profileId = await extractProfileId(token);
  const before = await listByProfileId(token, profileId);
  const beforeIds = new Set(before.map((c) => c.id));
  const res = await callTalentProfile(
    token,
    "CREATE_CERTIFICATION",
    CREATE_CERTIFICATION_MUTATION,
    { input: { profileId, certification: fields } },
    "certifications add",
  );
  const payload = unwrapMutation(res, "createCertification", "certifications add");
  const after =
    payload.profile?.certifications.nodes
      .filter((n): n is Record<string, unknown> => n !== null)
      .map(mapCertificationNode) ?? [];
  const created = after.find((c) => !beforeIds.has(c.id));
  if (!created) {
    throw new ProfileError("UNKNOWN", "certifications add returned success but no new row was found in the response.");
  }
  return created;
}

/**
 * Update an existing certification row. Wire format per Pattern 1:
 * `{ certificationId, certification: CertificationInput }`.
 */
export async function update(token: string, id: string, fields: CertificationFields): Promise<Certification> {
  if (Object.keys(fields).length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "certifications update requires at least one field flag.");
  }
  const res = await callTalentProfile(
    token,
    "UPDATE_CERTIFICATION",
    UPDATE_CERTIFICATION_MUTATION,
    { input: { certificationId: id, certification: fields } },
    "certifications update",
  );
  const payload = unwrapMutation(res, "updateCertification", "certifications update");
  const updated = payload.profile?.certifications.nodes
    .filter((n): n is Record<string, unknown> => n !== null)
    .map(mapCertificationNode)
    .find((c) => c.id === id);
  if (!updated) {
    throw new ProfileError(
      "UNKNOWN",
      `certifications update returned success but row "${id}" was not in the response.`,
    );
  }
  return updated;
}

/**
 * Remove a certification row. Wire format per Pattern 3:
 * `{ certificationId }`.
 */
export async function remove(token: string, id: string): Promise<string> {
  const res = await callTalentProfile(
    token,
    "REMOVE_CERTIFICATION",
    REMOVE_CERTIFICATION_MUTATION,
    { input: { certificationId: id } },
    "certifications remove",
  );
  unwrapMutation(res, "removeCertification", "certifications remove");
  return id;
}

/**
 * Toggle the `highlight` flag on a certification row. Wire format per
 * Pattern 4: `{ certificationId, highlight: Boolean }`.
 */
export async function highlight(token: string, id: string, value = true): Promise<{ id: string; highlight: boolean }> {
  const res = await callTalentProfile(
    token,
    "highlightCertification",
    HIGHLIGHT_CERTIFICATION_MUTATION,
    { id, highlight: value },
    "certifications highlight",
  );
  const body = res.body as MutationResponse | null;
  ensureNoTopLevelErrors(body, "certifications highlight");
  const payload = body?.data?.highlightCertification as HighlightPayload | undefined;
  if (!payload) throw new ProfileError("UNKNOWN", "certifications highlight response had no payload.");
  applyUserErrorsAndSuccess(payload, "certifications highlight");
  if (!payload.certification) {
    throw new ProfileError("UNKNOWN", "certifications highlight response had no `certification` field.");
  }
  return payload.certification;
}

function unwrapMutation(
  res: { body: unknown },
  payloadKey: "createCertification" | "updateCertification" | "removeCertification",
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
