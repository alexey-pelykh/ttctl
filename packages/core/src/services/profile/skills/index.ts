// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `profile.skills` service module — implements the eight leaves the CLI /
 * MCP surface expose for the user's Toptal Talent skill catalog:
 *
 * | Leaf             | Operation(s)                                            |
 * |------------------|---------------------------------------------------------|
 * | `add`            | `ADD_PROFILE_SKILL_SET`                                 |
 * | `rm`             | `REMOVE_PROFILE_SKILL_SET`                              |
 * | `set`            | `UPDATE_PROFILE_SKILL_SET_RATING` /                     |
 * |                  | `UPDATE_PROFILE_SKILL_SET_EXPERIENCE` /                 |
 * |                  | `UPDATE_PROFILE_SKILL_SET_PUBLICITY` (multi-flag)       |
 * | `show`           | `GetSkillSetWithConnections`                            |
 * | `list`           | `getSkillSetsWithConnectionsWithConnectionsCount`       |
 * | `autocomplete`   | `GET_SKILLS_FOR_AUTOCOMPLETE`                           |
 * | `readiness`      | `getSkillsReadiness`                                    |
 * | `add-connection` | `addProfileSkillSetConnection`                          |
 * | `remove-connection` | `removeProfileSkillSetConnection`                    |
 *
 * **Cardinality**: 19 raw operations → 9 leaves. `add-connection` and
 * `remove-connection` are per-edge link/unlink ops — distinct from
 * `add` / `rm` because they link an existing skill-set to a
 * portfolio / education / employment / certification row, gated by the
 * ADR-009 (ttctl) `profile-capability` consent ceremony. Full mapping
 * table:
 *
 * - `ADD_PROFILE_SKILL_SET`                                            → `add`
 * - `REMOVE_PROFILE_SKILL_SET`, `RemoveProfileSkillSet`                → `rm`
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
 * - `addProfileSkillSetConnection`                                     → `add-connection`
 * - `removeProfileSkillSetConnection`                                  → `remove-connection`
 *
 * **Routing**: All operations dispatch against the `talent_profile`
 * Cloudflare-protected surface via `impersonatedTransport`. The mobile
 * gateway exposes a partial skills view via `viewer.viewerRole.profile.skillSets`
 * (used by `profile.basic.show`), but per-skillset operations (show by id,
 * autocomplete, readiness) only exist on the talent-profile surface — and
 * routing all skills calls through one transport keeps the implementation
 * coherent and the response shapes uniform.
 */

import type { z } from "zod";

import { callGatewayShared } from "../../_shared/transport.js";
import { ensureDestructiveConsent } from "../../../consent.js";
import { buildDryRunPreview } from "../../../transport.js";
import type { DryRunPreview } from "../../../transport.js";
import { DRY_RUN_PROFILE_ID_PLACEHOLDER } from "../basic/index.js";
import { extractProfileId } from "../shared.js";

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
 * Catalog (or custom) skill the {@link ProfileSkillSet} is bound to.
 *
 * Declared as a *named* interface rather than an inline object literal so
 * the write-read-symmetry gate's file-local BFS can traverse it: the gate
 * builds the reachable echo-field set by walking named interface
 * references, and an inline `{ id; name }` is invisible to that walk.
 * With `SkillRef` named, `AddSkillFields.name` is correctly recognised as
 * echoed at `ProfileSkillSet.skill.name` (Class B gap defense — see
 * CLAUDE.md § Write-read symmetry gate).
 */
export interface SkillRef {
  /** Catalog `Skill` id (`V1-Skill-<n>`) or the server-synthesised id for a custom skill. */
  id: string;
  /** Display name of the skill. Echoes {@link AddSkillFields.name}. */
  name: string;
}

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
  skill: SkillRef;
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

