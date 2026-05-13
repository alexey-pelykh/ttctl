// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { AuthRevokedError, TtctlError } from "../../../auth/errors.js";
import { impersonatedMultipartTransport, impersonatedTransport } from "../../../transport.js";
import type { MultipartFile, TransportResponse } from "../../../transport.js";
import { isAuthRevokedExtensionCode } from "../shared.js";

/**
 * Resume sub-domain error codes. Cross-cutting auth/Cloudflare failures
 * propagate as `TtctlError` subclasses unchanged.
 */
export type ResumeErrorCode =
  | "GRAPHQL_ERROR"
  | "NETWORK_ERROR"
  | "USER_ERROR"
  | "VALIDATION_ERROR"
  | "FILE_NOT_FOUND"
  | "FILE_READ_ERROR"
  | "UNKNOWN";

export class ResumeError extends Error {
  override readonly name = "ResumeError";
  constructor(
    public readonly code: ResumeErrorCode,
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

interface TalentProfileResponse<T> {
  data?: { [key: string]: T | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Source for the resume file. Mirrors the {@link FileSource} pattern in
 * the portfolio service: CLI surface uses the `path` variant, MCP surface
 * uses the `buffer` variant (after base64-decoding).
 */
export type FileSource =
  | { kind: "path"; path: string }
  | { kind: "buffer"; filename: string; content: Buffer | Uint8Array; contentType?: string };

async function resolveFileSource(source: FileSource): Promise<MultipartFile> {
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
      throw new ResumeError("FILE_NOT_FOUND", `resume upload: file not found: ${source.path}`);
    }
    throw new ResumeError("FILE_READ_ERROR", `resume upload: failed to read ${source.path}: ${message}`);
  }
  return { filename: basename(source.path), content };
}

/**
 * Common "200 with errors" shape handler. Returns the unwrapped payload
 * (the value of the single root data field) as `unknown`; callers narrow
 * to their per-operation payload shape at the call site.
 */
function unwrapResponse(res: TransportResponse, operationName: string): unknown {
  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ResumeError("UNKNOWN", `${operationName} returned HTTP ${res.status.toString()}`);
  }
  const body = res.body as TalentProfileResponse<unknown> | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new ResumeError("GRAPHQL_ERROR", `${operationName} failed: ${first?.message ?? "GraphQL error"}`);
  }
  if (!body?.data) {
    throw new ResumeError("UNKNOWN", `${operationName} response had no \`data\` field`);
  }
  const keys = Object.keys(body.data);
  if (keys.length === 0) {
    throw new ResumeError("UNKNOWN", `${operationName} response had empty \`data\``);
  }
  const firstKey = keys[0] as string;
  const payload = body.data[firstKey];
  if (payload === null || payload === undefined) {
    throw new ResumeError("UNKNOWN", `${operationName} response had \`null\` payload`);
  }
  return payload;
}

function rejectIfUserErrors(errors: UserError[] | null | undefined, operationName: string): void {
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    const fieldHint = first?.key ? ` (${first.key})` : "";
    throw new ResumeError("USER_ERROR", `${operationName} rejected${fieldHint}: ${first?.message ?? "unknown error"}`);
  }
}

async function withTransportErrors<T>(operationName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    if (err instanceof ResumeError) throw err;
    throw new ResumeError("NETWORK_ERROR", `${operationName} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/**
 * Full-document `uploadResume` mutation. The wire shape carries the file
 * via the GraphQL multipart spec — `variables.input.file` is the slot
 * the multipart map binds to.
 *
 * The server-side `UploadResumeInput` is partially documented (placeholder
 * in the synthesized SDL); empirically the only required member is the
 * `Upload`-typed `file` field. If the server rejects the wrapper key or
 * names a different field, capture the live shape via curl.
 */
const UPLOAD_RESUME_MUTATION = `mutation uploadResume($input: UploadResumeInput!) {
  uploadResume(input: $input) {
    success
    errors {
      code
      key
      message
    }
  }
}`;

interface UploadResumePayload {
  success?: boolean | null;
  errors?: UserError[] | null;
}

export interface UploadResumeResult {
  success: boolean;
}

/**
 * Upload a resume file. Returns `{ success: true }` on a server-confirmed
 * success; throws `ResumeError` on any failure path.
 */
export async function upload(token: string, source: FileSource): Promise<UploadResumeResult> {
  const file = await resolveFileSource(source);
  // Destructive — overwrites the maintainer's published resume file with no
  // safe rollback path. The cancelResumeUpload semantic only clears
  // half-uploaded server-side state; if the upload commits before cancel
  // arrives, the file is replaced. The impersonatedMultipartTransport wire
  // path is covered transitively by uploadPortfolioCover / uploadPortfolioFile
  // in packages/e2e/src/36-profile-portfolio.e2e.test.ts; the talent-profile
  // JSON mutation wire shape is covered for this sub-domain by
  // cancelResumeUpload in packages/e2e/src/39-profile-resume.e2e.test.ts.
  const res = await withTransportErrors("uploadResume", async () =>
    impersonatedMultipartTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        // e2e-exempt: destructive — see comment above the withTransportErrors call.
        operationName: "uploadResume",
        query: UPLOAD_RESUME_MUTATION,
        variables: {
          input: { file: null },
        },
      },
      files: { "0": file },
      map: { "0": ["variables.input.file"] },
    }),
  );
  const payload = unwrapResponse(res, "uploadResume") as UploadResumePayload;
  rejectIfUserErrors(payload.errors, "uploadResume");
  if (payload.success === false) {
    throw new ResumeError("USER_ERROR", "uploadResume reported success=false");
  }
  return { success: payload.success === true };
}

/**
 * Full-document `cancelResumeUpload` mutation. The `CancelResumeUploadInput`
 * is empty per Pattern 7 (the server uses session context); we send `{}`.
 */
const CANCEL_RESUME_UPLOAD_MUTATION = `mutation cancelResumeUpload($input: CancelResumeUploadInput!) {
  cancelResumeUpload(input: $input) {
    success
    errors {
      code
      key
      message
    }
  }
}`;

interface CancelResumeUploadPayload {
  success?: boolean | null;
  errors?: UserError[] | null;
}

export interface CancelResumeUploadResult {
  success: boolean;
}

/**
 * Cancel any in-flight resume upload, clearing half-uploaded server-side
 * state. Idempotent — returns `{ success: true }` even when no upload is
 * in flight (the server's contract).
 */
export async function cancelUpload(token: string): Promise<CancelResumeUploadResult> {
  const res = await withTransportErrors("cancelResumeUpload", async () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "cancelResumeUpload",
        query: CANCEL_RESUME_UPLOAD_MUTATION,
        variables: { input: {} },
      },
    }),
  );
  const payload = unwrapResponse(res, "cancelResumeUpload") as CancelResumeUploadPayload;
  rejectIfUserErrors(payload.errors, "cancelResumeUpload");
  return { success: payload.success === true };
}
