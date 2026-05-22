// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `profile.reviews` service module.
 *
 * Section reviews are the section/item review-and-approval flow: when the
 * talent edits a sensitive section (basic info, skills, employments, etc.)
 * the change goes into a "pending review" state; the talent must explicitly
 * approve each pending item or section before it's published.
 *
 * Per issue #76 the v0 user-facing surface exposes 4 leaves:
 *
 *   1. {@link list}                — list pending section reviews
 *   2. {@link approveItem}         — approve a single pending item within a section
 *   3. {@link approveSection}      — approve all pending items in a section
 *   4. {@link submitForReview}     — re-submit the profile for platform-side re-review
 *
 * ## Spec / API divergences (documented per #76 AC)
 *
 * The issue (#76) suggests `approve-item <id>` and `approve-section <id>` as
 * single-positional CLI signatures. The actual GraphQL inputs require three
 * fields each (`reviewId`, `itemId`, `itemKind` for item; `reviewId`,
 * `section` for section — see
 * `research/notes/10-mutation-input-patterns.md`). The CLI uses named flags
 * (`--review-id`, `--item-id`, `--kind`, `--section`) to disambiguate.
 *
 * `submitForReview` is listed in
 * `research/notes/10-mutation-input-patterns.md` § "non-obvious shapes"
 * with no live capture. We follow Pattern 2 (`{ profileId: ID! }`) as the
 * most plausible inferred shape; deviations would surface at runtime as
 * `USER_ERROR`. Marked **INFERRED — UNVERIFIED** in the implementation.
 *
 * `ItemReviewKind` and `ReviewSection` enum values are not catalogued in
 * the schema (`research/graphql/talent_profile/schema.graphql` types most
 * scalars as `Unknown`). The CLI accepts these as plain strings and lets
 * the server validate; the server's user-error response is rendered
 * verbatim so the user sees the rejected value alongside the expected
 * vocabulary.
 *
 * ## Wire-shape decisions
 *
 * All operations target the talent_profile surface and use
 * {@link impersonatedTransport}. Same full-document strategy as the
 * external sub-domain — see `services/profile/external/index.ts` § "Wire-
 * shape decisions" for rationale.
 */

import { AuthRevokedError, TtctlError } from "../../../auth/errors.js";
import { ensureDestructiveConsent } from "../../../consent.js";
import { impersonatedTransport } from "../../../transport.js";
import type { TransportResponse } from "../../../transport.js";
import { ProfileError } from "../basic/index.js";
import type { ProfileErrorCode } from "../basic/index.js";
import { extractProfileId, isAuthRevokedExtensionCode } from "../shared.js";

// Re-export the shared `ProfileError` / `ProfileErrorCode` so consumers can
// continue to write `profile.reviews.ProfileError`.
export { ProfileError };
export type { ProfileErrorCode };

interface GraphQLErrorEntry {
  message?: string | null;
  // GraphQL spec § 7.1.7 — `path` is present on field-level errors (carrying the response
  // key sequence to the field that errored) and absent on errors raised before field
  // resolution (e.g. session-revoked top-level errors). Used by
  // {@link isFieldHiddenSectionReviews} as the primary discriminator between the two
  // overloaded meanings of `extensions.code = "UNAUTHORIZED"` on talent_profile.
  path?: readonly (string | number)[] | null;
  extensions?: { code?: string | null } | null;
}

interface UserErrorEntry {
  code?: string | null;
  key?: string | null;
  message?: string | null;
}

interface TalentProfileResponse<TData> {
  data?: TData | null;
  errors?: GraphQLErrorEntry[] | null;
}

function parseTalentProfileResponse(
  res: TransportResponse,
  commandLabel: string,
  fallbackErrorCode: ProfileErrorCode = "UNKNOWN",
): unknown {
  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProfileError(fallbackErrorCode, `${commandLabel} returned HTTP ${res.status.toString()}`);
  }
  const body = res.body as TalentProfileResponse<unknown> | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    const message = first?.message ?? "GraphQL error";
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ProfileError("GRAPHQL_ERROR", `${commandLabel} failed: ${message}`);
  }
  if (!body?.data) {
    throw new ProfileError(fallbackErrorCode, `${commandLabel} response had no \`data\` field`);
  }
  return body.data;
}

