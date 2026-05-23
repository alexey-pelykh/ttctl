// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { AuthRevokedError, TtctlError } from "../../../auth/errors.js";
import { impersonatedMultipartTransport, impersonatedTransport } from "../../../transport.js";
import type { MultipartFile, TransportResponse } from "../../../transport.js";
import { extractProfileId, isAuthRevokedExtensionCode } from "../shared.js";
import { list as listSkills } from "../skills/index.js";

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
  | "WIRE_SHAPE_ERROR"
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
  code?: string | null;
  key?: string | null;
  message?: string | null;
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
 * Portfolio item kind enumeration. Empirically the server requires this
 * as a non-null field on `CreatePortfolioItemInput.portfolioItem`. The
 * WRITE-side enum uses **lowercase snake_case** values — the
 * SCREAMING_SNAKE forms returned by the read-side `PortfolioItemKindEnum`
 * in `research/graphql/gateway/schema.graphql` are REJECTED on create
 * with `"kind: is not included in the list"` (verified live 2026-05-16
 * during issue #314 investigation, see `.tmp/probe-portfolio-kind.mjs`).
 *
 * Use the {@link PORTFOLIO_ITEM_KIND} constant for autocomplete-friendly
 * references. The {@link PortfolioItemKind} type is derived so adding a
 * member here automatically extends the type.
 */
export const PORTFOLIO_ITEM_KIND = {
  ACCOMPLISHMENT: "accomplishment",
  BASIC: "basic",
  CLASSIC: "classic",
  CODE_BASE: "code_base",
  OTHER_AMAZING_THINGS: "other_amazing_things",
} as const;

export type PortfolioItemKind = (typeof PORTFOLIO_ITEM_KIND)[keyof typeof PORTFOLIO_ITEM_KIND];

/**
 * Portfolio item write-side input shape.
 *
 * **[INFERRED — partially verified live]** Mirrors the read-side `Portfolio`
 * fragment field-by-field per Pattern 1/2 in
 * `research/notes/10-mutation-input-patterns.md`. The `UPDATE_BASIC_INFO`
 * precedent showed that wrapper-key inference can be falsified by live
 * capture (`profile` vs the predicted `basicInfo`). The 2026-05-15 batch
 * (issue #314) live-discovered that `kind`, `showViaToptal`, and `skills`
 * are non-null required on create — {@link add} applies safe defaults so
 * existing callers do not need to thread these fields.
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
  kind?: PortfolioItemKind;
  skills?: SkillRef[];
  /**
   * Catalog Industry IDs (from `industriesAutocomplete`) that this
   * portfolio item belongs to. Required by the server on create — empty
   * array surfaces as `industries: You can't leave this empty` USER_ERROR
   * (verified live 2026-05-16, see `.tmp/probe-portfolio-industries.mjs`).
   *
   * **Per-item explicit choice**: industries are NOT defaulted from
   * `Profile.basicInfoIndustries`, `industriesAutocomplete`, skill
   * inference, or any other source. Each portfolio item's industry
   * association is the caller's deliberate decision; auto-defaulting
   * would silently mis-tag work and pollute the portfolio.
   */
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
 * `PortfolioItem.details` body block — the structured project narrative
 * the talent authored. The wire surface is a GraphQL union resolved via
 * `__typename` discrimination across four concrete variants (Image,
 * Text, Video, Gallery), each carrying a different content shape.
 *
 * **[INFERRED — schema-synth understated]** The synthesized SDL at
 * `research/graphql/talent_profile/schema.graphql:380` declares
 * `details: PortfolioItemImageBlock` as a singular concrete type, but
 * empirical operations on the talent-profile surface use inline
 * fragments to project four variants:
 *
 *   ```graphql
 *   details {
 *     __typename
 *     ... on PortfolioItemImageBlock   { id title image { thumbUrl optimizedUrl } }
 *     ... on PortfolioItemTextBlock    { id title contentHast }
 *     ... on PortfolioItemVideoBlock   { id title videoUrl }
 *     ... on PortfolioItemGalleryBlock { id title items { id image { thumbUrl optimizedUrl } contentType } }
 *   }
 *   ```
 *
 * (sources: `research/graphql/talent_profile/fragments/Portfolio.graphql`,
 * `PortfolioItem{Image,Text,Video,Gallery}Block.graphql`; live operation
 * `research/captures/web/operations/getProfileData.graphql:237-244`).
 * The SDL synthesis sees only the first concrete type from the
 * introspection root, hence the understated declaration.
 *
 * `kind` is the lowercase variant discriminator projected by
 * {@link projectDetails} from the wire `__typename`. Unknown
 * `__typename` values, null details, or shape mismatches collapse to
 * `null` — silently absent body content rather than a fabricated shape.
 * The `assertWireShapeStable` snapshot at
 * `packages/e2e/src/wire-snapshots/createPortfolioItem.snapshot.json`
 * catches `__typename` drift across releases.
 */
export type PortfolioItemDetails =
  | PortfolioImageBlock
  | PortfolioTextBlock
  | PortfolioVideoBlock
  | PortfolioGalleryBlock;

export interface PortfolioImageBlock {
  kind: "image";
  id: string;
  title: string | null;
  image: { thumbUrl: string | null; optimizedUrl: string | null } | null;
}

export interface PortfolioTextBlock {
  kind: "text";
  id: string;
  title: string | null;
  /**
   * Hypertext Abstract Syntax Tree (HAST) — opaque structured content
   * tree representing the formatted text body. Shape is the
   * `unist`/`hast` JSON spec (a `root` node with child nodes for
   * paragraphs, headings, emphasis, etc.). Surfaced as `unknown` because
   * the synth SDL declares the field as `Unknown` and the live shape
   * carries arbitrary depth — callers that need the rendered body should
   * traverse the tree or hand off to a `hast-util-to-text` consumer. Set
   * to `null` if the wire returned a non-object.
   */
  contentHast: unknown;
}

export interface PortfolioVideoBlock {
  kind: "video";
  id: string;
  title: string | null;
  videoUrl: string | null;
}

export interface PortfolioGalleryBlock {
  kind: "gallery";
  id: string;
  title: string | null;
  items: PortfolioGalleryItem[];
}

export interface PortfolioGalleryItem {
  id: string;
  contentType: string | null;
  image: { thumbUrl: string | null; optimizedUrl: string | null } | null;
}

/**
 * `PortfolioItem.files` attachment — a file uploaded for the portfolio
 * item (a PDF document or an image), the read-side counterpart to the
 * write-side `uploadPortfolioFile` mutation. The wire surface is a
 * GraphQL connection (`PortfolioItemFileConnection`) whose `nodes` are a
 * union resolved via `__typename` discrimination across two concrete
 * variants (Pdf, Image), each carrying a different content shape.
 *
 * **[INFERRED — schema-synth understated]** The synthesized SDL at
 * `research/graphql/talent_profile/schema.graphql:403` declares
 * `PortfolioItemFileConnection { nodes: PortfolioItemFilePdf }` — a
 * singular concrete node type — but the empirical talent-profile
 * fragments project the nodes as a union via inline fragments:
 *
 *   ```graphql
 *   files {
 *     nodes {
 *       __typename
 *       ... on PortfolioItemFilePdf   { id title description contentType fileUrl primaryContentType }
 *       ... on PortfolioItemFileImage { id title description contentType image { thumbUrl optimizedUrl } }
 *     }
 *   }
 *   ```
 *
 * (sources: `research/graphql/talent_profile/fragments/PortfolioItemFileConnection.graphql`,
 * `PortfolioItemFile{,Pdf,Image,ImageContent}.graphql`). The SDL
 * synthesis collapses the `nodes` union to whichever concrete type the
 * introspection root saw first, hence the understated declaration. The
 * shared `title` / `description` / `contentType` fields come from the
 * `PortfolioItemFile` interface both variants implement.
 *
 * `kind` is the lowercase variant discriminator projected by
 * {@link projectFiles} from the wire `__typename`. Nodes with an unknown
 * `__typename` (a new server variant), a missing `__typename`, or a
 * non-string `id` are dropped from the array — silently absent rather
 * than a fabricated shape. The `assertWireShapeStable` snapshot at
 * `packages/e2e/src/wire-snapshots/createPortfolioItem.snapshot.json`
 * catches `__typename` drift across releases.
 */
export type PortfolioItemFile = PortfolioFilePdf | PortfolioFileImage;

export interface PortfolioFilePdf {
  kind: "pdf";
  id: string;
  title: string | null;
  description: string | null;
  contentType: string | null;
  fileUrl: string | null;
  primaryContentType: string | null;
}

export interface PortfolioFileImage {
  kind: "image";
  id: string;
  title: string | null;
  description: string | null;
  contentType: string | null;
  image: { thumbUrl: string | null; optimizedUrl: string | null } | null;
}

/**
 * `PortfolioItem.kpis` entry — a quantified outcome the talent attached to
 * a portfolio project (e.g., `{ value: "40%", description: "page load
 * reduction" }`, `{ value: "1M", description: "monthly active users" }`).
 *
 * **[INFERRED — partial wire verification via empty-list probe, 2026-05-23]**
 * The synthesized SDL at
 * `research/graphql/talent_profile/schema.graphql:386` declares
 * `PortfolioItem.kpis: Unknown` (introspection didn't expose the structured
 * shape). The empirical `Portfolio.graphql` fragment + captured
 * `getProfileData.graphql:250-254` operation both project:
 *
 *   ```graphql
 *   kpis { id value description }
 *   ```
 *
 * (sources: `research/graphql/talent_profile/fragments/Portfolio.graphql:27-31`,
 * `research/captures/web/operations/getProfileData.graphql:250-254`,
 * `research/.tmp/web-bundles/main.49dbe1ed.js:396` — the live Toptal web
 * bundle pulls `kpis:p` straight off the response without `.nodes`,
 * confirming the direct-list shape).
 *
 * Live-probe evidence (`.tmp/probe-portfolio-kpis*.mjs`, 2026-05-23 against
 * the maintainer's profile):
 *
 *   - The shape `kpis { id value description }` is accepted on the wire
 *     (no GraphQL errors when projected via the talent-profile surface).
 *   - The element type is `PortfolioItemKpi` (revealed by the error
 *     "Field 'X' doesn't exist on type 'PortfolioItemKpi'" returned when
 *     probing extra fields).
 *   - The 3 fields {id, value, description} are the only fields on the
 *     element type (confirmed by elimination: `label`, `name`, `unit` all
 *     rejected as undefined).
 *   - The wire shape is a **direct list** (NOT a connection): probing
 *     `kpis { nodes }` errors with "Field 'nodes' doesn't exist on type
 *     'PortfolioItemKpi'".
 *   - Empty case returns `[]` (NOT `null`): all 32 items on the test
 *     account had `kpis: []`. The populated sub-field scalar types
 *     remain INFERRED — every probed item was empty, so concrete values
 *     for `value` / `description` were not observed. Field semantics
 *     (KPI value e.g. "40%", description e.g. "page load reduction")
 *     match String types in the Portfolio fragment.
 *
 * Defensive projection: nodes without a string `id` are dropped from the
 * array — silently absent rather than fabricated. The
 * `assertWireShapeStable` snapshot at
 * `packages/e2e/src/wire-snapshots/createPortfolioItem.snapshot.json`
 * catches shape drift across releases.
 */
export interface PortfolioItemKpi {
  id: string;
  value: string | null;
  description: string | null;
}

/**
 * Read-side portfolio item shape — projection of the `Portfolio` fragment.
 * Service callers receive this on `list()` / mutation responses; the
 * mutation responses also surface the full mutated list on `profile.portfolioItems.nodes`.
 *
 * The `kind`, `skills`, and `industries` fields are populated for callers
 * that need the full state (e.g. {@link update}'s read-modify-write
 * path); the server enforces these as non-null on `update` mutations.
 *
 * `details` (#548) carries the structured project-narrative body — see
 * {@link PortfolioItemDetails}. `null` when the item has no body block
 * attached (typical for freshly-created items); the four block variants
 * (`image` / `text` / `video` / `gallery`) carry distinct shapes the
 * caller discriminates via the `kind` field.
 *
 * `files` (#549) carries the item's attached files — see
 * {@link PortfolioItemFile}. Empty array `[]` when the item has no
 * attachments (typical for freshly-created items); the two variants
 * (`pdf` / `image`) carry distinct shapes the caller discriminates via
 * the `kind` field.
 *
 * `kpis` (#550) carries the talent-authored quantified outcomes for the
 * project — see {@link PortfolioItemKpi}. Empty array `[]` when the item
 * has no KPIs (typical for items without quantified metrics); each entry
 * carries `{id, value, description}` (e.g., `value: "40%"`,
 * `description: "page load reduction"`).
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
  kind: PortfolioItemKind | null;
  skills: SkillRef[];
  industries: { id: string; name: string }[];
  details: PortfolioItemDetails | null;
  files: PortfolioItemFile[];
  kpis: PortfolioItemKpi[];
}

interface TalentProfileResponse<T> {
  data?: { [key: string]: T | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Map a portfolio fragment node from the wire shape to the typed
 * {@link PortfolioItem}. Skills, industries, `details` (#548), `files`
 * (#549), and `kpis` (#550) are projected here; the remaining wire field
 * (`quotes`) stays out of scope for the read surface and is dropped.
 * Callers that need the extras can issue a richer query in a follow-up.
 */
function mapPortfolioNode(node: Record<string, unknown>): PortfolioItem {
  const id = node["id"];
  const skillsConn = node["skills"] as { nodes?: { id?: unknown; name?: unknown }[] } | null | undefined;
  const industriesConn = node["industries"] as { nodes?: { id?: unknown; name?: unknown }[] } | null | undefined;
  const skills: SkillRef[] = Array.isArray(skillsConn?.nodes)
    ? skillsConn.nodes.flatMap((s) =>
        typeof s.id === "string" && typeof s.name === "string" ? [{ id: s.id, name: s.name }] : [],
      )
    : [];
  const industries: { id: string; name: string }[] = Array.isArray(industriesConn?.nodes)
    ? industriesConn.nodes.flatMap((i) =>
        typeof i.id === "string" && typeof i.name === "string" ? [{ id: i.id, name: i.name }] : [],
      )
    : [];
  const rawKind = node["kind"];
  const kind: PortfolioItemKind | null =
    typeof rawKind === "string" && (Object.values(PORTFOLIO_ITEM_KIND) as string[]).includes(rawKind)
      ? (rawKind as PortfolioItemKind)
      : null;
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
    kind,
    skills,
    industries,
    details: projectDetails(node["details"]),
    files: projectFiles(node["files"]),
    kpis: projectKpis(node["kpis"]),
  };
}

