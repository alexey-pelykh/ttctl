// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { AuthValue } from "./config.js";
import { resolveOnePasswordReference } from "./onepassword.js";
import type { Credentials } from "./types.js";

/**
 * Collapse the polymorphic auth value into resolved credentials.
 *
 * Form A (string)  → `op://VAULT/ITEM` → resolved via `op` CLI
 * Form B (object)  → literal `{ email, password }`
 */
export function resolveCredentials(auth: AuthValue): Credentials {
  if (typeof auth === "string") {
    return resolveOnePasswordReference(auth);
  }
  return { email: auth.email, password: auth.password };
}

/**
 * Sign in to Toptal Talent via `EmailPasswordSignIn` GraphQL mutation in
 * persisted-query mode. Captures session cookies into the supplied jar.
 *
 * Implementation deferred to milestone 1 — see issue tracker. This stub keeps
 * the type surface in place so dependent code compiles.
 */
export function signIn(credentials: Credentials): Promise<void> {
  // TODO(milestone-1): POST EmailPasswordSignIn (persisted-query SHA-256 hash
  // from research/graphql/operations.json), capture Set-Cookie into the jar,
  // verify Viewer query succeeds with the resulting session.
  void credentials;
  return Promise.reject(new Error("signIn not yet implemented; see TODO"));
}