async function withNetworkErrorMapping<T>(commandLabel: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    if (err instanceof ProfileError) throw err;
    throw new ProfileError("NETWORK_ERROR", `${commandLabel} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

// -----------------------------------------------------------------------------
// list
// -----------------------------------------------------------------------------

/**
 * One pending item inside a {@link SectionReview}.
 *
 * `id` is the SectionReviewItem's own ID; `itemId` is the underlying entity's
 * ID (e.g. the Education / Employment / SkillSet that's pending review).
 * Both are surfaced because callers (CLI / MCP) typically want both — `id` to
 * pass to `approveItem`, `itemId` to cross-reference the entity in question.
 */
export interface SectionReviewItem {
  id: string;
  itemId: string;
  requestedAt: string | null;
}

/**
 * One section-level review entry. `section` is a `ReviewSection` enum value
 * (e.g. `EDUCATION`, `SKILLS`); we surface it as a plain string because the
 * enum vocabulary is not catalogued in the schema.
 */
export interface SectionReview {
  id: string;
  section: string | null;
  requestedAt: string | null;
  items: SectionReviewItem[];
}

const SECTION_REVIEWS_QUERY = `query sectionReviews($profileId: ID!) {
  sectionReviews(id: $profileId) {
    id
    section
    requestedAt
    items {
      id
      itemId
      requestedAt
    }
  }
}`;

interface SectionReviewsData {
  sectionReviews?:
    | ({
        id?: unknown;
        section?: unknown;
        requestedAt?: unknown;
        items?: ({ id?: unknown; itemId?: unknown; requestedAt?: unknown } | null)[] | null;
      } | null)[]
    | null;
}

function coerceString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Detect the talent_profile graphql-pro "field hidden due to permissions"
 * response on the `sectionReviews` field. The server emits this when the
 * signed-in user has no pending section reviews visible — the field is
 * permission-gated rather than returning an empty array. The shape is:
 *
 *   { data: null, errors: [{
 *       message: "An object of type SectionReview was hidden due to permissions",
 *       path: ["sectionReviews", 0],
 *       extensions: { code: "UNAUTHORIZED" },
 *     }] }
 *
 * `extensions.code` ALONE is ambiguous (same code is used for session-revoked
 * bearer). Two discriminators are checked, both must hold:
 *
 *   1. **Primary** — `path[0] === "sectionReviews"`. GraphQL spec § 7.1.7 mandates
 *      `path` on field-level errors and prohibits it on errors raised before
 *      field resolution (session-revoked top-level errors fire BEFORE field
 *      resolution and therefore have no `path`). This is the structural
 *      discriminator and survives English-wording drift of the message.
 *   2. **Confirmation** — message contains `"hidden due to permissions"`. Defense
 *      against the (unlikely) case where a path-bearing top-level error is
 *      emitted for some unrelated reason.
 */
function isFieldHiddenSectionReviews(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const envelope = body as { data?: unknown; errors?: GraphQLErrorEntry[] | null };
  if (envelope.data !== null && envelope.data !== undefined) return false;
  if (!Array.isArray(envelope.errors) || envelope.errors.length === 0) return false;
  const first = envelope.errors[0];
  if (first?.extensions?.code !== "UNAUTHORIZED") return false;
  if (!Array.isArray(first.path) || first.path[0] !== "sectionReviews") return false;
  return typeof first.message === "string" && first.message.includes("hidden due to permissions");
}

/**
 * List pending section reviews for the signed-in user. Returns an empty
 * array (not a `null` or thrown error) when no reviews are pending. This
 * includes the talent_profile "field hidden due to permissions" response
 * (see {@link isFieldHiddenSectionReviews}) — empirically the
 * no-pending-reviews surface form for accounts that have no review activity.
 *
 * Errors: `AuthRevokedError`, `ProfileError(GRAPHQL_ERROR)`,
 * `ProfileError(NETWORK_ERROR)`, `Cf403Error` (and other `TtctlError`
 * subclasses) propagate verbatim.
 */
export async function list(token: string): Promise<SectionReview[]> {
  const profileId = await extractProfileId(token);

  const res = await withNetworkErrorMapping("Section reviews list", () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "sectionReviews",
        query: SECTION_REVIEWS_QUERY,
        variables: { profileId },
      },
    }),
  );

  // talent_profile's graphql-pro layer overloads `extensions.code = "UNAUTHORIZED"`
  // for two distinct conditions: (1) session-revoked bearer (handled globally by
  // `isAuthRevokedExtensionCode` → AuthRevokedError); (2) field-level permission
  // denial, surfaced with `data: null` + `message: "An object of type
  // SectionReview was hidden due to permissions"`. For `sectionReviews` the
  // field-hidden case empirically corresponds to "no pending reviews are visible
  // to this user" (live capture 2026-05-16 against an account with no pending
  // section reviews). Short-circuit to `[]` BEFORE the generic auth-revoked
  // mapping fires, otherwise the user sees a misleading "Run `ttctl auth
  // signin`" hint when the session is in fact valid for every other
  // talent_profile op.
  if (res.status === 200 && isFieldHiddenSectionReviews(res.body)) {
    return [];
  }

  const data = parseTalentProfileResponse(res, "Section reviews list") as SectionReviewsData;
  const rows = data.sectionReviews ?? [];
  return rows
    .filter((r): r is NonNullable<typeof r> => r !== null && typeof r === "object")
    .map((row) => {
      const items = (row.items ?? [])
        .filter((it): it is NonNullable<typeof it> => it !== null && typeof it === "object")
        .map((it) => ({
          id: typeof it.id === "string" ? it.id : "",
          itemId: typeof it.itemId === "string" ? it.itemId : "",
          requestedAt: coerceString(it.requestedAt),
        }))
        .filter((it) => it.id.length > 0);
      return {
        id: typeof row.id === "string" ? row.id : "",
        section: coerceString(row.section),
        requestedAt: coerceString(row.requestedAt),
        items,
      };
    })
    .filter((row) => row.id.length > 0);
}

// -----------------------------------------------------------------------------
// approveItem
// -----------------------------------------------------------------------------

/**
 * Input parameters for {@link approveItem}. All three fields are required.
 *
 *   - `reviewId`: the ID of the parent SectionReview (from `list`)
 *   - `itemId`:   the ID of the SectionReviewItem (from `list`'s `items[].id`)
 *   - `itemKind`: an `ItemReviewKind` enum value as a plain string
 *
 * The schema does not enumerate `ItemReviewKind` values; the inferred set
 * per `research/notes/10-mutation-input-patterns.md` includes `EDUCATION`,
 * `EMPLOYMENT`, etc. Pass it as the server expects it; an invalid value
 * surfaces as a `USER_ERROR` (the message will name the rejected value).
 */
export interface ApproveItemReviewArgs {
  reviewId: string;
  itemId: string;
  itemKind: string;
}

/**
 * Server-confirmed result of {@link approveItem}. The mutation returns the
 * updated `sectionReviews` payload (now without the approved item, if the
 * server was the only pending item; the section may still be returned with
 * other pending items). We surface the post-approval list verbatim so the
 * caller can re-render the pending queue.
 */
export interface ApproveItemReviewResult {
  sectionReviews: SectionReview[];
  notice: string | null;
}

const APPROVE_ITEM_REVIEW_MUTATION = `mutation ApproveItemReview($input: ApproveItemReviewInput!) {
  approveItemReview(input: $input) {
    sectionReviews {
      id
      section
      requestedAt
      items {
        id
        itemId
        requestedAt
      }
    }
    errors {
      code
      key
      message
    }
    notice
    success
  }
}`;

interface ApproveItemReviewInput {
  reviewId: string;
  itemId: string;
  itemKind: string;
}

interface ApproveItemReviewPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserErrorEntry[] | null;
  sectionReviews?: SectionReviewsData["sectionReviews"];
}