/**
 * Caller-facing input shape for {@link add}.
 *
 * **Required**: `name`. **Optional with defaults**: `rating` ("COMPETENT"),
 * `experience` (1), `public` (false). The defaults exist so the AC
 * `{name: "<skill>"}` succeeds against the live wire (the server rejects
 * with "Expected value to not be null" on any of `rating` / `experience` /
 * `public` if omitted). Callers wanting a different proficiency can either
 * pass it here OR add the skill with the defaults and follow up with
 * {@link set}.
 *
 * **Optional bypass**: `skillId`. When supplied, the server binds the new
 * `ProfileSkillSet` to the catalog `Skill` identified by this id (e.g.,
 * `"V1-Skill-278891"`). Sourced via {@link autocomplete}. When omitted,
 * {@link add} fires autocomplete with `name` and applies the resolution
 * policy (#405) — see {@link add} for the policy. Both the explicit-bypass
 * path AND the auto-resolved path send the resolved catalog id on the
 * wire; the custom-skill fallback (`skillSet.id` omitted) only fires when
 * autocomplete returns zero exact matches.
 *
 * **Per the wire capture** (`research/captures/web/inputs/
 * ADD_PROFILE_SKILL_SET.json`): the wire format is
 * `{ profileId, skillSet: { name, rating, experience, public, [id] } }` —
 * Pattern 2 with parent id; the inner `skillSet.id` is the CATALOG skill
 * id (`V1-Skill-<n>`), NOT the resulting `ProfileSkillSet` id (which is
 * `V1-ProfileSkillSet-<n>` and only exists in the response).
 */
export interface AddSkillFields {
  name: string;
  /** Proficiency rating. Defaults to `"COMPETENT"`. */
  rating?: ProficiencyRating;
  /** Total experience on the skill. Defaults to `1`. Passed verbatim to the wire (the existing `set` flow uses the same convention). */
  experience?: number;
  /** Profile visibility. Defaults to `false` (private). */
  public?: boolean;
  // write-only: catalog `Skill` id (e.g. "V1-Skill-278891") consumed to bind
  // the new ProfileSkillSet to a catalog Skill; the resolved binding is
  // echoed via skill.id / skill.name on the read side rather than the input
  // field name. Omit to let {@link add} resolve via autocomplete (#405).
  // See AddSkillFields docstring § "Optional bypass" and the employment.add
  // employerId precedent.
  skillId?: string;
}

/**
 * Options accepted by {@link add}. `dryRun` mirrors the option-shape
 * established by `basic.set` (#393 / SetOptions) and `employment.add`
 * (#395 / AddOptions) so the cross-service surface stays uniform —
 * callers branch on the {@link AddSkillOutcome} `kind` discriminator
 * regardless of which mutation they're invoking.
 *
 * **Dry-run network behavior (#405)**: dry-run with an explicit `skillId`
 * is zero-network — `extractProfileId` is skipped, the placeholder
 * {@link DRY_RUN_PROFILE_ID_PLACEHOLDER} stands in for `profileId`, and
 * the `ADD_PROFILE_SKILL_SET` mutation is NOT fired. Dry-run WITHOUT a
 * `skillId` fires `extractProfileId` + autocomplete reads so the
 * preview's wire shape carries the resolved `skillSet.id` (or omits it
 * for the custom-skill fallback) — matching what the live mutation would
 * transmit. The mutation transport is still NEVER fired in `dryRun` mode.
 * This mirrors the {@link employment.add} (#395) dry-run pattern; the
 * difference vs `basic.set` (zero-network dry-run) is intentional —
 * preview wire-shape accuracy beats the zero-network invariant here.
 */
export interface AddSkillOptions {
  dryRun?: boolean;
}

/**
 * Discriminated outcome of an {@link add} call when the apply-path
 * succeeded — the newly created `ProfileSkillSet`.
 */
export interface AddSkillOutcomeCreated {
  kind: "created";
  result: ProfileSkillSet;
}

/**
 * Discriminated outcome of an {@link add} call invoked with
 * `dryRun: true` — the structured preview of the request that WOULD
 * have been sent. The `skillsAutocomplete` read query MAY have been
 * fired during dry-run to resolve `skillSet.id` (#405); the
 * `ADD_PROFILE_SKILL_SET` mutation transport was NOT fired.
 */
export interface AddSkillOutcomePreview {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link add}. Apply-path callers
 * branch on `outcome.kind === "created"`; dry-run callers branch on
 * `"preview"`. Symmetric with `basic.set`'s `SetOutcome` (#393) and
 * `employment.add`'s `AddOutcome` (#395).
 */