/**
 * Wire `__typename` → surface `kind` discriminator. Centralized so the
 * mapping is auditable from one place when the server adds new variants.
 */
const DETAILS_TYPENAME_TO_KIND = {
  PortfolioItemImageBlock: "image",
  PortfolioItemTextBlock: "text",
  PortfolioItemVideoBlock: "video",
  PortfolioItemGalleryBlock: "gallery",
} as const satisfies Record<string, PortfolioItemDetails["kind"]>;

/**
 * Defensively project the `details` wire field into a typed
 * {@link PortfolioItemDetails}. Returns `null` when the wire returned
 * `null`/missing (item has no body block), the value isn't an object,
 * `__typename` is absent or unrecognized (a new server variant we
 * haven't taught the projection about), or `id` is missing — silently
 * absent body content rather than a fabricated shape. The `__typename`
 * regression itself surfaces loudly via the
 * `createPortfolioItem.snapshot.json` snapshot.
 *
 * Per-variant nested-field shape mismatches degrade to `null`/`""`
 * within the variant rather than failing the whole projection — the
 * top-level `kind` discriminator is the contract; sub-field types are
 * INFERRED and can shift independently of the variant identity.
 */
function projectDetails(raw: unknown): PortfolioItemDetails | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const typename = obj["__typename"];
  if (typeof typename !== "string") return null;
  const kind = (DETAILS_TYPENAME_TO_KIND as Record<string, PortfolioItemDetails["kind"] | undefined>)[typename];
  if (kind === undefined) return null;
  const id = obj["id"];
  if (typeof id !== "string") return null;
  const title = typeof obj["title"] === "string" ? obj["title"] : null;
  switch (kind) {
    case "image":
      return { kind: "image", id, title, image: projectImage(obj["image"]) };
    case "text":
      return {
        kind: "text",
        id,
        title,
        // HAST tree shape is opaque — pass through as-is if object, else
        // null. The caller decides whether to traverse or hand off.
        contentHast: typeof obj["contentHast"] === "object" && obj["contentHast"] !== null ? obj["contentHast"] : null,
      };
    case "video":
      return {
        kind: "video",
        id,
        title,
        videoUrl: typeof obj["videoUrl"] === "string" ? obj["videoUrl"] : null,
      };
    case "gallery": {
      const items = Array.isArray(obj["items"])
        ? obj["items"].flatMap((it): PortfolioGalleryItem[] => {
            if (it === null || typeof it !== "object") return [];
            const rec = it as Record<string, unknown>;
            const itemId = rec["id"];
            if (typeof itemId !== "string") return [];
            return [
              {
                id: itemId,
                contentType: typeof rec["contentType"] === "string" ? rec["contentType"] : null,
                image: projectImage(rec["image"]),
              },
            ];
          })
        : [];
      return { kind: "gallery", id, title, items };
    }
  }
}