function rowsToSectionReviews(rows: SectionReviewsData["sectionReviews"]): SectionReview[] {
  return (rows ?? [])
    .filter((r): r is NonNullable<typeof r> => r !== null && typeof r === "object")
    .map((row) => ({
      id: typeof row.id === "string" ? row.id : "",
      section: coerceString(row.section),
      requestedAt: coerceString(row.requestedAt),
      items: (row.items ?? [])
        .filter((it): it is NonNullable<typeof it> => it !== null && typeof it === "object")
        .map((it) => ({
          id: typeof it.id === "string" ? it.id : "",
          itemId: typeof it.itemId === "string" ? it.itemId : "",
          requestedAt: coerceString(it.requestedAt),
        }))
        .filter((it) => it.id.length > 0),
    }))
    .filter((row) => row.id.length > 0);
}

/**
 * Approve a single pending item within a section review. Returns the
 * server-confirmed updated list of pending section reviews.
 *
 * **Destructive**: approval is final per the platform's review semantics —
 * once approved, the change is published and cannot be reverted from this
 * surface. Callers are expected to confirm intent (the CLI does so by
 * requiring explicit `--review-id` / `--item-id` / `--kind` flags rather
 * than auto-discovering pending items).
 *
 * Errors:
 *   - `ProfileError("VALIDATION_ERROR")` when any of `reviewId / itemId /
 *     itemKind` is empty
 *   - `ProfileError("USER_ERROR")` when the server rejects the input (e.g.
 *     unknown item kind, item already approved)
 *   - `AuthRevokedError`, `Cf403Error`, other `TtctlError` subclasses
 *     propagate verbatim
 */
