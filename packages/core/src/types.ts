// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Resolved credentials ready to be passed to the sign-in flow.
 * Both forms in `.ttctl.yaml` (literal object and `op://...` reference)
 * collapse to this shape after resolution.
 */
export interface Credentials {
  email: string;
  password: string;
}

/**
 * Logical Toptal Talent surface. Each surface has its own endpoint, transport
 * requirements, and persisted-query expectations.
 */
export type ToptalSurface = "mobile-gateway" | "talent-profile" | "scheduler";

/**
 * Endpoint URLs for each surface. Kept in one place so the impersonated vs
 * stock-transport routing has a single source of truth.
 */
export const SURFACE_ENDPOINTS: Record<ToptalSurface, string> = {
  "mobile-gateway": "https://www.toptal.com/gateway/graphql/talent/graphql",
  "talent-profile": "https://www.toptal.com/api/talent_profile/graphql",
  scheduler: "https://scheduler.toptal.com/api/graphql",
};

/**
 * Surfaces that require Chrome TLS-fingerprint impersonation (Cloudflare
 * bot-management gates them). `mobile-gateway` accepts stock TLS, the others
 * require `node-wreq` with a recent Chrome profile.
 */
export const SURFACES_REQUIRING_IMPERSONATION: ReadonlySet<ToptalSurface> = new Set(["talent-profile", "scheduler"]);

/**
 * GraphQL request envelope. Compatible with both full-document and
 * persisted-query (Apollo APQ) wire formats.
 */
export interface GraphQLRequest {
  operationName: string;
  variables?: Record<string, unknown>;
  query?: string;
  extensions?: {
    persistedQuery?: {
      version: 1;
      sha256Hash: string;
    };
  };
}