/** Project the `{ thumbUrl, optimizedUrl }` image sub-shape. Both fields nullable. */
function projectImage(raw: unknown): { thumbUrl: string | null; optimizedUrl: string | null } | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    thumbUrl: typeof obj["thumbUrl"] === "string" ? obj["thumbUrl"] : null,
    optimizedUrl: typeof obj["optimizedUrl"] === "string" ? obj["optimizedUrl"] : null,
  };
}

/**
 * Wire `__typename` → surface `kind` discriminator for file attachments.
 * Centralized so the mapping is auditable from one place when the server
 * adds new file variants.
 */
const FILE_TYPENAME_TO_KIND = {
  PortfolioItemFilePdf: "pdf",
  PortfolioItemFileImage: "image",
} as const satisfies Record<string, PortfolioItemFile["kind"]>;

/**
 * Defensively project the `files` connection wire field into a typed
 * {@link PortfolioItemFile} array. Returns `[]` when the wire returned
 * `null`/missing (item has no attachments) or `nodes` is absent/not an
 * array. Individual nodes that fail projection (unknown/missing
 * `__typename`, non-string `id`) are dropped rather than fabricated — a
 * partial array is preferable to a poisoned one. The `__typename`
 * regression itself surfaces loudly via the
 * `createPortfolioItem.snapshot.json` snapshot.
 */