export async function approveItem(token: string, args: ApproveItemReviewArgs): Promise<ApproveItemReviewResult> {
  if (args.reviewId.length === 0 || args.itemId.length === 0 || args.itemKind.length === 0) {
    throw new ProfileError(
      "VALIDATION_ERROR",
      "Approve-item review requires non-empty reviewId, itemId, and itemKind.",
    );
  }

  // Destructive — approval is final per platform review semantics; once
  // approved, the change is published and cannot be reverted from this
  // surface. No safe round-trip on a live maintainer profile. Wire shape
  // inferred from research/notes/10. The read-side sectionReviews query
  // is covered in packages/e2e/src/40-profile-reviews.e2e.test.ts.
  const res = await withNetworkErrorMapping("Approve item review", () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        // e2e-exempt: destructive — see comment above the withNetworkErrorMapping call.
        operationName: "ApproveItemReview",
        query: APPROVE_ITEM_REVIEW_MUTATION,
        variables: {
          input: {
            reviewId: args.reviewId,
            itemId: args.itemId,
            itemKind: args.itemKind,
          } satisfies ApproveItemReviewInput,
        },
      },
    }),
  );

  const data = parseTalentProfileResponse(res, "Approve item review") as {
    approveItemReview?: ApproveItemReviewPayload | null;
  };
  const payload = data.approveItemReview;
  if (!payload) {
    throw new ProfileError("UNKNOWN", "Approve item review response had no payload");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const fieldHint = first?.key ? ` (${first.key})` : "";
    throw new ProfileError(
      "USER_ERROR",
      `Approve item review rejected${fieldHint}: ${first?.message ?? "unknown error"}`,
    );
  }
  if (payload.success === false) {
    throw new ProfileError(
      "USER_ERROR",
      `Approve item review reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }

  return {
    sectionReviews: rowsToSectionReviews(payload.sectionReviews),
    notice: payload.notice ?? null,
  };
}

// -----------------------------------------------------------------------------
// approveSection
// -----------------------------------------------------------------------------

/**
 * Input parameters for {@link approveSection}. Both fields are required.
 *
 *   - `reviewId`: the ID of the SectionReview (from `list`)
 *   - `section`: a `ReviewSection` enum value as a plain string
 *
 * Same string-pass-through rationale as {@link ApproveItemReviewArgs#itemKind}.
 */
export interface ApproveSectionReviewArgs {
  reviewId: string;
  section: string;
}

/** Result of {@link approveSection}. Same shape as {@link ApproveItemReviewResult}. */
export type ApproveSectionReviewResult = ApproveItemReviewResult;

const APPROVE_SECTION_REVIEW_MUTATION = `mutation ApproveSectionReview($input: ApproveSectionReviewInput!) {
  approveSectionReview(input: $input) {
    sectionReviews {
      id
      section
      requestedAt
      items {
        id
        itemId
        requestedAt
      }
    }
    errors {
      code
      key
      message
    }
    notice
    success
  }
}`;

interface ApproveSectionReviewInput {
  reviewId: string;
  section: string;
}

interface ApproveSectionReviewPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: UserErrorEntry[] | null;
  sectionReviews?: SectionReviewsData["sectionReviews"];
}

/**
 * Approve all pending items within a section review. Returns the
 * server-confirmed updated list of pending section reviews.
 *
 * **Destructive**: same caveat as {@link approveItem} — approvals are final.
 *
 * Errors: same taxonomy as {@link approveItem}.
 */
export async function approveSection(
  token: string,
  args: ApproveSectionReviewArgs,
): Promise<ApproveSectionReviewResult> {
  if (args.reviewId.length === 0 || args.section.length === 0) {
    throw new ProfileError("VALIDATION_ERROR", "Approve-section review requires non-empty reviewId and section.");
  }

  // Destructive — section-level approval is final per platform review
  // semantics; the entire section's pending items are published in one
  // call. No safe round-trip on a live maintainer profile. Wire shape
  // inferred from research/notes/10. The read-side sectionReviews query
  // is covered in packages/e2e/src/40-profile-reviews.e2e.test.ts.
  const res = await withNetworkErrorMapping("Approve section review", () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        // e2e-exempt: destructive — see comment above the withNetworkErrorMapping call.
        operationName: "ApproveSectionReview",
        query: APPROVE_SECTION_REVIEW_MUTATION,
        variables: {
          input: {
            reviewId: args.reviewId,
            section: args.section,
          } satisfies ApproveSectionReviewInput,
        },
      },
    }),
  );

  const data = parseTalentProfileResponse(res, "Approve section review") as {
    approveSectionReview?: ApproveSectionReviewPayload | null;
  };
  const payload = data.approveSectionReview;
  if (!payload) {
    throw new ProfileError("UNKNOWN", "Approve section review response had no payload");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const fieldHint = first?.key ? ` (${first.key})` : "";
    throw new ProfileError(
      "USER_ERROR",
      `Approve section review rejected${fieldHint}: ${first?.message ?? "unknown error"}`,
    );
  }
  if (payload.success === false) {
    throw new ProfileError(
      "USER_ERROR",
      `Approve section review reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }

  return {
    sectionReviews: rowsToSectionReviews(payload.sectionReviews),
    notice: payload.notice ?? null,
  };
}

