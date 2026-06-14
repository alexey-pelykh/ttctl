// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// Transport barrel (ADR-010 layout): the public transport surface is split
// across `_shared.ts` (cross-cutting infra — types, COMMON_HEADERS, dry-run,
// resilience loop, RedirectError), `stock.ts` (undici mobile-gateway path),
// and `impersonated.ts` (node-wreq Cloudflare path + CF/native errors). This
// barrel re-exports the exact surface the former single `transport.ts` file
// exported, so every consumer that imports `@ttctl/core` or `transport/index.js`
// is unaffected by the internal decomposition. Pure module-boundary move — no
// semantic change.

import { impersonatedTransport } from "./impersonated.js";
import { stockTransport } from "./stock.js";
import { SURFACES_REQUIRING_IMPERSONATION } from "../types.js";
import type { TransportRequest, TransportResponse } from "./_shared.js";

/**
 * Choose transport per surface. The mobile gateway accepts stock TLS;
 * `talent-profile` and `scheduler` require Chrome TLS-fingerprint impersonation
 * to clear Cloudflare's bot-management.
 */
export async function callSurface(req: TransportRequest): Promise<TransportResponse> {
  if (SURFACES_REQUIRING_IMPERSONATION.has(req.surface)) {
    return impersonatedTransport(req);
  }
  return stockTransport(req);
}

export {
  buildDryRunPreview,
  DRY_RUN_REDACTED_AUTHORIZATION,
  getRedirectLocation,
  IMPERSONATE_PROFILE,
  RedirectError,
  USER_AGENT,
} from "./_shared.js";
export type {
  DryRunPreview,
  MultipartFile,
  MultipartTransportRequest,
  TransportRequest,
  TransportResponse,
} from "./_shared.js";

export { stockTransport } from "./stock.js";

export {
  buildGraphQLMultipart,
  Cf403Error,
  Cf403PersistentError,
  impersonatedFetch,
  impersonatedMultipartTransport,
  impersonatedTransport,
  NativeModuleUnavailableError,
  SchedulerBearerExpired,
} from "./impersonated.js";