function projectFiles(raw: unknown): PortfolioItemFile[] {
  if (raw === null || raw === undefined || typeof raw !== "object") return [];
  const nodes = (raw as Record<string, unknown>)["nodes"];
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node): PortfolioItemFile[] => {
    const file = projectFile(node);
    return file ? [file] : [];
  });
}

/**
 * Project a single `files.nodes[]` entry into a typed
 * {@link PortfolioItemFile}, or `null` when the node isn't an object,
 * `__typename` is absent/unrecognized, or `id` is missing. Per-variant
 * nested-field shape mismatches degrade to `null` within the variant
 * rather than dropping the whole node — the top-level `kind`
 * discriminator is the contract; sub-field types are INFERRED and can
 * shift independently of the variant identity.
 */
function projectFile(raw: unknown): PortfolioItemFile | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const typename = obj["__typename"];
  if (typeof typename !== "string") return null;
  const kind = (FILE_TYPENAME_TO_KIND as Record<string, PortfolioItemFile["kind"] | undefined>)[typename];
  if (kind === undefined) return null;
  const id = obj["id"];
  if (typeof id !== "string") return null;
  const title = typeof obj["title"] === "string" ? obj["title"] : null;
  const description = typeof obj["description"] === "string" ? obj["description"] : null;
  const contentType = typeof obj["contentType"] === "string" ? obj["contentType"] : null;
  switch (kind) {
    case "pdf":
      return {
        kind: "pdf",
        id,
        title,
        description,
        contentType,
        fileUrl: typeof obj["fileUrl"] === "string" ? obj["fileUrl"] : null,
        primaryContentType: typeof obj["primaryContentType"] === "string" ? obj["primaryContentType"] : null,
      };
    case "image":
      return { kind: "image", id, title, description, contentType, image: projectImage(obj["image"]) };
  }
}

/**
 * Defensively project the `kpis` wire field into a typed
 * {@link PortfolioItemKpi} array. Returns `[]` when the wire returned
 * `null`/missing/non-array — silently absent rather than throwing.
 * Per-element nodes without a string `id` are dropped (siblings preserved);
 * `value` and `description` are nullable scalars projected as strings or
 * `null` (the wire field types are INFERRED — see {@link PortfolioItemKpi}
 * for the full evidence chain).
 *
 * Wire shape: direct list (NOT a connection — verified via probe error
 * "Field 'nodes' doesn't exist on type 'PortfolioItemKpi'", 2026-05-23).
 * Element type `PortfolioItemKpi` with exactly the 3 fields below
 * (verified by elimination: `label` / `name` / `unit` all rejected as
 * undefined fields on `PortfolioItemKpi`).
 */