// -----------------------------------------------------------------------------
// submitForReview
// -----------------------------------------------------------------------------

/**
 * Server-confirmed result of {@link submitForReview}. We surface only
 * `notice` (textual confirmation) at v0; the upstream `activation` payload
 * is implementation-detail (a per-step list of activation gates) that the
 * user doesn't need at the CLI level.
 */
export interface SubmitForReviewResult {
  notice: string | null;
}

const SUBMIT_FOR_REVIEW_MUTATION = `mutation submitForReview($input: SubmitForReviewInput!) {
  submitForReview(input: $input) {
    errors {
      code
      key
      message
    }
    notice
    success
  }
}`;

interface SubmitForReviewInput {
  profileId: string;
}

interface SubmitForReviewUserError {
  code?: string | null;
  key?: string | null;
  message?: string | null;
}

interface SubmitForReviewPayload {
  success?: boolean | null;
  notice?: string | null;
  errors?: SubmitForReviewUserError[] | null;
}

/**
 * Per-domain consent ceremony for {@link submitForReview}. Per
 * ADR-009 (ttctl) § Decision Part 1, this mutation is in the
 * `profile-capability` domain (it commits the talent's profile to the
 * platform review queue — a recruiter-visible capability change).
 *
 * The field is statically typed to `true` (literal) — TypeScript
 * compile-time gate. The runtime gate at
 * {@link ensureDestructiveConsent} covers `as`-cast bypasses and
 * JSON-sourced inputs (CLI / MCP / agents passing untyped objects).
 */
