// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { AuthRevokedError, TtctlError } from "../../../auth/errors.js";
import { impersonatedMultipartTransport, impersonatedTransport, stockTransport } from "../../../transport.js";
import type { MultipartFile, TransportResponse } from "../../../transport.js";
import { show as showBasic } from "../basic/index.js";
import { isAuthRevokedExtensionCode } from "../shared.js";

/**
 * Portfolio sub-domain error codes. All file-shape and field-shape
 * validation failures collapse into `VALIDATION_ERROR`; the cross-cutting
 * `AuthRevokedError` / `Cf403Error` (from `TtctlError` hierarchy) propagate
 * unchanged so the CLI / MCP surfaces apply their uniform `Recovery: ...`
 * presentation per #77.
 */
export type PortfolioErrorCode =
  | "NO_VIEWER"
  | "GRAPHQL_ERROR"
  | "NETWORK_ERROR"
  | "USER_ERROR"
  | "VALIDATION_ERROR"
  | "FILE_NOT_FOUND"
  | "FILE_READ_ERROR"
  | "UNKNOWN";

export class PortfolioError extends Error {
  override readonly name = "PortfolioError";
  constructor(
    public readonly code: PortfolioErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

interface GraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

interface UserError {
  message?: string | null;
  field?: string | null;
}

/**
 * Skill reference shape carried by `createPortfolioItem` /
 * `updatePortfolioItem` inputs. Extracted from the Portfolio fragment
 * (`research/graphql/talent_profile/fragments/Portfolio.graphql`) which
 * names `skills.nodes[].id` and `.name` — the input variant takes
 * `{ id, name }` per the Pattern 1/2 inferred shapes in
 * `research/notes/10-mutation-input-patterns.md`.
 */
export interface SkillRef {
  id: string;
  name: string;
}

/**
 * Portfolio item write-side input shape.
 *
 * **[INFERRED — UNVERIFIED]** Mirrors the read-side `Portfolio` fragment
 * field-by-field per Pattern 1/2 in `research/notes/10-mutation-input-patterns.md`.
 * The `UPDATE_BASIC_INFO` precedent showed that wrapper-key inference can
 * be falsified by live capture (`profile` vs the predicted `basicInfo`).
 * If the API rejects the wrapper-key `portfolioItem`, capture the actual
 * shape via curl and amend.
 */
export interface PortfolioItemInput {
  title?: string;
  description?: string;
  link?: string;
  websiteUrl?: string;
  accomplishment?: string;
  publicationPermit?: boolean;
  clientOrCompanyName?: string;
  toptalRelated?: boolean;
  showViaToptal?: boolean;
  highlight?: boolean;
  skills?: SkillRef[];
  industryIds?: string[];
  /**
   * Cover-image cache name returned by a prior `uploadCover()` call. The
   * two-step "upload, then create with the cache name" flow is what the
   * talent-profile web client uses to bind a cover to a new portfolio
   * item — the read-side `Portfolio.coverImage` field surfaces a URL
   * once the server has resolved the cache name.
   */
  coverImage?: string;
}

/**
 * Read-side portfolio item shape — projection of the `Portfolio` fragment.
 * Service callers receive this on `list()` / mutation responses; the
 * mutation responses also surface the full mutated list on `profile.portfolioItems.nodes`.
 */
export interface PortfolioItem {
  id: string;
  title: string | null;
  description: string | null;
  link: string | null;
  highlight: boolean;
  coverImage: string | null;
  accomplishment: string | null;
  publicationPermit: boolean | null;
  clientOrCompanyName: string | null;
  websiteUrl: string | null;
  toptalRelated: boolean | null;
  showViaToptal: boolean | null;
}

interface TalentProfileResponse<T> {
  data?: { [key: string]: T | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Map a portfolio fragment node from the wire shape to the typed
 * {@link PortfolioItem}. The wire shape carries many more fields (skills,
 * industries, files, kpis, quotes, details unions) — those are out of
 * scope for the v0 read surface and dropped here. Callers that need the
 * extras can issue a richer query in a follow-up.
 */
function mapPortfolioNode(node: Record<string, unknown>): PortfolioItem {
  const id = node["id"];
  return {
    id: typeof id === "string" ? id : "",
    title: (node["title"] as string | null | undefined) ?? null,
    description: (node["description"] as string | null | undefined) ?? null,
    link: (node["link"] as string | null | undefined) ?? null,
    highlight: Boolean(node["highlight"]),
    coverImage: (node["coverImage"] as string | null | undefined) ?? null,
    accomplishment: (node["accomplishment"] as string | null | undefined) ?? null,
    publicationPermit: (node["publicationPermit"] as boolean | null | undefined) ?? null,
    clientOrCompanyName: (node["clientOrCompanyName"] as string | null | undefined) ?? null,
    websiteUrl: (node["websiteUrl"] as string | null | undefined) ?? null,
    toptalRelated: (node["toptalRelated"] as boolean | null | undefined) ?? null,
    showViaToptal: (node["showViaToptal"] as boolean | null | undefined) ?? null,
  };
}

/**
 * Resolve the signed-in user's `profileId` via the mobile-gateway
 * `ProfileShow` query. Centralized here so each write-side operation has
 * one path to the id without duplicating the read-call boilerplate.
 *
 * Errors propagate verbatim: a `set`-flow that can't read its own profile
 * is unrecoverable, and surfacing the read-side error gives the user the
 * same actionable message they'd get from `ttctl profile show`.
 */
async function resolveProfileId(token: string): Promise<string> {
  const profile = await showBasic(token);
  const profileId = profile.viewer?.viewerRole.profileId;
  if (profileId === undefined) {
    throw new PortfolioError("NO_VIEWER", "Cannot resolve profile id from session response.");
  }
  return profileId;
}

/**
 * Common "200 with errors" shape handler. Returns the unwrapped payload
 * (the value of the single root data field) as `unknown`; callers
 * narrow at the call site to their per-operation payload shape. The
 * helper centralizes the auth-revoked / GraphQL-error / null-data paths
 * so each operation's domain code stays focused on its own payload
 * shape.
 */
function unwrapResponse(res: TransportResponse, operationName: string): unknown {
  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new PortfolioError("UNKNOWN", `${operationName} returned HTTP ${res.status.toString()}`);
  }
  const body = res.body as TalentProfileResponse<unknown> | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new PortfolioError("GRAPHQL_ERROR", `${operationName} failed: ${first?.message ?? "GraphQL error"}`);
  }
  if (!body?.data) {
    throw new PortfolioError("UNKNOWN", `${operationName} response had no \`data\` field`);
  }
  // The mutation/query operations in this module all use a single root
  // field whose name matches the operation (createPortfolioItem,
  // updatePortfolioItem, getPortfolioItems, profile, …). We extract the
  // single value from `data` here.
  const keys = Object.keys(body.data);
  if (keys.length === 0) {
    throw new PortfolioError("UNKNOWN", `${operationName} response had empty \`data\``);
  }
  const firstKey = keys[0] as string;
  const payload = body.data[firstKey];
  if (payload === null || payload === undefined) {
    throw new PortfolioError("UNKNOWN", `${operationName} response had \`null\` payload`);
  }
  return payload;
}

/** Translate `userErrors[]` into a `USER_ERROR` `PortfolioError`. */
function rejectIfUserErrors(errors: UserError[] | null | undefined, operationName: string): void {
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    const fieldHint = first?.field ? ` (${first.field})` : "";
    throw new PortfolioError(
      "USER_ERROR",
      `${operationName} rejected${fieldHint}: ${first?.message ?? "unknown error"}`,
    );
  }
}

/**
 * Wrap a transport call, narrowing transport-level errors to
 * `PortfolioError("NETWORK_ERROR")` while letting `TtctlError` subclasses
 * (`Cf403Error`, `AuthRevokedError`) bubble up so the CLI/MCP surfaces can
 * apply uniform recovery presentation.
 */
async function withTransportErrors<T>(operationName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    if (err instanceof PortfolioError) throw err;
    throw new PortfolioError("NETWORK_ERROR", `${operationName} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                                Operations                                  */
/* -------------------------------------------------------------------------- */

/**
 * Full-document `getPortfolioItems` query. Sent against `talent-profile`
 * (Cloudflare-protected, requires impersonation). Mirrors
 * `research/graphql/talent_profile/operations/getPortfolioItems.graphql`,
 * trimmed to the v0 read surface (no skills/industries/files/details
 * fragments — those are separate sub-domains).
 */
const GET_PORTFOLIO_ITEMS_QUERY = `query getPortfolioItems($profileId: ID!) {
  profile(id: $profileId) {
    id
    portfolioItems {
      nodes {
        id
        title
        description
        link
        highlight
        coverImage
        accomplishment
        publicationPermit
        clientOrCompanyName
        websiteUrl
        toptalRelated
        showViaToptal
      }
    }
  }
}`;

/**
 * Fetch the signed-in user's portfolio items. Takes the user's auth token
 * and returns the typed array; the empty-list case returns `[]` (not
 * `null`).
 */
export async function list(token: string): Promise<PortfolioItem[]> {
  const profileId = await resolveProfileId(token);
  const res = await withTransportErrors("getPortfolioItems", async () =>
    stockTransport({
      surface: "mobile-gateway",
      authToken: token,
      body: {
        operationName: "getPortfolioItems",
        query: GET_PORTFOLIO_ITEMS_QUERY,
        variables: { profileId },
      },
    }),
  );
  const profile = unwrapResponse(res, "getPortfolioItems") as {
    id: string;
    portfolioItems: { nodes: Record<string, unknown>[] };
  };
  return profile.portfolioItems.nodes.map(mapPortfolioNode);
}

/**
 * Full-document `createPortfolioItem` mutation. Sent against
 * `talent-profile`. Returns the freshly-created list so the caller can
 * surface the new item's id without a second list round-trip.
 *
 * **[INFERRED]** Wrapper key `portfolioItem` per Pattern 2 — see
 * `research/notes/10-mutation-input-patterns.md`. Live-capture this
 * shape if the server rejects the wrapper.
 */
const CREATE_PORTFOLIO_ITEM_MUTATION = `mutation createPortfolioItem($input: CreatePortfolioItemInput!) {
  createPortfolioItem(input: $input) {
    profile {
      id
      portfolioItems {
        nodes {
          id
          title
          description
          link
          highlight
          coverImage
          accomplishment
          publicationPermit
          clientOrCompanyName
          websiteUrl
          toptalRelated
          showViaToptal
        }
      }
    }
    success
    notice
    errors {
      message
      field
    }
  }
}`;

interface CreatePortfolioItemInput {
  profileId: string;
  portfolioItem: PortfolioItemInput;
}

interface PortfolioMutationPayload {
  profile?: { id: string; portfolioItems: { nodes: Record<string, unknown>[] } } | null;
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
}

/**
 * Create a new portfolio item.
 *
 * Returns the full updated portfolio list — the server treats portfolio
 * items as a profile-scoped collection, and the mutation response always
 * carries the post-mutation snapshot. Callers that only want the new item
 * find it as the last entry (or by matching `title`).
 */
export async function add(token: string, input: PortfolioItemInput): Promise<PortfolioItem[]> {
  if (!input.title || input.title.trim() === "") {
    throw new PortfolioError("VALIDATION_ERROR", "Portfolio item requires a non-empty `title`.");
  }
  const profileId = await resolveProfileId(token);
  const variables: { input: CreatePortfolioItemInput } = {
    input: { profileId, portfolioItem: input },
  };
  const res = await withTransportErrors("createPortfolioItem", async () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "createPortfolioItem",
        query: CREATE_PORTFOLIO_ITEM_MUTATION,
        variables,
      },
    }),
  );
  const payload = unwrapResponse(res, "createPortfolioItem") as PortfolioMutationPayload;
  rejectIfUserErrors(payload.errors, "createPortfolioItem");
  if (payload.success === false) {
    throw new PortfolioError(
      "USER_ERROR",
      `createPortfolioItem reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
  if (!payload.profile) {
    throw new PortfolioError("UNKNOWN", "createPortfolioItem succeeded but response had no profile payload.");
  }
  return payload.profile.portfolioItems.nodes.map(mapPortfolioNode);
}

/**
 * Full-document `updatePortfolioItem` mutation.
 *
 * **[INFERRED]** Wrapper key `portfolioItem` per Pattern 1.
 */
const UPDATE_PORTFOLIO_ITEM_MUTATION = `mutation updatePortfolioItem($input: UpdatePortfolioItemInput!) {
  updatePortfolioItem(input: $input) {
    profile {
      id
      portfolioItems {
        nodes {
          id
          title
          description
          link
          highlight
          coverImage
          accomplishment
          publicationPermit
          clientOrCompanyName
          websiteUrl
          toptalRelated
          showViaToptal
        }
      }
    }
    success
    notice
    errors {
      message
      field
    }
  }
}`;

interface UpdatePortfolioItemInput {
  portfolioItemId: string;
  portfolioItem: PortfolioItemInput;
}

/**
 * Update a portfolio item by id. Only the fields supplied in `changes`
 * are sent to the server.
 */
export async function update(token: string, id: string, changes: PortfolioItemInput): Promise<PortfolioItem[]> {
  if (Object.keys(changes).length === 0) {
    throw new PortfolioError("VALIDATION_ERROR", "Portfolio update requires at least one field.");
  }
  const variables: { input: UpdatePortfolioItemInput } = {
    input: { portfolioItemId: id, portfolioItem: changes },
  };
  const res = await withTransportErrors("updatePortfolioItem", async () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "updatePortfolioItem",
        query: UPDATE_PORTFOLIO_ITEM_MUTATION,
        variables,
      },
    }),
  );
  const payload = unwrapResponse(res, "updatePortfolioItem") as PortfolioMutationPayload;
  rejectIfUserErrors(payload.errors, "updatePortfolioItem");
  if (payload.success === false) {
    throw new PortfolioError(
      "USER_ERROR",
      `updatePortfolioItem reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
  if (!payload.profile) {
    throw new PortfolioError("UNKNOWN", "updatePortfolioItem succeeded but response had no profile payload.");
  }
  return payload.profile.portfolioItems.nodes.map(mapPortfolioNode);
}

/** Full-document `removePortfolioItem` mutation. Pattern 3 (`Remove<Entity>Input`). */
const REMOVE_PORTFOLIO_ITEM_MUTATION = `mutation removePortfolioItem($input: RemovePortfolioItemInput!) {
  removePortfolioItem(input: $input) {
    profile {
      id
      portfolioItems {
        nodes {
          id
          title
          description
          link
          highlight
          coverImage
          accomplishment
          publicationPermit
          clientOrCompanyName
          websiteUrl
          toptalRelated
          showViaToptal
        }
      }
    }
    success
    notice
    errors {
      message
      field
    }
  }
}`;

/** Remove a portfolio item by id. Returns the post-removal list. */
export async function remove(token: string, id: string): Promise<PortfolioItem[]> {
  const variables = { input: { portfolioItemId: id } };
  const res = await withTransportErrors("removePortfolioItem", async () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "removePortfolioItem",
        query: REMOVE_PORTFOLIO_ITEM_MUTATION,
        variables,
      },
    }),
  );
  const payload = unwrapResponse(res, "removePortfolioItem") as PortfolioMutationPayload;
  rejectIfUserErrors(payload.errors, "removePortfolioItem");
  if (!payload.profile) {
    throw new PortfolioError("UNKNOWN", "removePortfolioItem succeeded but response had no profile payload.");
  }
  return payload.profile.portfolioItems.nodes.map(mapPortfolioNode);
}

/**
 * Full-document `changePortfolioItemPosition` mutation. Pattern 5
 * (`Change<Entity>PositionInput { <entity>Id, position }`).
 */
const CHANGE_PORTFOLIO_ITEM_POSITION_MUTATION = `mutation changePortfolioItemPosition($input: ChangePortfolioItemPositionInput!) {
  changePortfolioItemPosition(input: $input) {
    profile {
      id
      portfolioItems {
        nodes {
          id
          title
          description
          link
          highlight
          coverImage
          accomplishment
          publicationPermit
          clientOrCompanyName
          websiteUrl
          toptalRelated
          showViaToptal
        }
      }
    }
    success
    notice
    errors {
      message
      field
    }
  }
}`;

/**
 * Reorder portfolio items by setting `id` to the absolute `position`. The
 * CLI surface translates the more user-friendly `--before <id>` /
 * `--after <id>` flags to this absolute position; the helpers
 * {@link positionBefore} / {@link positionAfter} compute the position
 * given the current list.
 */
export async function reorder(token: string, id: string, position: number): Promise<PortfolioItem[]> {
  if (!Number.isInteger(position) || position < 0) {
    throw new PortfolioError("VALIDATION_ERROR", "Portfolio reorder position must be a non-negative integer.");
  }
  const variables = { input: { portfolioItemId: id, position } };
  const res = await withTransportErrors("changePortfolioItemPosition", async () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "changePortfolioItemPosition",
        query: CHANGE_PORTFOLIO_ITEM_POSITION_MUTATION,
        variables,
      },
    }),
  );
  const payload = unwrapResponse(res, "changePortfolioItemPosition") as PortfolioMutationPayload;
  rejectIfUserErrors(payload.errors, "changePortfolioItemPosition");
  if (!payload.profile) {
    throw new PortfolioError("UNKNOWN", "changePortfolioItemPosition succeeded but response had no profile payload.");
  }
  return payload.profile.portfolioItems.nodes.map(mapPortfolioNode);
}

/**
 * Compute the absolute position (0-based) the moved item should land at,
 * given a target item to be placed BEFORE. Returns `null` if `targetId`
 * is not in the list. The current list is required because the server's
 * `changePortfolioItemPosition` takes an absolute index, not a relative
 * one — the CLI computes the index from a friendlier neighbour-anchored
 * flag.
 */
export function positionBefore(items: PortfolioItem[], targetId: string): number | null {
  const idx = items.findIndex((it) => it.id === targetId);
  return idx === -1 ? null : idx;
}

/**
 * Compute the absolute position the moved item should land at, given a
 * target item to be placed AFTER. Returns `null` if `targetId` is not in
 * the list.
 */
export function positionAfter(items: PortfolioItem[], targetId: string): number | null {
  const idx = items.findIndex((it) => it.id === targetId);
  return idx === -1 ? null : idx + 1;
}

/**
 * Full-document `highlightPortfolioItem` mutation. Pattern 4
 * (`Highlight<Entity>Input { <entity>Id, highlight }`). The operation
 * source-of-truth is `research/graphql/talent_profile/operations/highlightPortfolioItem.graphql`.
 *
 * Currently TTCtl exposes a single `highlight <id>` toggle that flips the
 * highlight state on; un-highlighting via this surface lands as a
 * follow-up if the use case surfaces.
 */
const HIGHLIGHT_PORTFOLIO_ITEM_MUTATION = `mutation highlightPortfolioItem($id: ID!, $highlight: Boolean!) {
  highlightPortfolioItem(input: { portfolioItemId: $id, highlight: $highlight }) {
    portfolioItem {
      id
      highlight
    }
    success
    notice
    errors {
      message
      field
    }
  }
}`;

interface HighlightPortfolioItemPayload {
  portfolioItem?: { id: string; highlight: boolean } | null;
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
}

/**
 * Set or clear the "highlight" flag on a portfolio item. Returns the
 * minimal `{ id, highlight }` projection from the mutation payload —
 * fetching the full updated item is a separate `list()` round-trip when
 * needed.
 */
export async function highlight(
  token: string,
  id: string,
  flag: boolean = true,
): Promise<{ id: string; highlight: boolean }> {
  const res = await withTransportErrors("highlightPortfolioItem", async () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "highlightPortfolioItem",
        query: HIGHLIGHT_PORTFOLIO_ITEM_MUTATION,
        variables: { id, highlight: flag },
      },
    }),
  );
  const payload = unwrapResponse(res, "highlightPortfolioItem") as HighlightPortfolioItemPayload;
  rejectIfUserErrors(payload.errors, "highlightPortfolioItem");
  if (!payload.portfolioItem) {
    throw new PortfolioError("UNKNOWN", "highlightPortfolioItem succeeded but response had no portfolioItem payload.");
  }
  return { id: payload.portfolioItem.id, highlight: payload.portfolioItem.highlight };
}

/* -------------------------------------------------------------------------- */
/*                                File uploads                                */
/* -------------------------------------------------------------------------- */

/**
 * File-upload input — service callers pass either a filesystem path (the
 * helper opens it) or a pre-loaded {@link MultipartFile} buffer. The MCP
 * surface uses the buffer path for hosts that lack filesystem access (it
 * decodes base64 first); the CLI surface uses the path-based variant.
 */
export type FileSource =
  | { kind: "path"; path: string }
  | { kind: "buffer"; filename: string; content: Buffer | Uint8Array; contentType?: string };

/**
 * Resolve a {@link FileSource} into a {@link MultipartFile} ready for the
 * multipart body. Path-mode reads the file off disk; buffer-mode is a
 * pass-through.
 */
async function resolveFileSource(source: FileSource, fieldLabel: string): Promise<MultipartFile> {
  if (source.kind === "buffer") {
    return {
      filename: source.filename,
      content: source.content,
      ...(source.contentType !== undefined ? { contentType: source.contentType } : {}),
    };
  }
  let content: Buffer;
  try {
    content = await readFile(source.path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "ENOENT") {
      throw new PortfolioError("FILE_NOT_FOUND", `${fieldLabel}: file not found: ${source.path}`);
    }
    throw new PortfolioError("FILE_READ_ERROR", `${fieldLabel}: failed to read ${source.path}: ${message}`);
  }
  return { filename: basename(source.path), content };
}

/**
 * Full-document `uploadPortfolioCover` mutation. The `file` variable is a
 * GraphQL `Upload` slot — the multipart map binds it to the
 * `variables.file` path.
 *
 * `transformation` is required by the input schema even when no transform
 * is desired; we send an empty object to satisfy the contract.
 */
const UPLOAD_PORTFOLIO_COVER_MUTATION = `mutation uploadPortfolioCover(
  $profileId: ID!
  $transformation: PortfolioCoverImageTransformationInput!
  $file: Upload!
) {
  uploadPortfolioCoverImage(
    input: { profileId: $profileId, transformation: $transformation, file: $file }
  ) {
    coverImageCacheName
    coverImageUrl
    success
    notice
    errors {
      message
      field
    }
  }
}`;

interface UploadPortfolioCoverPayload {
  coverImageCacheName?: string | null;
  coverImageUrl?: string | null;
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
}

export interface UploadPortfolioCoverResult {
  coverImageCacheName: string | null;
  coverImageUrl: string | null;
}

/**
 * Upload a cover image for a portfolio item. The cover image is bound to
 * the user's profile rather than a specific portfolio item — the response
 * carries a `coverImageCacheName` the caller passes back into a
 * subsequent `update()` call (or `add()` for new items) via the
 * `coverImage` field.
 */
export async function uploadCover(token: string, source: FileSource): Promise<UploadPortfolioCoverResult> {
  const profileId = await resolveProfileId(token);
  const file = await resolveFileSource(source, "uploadCover");
  const res = await withTransportErrors("uploadPortfolioCover", async () =>
    impersonatedMultipartTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "uploadPortfolioCover",
        query: UPLOAD_PORTFOLIO_COVER_MUTATION,
        variables: {
          profileId,
          transformation: {},
          file: null,
        },
      },
      files: { "0": file },
      map: { "0": ["variables.file"] },
    }),
  );
  const payload = unwrapResponse(res, "uploadPortfolioCover") as UploadPortfolioCoverPayload;
  rejectIfUserErrors(payload.errors, "uploadPortfolioCover");
  if (payload.success === false) {
    throw new PortfolioError(
      "USER_ERROR",
      `uploadPortfolioCover reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
  return {
    coverImageCacheName: payload.coverImageCacheName ?? null,
    coverImageUrl: payload.coverImageUrl ?? null,
  };
}

/**
 * Full-document `uploadPortfolioFile` mutation. Variant of `uploadCover`
 * for arbitrary attachment files (not necessarily images). Same
 * multipart-map shape; the response carries a `fileCacheName` /
 * `fileUrl` pair.
 */
const UPLOAD_PORTFOLIO_FILE_MUTATION = `mutation uploadPortfolioFile($profileId: ID!, $file: Upload!) {
  uploadPortfolioFile(input: { profileId: $profileId, file: $file }) {
    fileCacheName
    fileUrl
    success
    notice
    errors {
      message
      field
    }
  }
}`;

interface UploadPortfolioFilePayload {
  fileCacheName?: string | null;
  fileUrl?: string | null;
  success?: boolean | null;
  notice?: string | null;
  errors?: UserError[] | null;
}

export interface UploadPortfolioFileResult {
  fileCacheName: string | null;
  fileUrl: string | null;
}

/**
 * Upload a file attachment associated with the user's portfolio. Returns
 * the cache name + url; the CLI surface prints both for downstream use.
 */
export async function uploadFile(token: string, source: FileSource): Promise<UploadPortfolioFileResult> {
  const profileId = await resolveProfileId(token);
  const file = await resolveFileSource(source, "uploadFile");
  const res = await withTransportErrors("uploadPortfolioFile", async () =>
    impersonatedMultipartTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "uploadPortfolioFile",
        query: UPLOAD_PORTFOLIO_FILE_MUTATION,
        variables: {
          profileId,
          file: null,
        },
      },
      files: { "0": file },
      map: { "0": ["variables.file"] },
    }),
  );
  const payload = unwrapResponse(res, "uploadPortfolioFile") as UploadPortfolioFilePayload;
  rejectIfUserErrors(payload.errors, "uploadPortfolioFile");
  if (payload.success === false) {
    throw new PortfolioError(
      "USER_ERROR",
      `uploadPortfolioFile reported success=false${payload.notice ? `: ${payload.notice}` : ""}`,
    );
  }
  return {
    fileCacheName: payload.fileCacheName ?? null,
    fileUrl: payload.fileUrl ?? null,
  };
}