function projectKpis(raw: unknown): PortfolioItemKpi[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((node): PortfolioItemKpi[] => {
    if (node === null || typeof node !== "object") return [];
    const obj = node as Record<string, unknown>;
    const id = obj["id"];
    if (typeof id !== "string") return [];
    const value = typeof obj["value"] === "string" ? obj["value"] : null;
    const description = typeof obj["description"] === "string" ? obj["description"] : null;
    return [{ id, value, description }];
  });
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
    const fieldHint = first?.key ? ` (${first.key})` : "";
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
/**
 * Shared selection set for `PortfolioItem` nodes used across `list`,
 * `create`, `update`, `remove`, `reorder`, and `highlight` mutation
 * responses. Centralized so the `mapPortfolioNode` mapper always sees a
 * consistent shape regardless of which operation produced the response.
 *
 * Includes `kind`, `skills.nodes`, and `industries.nodes` so the
 * `update` read-modify-write path can preserve non-null required fields
 * the server enforces (`showViaToptal`, `skills`).
 */
const PORTFOLIO_NODE_SELECTION = `
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
  kind
  skills { nodes { id name } }
  industries { nodes { id name } }
  details {
    __typename
    ... on PortfolioItemImageBlock { id title image { thumbUrl optimizedUrl } }
    ... on PortfolioItemTextBlock { id title contentHast }
    ... on PortfolioItemVideoBlock { id title videoUrl }
    ... on PortfolioItemGalleryBlock { id title items { id contentType image { thumbUrl optimizedUrl } } }
  }
  files {
    nodes {
      __typename
      ... on PortfolioItemFilePdf { id title description contentType fileUrl primaryContentType }
      ... on PortfolioItemFileImage { id title description contentType image { thumbUrl optimizedUrl } }
    }
  }
  kpis { id value description }
`;

const GET_PORTFOLIO_ITEMS_QUERY = `query getPortfolioItems($profileId: ID!) {
  profile(id: $profileId) {
    id
    portfolioItems {
      nodes { ${PORTFOLIO_NODE_SELECTION} }
    }
  }
}`;

/**
 * Fetch the signed-in user's portfolio items. Takes the user's auth token
 * and returns the typed array; the empty-list case returns `[]` (not
 * `null`).
 */
export async function list(token: string): Promise<PortfolioItem[]> {
  const profileId = await extractProfileId(token);
  // Routed to `talent-profile` (impersonated, Cloudflare-protected): the
  // older `mobile-gateway` schema is missing fields the read surface
  // selects (`toptalRelated` empirically — `Cannot query field
  // "toptalRelated" on type "PortfolioItem"`, captured 2026-05-16). The
  // talent-profile schema is authoritative for all mutations in this
  // service; aligning the query surface keeps a single source of truth.
  const res = await withTransportErrors("getPortfolioItems", async () =>
    impersonatedTransport({
      surface: "talent-profile",
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
        nodes { ${PORTFOLIO_NODE_SELECTION} }
      }
    }
    success
    notice
    errors {
      code
      key
      message
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
 * Default description used when the caller does not supply one. The
 * server validates a minimum length on `description` (≥200 characters,
 * empirically discovered during issue #314); a short title-derived
 * default would be rejected with `"is too short (minimum is 200
 * characters)"` for typical CLI titles. This placeholder satisfies the
 * minimum while remaining obviously a placeholder a user would refine.
 *
 * Length: 273 characters.
 */
const DEFAULT_PORTFOLIO_DESCRIPTION =
  "This portfolio item was created via the ttctl CLI without an explicit description. " +
  "Replace this placeholder via `ttctl profile portfolio update <id> --description ...` " +
  "with details about the project, the work performed, the technologies used, and the outcomes achieved.";

/**
 * Create a new portfolio item.
 *
 * Returns the full updated portfolio list — the server treats portfolio
 * items as a profile-scoped collection, and the mutation response always
 * carries the post-mutation snapshot. Callers that only want the new item
 * find it as the last entry (or by matching `title`).
 *
 * **Required-field defaults**: live capture (issue #314, batch 2026-05-15;
 * extended 2026-05-16 with empirical re-investigation via
 * `.tmp/probe-portfolio-*.mjs`) showed the server requires `kind`,
 * `showViaToptal`, `skills`, `description`, `publicationPermit`, and
 * `industryIds` as non-null (and `description` carries a ≥200-character
 * minimum-length constraint). We project safe defaults so existing
 * callers (e.g. the `ttctl profile portfolio add --title ...` CLI
 * surface) do not need to thread the structural fields; users who want
 * explicit control can still pass them through.
 *
 *   - `kind` defaults to `"basic"` — the most neutral enum member,
 *     matching a portfolio entry with only `title` / `description` /
 *     `link` and no special structural framing (vs. `accomplishment`,
 *     `classic` case-study, `code_base` repo, or `other_amazing_things`).
 *     Note: write-side enum is LOWERCASE; the synthesized read-side
 *     `PortfolioItemKindEnum` uses SCREAMING_SNAKE which is rejected on
 *     create.
 *   - `showViaToptal` defaults to `true` — a TTCtl-created item is
 *     intended for visibility on the user's Toptal profile; users who
 *     want to hide can `update` after create.
 *   - `skills` defaults to the first profile skill — preserves the
 *     "minimal CLI invocation just works" UX; empty-profile case
 *     surfaces VALIDATION_ERROR.
 *   - `description` defaults to {@link DEFAULT_PORTFOLIO_DESCRIPTION},
 *     a 273-character placeholder that satisfies the server's ≥200-char
 *     minimum and obviously reads as a placeholder users would refine
 *     via `ttctl profile portfolio update`.
 *   - `publicationPermit` defaults to `true`. The server treats `false`
 *     as blank (`USER_ERROR code: blank, key: publicationPermit`) — only
 *     `true` is accepted on create. The update path's persisted-state
 *     semantic on the sibling Employment surface was found server-controlled
 *     (#488 — sending `true` does not guarantee a `false`-current row
 *     flips to `true`); Portfolio likely shares this server-side semantic
 *     but it remains uninvestigated here. Field does NOT gate public
 *     resume listing (the rc.6 #402 framing of "publicly listable" was
 *     inaccurate).
 *   - `industryIds` is **REQUIRED** — caller MUST supply at least one
 *     catalog Industry ID per portfolio item. We do NOT default from
 *     `Profile.basicInfoIndustries`, `industriesAutocomplete`, or skill
 *     inference: each portfolio item's industry association is the
 *     caller's deliberate choice; auto-defaulting would silently mis-tag
 *     work. Discover IDs via `ttctl profile industries autocomplete
 *     <query>`.
 */
/**
 * `add()` parameter shape: `PortfolioItemInput` with `industryIds` narrowed
 * to a required field. `update()` still accepts the base
 * `PortfolioItemInput` (where `industryIds` is optional — partial-update
 * semantics). Splitting at the function-parameter level keeps a single
 * input vocabulary and lets TypeScript catch missing-industries at the
 * call site instead of waiting for the runtime guard.
 *
 * The empty-array case is still checked at runtime — `[]` is structurally
 * a `string[]` but semantically invalid; TS lacks a native non-empty-array
 * type and `[string, ...string[]]` would be hostile to spread-from-array
 * call sites.
 */
export type PortfolioItemAddInput = PortfolioItemInput & { industryIds: string[] };

export async function add(token: string, input: PortfolioItemAddInput): Promise<PortfolioItem[]> {
  if (!input.title || input.title.trim() === "") {
    throw new PortfolioError("VALIDATION_ERROR", "Portfolio item requires a non-empty `title`.");
  }
  // Runtime guard: TS narrowing requires `industryIds` to exist as a
  // `string[]`, but JS callers / MCP tool inputs / `as any` casts can
  // bypass that. Server-verified to reject `[]` / `null` / omitted with
  // `code: blank, key: industries` (live probe 2026-05-16,
  // `.tmp/probe-empty-industries.mjs`); we surface the same constraint as
  // VALIDATION_ERROR before reaching the wire.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defense-in-depth for non-TS callers
  if (!input.industryIds || input.industryIds.length === 0) {
    throw new PortfolioError(
      "VALIDATION_ERROR",
      "Portfolio item requires at least one industry id (`industryIds`). " +
        "Discover catalog IDs via `ttctl profile industries autocomplete <query>`, " +
        "then pass `--industry-id <id>` (repeatable) on the CLI.",
    );
  }
  const profileId = await extractProfileId(token);

  // The server rejects `skills: []` with `"You need to add at least one
  // tag"`. When the caller does not supply skills, fall back to the
  // user's first profile skill — preserves the "minimal CLI invocation
  // just works" experience and aligns the portfolio entry with the
  // user's primary skill domain. Empty-profile case surfaces a clear
  // VALIDATION_ERROR pointing the user at remediation.
  const callerSkills = input.skills;
  let resolvedSkills: SkillRef[];
  if (callerSkills !== undefined && callerSkills.length > 0) {
    resolvedSkills = callerSkills;
  } else {
    const profileSkills = await listSkills(token, profileId);
    if (profileSkills.length === 0) {
      throw new PortfolioError(
        "VALIDATION_ERROR",
        "Cannot create portfolio item: profile has no skills. " +
          "Add at least one skill via `ttctl profile skills add <name>`, " +
          "then retry — or pass `skills` explicitly.",
      );
    }
    // The first skill set is typically the talent's primary skill;
    // users who want a different tag association can update the item
    // afterward (or thread `skills` explicitly).
    const first = profileSkills[0];
    if (first === undefined) {
      throw new PortfolioError("UNKNOWN", "Skills list non-empty but indexed lookup returned undefined.");
    }
    resolvedSkills = [{ id: first.skill.id, name: first.skill.name }];
  }

  const portfolioItem: PortfolioItemInput = {
    kind: PORTFOLIO_ITEM_KIND.BASIC,
    showViaToptal: true,
    description: DEFAULT_PORTFOLIO_DESCRIPTION,
    publicationPermit: true,
    ...input,
    // `skills` is set AFTER the spread so the resolved default applies
    // even when the caller passed an empty array (the server treats `[]`
    // identically to `null` for this field).
    skills: resolvedSkills,
  };
  const variables: { input: CreatePortfolioItemInput } = {
    input: { profileId, portfolioItem },
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
        nodes { ${PORTFOLIO_NODE_SELECTION} }
      }
    }
    success
    notice
    errors {
      code
      key
      message
    }
  }
}`;

interface UpdatePortfolioItemInput {
  portfolioItemId: string;
  portfolioItem: PortfolioItemInput;
}

/**
 * Update a portfolio item by id. Conceptually a partial update — callers
 * supply only the fields they want to change — but the server's
 * `updatePortfolioItem` mutation enforces full-replace semantics on
 * `PortfolioItemUpdateInput` non-null fields. Verified live 2026-05-16
 * (probe `.tmp/probe-portfolio-update-shape2.mjs`): the update input
 * shape DIFFERS from create:
 *
 *   - GQL-level non-null required: `showViaToptal`, `skills`.
 *   - USER_ERROR (`code: blank`) if missing: `description` (≥200 chars),
 *     `publicationPermit`, `industries` (i.e. `industryIds`).
 *   - **NOT defined** on `PortfolioItemUpdateInput` (rejected at GQL
 *     layer): `kind`, `coverImage`. These are write-once on create; to
 *     change a cover, the caller goes through `uploadCover()` →
 *     separate mutation, not via `update`.
 *
 * To preserve the partial-update UX over the full-replace wire shape,
 * this function does read-modify-write: fetch the current item, merge
 * caller's `changes` on top of the current state, then send the merged
 * input. The mutation response carries the full post-mutation list,
 * which is returned to callers as `PortfolioItem[]`.
 *
 * The function ACCEPTS the broader `PortfolioItemInput` shape (which
 * still types `kind` / `coverImage`) so callers don't need a separate
 * partial type, but it INTENTIONALLY DROPS those fields from the merged
 * payload before sending — keeping them would surface a confusing
 * "Field is not defined on PortfolioItemUpdateInput" GraphQL error.
 */
export async function update(token: string, id: string, changes: PortfolioItemInput): Promise<PortfolioItem[]> {
  if (Object.keys(changes).length === 0) {
    throw new PortfolioError("VALIDATION_ERROR", "Portfolio update requires at least one field.");
  }
  // Read-modify-write: fetch current state of the target item so we can
  // satisfy the server's non-null requirements on update. `list()` is the
  // single source of truth for the current shape — using it keeps the
  // selection-set in sync with `mapPortfolioNode`.
  const current = (await list(token)).find((it) => it.id === id);
  if (!current) {
    throw new PortfolioError("VALIDATION_ERROR", `Portfolio item ${id} not found.`);
  }
  // Build the merged input: current state as base, caller's `changes` as
  // overrides. The wire shape uses `industryIds: string[]` (catalog IDs)
  // whereas the read shape returns `industries: { id, name }[]` — bridge
  // by projecting current.industries to ids. Caller's `industryIds`
  // (when supplied via `changes`) wins over the projected current set.
  //
  // Conditional spread is required by `exactOptionalPropertyTypes: true`:
  // a `T?: string` field cannot be assigned `undefined` (only omitted or
  // a value), so each potentially-null current field becomes a `&& {...}`
  // spread that contributes nothing when the current value is null.
  //
  // `kind` and `coverImage` are intentionally NOT spread from current —
  // `PortfolioItemUpdateInput` does not define them. Caller's `changes`
  // are merged below; we strip these two fields out of the final payload.
  const merged: PortfolioItemInput = {
    ...(current.title !== null && { title: current.title }),
    ...(current.description !== null && { description: current.description }),
    ...(current.link !== null && { link: current.link }),
    ...(current.websiteUrl !== null && { websiteUrl: current.websiteUrl }),
    ...(current.accomplishment !== null && { accomplishment: current.accomplishment }),
    ...(current.publicationPermit !== null && { publicationPermit: current.publicationPermit }),
    ...(current.clientOrCompanyName !== null && { clientOrCompanyName: current.clientOrCompanyName }),
    ...(current.toptalRelated !== null && { toptalRelated: current.toptalRelated }),
    ...(current.showViaToptal !== null && { showViaToptal: current.showViaToptal }),
    highlight: current.highlight,
    skills: current.skills,
    industryIds: current.industries.map((i) => i.id),
    ...changes,
  };
  // Strip the two fields rejected by `PortfolioItemUpdateInput` even if
  // a caller passed them in `changes` — the typed `PortfolioItemInput`
  // is shared with `add()` which DOES accept them. Deleting here keeps
  // the call-site UX uniform: callers can pass `kind` / `coverImage`
  // through the same typed dict; we'll quietly drop them on the update
  // path rather than crashing with a server-side GraphQL error.
  delete merged.kind;
  delete merged.coverImage;
  const variables: { input: UpdatePortfolioItemInput } = {
    input: { portfolioItemId: id, portfolioItem: merged },
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
        nodes { ${PORTFOLIO_NODE_SELECTION} }
      }
    }
    success
    notice
    errors {
      code
      key
      message
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
        nodes { ${PORTFOLIO_NODE_SELECTION} }
      }
    }
    success
    notice
    errors {
      code
      key
      message
    }
  }
}`;

/**
 * Reorder portfolio items by setting `id` to the absolute `position`. The
 * CLI surface translates the more user-friendly `--before <id>` /
 * `--after <id>` flags to this absolute position; the helpers
 * {@link positionBefore} / {@link positionAfter} compute the position
 * given the current list.
 *
 * Wire shape (verified live 2026-05-16, probe
 * `.tmp/probe-portfolio-reorder.mjs`): the position lives INSIDE
 * `portfolioItem: { position: Int! }` — NOT at the top level of
 * `ChangePortfolioItemPositionInput`. The naive `{ portfolioItemId,
 * position }` shape is rejected with "Field is not defined on
 * ChangePortfolioItemPositionInput" (for `position`) and
 * "portfolioItem (Expected value to not be null)".
 */
export async function reorder(token: string, id: string, position: number): Promise<PortfolioItem[]> {
  if (!Number.isInteger(position) || position < 0) {
    throw new PortfolioError("VALIDATION_ERROR", "Portfolio reorder position must be a non-negative integer.");
  }
  const variables = { input: { portfolioItemId: id, portfolioItem: { position } } };
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
 *
 * Verified live 2026-05-16: the server interprets `position` against the
 * POST-REMOVAL list (i.e. it first removes the moving item, then inserts
 * at `position`). Valid range is `[0, N-1]` where `N` is the original
 * list length; `position = N` (= the naive "after the last item")
 * returns `USER_ERROR code: invalidPosition` ("Position should be
 * greater or equal to 0 and less than the number of items").
 *
 * When `movingId` is supplied AND points at an item that exists in
 * `items`, that item is filtered out before computing the target's
 * index — this correctly handles the case where the moving item is
 * already in the list and sits before the target (removing it shifts
 * the target left by 1).
 */
export function positionBefore(items: PortfolioItem[], targetId: string, movingId?: string): number | null {
  const filtered = movingId !== undefined ? items.filter((it) => it.id !== movingId) : items;
  const idx = filtered.findIndex((it) => it.id === targetId);
  return idx === -1 ? null : idx;
}

/**
 * Compute the absolute position the moved item should land at, given a
 * target item to be placed AFTER. Returns `null` if `targetId` is not in
 * the list.
 *
 * Same post-removal semantics as {@link positionBefore} — pass the
 * `movingId` so the helper can filter it out of `items` before
 * computing the target's index. Without `movingId`, the helper assumes
 * the moving item is not present and computes `idx + 1` directly; that
 * value will be one too high for the common "move A `--after` B" CLI
 * flow when both items are in the list and A is before B, and the
 * server will reject it.
 */
export function positionAfter(items: PortfolioItem[], targetId: string, movingId?: string): number | null {
  const filtered = movingId !== undefined ? items.filter((it) => it.id !== movingId) : items;
  const idx = filtered.findIndex((it) => it.id === targetId);
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
      code
      key
      message
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
 * `transformation` is `PortfolioCoverImageTransformationInput!` with four
 * non-null `Int!` fields — `cropX`, `cropY`, `cropW`, `cropH` (verified
 * live 2026-05-16, probe `.tmp/probe-cover-crop.mjs`). Sending `{}` is
 * rejected at the GQL layer ("Expected value to not be null"). All four
 * fields must be integers in PIXEL units. The server is tolerant of
 * oversized crop boxes (e.g. `cropW: 99999`) and will clamp; it does
 * NOT support normalized 0..1 units.
 *
 * The server also enforces a minimum cover-image dimension of
 * **750 × 500 px** (USER_ERROR `code: invalidImage` —
 * "This image must be at least 750 x 500px and under 5MB to be
 * accepted"). Callers are responsible for ensuring the uploaded file
 * meets this bound; this service does not pre-validate dimensions.
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
      code
      key
      message
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
 * Crop transformation input for {@link uploadCover}. Pixel-based; all
 * four values are required by the server. {@link uploadCover} accepts
 * this as an optional parameter — when omitted, the service attempts to
 * read the source image's dimensions (PNG header parsing) and defaults
 * to a whole-image crop. For non-PNG sources or parse failures, the
 * service falls back to an oversized `(0, 0, 99999, 99999)` bounding
 * box and lets the server clamp.
 */
export interface PortfolioCoverTransformation {
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
}

/**
 * Read width/height from a PNG file's IHDR chunk. PNG signature is
 * 8 bytes; the IHDR chunk follows with a 4-byte length, "IHDR" type,
 * then 4-byte width, 4-byte height (big-endian uint32s). Returns
 * `null` for non-PNG inputs or short buffers (caller falls back to a
 * sentinel oversized crop).
 */
function parsePngDimensions(buffer: Buffer | Uint8Array): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  const isPng =
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d;
  if (!isPng) return null;
  const view = new DataView(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Upload a cover image for a portfolio item. The cover image is bound to
 * the user's profile rather than a specific portfolio item — the response
 * carries a `coverImageCacheName` the caller passes back into a
 * subsequent `update()` call (or `add()` for new items) via the
 * `coverImage` field.
 *
 * The `transformation` parameter is optional. When omitted, the service
 * resolves a sensible default: PNG sources have their dimensions read
 * from the IHDR header and used as the whole-image crop
 * `(0, 0, width, height)`; non-PNG sources fall back to a large
 * bounding box `(0, 0, 99999, 99999)` (the server clamps oversized
 * crops). Callers who need explicit control pass `transformation`
 * directly.
 *
 * The server enforces a minimum cover-image size of 750x500px — the
 * service does NOT pre-validate this; callers receive a `USER_ERROR`
 * (`code: invalidImage`) when the image is too small.
 */
export async function uploadCover(
  token: string,
  source: FileSource,
  transformation?: PortfolioCoverTransformation,
): Promise<UploadPortfolioCoverResult> {
  const profileId = await extractProfileId(token);
  const file = await resolveFileSource(source, "uploadCover");
  const resolvedTransformation: PortfolioCoverTransformation =
    transformation ?? defaultCoverTransformation(file.content);
  const res = await withTransportErrors("uploadPortfolioCover", async () =>
    impersonatedMultipartTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "uploadPortfolioCover",
        query: UPLOAD_PORTFOLIO_COVER_MUTATION,
        variables: {
          profileId,
          transformation: resolvedTransformation,
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
 * Sentinel oversized crop bounding box used when image dimensions
 * cannot be statically inferred (non-PNG, malformed PNG). The server
 * clamps oversized crops to the actual image extent.
 */
const OVERSIZED_CROP: PortfolioCoverTransformation = { cropX: 0, cropY: 0, cropW: 99999, cropH: 99999 };

function defaultCoverTransformation(content: Buffer | Uint8Array): PortfolioCoverTransformation {
  const dims = parsePngDimensions(content);
  if (dims) {
    return { cropX: 0, cropY: 0, cropW: dims.width, cropH: dims.height };
  }
  return OVERSIZED_CROP;
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
      code
      key
      message
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
  const profileId = await extractProfileId(token);
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
