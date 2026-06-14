// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `me` service module — viewer-scoped reads that don't belong to a
 * profile-content or engagement domain.
 *
 * | Leaf            | Operation             |
 * |-----------------|-----------------------|
 * | `actions.list`  | `GetPerformedActions` |
 *
 * **`actions.list`** surfaces the per-role audit log at
 * `viewer.viewerRole.performedActions` — status changes, applications
 * submitted, and similar viewer actions. Routing is the **mobile-gateway**
 * surface (`callGatewayShared("mobile-gateway", …)`, stock transport),
 * the same backend as `engagements` / `timesheet`.
 *
 * **Pagination** follows ADR-007 (ttctl) row 5 — bare bidirectional
 * cursor: the wire takes `before` / `after` (opaque `String` cursors)
 * and `limit` (`Int`) as direct args, with no `pagination: {…}` wrapper.
 * The return is a bare list (no Connection wrapper, no `totalCount`).
 *
 * **Schema/contract validation rule**: `performedActions` and its
 * `PerformedAction` shape are absent from the synthesized gateway SDL
 * (`ViewerRole.roleId` exists; `performedActions` does not), so
 * `GetPerformedActions` is in `GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS` in
 * `codegen.config.ts` and carries no typed bindings — the projection
 * here is INFERRED. Live wire validation via
 * `packages/e2e/src/92-me-actions-list.e2e.test.ts` (T1 wire snapshot)
 * is mandatory pre-merge.
 */

import { callGatewayShared } from "../_shared/transport.js";

// ---------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------

/**
 * `me`-domain error codes. The union is exactly the shared-transport
 * code set (`callGatewayShared`'s `SharedTransportErrorCode`) — a pure
 * list read has no domain-specific failure mode beyond `NO_VIEWER`.
 * Auth-revoked failures throw `AuthRevokedError` (cross-cutting), not a
 * code on this enum.
 */
export type MeErrorCode = "NO_VIEWER" | "GRAPHQL_ERROR" | "NETWORK_ERROR" | "WIRE_SHAPE_ERROR" | "UNKNOWN";

export class MeError extends Error {
  override readonly name = "MeError";
  constructor(
    public readonly code: MeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/** One `name` / `text` substitution inside a {@link PerformedActionDescription}. */
export interface PerformedActionVariable {
  name: string | null;
  text: string | null;
}

/**
 * Templated, human-readable description of a performed action. `template`
 * carries placeholder tokens; `variables` carries their substitutions.
 */
export interface PerformedActionDescription {
  template: string | null;
  variables: PerformedActionVariable[];
}

/**
 * One audit-log entry — a single action the viewer performed (a status
 * change, an application submitted, etc.). Every field beyond `id` is
 * surfaced nullable: the shape is INFERRED (absent from the SDL) and
 * coalesced defensively until the gated E2E pins it.
 */
export interface PerformedAction {
  id: string;
  category: string | null;
  description: PerformedActionDescription | null;
  occurredAt: string | null;
}

/**
 * Pagination args for {@link list} — ADR-007 row 5 (bare bidirectional
 * cursor). `before` / `after` are opaque cursor tokens echoed from a
 * prior page; `limit` caps the page size. All optional; omitting all
 * three returns the server's default first page.
 */
export interface ListOptions {
  before?: string;
  after?: string;
  limit?: number;
}

// ---------------------------------------------------------------------
// Wire op + response shape (INFERRED — see module docstring)
// ---------------------------------------------------------------------

/**
 * `GetPerformedActions` — transcribed faithfully from the captured
 * document at `../research/graphql/gateway/operations/portal/GetPerformedActions.graphql`.
 * The wire args are direct (no wrapper) per ADR-007 row 5.
 */
const GET_PERFORMED_ACTIONS_QUERY = `query GetPerformedActions($before: String, $after: String, $limit: Int) {
  viewer {
    id
    viewerRole {
      roleId
      performedActions(before: $before, after: $after, limit: $limit) {
        id
        category
        description {
          template
          variables {
            name
            text
          }
        }
        occurredAt
      }
    }
  }
}`;

interface PerformedActionsResponse {
  viewer: {
    id: string;
    viewerRole: {
      roleId: number;
      performedActions: WirePerformedAction[] | null;
    } | null;
  } | null;
}

interface WirePerformedAction {
  id: string;
  category: string | null;
  description: {
    template: string | null;
    variables: (WirePerformedActionVariable | null)[] | null;
  } | null;
  occurredAt: string | null;
}

interface WirePerformedActionVariable {
  name: string | null;
  text: string | null;
}

/** Project a wire entry into the public {@link PerformedAction}, coalescing every nullable hop. */
function projectAction(wire: WirePerformedAction): PerformedAction {
  return {
    id: wire.id,
    category: wire.category ?? null,
    description:
      wire.description == null
        ? null
        : {
            template: wire.description.template ?? null,
            variables: (wire.description.variables ?? [])
              .filter((v): v is WirePerformedActionVariable => v != null)
              .map((v) => ({ name: v.name ?? null, text: v.text ?? null })),
          },
    occurredAt: wire.occurredAt ?? null,
  };
}

// ---------------------------------------------------------------------
// Public API — `me.actions.*`
// ---------------------------------------------------------------------

/**
 * The `me.actions` sub-domain (mirrors the `payments.payouts` /
 * `engagements.breaks` nested-namespace shape). Holds the viewer
 * audit-log reads; CLI `ttctl me actions list` / MCP
 * `ttctl_me_actions_list` invoke `me.actions.list`.
 */
export const actions = {
  /**
   * List the viewer's performed actions (audit log), in the order the
   * wire returns them. An empty list is a legitimate return value.
   *
   * Throws `MeError("NO_VIEWER")` when the session is valid but no
   * viewer is bound to it. A null `viewerRole` or `performedActions` is
   * treated as an empty result rather than an error (defensive — the
   * SDL declares neither, so absence is not a failure signal).
   */
  async list(token: string, opts: ListOptions = {}): Promise<PerformedAction[]> {
    const variables: Record<string, unknown> = {
      before: opts.before ?? null,
      after: opts.after ?? null,
      limit: opts.limit ?? null,
    };
    const data = await callGatewayShared<PerformedActionsResponse, MeError>(
      "mobile-gateway",
      token,
      "GetPerformedActions",
      GET_PERFORMED_ACTIONS_QUERY,
      variables,
      MeError,
    );
    if (data.viewer === null) {
      throw new MeError("NO_VIEWER", "Session is valid but no viewer is bound to it.");
    }
    const role = data.viewer.viewerRole;
    if (role === null) return [];
    return (role.performedActions ?? []).map(projectAction);
  },
};