export type AddSkillOutcome = AddSkillOutcomeCreated | AddSkillOutcomePreview;

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
  skill: SkillRef;
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
 * its `name` (e.g. `"TypeScript"`) plus the proficiency dimensions the
 * live wire requires (`rating`, `experience`, `public`).
 *
 * **Wire shape** (per `research/captures/web/inputs/ADD_PROFILE_SKILL_SET.json`):
 * `{ input: { profileId, skillSet: { name, rating, experience, public, [id] } } }` —
 * Pattern 2 with parent id. The inner `skillSet.id` is the catalog
 * `Skill` id (V1-Skill-<n>); omit it to create a custom (non-catalog)
 * skill from the `name` string.
 *
 * **Defaults** (so `add(token, { name })` succeeds out of the box):
 *   - `rating: "COMPETENT"` (least-claim default; user can upgrade via `set`)
 *   - `experience: 1`
 *   - `public: false` (privacy default)
 *
 * **skillId resolution (#405)**: mirrors the {@link employment.add}
 * (#395) `--company` → `employerId` flow so the cross-domain UX stays
 * uniform.
 *
 *   1. If `fields.skillId` is supplied → use it verbatim. This is the
 *      explicit-bypass path (`--skill-id` on CLI, `skillId` on MCP) —
 *      useful for replay scripts, the disambiguation fallback, or
 *      known-good catalog ids.
 *   2. Otherwise, fire {@link autocomplete} against `fields.name`.
 *      Practical cardinality is on EXACT NAME MATCH (case-insensitive,
 *      trimmed):
 *        - exactly 1 exact match → use its id transparently
 *        - 2+ exact matches (catalog duplicates) → `VALIDATION_ERROR`
 *          listing the duplicates + `--skill-id` nudge
 *        - 0 exact matches → fall back to custom-skill creation
 *          (preserves pre-#405 behavior; `skillSet.id` is OMITTED and
 *          the server treats `name` as a free-text custom skill).
 *
 *      The 0-match case INTENTIONALLY differs from {@link employment.add}
 *      (which throws): a custom-skill is a valid Toptal wire variant
 *      (captured at `research/captures/web/inputs/ADD_PROFILE_SKILL_SET.json`),
 *      whereas a custom-employer requires the explicit `noEmployer` opt-in
 *      (#401). The "scoped escape hatch" is the existing `--skill-id`
 *      flag — a user who wants a custom-skill despite an exact catalog
 *      match should either tweak the name OR file a follow-up requesting
 *      an explicit custom-skill flag.
 *
 * **Bug history (#396)**: pre-#396, `add(token, name)` sent the invented
 * shape `{ input: { name } }`. The server rejected with
 * `name (Field is not defined), profileId (required), skillSet (required)`
 * — the schema for `AddProfileSkillSetInput` was a gap
 * (`{ _placeholder: String }` at `schema.graphql:893`) and the shape had
 * to be derived from live capture. #396 commits the capture, fixes the
 * wire shape, and bumps the signature to a `{ fields, options }` form
 * mirroring `employment.add` (#395) and `basic.set` (#393). #405 wires
 * transparent autocomplete resolution on top of that capture.
 *
 * **Dry-run network behavior**: see {@link AddSkillOptions} for the
 * full semantics. Briefly: dry-run + explicit `skillId` = zero-network;
 * dry-run + no `skillId` fires `extractProfileId` + autocomplete so the
 * preview's wire shape carries the resolved `skillSet.id` (or omits it
 * for the 0-match custom-skill fallback). The mutation transport is
 * NEVER fired in dry-run mode.
 *
 * Errors:
 * - `SkillsError` `VALIDATION_ERROR` when `fields.name` is empty or
 *   whitespace-only, OR when autocomplete returns ≥2 exact matches and
 *   the caller did not supply `skillId` to disambiguate.
 * - `SkillsError` `USER_ERROR` when the server reports a domain failure
 *   (e.g., skill already on profile, invalid catalog id, server-side
 *   policy rejection).
 * - `ProfileError` `NO_VIEWER` from the `extractProfileId(token)`
 *   round-trip propagates verbatim — fires on every path EXCEPT
 *   dry-run + explicit `skillId` (the zero-network combo). Surfaces
 *   with the same actionable message as `ttctl profile show`.
 * - `AuthRevokedError`, `Cf403Error`, plus the standard
 *   `GRAPHQL_ERROR`/`NETWORK_ERROR`/`UNKNOWN` codes from the shared
 *   transport-error path.
 */
export async function add(
  token: string,
  fields: AddSkillFields,
  options: AddSkillOptions = {},
): Promise<AddSkillOutcome> {
  const name = fields.name.trim();
  if (name.length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Skill name is required.");
  }

  // Build the `skillSet` wire-input verbatim per the capture. Defaults
  // are applied here (not at the call sites) so every caller — CLI,
  // MCP, internal — converges on the same wire shape.
  const skillSet: {
    name: string;
    rating: ProficiencyRating;
    experience: number;
    public: boolean;
    id?: string;
  } = {
    name,
    rating: fields.rating ?? "COMPETENT",
    experience: fields.experience ?? 1,
    public: fields.public ?? false,
  };

  // Resolve `skillSet.id` (#405). Three branches:
  //   - explicit `skillId` → use verbatim; no autocomplete fired.
  //   - no `skillId` → extractProfileId (autocomplete requires it) →
  //     autocomplete → policy. Resolution fires in BOTH dry-run and
  //     apply paths so the preview's wire shape matches what the live
  //     mutation would transmit (mirrors #395 employment.add).
  //
  // `profileId` is captured here so the apply-path mutation can reuse
  // it without re-fetching.
  let profileId: string | undefined;
  if (fields.skillId !== undefined && fields.skillId !== "") {
    skillSet.id = fields.skillId;
  } else {
    profileId = await extractProfileId(token);
    const resolved = await resolveSkillId(token, profileId, name);
    if (resolved !== undefined) {
      skillSet.id = resolved;
    }
  }

  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "talent-profile",
        authToken: token,
        body: {
          operationName: "ADD_PROFILE_SKILL_SET",
          query: ADD_PROFILE_SKILL_SET_MUTATION,
          variables: { input: { profileId: DRY_RUN_PROFILE_ID_PLACEHOLDER, skillSet } },
        },
      }),
    };
  }

  // Apply path. Reuse `profileId` from the resolution branch if already
  // extracted, otherwise extract it now (explicit-skillId path skipped
  // it above).
  profileId ??= await extractProfileId(token);
  const data = await callTalentProfile<AddSkillSetData>(
    token,
    "ADD_PROFILE_SKILL_SET",
    ADD_PROFILE_SKILL_SET_MUTATION,
    { input: { profileId, skillSet } },
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
  return { kind: "created", result: normaliseSkillSet(payload.skillSet) };
}

/**
 * Resolve `fields.skillId` for the {@link add} flow when the caller did
 * NOT supply an explicit `skillId` (#405). Mirrors the
 * {@link employment.add} (#395) `resolveEmployerId` policy:
 *
 *   - 1 exact name match (case-insensitive, trimmed) → return its id
 *     for transparent binding to the catalog `Skill`.
 *   - 2+ exact matches → `VALIDATION_ERROR` listing the duplicates +
 *     `--skill-id` nudge. Catalog duplicates are rare but possible
 *     (e.g., distinct entries with identical display names across
 *     verticals); when they occur the caller must disambiguate.
 *   - 0 exact matches (regardless of fuzzy count) → return `undefined`
 *     and let `add()` fall back to the custom-skill path (omits
 *     `skillSet.id`). This INTENTIONALLY differs from
 *     `resolveEmployerId` — see {@link add} for the rationale.
 *
 * The autocomplete is fired with the default `limit: 10`. Fuzzy matches
 * are not surfaced (the policy depends only on the exact-match
 * cardinality), so a larger limit would only cost network without
 * changing the resolution outcome.
 */
async function resolveSkillId(token: string, profileId: string, name: string): Promise<string | undefined> {
  const matches = await autocomplete(token, profileId, name);
  const norm = name.trim().toLowerCase();
  const exact = matches.filter((m) => m.name.trim().toLowerCase() === norm);

  if (exact.length === 1) {
    const only = exact[0];
    if (only === undefined) {
      // Defensive: exact.length === 1 but indexed read is undefined —
      // a TypeScript noUncheckedIndexedAccess guard. Unreachable at runtime.
      throw new SkillsError("UNKNOWN", "skill-autocomplete returned 1 exact match but indexing it yielded undefined.");
    }
    return only.id;
  }

  if (exact.length >= 2) {
    // Multiple catalog records share the user-supplied exact name.
    const list = exact.map(formatSkillCandidate).join("\n");
    throw new SkillsError(
      "VALIDATION_ERROR",
      `Multiple catalog skills matched "${name}" exactly (${exact.length.toString()} duplicates in the catalog):\n` +
        `${list}\n` +
        `Pass \`--skill-id <id>\` to disambiguate.`,
    );
  }

  // exact.length === 0 → fall back to custom-skill creation (preserves
  // pre-#405 behavior). The fuzzy matches are intentionally NOT
  // surfaced here — they would just nudge the user away from the valid
  // custom-skill path, and the resolution policy explicitly treats
  // fuzzy-only as the same bucket as no-match-at-all.
  return undefined;
}

function formatSkillCandidate(m: SkillSuggestion): string {
  return `  - ${m.id}  ${m.name}`;
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

// -----------------------------------------------------------------------
// add-connection — addProfileSkillSetConnection
// -----------------------------------------------------------------------

/**
 * Connection-target taxonomy for the CLI / MCP `--connection-type` flag.
 * NOT sent on the wire — the server resolves the target from the Relay
 * node id's type segment. The enum survives as a client-side UX guard:
 * the caller declares the expected type, the service cross-checks
 * against the connectionId prefix, mismatches surface as
 * `VALIDATION_ERROR` before any wire call.
 */
export type SkillConnectionType = "EMPLOYMENT" | "EDUCATION" | "PORTFOLIO_ITEM" | "CERTIFICATION";

/**
 * Frozen list of permitted {@link SkillConnectionType} values — used by
 * the client-side cross-check and re-exported through the CLI / MCP
 * surfaces so `--help` text and Zod enums share one source of truth.
 */
export const SKILL_CONNECTION_TYPES: readonly SkillConnectionType[] = Object.freeze([
  "EMPLOYMENT",
  "EDUCATION",
  "PORTFOLIO_ITEM",
  "CERTIFICATION",
]);

const RELAY_PREFIX_TO_CONNECTION_TYPE: Readonly<Record<string, SkillConnectionType>> = Object.freeze({
  Employment: "EMPLOYMENT",
  Education: "EDUCATION",
  Certification: "CERTIFICATION",
  PortfolioItem: "PORTFOLIO_ITEM",
});

function inferConnectionTypeFromId(connectionId: string): SkillConnectionType | null {
  const match = /^V1-([A-Za-z]+)-/.exec(connectionId);
  if (!match) return null;
  return RELAY_PREFIX_TO_CONNECTION_TYPE[match[1] ?? ""] ?? null;
}

/**
 * Per-domain consent ceremony for {@link addConnection}. Per
 * ADR-009 (ttctl) § Decision Part 1, this mutation is in the
 * `profile-capability` domain — linking a skill to an
 * employment / education / certification / portfolio row writes a
 * recruiter-visible capability claim onto the public profile. The
 * static type narrows to compile-time-true; the runtime gate at
 * {@link ensureDestructiveConsent} covers `as`-cast bypasses and
 * JSON-sourced inputs (CLI / MCP / agents).
 */
export interface AddSkillConnectionConsent {
  // write-only: ADR-009 (ttctl) per-domain consent literal — TTCtl-layer
  // gate field, never echoed by the wire.
  profileCapabilityConsentIssued: true;
}

/**
 * Caller-facing input for {@link addConnection}. The wire input is
 * `{ skillSetId, connectionId }`; {@link connectionType} is a
 * TTCtl-layer UX guard cross-checked against the connectionId Relay
 * prefix, not sent on the wire.
 */
export interface AddSkillConnectionFields {
  /**
   * `ProfileSkillSet` id (`V1-ProfileSkillSet-<n>`) — the skill being
   * linked. Obtain via {@link list} / {@link show}.
   */
  skillSetId: string;
  /**
   * Declared target type. NOT sent on the wire — cross-checked against
   * the {@link connectionId} Relay prefix; mismatches throw
   * `VALIDATION_ERROR`.
   */
  connectionType: SkillConnectionType;
  /**
   * Target row id — `V1-Employment-<n>` for `EMPLOYMENT`,
   * `V1-Education-<n>` for `EDUCATION`, `V1-Certification-<n>` for
   * `CERTIFICATION`, `V1-PortfolioItem-<n>` for `PORTFOLIO_ITEM`. The
   * Relay type segment is the wire-side discriminator.
   */
  connectionId: string;
}

/**
 * Options accepted by {@link addConnection}. `dryRun` mirrors the
 * cross-service option-shape used elsewhere in this module (`add` /
 * `set`) — callers branch on the {@link AddSkillConnectionOutcome}
 * `kind` discriminator regardless of which leaf they're invoking.
 */
export interface AddSkillConnectionOptions {
  dryRun?: boolean;
}

/**
 * Server-confirmed result of {@link addConnection}.
 */
export interface AddSkillConnectionResult {
  /** Echo of the {@link AddSkillConnectionFields.skillSetId} input. */
  skillSetId: string;
  /** Post-link `connections.totalCount` on the skill-set. */
  connectionsCount: number;
  /**
   * Connection node ids attached to the skill-set after the link
   * landed — the just-linked
   * {@link AddSkillConnectionFields.connectionId} appears here on
   * success (the write-read symmetry checkpoint).
   */
  connectionIds: string[];
  /**
   * Server-supplied free-text notice (e.g. "Connection added."). May be
   * `null` when the wire returns no notice.
   */
  notice: string | null;
}

/**
 * Discriminated apply-path outcome for {@link addConnection}.
 */
export interface AddSkillConnectionAppliedOutcome {
  kind: "applied";
  result: AddSkillConnectionResult;
}

/**
 * Discriminated dry-run outcome for {@link addConnection}. Mirrors the
 * cross-service `*.Preview` outcome shape (`basic.set`, `employment.add`,
 * `specializations.apply`).
 */
export interface AddSkillConnectionPreviewOutcome {
  kind: "preview";
  preview: DryRunPreview;
}

/**
 * Discriminated-union return type for {@link addConnection}. Apply-path
 * callers branch on `outcome.kind === "applied"`; dry-run callers branch
 * on `"preview"`.
 */
export type AddSkillConnectionOutcome = AddSkillConnectionAppliedOutcome | AddSkillConnectionPreviewOutcome;

// Untrusted catalog: listed in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`
// (`codegen.config.ts`), so no generated operation type exists — T1
// (snapshot) disposition. Response selection mirrors `GET_SKILL_SET_QUERY`.
const ADD_PROFILE_SKILL_SET_CONNECTION_MUTATION = `mutation addProfileSkillSetConnection($input: AddProfileSkillSetConnectionInput!) {
  addProfileSkillSetConnection(input: $input) {
    skillSet {
      id
      connections {
        totalCount
        nodes {
          ... on Node { id }
        }
      }
    }
    success
    notice
    errors { code key message }
  }
}`;

interface AddSkillSetConnectionData {
  addProfileSkillSetConnection?: {
    skillSet?: {
      id: string;
      connections?: {
        totalCount: number;
        nodes?: ({ id: string } | null)[] | null;
      } | null;
    } | null;
    success?: boolean | null;
    notice?: string | null;
    errors?: UserErrorEntry[] | null;
  } | null;
}

/**
 * Link a `ProfileSkillSet` to a single employment / education /
 * certification / portfolio row.
 *
 * Flow:
 *   1. Consent gate (ADR-009 (ttctl) `profile-capability` domain) — fires
 *      BEFORE the dry-run short-circuit.
 *   2. Input validation: `skillSetId` / `connectionId` non-empty;
 *      `connectionType` ∈ {@link SKILL_CONNECTION_TYPES}; the
 *      `connectionId` Relay prefix matches the declared `connectionType`
 *      (client-side guard — server discriminates from the Relay id
 *      itself).
 *   3. Dry-run short-circuit on `options.dryRun === true`.
 *   4. Wire call: `addProfileSkillSetConnection` against the
 *      talent-profile surface via `impersonatedTransport`. Wire
 *      variables are `{ skillSetId, connectionId }`.
 *   5. Error mapping: `payload.errors[]` non-empty OR
 *      `payload.success === false` surfaces as `USER_ERROR`.
 *
 * T1 disposition — `addProfileSkillSetConnection` has no generated
 * operation type. The committed snapshot at
 * `packages/e2e/src/wire-snapshots/addProfileSkillSetConnection.snapshot.json`
 * is the continuous drift defense.
 *
 * Errors:
 * - `ConsentRequiredError("CONSENT_REQUIRED")` when consent is absent.
 * - `SkillsError("VALIDATION_ERROR")` on empty `skillSetId` /
 *   `connectionId`, on a `connectionType` outside
 *   {@link SKILL_CONNECTION_TYPES}, on a `connectionId` whose Relay
 *   prefix is unrecognized, or on a prefix-vs-type mismatch.
 * - `SkillsError("USER_ERROR")` on a `success: false` / non-empty
 *   `errors[]` payload.
 * - `SkillsError("UNKNOWN")` on a null/missing payload.
 * - `AuthRevokedError`, `Cf403Error`, plus standard
 *   `GRAPHQL_ERROR` / `NETWORK_ERROR` / `UNKNOWN` codes.
 */
export async function addConnection(
  token: string,
  fields: AddSkillConnectionFields,
  consent: AddSkillConnectionConsent,
  options: AddSkillConnectionOptions = {},
): Promise<AddSkillConnectionOutcome> {
  // Runtime gate covers `as`-cast bypasses and JSON-sourced inputs
  // (CLI/MCP/agents) — the static `true` literal would otherwise make
  // this look like dead code.
  ensureDestructiveConsent(
    "addProfileSkillSetConnection",
    "profile-capability",
    consent as unknown as { readonly [key: string]: unknown },
  );

  if (fields.skillSetId.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Skill set id is required.");
  }
  if (fields.connectionId.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Connection id is required.");
  }
  if (!SKILL_CONNECTION_TYPES.includes(fields.connectionType)) {
    throw new SkillsError(
      "VALIDATION_ERROR",
      `Invalid connectionType "${fields.connectionType}". Must be one of: ${SKILL_CONNECTION_TYPES.join(", ")}.`,
    );
  }
  const inferredType = inferConnectionTypeFromId(fields.connectionId);
  if (inferredType === null) {
    throw new SkillsError(
      "VALIDATION_ERROR",
      `connectionId "${fields.connectionId}" does not match the expected Relay format (V1-Employment-<n> / V1-Education-<n> / V1-Certification-<n> / V1-PortfolioItem-<n>).`,
    );
  }
  if (inferredType !== fields.connectionType) {
    throw new SkillsError(
      "VALIDATION_ERROR",
      `connectionId "${fields.connectionId}" is a ${inferredType} but connectionType declared ${fields.connectionType}.`,
    );
  }

  const variables = {
    input: {
      skillSetId: fields.skillSetId,
      connectionId: fields.connectionId,
    },
  };

  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "talent-profile",
        authToken: token,
        body: {
          operationName: "addProfileSkillSetConnection",
          query: ADD_PROFILE_SKILL_SET_CONNECTION_MUTATION,
          variables,
        },
      }),
    };
  }

  const data = await callTalentProfile<AddSkillSetConnectionData>(
    token,
    "addProfileSkillSetConnection",
    ADD_PROFILE_SKILL_SET_CONNECTION_MUTATION,
    variables,
  );
  const payload = data.addProfileSkillSetConnection;
  if (!payload) {
    throw new SkillsError(
      "UNKNOWN",
      "addProfileSkillSetConnection response had no `data.addProfileSkillSetConnection` field",
    );
  }
  raiseUserErrors("Skill add-connection", payload.errors);
  if (payload.success === false) {
    throw new SkillsError(
      "USER_ERROR",
      `Skill add-connection reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
  if (!payload.skillSet) {
    throw new SkillsError("UNKNOWN", "addProfileSkillSetConnection succeeded but response had no `skillSet` payload");
  }
  const connections = payload.skillSet.connections;
  if (!connections) {
    throw new SkillsError(
      "UNKNOWN",
      "addProfileSkillSetConnection succeeded but response had no `skillSet.connections` payload",
    );
  }
  const connectionIds = (connections.nodes ?? []).filter((n): n is { id: string } => n !== null).map((n) => n.id);
  return {
    kind: "applied",
    result: {
      skillSetId: payload.skillSet.id,
      connectionsCount: connections.totalCount,
      connectionIds,
      notice: payload.notice ?? null,
    },
  };
}

// -----------------------------------------------------------------------
// remove-connection — removeProfileSkillSetConnection (#463)
// -----------------------------------------------------------------------

export interface RemoveSkillConnectionConsent {
  // write-only: ADR-009 (ttctl) per-domain consent literal — never echoed by the wire.
  profileCapabilityConsentIssued: true;
}

export interface RemoveSkillConnectionFields {
  skillSetId: string;
  connectionId: string;
}

export interface RemoveSkillConnectionOptions {
  dryRun?: boolean;
}

export interface RemoveSkillConnectionResult {
  skillSetId: string;
  connectionsCount: number;
  connectionIds: string[];
  notice: string | null;
}

export interface RemoveSkillConnectionAppliedOutcome {
  kind: "applied";
  result: RemoveSkillConnectionResult;
}

export interface RemoveSkillConnectionPreviewOutcome {
  kind: "preview";
  preview: DryRunPreview;
}

export type RemoveSkillConnectionOutcome = RemoveSkillConnectionAppliedOutcome | RemoveSkillConnectionPreviewOutcome;

// In TALENT_PROFILE_KNOWN_UNTRUSTED_OPS → T1 (snapshot) disposition.
const REMOVE_PROFILE_SKILL_SET_CONNECTION_MUTATION = `mutation removeProfileSkillSetConnection($input: RemoveProfileSkillSetConnectionInput!) {
  removeProfileSkillSetConnection(input: $input) {
    skillSet {
      id
      connections {
        totalCount
        nodes {
          ... on Node { id }
        }
      }
    }
    success
    notice
    errors { code key message }
  }
}`;

interface RemoveSkillSetConnectionData {
  removeProfileSkillSetConnection?: {
    skillSet?: {
      id: string;
      connections?: {
        totalCount: number;
        nodes?: ({ id: string } | null)[] | null;
      } | null;
    } | null;
    success?: boolean | null;
    notice?: string | null;
    errors?: UserErrorEntry[] | null;
  } | null;
}

/**
 * Per-edge unlink — sibling of {@link addConnection}. Wire input is
 * `{ skillSetId, connectionId }`; the server discriminates the target
 * from the Relay id.
 */
export async function removeConnection(
  token: string,
  fields: RemoveSkillConnectionFields,
  consent: RemoveSkillConnectionConsent,
  options: RemoveSkillConnectionOptions = {},
): Promise<RemoveSkillConnectionOutcome> {
  // Runtime consent gate covers `as`-cast bypasses past the literal type.
  ensureDestructiveConsent(
    "removeProfileSkillSetConnection",
    "profile-capability",
    consent as unknown as { readonly [key: string]: unknown },
  );

  if (fields.skillSetId.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Skill set id is required.");
  }
  if (fields.connectionId.trim().length === 0) {
    throw new SkillsError("VALIDATION_ERROR", "Connection id is required.");
  }

  const variables = {
    input: {
      skillSetId: fields.skillSetId,
      connectionId: fields.connectionId,
    },
  };

  if (options.dryRun === true) {
    return {
      kind: "preview",
      preview: buildDryRunPreview({
        surface: "talent-profile",
        authToken: token,
        body: {
          operationName: "removeProfileSkillSetConnection",
          query: REMOVE_PROFILE_SKILL_SET_CONNECTION_MUTATION,
          variables,
        },
      }),
    };
  }

  const data = await callTalentProfile<RemoveSkillSetConnectionData>(
    token,
    "removeProfileSkillSetConnection",
    REMOVE_PROFILE_SKILL_SET_CONNECTION_MUTATION,
    variables,
  );
  const payload = data.removeProfileSkillSetConnection;
  if (!payload) {
    throw new SkillsError(
      "UNKNOWN",
      "removeProfileSkillSetConnection response had no `data.removeProfileSkillSetConnection` field",
    );
  }
  raiseUserErrors("Skill remove-connection", payload.errors);
  if (payload.success === false) {
    throw new SkillsError(
      "USER_ERROR",
      `Skill remove-connection reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
  if (!payload.skillSet) {
    throw new SkillsError(
      "UNKNOWN",
      "removeProfileSkillSetConnection succeeded but response had no `skillSet` payload",
    );
  }
  const connections = payload.skillSet.connections;
  if (!connections) {
    throw new SkillsError(
      "UNKNOWN",
      "removeProfileSkillSetConnection succeeded but response had no `skillSet.connections` payload",
    );
  }
  const connectionIds = (connections.nodes ?? []).filter((n): n is { id: string } => n !== null).map((n) => n.id);
  return {
    kind: "applied",
    result: {
      skillSetId: payload.skillSet.id,
      connectionsCount: connections.totalCount,
      connectionIds,
      notice: payload.notice ?? null,
    },
  };
}
