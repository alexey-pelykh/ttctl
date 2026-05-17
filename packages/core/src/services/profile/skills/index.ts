// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `profile.skills` service module — implements the seven leaves the CLI /
 * MCP surface expose for the user's Toptal Talent skill catalog:
 *
 * | Leaf            | Operation(s)                                            |
 * |-----------------|---------------------------------------------------------|
 * | `add`           | `ADD_PROFILE_SKILL_SET`                                 |
 * | `rm`            | `REMOVE_PROFILE_SKILL_SET`                              |
 * | `set`           | `UPDATE_PROFILE_SKILL_SET_RATING` /                     |
 * |                 | `UPDATE_PROFILE_SKILL_SET_EXPERIENCE` /                 |
 * |                 | `UPDATE_PROFILE_SKILL_SET_PUBLICITY` (multi-flag)       |
 * | `show`          | `GetSkillSetWithConnections`                            |
 * | `list`          | `getSkillSetsWithConnectionsWithConnectionsCount`       |
 * | `autocomplete`  | `GET_SKILLS_FOR_AUTOCOMPLETE`                           |
 * | `readiness`     | `getSkillsReadiness`                                    |
 *
 * **Cardinality collapse (per issue #73)**: 18 raw operations → 7 leaves.
 * The mapping above is the validated collapse — full mapping table from
 * the issue body (showing which operations fold into which leaf):
 *
 * - `ADD_PROFILE_SKILL_SET`, `addProfileSkillSetConnection`            → `add`
 * - `REMOVE_PROFILE_SKILL_SET`, `removeProfileSkillSetConnection`,
 *   `RemoveProfileSkillSet`                                            → `rm`
 * - `UPDATE_PROFILE_SKILL_SET_EXPERIENCE`, `_PUBLICITY`, `_RATING`,
 *   `SaveProfileSkillSet`, `SaveProfileSkillSetsAndConnections`,
 *   `SaveProfileSkillSetsPublicity`                                    → `set`
 * - `GetSkillSetWithConnections`,
 *   `GetSkillSetWithConnectionsTotalCounts`                            → `show`
 * - `getSkillSetsWithConnectionsWithConnectionsCount`,
 *   `REFETCH_PROFILE_SECTIONS_SKILLS`                                  → `list`
 * - `getSkills`, `GET_SKILLS_FOR_AUTOCOMPLETE`,
 *   `GetSkillsForAutoSuggest`, `SkillsAutocomplete`                    → `autocomplete`
 * - `getSkillsReadiness`                                               → `readiness`
 *
 * **Routing**: All operations dispatch against the `talent_profile`
 * Cloudflare-protected surface via `impersonatedTransport`. The mobile
 * gateway exposes a partial skills view via `viewer.viewerRole.profile.skillSets`
 * (used by `profile.basic.show`), but per-skillset operations (show by id,
 * autocomplete, readiness) only exist on the talent-profile surface — and
 * routing all skills calls through one transport keeps the implementation
 * coherent and the response shapes uniform.
 *
 * **Connection mutations are out of scope** for this leaf set:
 * `addProfileSkillSetConnection` / `removeProfileSkillSetConnection` link
 * a skill to a portfolio item / education / employment / certification.
 * They fold into `add` / `rm` semantically (the issue's cardinality table)
 * but are NOT wired here — the `connectionId` argument requires a UI flow
 * that surfaces selectable connection candidates first. Tracked as a
 * follow-up.
 */

import type { z } from "zod";

import { callGatewayShared } from "../../_shared/transport.js";

/**
 * Skills-domain error codes. Mirrors `profile.basic.ProfileErrorCode`'s
 * shape (NO_VIEWER, GRAPHQL_ERROR, NETWORK_ERROR, USER_ERROR, VALIDATION_ERROR,
 * UNKNOWN) — the duplication is intentional so each sub-domain can carry
 * its own typed error class without callers having to import a shared
 * cross-domain enum. Auth-revoked failures throw `AuthRevokedError`
 * (cross-cutting `TtctlError` subclass per issue #77), not a code on this
 * enum.
 */
export type SkillsErrorCode =
  | "NO_VIEWER"
  | "GRAPHQL_ERROR"
  | "NETWORK_ERROR"
  | "USER_ERROR"
  | "VALIDATION_ERROR"
  | "PARTIAL_FAILURE"
  | "WIRE_SHAPE_ERROR"
  | "UNKNOWN";

export class SkillsError extends Error {
  override readonly name = "SkillsError";
  constructor(
    public readonly code: SkillsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Thin per-service wrapper around {@link callGatewayShared} (issue
 * #329). Pins the talent-profile surface and the {@link SkillsError}
 * domain class. The `variables: unknown` parameter (cast to
 * `Record<string, unknown>` here) preserves the historical signature
 * — every leaf in this file constructs a fresh variables literal that
 * is structurally a `Record` regardless of nominal typing.
 */
async function callTalentProfile<T>(
  token: string,
  operationName: string,
  query: string,
  variables: unknown,
  schema?: z.ZodType<T>,
): Promise<T> {
  return callGatewayShared<T, SkillsError>(
    "talent-profile",
    token,
    operationName,
    query,
    variables as Record<string, unknown>,
    SkillsError,
    { schema },
  );
}

// -----------------------------------------------------------------------
// GraphQL operation documents
//
// These mirror `research/graphql/talent_profile/operations/*.graphql`,
// stripped of the unwired fragment dependencies (`MutationResultFragment`,
// `UserErrorFragment`, `ProfileCompletion`, `RealTimeFields`,
// `SkillsReadiness`, `ProfileRecommendations`) that the codegen pipeline
// hasn't yet been pointed at. The fragments are inlined to the minimum
// shape each leaf consumes — same pattern as `UPDATE_BASIC_INFO_MUTATION`
// in `profile.basic`.
//
// **Operation names are SCREAMING_CASE for mutations and camelCase for
// queries**, matching the bundle-extracted documents — see
// `research/notes/05-talent-profile-api.md` for the rationale (the server
// matches `operationName` literally and the React app sends these forms).
// -----------------------------------------------------------------------

const ADD_PROFILE_SKILL_SET_MUTATION = `mutation ADD_PROFILE_SKILL_SET($input: AddProfileSkillSetInput!) {
  addProfileSkillSet(input: $input) {
    skillSet {
      id
      experience
      rating
      public
      position
      skill { id name }
      connections { totalCount }
    }
    success
    notice
    errors { code key message }
  }
}`;

const REMOVE_PROFILE_SKILL_SET_MUTATION = `mutation REMOVE_PROFILE_SKILL_SET($input: RemoveProfileSkillSetInput!) {
  removeProfileSkillSet(input: $input) {
    success
    notice
    errors { code key message }
    profile { id }
  }
}`;

const UPDATE_RATING_MUTATION = `mutation UPDATE_PROFILE_SKILL_SET_RATING($input: UpdateProfileSkillSetRatingInput!) {
  updateProfileSkillSetRating(input: $input) {
    skillSet { id rating }
    success
    notice
    errors { code key message }
  }
}`;

const UPDATE_EXPERIENCE_MUTATION = `mutation UPDATE_PROFILE_SKILL_SET_EXPERIENCE($input: UpdateProfileSkillSetExperienceInput!) {
  updateProfileSkillSetExperience(input: $input) {
    skillSet { id experience }
    success
    notice
    errors { code key message }
  }
}`;

const UPDATE_PUBLICITY_MUTATION = `mutation UPDATE_PROFILE_SKILL_SET_PUBLICITY($input: UpdateProfileSkillSetPublicityInput!) {
  updateProfileSkillSetPublicity(input: $input) {
    skillSet { id public }
    success
    notice
    errors { code key message }
  }
}`;

const GET_SKILL_SET_QUERY = `query GetSkillSetWithConnections($id: ID!) {
  node(id: $id) {
    ... on ProfileSkillSet {
      id
      experience
      rating
      public
      position
      skill { id name }
      connections {
        totalCount
        nodes {
          ... on Node { id }
        }
      }
    }
  }
}`;

const LIST_SKILL_SETS_QUERY = `query getSkillSetsWithConnectionsWithConnectionsCount($profileId: ID!) {
  profile(id: $profileId) {
    id
    skillSets {
      nodes {
        id
        experience
        rating
        public
        position
        skill { id name }
        connections { totalCount }
      }
    }
  }
}`;

const AUTOCOMPLETE_SKILLS_QUERY = `query GET_SKILLS_FOR_AUTOCOMPLETE($profileId: ID!, $search: String!, $limit: Int!, $withoutIds: [ID!]) {
  profile(id: $profileId) {
    id
    skillsAutocomplete(search: $search, limit: $limit, withoutIds: $withoutIds) {
      id
      name
    }
  }
}`;

const SKILLS_READINESS_QUERY = `query getSkillsReadiness($profileId: ID!) {
  profile(id: $profileId) {
    id
    skillsReadiness {
      isExpertProficiencyCountSatisfied
      isHighlightedItemsCountAndExperienceSatisfied
      isItemsCountSatisfied
      isProficiencyNotSetCountSatisfied
      isProgrammingLanguageSatisfied
    }
  }
}`;

// -----------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------

/**
 * Proficiency rating on a `ProfileSkillSet`. Confirmed enum values from
 * `research/notes/10-mutation-input-patterns.md`. The wire-format `NOVICE`
 * variant is documented as "possibly" present but not exercised by the
 * write path — accept-on-read, validate-on-write.
 */
export type ProficiencyRating = "COMPETENT" | "STRONG" | "EXPERT" | "NOVICE";

/**
 * Visibility on a `ProfileSkillSet`. Boolean wire-format value drives the
 * `--public` / `--private` CLI flag pair (CLI translates either flag to
 * the same boolean before calling `set()`).
 */
export type SkillVisibility = boolean;

/**
 * Full skill set as exposed to consumers. Mirrors the GraphQL
 * `ProfileSkillSet` selection set we ask for, normalised so optional
 * fields surface as `null` rather than `undefined` (matches the
 * `profile.basic` convention).
 */
export interface ProfileSkillSet {
  id: string;
  experience: number | null;
  rating: ProficiencyRating | null;
  public: boolean;
  position: number | null;
  skill: { id: string; name: string };
  connectionsCount: number;
}

/** Skill suggestion returned by `autocomplete`. */
export interface SkillSuggestion {
  id: string;
  name: string;
}

/** Skill-readiness flags. Each boolean reflects a sub-criterion. */
export interface SkillsReadiness {
  isExpertProficiencyCountSatisfied: boolean;
  isHighlightedItemsCountAndExperienceSatisfied: boolean;
  isItemsCountSatisfied: boolean;
  isProficiencyNotSetCountSatisfied: boolean;
  isProgrammingLanguageSatisfied: boolean;
}

/**
 * Multi-flag input for {@link set}. AT LEAST one of `rating` /
 * `experience` / `public` must be supplied; an empty object is rejected
 * with `VALIDATION_ERROR` (callers can detect the "user provided no
 * flags" case at the CLI / MCP layer too — the duplicate gate keeps the
 * service self-defending).
 *
 * `experience` is the talent's total years/months on this skill,
 * expressed as an integer count of months on the wire; the CLI accepts a
 * duration string (`"5y"`, `"60"`) and converts before calling.
 */
export interface SkillUpdate {
  rating?: ProficiencyRating;
  experience?: number;
  public?: boolean;
}

/**
 * Result of {@link set}. Records the post-update server-confirmed state
 * for each field that was touched, plus the collected `notice` strings
 * (one per fired mutation). Callers display the notices verbatim — the
 * server uses them for soft signals like "Profile review may be required".
 */
export interface UpdateSkillResult {
  id: string;
  rating: ProficiencyRating | null;
  experience: number | null;
  public: boolean | null;
  notices: string[];
}

// -----------------------------------------------------------------------
// Wire-format response shapes (private)
// -----------------------------------------------------------------------

interface UserErrorEntry {
  code?: string | null;
  key?: string | null;
  message?: string | null;
}

interface AddSkillSetData {
  addProfileSkillSet?: {
    skillSet?: WireSkillSet | null;
    success?: boolean | null;
    notice?: string | null;
    errors?: UserErrorEntry[] | null;
  } | null;
}

interface RemoveSkillSetData {
  removeProfileSkillSet?: {
    success?: boolean | null;
    notice?: string | null;
    errors?: UserErrorEntry[] | null;
  } | null;
}

interface UpdateRatingData {
  updateProfileSkillSetRating?: {
    skillSet?: { id: string; rating: ProficiencyRating | null } | null;
    success?: boolean | null;
    notice?: string | null;
    errors?: UserErrorEntry[] | null;
  } | null;
}

interface UpdateExperienceData {
  updateProfileSkillSetExperience?: {
    skillSet?: { id: string; experience: number | null } | null;
    success?: boolean | null;
    notice?: string | null;
    errors?: UserErrorEntry[] | null;
  } | null;
}

interface UpdatePublicityData {
  updateProfileSkillSetPublicity?: {
    skillSet?: { id: string; public: boolean | null } | null;
    success?: boolean | null;
    notice?: string | null;
    errors?: UserErrorEntry[] | null;
  } | null;
}

interface WireSkillSet {
  id: string;
  experience: number | null;
  rating: ProficiencyRating | null;
  public: boolean;
  position: number | null;
  skill: { id: string; name: string };
  connections: { totalCount: number };
}

interface GetSkillSetData {
  node?:
    | (WireSkillSet & {
        connections: { totalCount: number; nodes?: ({ id: string } | null)[] | null };
      })
    | null;
}

interface ListSkillSetsData {
  profile?: {
    id: string;
    skillSets: { nodes: (WireSkillSet | null)[] };
  } | null;
}

interface AutocompleteData {
  profile?: {
    id: string;
    skillsAutocomplete: SkillSuggestion[];
  } | null;
}

interface ReadinessData {
  profile?: {
    id: string;
    skillsReadiness: SkillsReadiness;
  } | null;
}

function normaliseSkillSet(wire: WireSkillSet): ProfileSkillSet {
  return {
    id: wire.id,
    experience: wire.experience,
    rating: wire.rating,
    public: wire.public,
    position: wire.position,
    skill: wire.skill,
    connectionsCount: wire.connections.totalCount,
  };
}

function raiseUserErrors(operation: string, errors: UserErrorEntry[] | null | undefined): void {
  if (!Array.isArray(errors) || errors.length === 0) return;
  const first = errors[0];
  const fieldHint = first?.key ? ` (${first.key})` : "";
  throw new SkillsError("USER_ERROR", `${operation} rejected${fieldHint}: ${first?.message ?? "unknown error"}`);
}

// -----------------------------------------------------------------------
// add(skillName)
// -----------------------------------------------------------------------

/**
 * Add a skill to the signed-in user's profile. Identifies the skill by
 * its catalog name (e.g. `"TypeScript"`); the server resolves the name to
 * a `Skill` id under the hood and returns the newly-attached
 * `ProfileSkillSet` with default `rating`/`experience`/`public` values.
 *
 * Use {@link autocomplete} first if the caller needs to disambiguate
 * between candidate skills (e.g., "Postgres" vs "PostgreSQL"). Once the
 * skill is added, configure proficiency via {@link set}.
 *
 * Errors:
 * - `SkillsError` `VALIDATION_ERROR` when `name` is empty or whitespace-only.
 * - `SkillsError` `USER_ERROR` when the server reports a domain failure
 *   (e.g., skill already on profile, name not in catalog).
 * - `AuthRevokedError`, `Cf403Error`, plus the standard
 *   `GRAPHQL_ERROR`/`NETWORK_ERROR`/`UNKNOWN` codes from the shared
 *   transport-error path.
 */
export async function add(token: string, name: string): Promise<ProfileSkillSet> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Skill name is required.");
  }
  const data = await callTalentProfile<AddSkillSetData>(
    token,
    "ADD_PROFILE_SKILL_SET",
    ADD_PROFILE_SKILL_SET_MUTATION,
    {
      input: { name: trimmed },
    },
  );
  const payload = data.addProfileSkillSet;
  if (!payload) {
    throw new SkillsError("UNKNOWN", "ADD_PROFILE_SKILL_SET response had no `data.addProfileSkillSet` field");
  }
  raiseUserErrors("Skill add", payload.errors);
  if (payload.success === false) {
    throw new SkillsError(
      "USER_ERROR",
      `Skill add reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
  if (!payload.skillSet) {
    throw new SkillsError("UNKNOWN", "Skill add succeeded but response had no `skillSet` payload");
  }
  return normaliseSkillSet(payload.skillSet);
}

// -----------------------------------------------------------------------
// rm(skillSetId)
// -----------------------------------------------------------------------

/**
 * Remove a skill from the signed-in user's profile by its ProfileSkillSet
 * id (NOT the Skill catalog id). Removal cascades to any connections the
 * skill set held to portfolio items, education, employment, or
 * certifications — the server cleans those up server-side, no per-edge
 * call required from the client.
 *
 * Errors:
 * - `SkillsError` `VALIDATION_ERROR` when `id` is empty.
 * - `SkillsError` `USER_ERROR` when the id doesn't match a skill set on
 *   the user's profile (caller used a stale id).
 * - Standard transport-error path (auth-revoked / Cf403 / GraphQL /
 *   network / unknown).
 */
export async function rm(token: string, id: string): Promise<void> {
  if (id.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Skill set id is required.");
  }
  const data = await callTalentProfile<RemoveSkillSetData>(
    token,
    "REMOVE_PROFILE_SKILL_SET",
    REMOVE_PROFILE_SKILL_SET_MUTATION,
    { input: { skillSetId: id } },
  );
  const payload = data.removeProfileSkillSet;
  if (!payload) {
    throw new SkillsError("UNKNOWN", "REMOVE_PROFILE_SKILL_SET response had no `data.removeProfileSkillSet` field");
  }
  raiseUserErrors("Skill remove", payload.errors);
  if (payload.success === false) {
    throw new SkillsError(
      "USER_ERROR",
      `Skill remove reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
}

// -----------------------------------------------------------------------
// set(id, fields)
// -----------------------------------------------------------------------

/**
 * Update one or more fields on an existing skill set. Multi-flag atomic
 * semantics: each provided field fires its own GraphQL mutation
 * (`UPDATE_PROFILE_SKILL_SET_RATING` / `_EXPERIENCE` / `_PUBLICITY`)
 * sequentially. **Partial-failure behavior**: if mutation N succeeds but
 * mutation N+1 fails, the prior changes are NOT rolled back — the server
 * lacks a multi-field atomic path, so the client serialises the updates
 * and reports a `PARTIAL_FAILURE` error carrying which fields landed and
 * which didn't. Callers re-issue only the missing fields after handling
 * the failure.
 *
 * The mutation order is `rating → experience → public`, deterministic so
 * tests can predict the call sequence.
 *
 * Errors:
 * - `SkillsError` `VALIDATION_ERROR` when `id` is empty OR no fields
 *   are supplied.
 * - `SkillsError` `PARTIAL_FAILURE` when the second or third mutation
 *   fails after at least one earlier mutation succeeded. The error
 *   message names the failing field and the underlying message; the
 *   error's `cause` carries the per-field failure for callers that want
 *   structured access. The successful fields are reflected in the
 *   `result` snapshot included on the error.
 * - `SkillsError` `USER_ERROR` when the FIRST mutation fails — caller
 *   sees the same shape they'd see from a single-flag invocation.
 * - Standard transport-error path.
 */
export async function set(token: string, id: string, fields: SkillUpdate): Promise<UpdateSkillResult> {
  if (id.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Skill set id is required.");
  }
  if (fields.rating === undefined && fields.experience === undefined && fields.public === undefined) {
    throw new SkillsError(
      "VALIDATION_ERROR",
      "Skill update requires at least one of `rating`, `experience`, or `public`.",
    );
  }

  const result: UpdateSkillResult = {
    id,
    rating: null,
    experience: null,
    public: null,
    notices: [],
  };
  const completed: ("rating" | "experience" | "public")[] = [];

  // Helper used per-mutation: drives the first call as a normal failure
  // (USER_ERROR / standard transport error), and any subsequent failure
  // as PARTIAL_FAILURE so the caller can reason about which writes landed.
  const runStep = async (field: "rating" | "experience" | "public", fire: () => Promise<void>): Promise<void> => {
    try {
      await fire();
      completed.push(field);
    } catch (err) {
      if (completed.length === 0) throw err;
      throw new SkillsError(
        "PARTIAL_FAILURE",
        `Skill update partially failed: ${completed.join(", ")} succeeded, ${field} failed: ${(err as Error).message}`,
        { cause: err },
      );
    }
  };

  if (fields.rating !== undefined) {
    const rating = fields.rating;
    await runStep("rating", async () => {
      const data = await callTalentProfile<UpdateRatingData>(
        token,
        "UPDATE_PROFILE_SKILL_SET_RATING",
        UPDATE_RATING_MUTATION,
        { input: { skillSetId: id, skillSet: { rating } } },
      );
      const payload = data.updateProfileSkillSetRating;
      if (!payload) {
        throw new SkillsError("UNKNOWN", "UPDATE_PROFILE_SKILL_SET_RATING response had no payload");
      }
      raiseUserErrors("Skill rating update", payload.errors);
      if (payload.success === false) {
        throw new SkillsError(
          "USER_ERROR",
          `Skill rating update reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
        );
      }
      result.rating = payload.skillSet?.rating ?? rating;
      if (payload.notice) result.notices.push(payload.notice);
    });
  }

  if (fields.experience !== undefined) {
    const experience = fields.experience;
    await runStep("experience", async () => {
      const data = await callTalentProfile<UpdateExperienceData>(
        token,
        "UPDATE_PROFILE_SKILL_SET_EXPERIENCE",
        UPDATE_EXPERIENCE_MUTATION,
        { input: { skillSetId: id, skillSet: { experience } } },
      );
      const payload = data.updateProfileSkillSetExperience;
      if (!payload) {
        throw new SkillsError("UNKNOWN", "UPDATE_PROFILE_SKILL_SET_EXPERIENCE response had no payload");
      }
      raiseUserErrors("Skill experience update", payload.errors);
      if (payload.success === false) {
        throw new SkillsError(
          "USER_ERROR",
          `Skill experience update reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
        );
      }
      result.experience = payload.skillSet?.experience ?? experience;
      if (payload.notice) result.notices.push(payload.notice);
    });
  }

  if (fields.public !== undefined) {
    const isPublic = fields.public;
    await runStep("public", async () => {
      const data = await callTalentProfile<UpdatePublicityData>(
        token,
        "UPDATE_PROFILE_SKILL_SET_PUBLICITY",
        UPDATE_PUBLICITY_MUTATION,
        { input: { skillSetId: id, skillSet: { public: isPublic } } },
      );
      const payload = data.updateProfileSkillSetPublicity;
      if (!payload) {
        throw new SkillsError("UNKNOWN", "UPDATE_PROFILE_SKILL_SET_PUBLICITY response had no payload");
      }
      raiseUserErrors("Skill publicity update", payload.errors);
      if (payload.success === false) {
        throw new SkillsError(
          "USER_ERROR",
          `Skill publicity update reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
        );
      }
      result.public = payload.skillSet?.public ?? isPublic;
      if (payload.notice) result.notices.push(payload.notice);
    });
  }

  return result;
}

// -----------------------------------------------------------------------
// show(id)
// -----------------------------------------------------------------------

/**
 * Fetch a single skill set by its id, including its connection edges to
 * portfolio items / employment / education / certifications. Useful when
 * the caller already has the id (from `list()` or a recent mutation) and
 * needs to display the full detail without paging.
 *
 * Errors:
 * - `SkillsError` `VALIDATION_ERROR` when `id` is empty.
 * - `SkillsError` `USER_ERROR` when the id doesn't resolve to a
 *   `ProfileSkillSet` (server returns `node: null`).
 * - Standard transport-error path.
 */
export async function show(token: string, id: string): Promise<ProfileSkillSet> {
  if (id.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Skill set id is required.");
  }
  const data = await callTalentProfile<GetSkillSetData>(token, "GetSkillSetWithConnections", GET_SKILL_SET_QUERY, {
    id,
  });
  if (!data.node) {
    throw new SkillsError("USER_ERROR", `No ProfileSkillSet found with id "${id}".`);
  }
  return normaliseSkillSet(data.node);
}

// -----------------------------------------------------------------------
// list(profileId)
// -----------------------------------------------------------------------

/**
 * List every skill set on the signed-in user's profile, with each entry
 * carrying its connection-count summary (the digits the portal shows next
 * to "linked to N items"). Order matches the server's `position` field;
 * callers that need a specific sort apply it after fetching.
 *
 * The talent-profile surface keys this query on `profileId` rather than
 * resolving it server-side from the auth token, so the caller passes the
 * `profileId` it has on hand (typically obtained from `profile.basic.show`
 * or cached for the session).
 *
 * Errors:
 * - `SkillsError` `VALIDATION_ERROR` when `profileId` is empty.
 * - `SkillsError` `USER_ERROR` when the profile id doesn't resolve.
 * - Standard transport-error path.
 */
export async function list(token: string, profileId: string): Promise<ProfileSkillSet[]> {
  if (profileId.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Profile id is required.");
  }
  const data = await callTalentProfile<ListSkillSetsData>(
    token,
    "getSkillSetsWithConnectionsWithConnectionsCount",
    LIST_SKILL_SETS_QUERY,
    { profileId },
  );
  if (!data.profile) {
    throw new SkillsError("USER_ERROR", `No profile found with id "${profileId}".`);
  }
  return data.profile.skillSets.nodes.filter((n): n is WireSkillSet => n !== null).map(normaliseSkillSet);
}

// -----------------------------------------------------------------------
// autocomplete(profileId, query, options?)
// -----------------------------------------------------------------------

/**
 * Search the global skill catalog for entries matching `search`,
 * suitable for populating an autocomplete dropdown. The server scopes
 * results to skills the talent's vertical permits and excludes any ids
 * passed in `withoutIds` (typically the talent's existing skill-set
 * skill ids, so the dropdown doesn't suggest skills they already have).
 *
 * `limit` defaults to 10 (matches the portal's default page size).
 *
 * Errors:
 * - `SkillsError` `VALIDATION_ERROR` when `profileId` or `search` is empty.
 * - Standard transport-error path.
 */
export async function autocomplete(
  token: string,
  profileId: string,
  search: string,
  options: { limit?: number; withoutIds?: string[] } = {},
): Promise<SkillSuggestion[]> {
  if (profileId.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Profile id is required.");
  }
  if (search.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Search query is required.");
  }
  const data = await callTalentProfile<AutocompleteData>(
    token,
    "GET_SKILLS_FOR_AUTOCOMPLETE",
    AUTOCOMPLETE_SKILLS_QUERY,
    {
      profileId,
      search: search.trim(),
      limit: options.limit ?? 10,
      withoutIds: options.withoutIds ?? [],
    },
  );
  if (!data.profile) {
    throw new SkillsError("USER_ERROR", `No profile found with id "${profileId}".`);
  }
  return data.profile.skillsAutocomplete;
}

// -----------------------------------------------------------------------
// readiness(profileId)
// -----------------------------------------------------------------------

/**
 * Fetch the skill-readiness snapshot for the user's profile — the same
 * heuristics the portal uses to gate the "ready to apply" state on the
 * skills section. Useful for surfacing a checklist of remaining tasks
 * via CLI or MCP.
 *
 * Errors:
 * - `SkillsError` `VALIDATION_ERROR` when `profileId` is empty.
 * - `SkillsError` `USER_ERROR` when the profile id doesn't resolve.
 * - Standard transport-error path.
 */
export async function readiness(token: string, profileId: string): Promise<SkillsReadiness> {
  if (profileId.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Profile id is required.");
  }
  const data = await callTalentProfile<ReadinessData>(token, "getSkillsReadiness", SKILLS_READINESS_QUERY, {
    profileId,
  });
  if (!data.profile) {
    throw new SkillsError("USER_ERROR", `No profile found with id "${profileId}".`);
  }
  return data.profile.skillsReadiness;
}
