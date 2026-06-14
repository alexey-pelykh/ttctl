// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Cross-cutting typed-error contract for authentication failures.
 *
 * Each Toptal Talent backend (gateway, talent_profile, scheduler) reports
 * authentication failures with a different wire shape:
 *
 *   - gateway          → JSON `{ errors: [{ extensions: { code: 'AUTHENTICATION_REQUIRED' } }] }`
 *   - talent_profile   → JSON `{ errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] }`
 *                        OR HTML Cloudflare challenge (HTTP 403)
 *   - scheduler        → JSON `{ error: 'unauthorized' }` (post-v1)
 *
 * Transport and service modules detect each shape and throw a concrete
 * `TtctlError` subclass. Errors are NOT caught at the service layer — they
 * propagate to `@ttctl/cli` (CLI) and `@ttctl/mcp` (MCP) which present them
 * per surface conventions (CLI: human-readable text + exit code; MCP:
 * structured tool-error response).
 *
 * Each subclass carries:
 *   - `code`     — stable machine-readable identifier (e.g. `'AUTH_REVOKED'`).
 *                  Script consumers branch on this without parsing prose.
 *   - `recovery` — short, actionable user-facing string explaining how to
 *                  recover. Phrasing should match what the user CAN do, not
 *                  what TTCtl COULD do internally.
 *   - `autoRecover` (optional) — when `true`, signals that the transport or
 *                  service layer SHOULD attempt recovery once before
 *                  surfacing the error (e.g. scheduler-bearer re-mint via
 *                  `GetTopSchedulerToken` post-v1). Defaults to `false`.
 *
 * See ADR-005 in the private `ttctl/research` repo for the cross-surface
 * auth model. See issue #77 for the full failure-mode table.
 */
export abstract class TtctlError extends Error {
  /**
   * Stable, machine-readable error code. Subclasses provide a literal string
   * (e.g. `'AUTH_REVOKED'`, `'CF_403_CLEARANCE'`). Script consumers branch
   * on this; the value is part of the public API and should not change
   * casually.
   */
  abstract readonly code: string;

  /**
   * Short, actionable user-facing string. Phrased imperatively where the
   * user can take an action (e.g. `Run \`ttctl auth signin\` to
   * re-authenticate.`). Phrased descriptively where there is no clean user
   * action (e.g. `Cloudflare's bot-management has flipped a feature flag.
   * File an issue at ...`). Surface-renderers (CLI / MCP) pass this through
   * verbatim.
   */
  abstract readonly recovery: string;

  /**
   * When `true`, the transport or service layer should attempt automated
   * recovery once before surfacing this error to the user. Concrete
   * subclasses opt in by overriding to `true` (e.g. `SchedulerBearerExpired`
   * post-v1, where `GetTopSchedulerToken` re-mints transparently).
   *
   * Default `false` — most auth failures (revoked token, Cloudflare block)
   * require user intervention and cannot be auto-recovered.
   */
  readonly autoRecover: boolean = false;
}

/**
 * Authentication revoked or expired — the token TTCtl is replaying as
 * `Authorization: Token token=<X>` is no longer accepted by the gateway.
 *
 * Detected at the service layer when:
 *   - HTTP response is 401, OR
 *   - GraphQL response carries `errors[0].extensions.code` equal to
 *     `'AUTHENTICATION_REQUIRED'` (gateway form) or `'UNAUTHENTICATED'`
 *     (talent_profile form).
 *
 * Recovery is unambiguous: the user runs `ttctl auth signin` to re-mint a
 * session token. There is no automated path — sign-in requires credentials
 * the agent does not have.
 */
export class AuthRevokedError extends TtctlError {
  override readonly name = "AuthRevokedError";
  readonly code = "AUTH_REVOKED";
  readonly recovery = "Run `ttctl auth signin` to re-authenticate.";

  constructor(message: string = "Session is invalid or expired.", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Returns `true` when `extensions.code` on a GraphQL error indicates the
 * session token has been revoked or expired and the user must re-run
 * `ttctl auth signin`.
 *
 * Recognized stable codes (accumulated across surfaces and history):
 *
 *   - `'UNAUTHENTICATED'`         — talent-profile (Cloudflare-protected, web-portal API)
 *   - `'AUTHENTICATION_REQUIRED'` — defensive carryover from #77 (provenance unverified;
 *                                    see "Empirical history" below)
 *   - `'UNAUTHORIZED'`            — mobile-gateway (federated `talent_schema` subgraph,
 *                                    empirically observed 2026-05-07 for invalid bearer
 *                                    tokens; see `research/notes/14-auth-error-extensions-code.md`)
 *
 * All three collapse to {@link AuthRevokedError} so the CLI / MCP surfaces apply a
 * uniform "Run `ttctl auth signin`" recovery hint regardless of which surface
 * raised the failure.
 *
 * Lives here in `auth/errors.ts` (cross-cutting auth home, ADR-010) — the
 * predicate that decides whether a wire error maps to `AuthRevokedError`
 * belongs beside that class. Consumers across the service layer
 * (profile sub-domains via `services/profile/shared.ts`, the gateway-shared
 * helper) import it from here.
 *
 * **Empirical history** (issue #89): the original predicate (#77) recognized
 * only the first two codes. Live mobile-gateway capture for an invalid bearer
 * token returned HTTP 200 with `errors[0].extensions.code = 'UNAUTHORIZED'`
 * (NOT `'AUTHENTICATION_REQUIRED'` as documentation suggested). All token-
 * shape variants (corrupted, malformed, no-auth, plausible-but-invalid) flow
 * through the same code path with identical responses, so this single code
 * covers every "gateway can't resolve the token to an account" case.
 *
 * Future drift: a server-side rename adds another `||` clause here. New codes
 * MUST be empirically captured before being added — see the research note for
 * the capture procedure.
 */
export function isAuthRevokedExtensionCode(code: string | null | undefined): boolean {
  return code === "UNAUTHENTICATED" || code === "AUTHENTICATION_REQUIRED" || code === "UNAUTHORIZED";
}