export interface SubmitForReviewConsent {
  /**
   * MUST be `true` — acknowledges that this enters the maintainer's
   * profile into the Toptal review queue (no safe round-trip). See
   * ADR-009 (ttctl) § Decision Part 1 for the per-domain consent
   * vocabulary.
   */
  profileCapabilityConsentIssued: true;
}

/**
 * Re-submit the talent's profile for platform-side re-review. Used after
 * profile edits that require the platform reviewer to re-verify the
 * content (skills, employments, etc.).
 *
 * **INFERRED — UNVERIFIED** input shape: `{ profileId: ID! }` per
 * `research/notes/10-mutation-input-patterns.md` Pattern 2. No live curl
 * capture exists for this mutation. Deviations would surface as
 * `USER_ERROR` at runtime.
 *
 * **Consent gate** (ADR-009 (ttctl) § Decision Part 1 — `profile-capability`
 * domain): refuses the call with `ConsentRequiredError("CONSENT_REQUIRED")`
 * BEFORE any wire call when `consent.profileCapabilityConsentIssued !== true`.
 * The compile-time literal narrows the static type; the runtime check
 * covers `as`-cast bypasses and JSON-sourced inputs from CLI / MCP /
 * agents. The `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` env-var bypasses the
 * literal check for non-interactive CI / test contexts.
 *
 * Errors:
 *   - `ConsentRequiredError("CONSENT_REQUIRED")` when consent is not
 *     supplied (and the env-var bypass is not set)
 *   - `ProfileError("USER_ERROR")` when the server rejects the submission
 *     (e.g. profile not yet ready per `getProfileReadiness`)
 *   - `AuthRevokedError`, `Cf403Error`, other `TtctlError` subclasses
 *     propagate verbatim
 */
export async function submitForReview(token: string, consent: SubmitForReviewConsent): Promise<SubmitForReviewResult> {
  // Runtime consent gate — covers `as`-cast bypasses and JSON-sourced
  // inputs from CLI / MCP / agents. The static type
  // `profileCapabilityConsentIssued: true` narrows to compile-time-true,
  // which would otherwise make this check look like dead code; the
  // widening cast (`as unknown as { readonly [key: string]: unknown }`)
  // is load-bearing. See ADR-009 (ttctl) and packages/core/src/consent.ts.
  ensureDestructiveConsent(
    "submitForReview",
    "profile-capability",
    consent as unknown as { readonly [key: string]: unknown },
  );

  const profileId = await extractProfileId(token);

  // Triggers an actual platform-side re-review against the maintainer's
  // profile when called on a submittable state. No safe reverse-trip.
  // Wire shape inferred from research/notes/10 Pattern 2
  // (`{ profileId: ID! }`). The read-side sectionReviews query is covered
  // in packages/e2e/src/40-profile-reviews.e2e.test.ts.
  const res = await withNetworkErrorMapping("Submit for review", () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        // e2e-exempt: destructive — see comment above the withNetworkErrorMapping call.
        operationName: "submitForReview",
        query: SUBMIT_FOR_REVIEW_MUTATION,
        variables: { input: { profileId } satisfies SubmitForReviewInput },
      },
    }),
  );

  const data = parseTalentProfileResponse(res, "Submit for review") as {
    submitForReview?: SubmitForReviewPayload | null;
  };
  const payload = data.submitForReview;
  if (!payload) {
    throw new ProfileError("UNKNOWN", "Submit-for-review response had no payload");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const keyHint = first?.key ? ` (${first.key})` : "";
    throw new ProfileError("USER_ERROR", `Submit for review rejected${keyHint}: ${first?.message ?? "unknown error"}`);
  }
  if (payload.success === false) {
    throw new ProfileError(
      "USER_ERROR",
      `Submit for review reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }

  return { notice: payload.notice ?? null };
}
