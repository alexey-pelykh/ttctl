// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { DryRunPreview } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import {
  buildAddEnvelope,
  buildDryRunEnvelope,
  buildErrorEnvelope,
  buildRemoveEnvelope,
  buildUpdateEnvelope,
  wrapListEnvelope,
} from "../envelopes.js";

/**
 * JSON-shape snapshot tests for the envelope ABI (#152).
 *
 * These tests pin the FULL JSON byte stream of every envelope shape
 * documented in `lib/envelopes.ts`. The envelope is the public-API
 * contract committed to stability post-v1.0; pre-1.0 (0.x), snapshot
 * updates are free per semver but the diff IS the change-review surface.
 *
 * Each test stringifies the envelope object via `JSON.stringify(env)`
 * (matching `formatXxxJson` and `emitXxxSuccess` JSON branches verbatim
 * — single-line, no extra whitespace) and snapshots the resulting
 * string. Any change to the envelope shape — added field, renamed
 * field, reordered field, type change — fails the corresponding
 * snapshot, forcing the contributor to either:
 *
 * 1. Revert the unintended change, OR
 * 2. Update the snapshot intentionally with `pnpm test -u` and review
 *    the diff (signaling a deliberate envelope evolution; post-1.0
 *    triggers semver-major).
 *
 * The fixture data is hand-crafted in this file (not imported from
 * `@ttctl/core` fixtures) because the envelope payload is intentionally
 * minimal — a representative entity per shape is enough to lock the
 * envelope wrapper itself. Sub-domain list envelopes (where the payload
 * variability matters) are pinned separately in the per-sub-domain
 * snapshot tests under `commands/profile/`.
 *
 * The fixture entity shape `{id, name, rating}` is deliberately a small
 * superset of fields covering string / nullable-number / nullable-string
 * so the snapshots exercise null-handling without coupling to a real
 * sub-domain type. Production sub-domain types are pinned in
 * `commands/profile/__tests__/list-envelope-snapshots.test.ts`.
 */

interface SkillEntity {
  id: string;
  name: string;
  rating: "EXPERT" | "STRONG" | "COMPETENT" | null;
}

const SKILL_FULL: SkillEntity = { id: "sk_abc123", name: "TypeScript", rating: "EXPERT" };
const SKILL_PARTIAL: SkillEntity = { id: "sk_def456", name: "Python", rating: null };

// =======================================================================
// Success envelopes: add / update / remove
// =======================================================================

describe("envelope JSON snapshots — success", () => {
  it("add envelope: full entity", () => {
    const env = buildAddEnvelope({ operation: "profile.skills.add", created: SKILL_FULL });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("add envelope: full entity with notice", () => {
    const env = buildAddEnvelope({
      operation: "profile.skills.add",
      created: SKILL_FULL,
      notice: "Auto-promoted to public after rating set.",
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("update envelope: full entity", () => {
    const env = buildUpdateEnvelope({ operation: "profile.skills.update", updated: SKILL_FULL });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("update envelope: full entity with changes diff", () => {
    const env = buildUpdateEnvelope({
      operation: "profile.skills.update",
      updated: SKILL_FULL,
      changes: [
        { field: "rating", from: "STRONG", to: "EXPERT" },
        { field: "experience", from: 48, to: 60 },
      ],
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("update envelope: nullable field set to null", () => {
    const env = buildUpdateEnvelope({ operation: "profile.skills.update", updated: SKILL_PARTIAL });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("remove envelope: id only", () => {
    const env = buildRemoveEnvelope({ operation: "profile.skills.remove", id: "sk_abc123" });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("remove envelope: id with notice", () => {
    const env = buildRemoveEnvelope({
      operation: "profile.skills.remove",
      id: "sk_abc123",
      notice: "Sibling industries removed due to dependency.",
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});

// =======================================================================
// Error envelope
// =======================================================================

describe("envelope JSON snapshots — error", () => {
  it("error envelope: single error with code + message", () => {
    const env = buildErrorEnvelope({
      operation: "profile.skills.add",
      errors: [{ code: "VALIDATION_ERROR", message: "Rating must be one of EXPERT|STRONG|COMPETENT." }],
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("error envelope: single error with all optional fields", () => {
    const env = buildErrorEnvelope({
      operation: "profile.skills.update",
      errors: [
        {
          code: "VALIDATION_ERROR",
          field: "experience",
          message: "Experience must be a non-negative integer.",
          hint: "Pass months as an integer (e.g., 60) or shorthand (e.g., 5y).",
        },
      ],
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("error envelope: multiple errors (plural array shape)", () => {
    const env = buildErrorEnvelope({
      operation: "profile.skills.add",
      errors: [
        { code: "VALIDATION_ERROR", field: "rating", message: "Rating is required." },
        { code: "VALIDATION_ERROR", field: "skill", message: "Skill id not found in catalog." },
      ],
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("error envelope: auth-revoked", () => {
    const env = buildErrorEnvelope({
      operation: "profile.skills.list",
      errors: [
        {
          code: "AUTH_REVOKED",
          message: "Session token has been revoked.",
          hint: "Run `ttctl auth signin` to re-authenticate.",
        },
      ],
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("error envelope: Cloudflare 403 (transport-level)", () => {
    const env = buildErrorEnvelope({
      operation: "profile.basic.set",
      errors: [
        {
          code: "CF_403_PERSISTENT",
          message: "Cloudflare blocked the request to talent-profile/graphql despite Chrome TLS impersonation.",
          hint: "File an issue at https://github.com/alexey-pelykh/ttctl/issues with the surface name and timestamp.",
        },
      ],
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});

// =======================================================================
// Dry-run envelope (#52, #165)
// =======================================================================

describe("envelope JSON snapshots — dry-run", () => {
  const PREVIEW_TALENT_PROFILE: DryRunPreview = {
    operationName: "updateBasicInfo",
    surface: "talent-profile",
    transport: "impersonated",
    endpoint: "https://www.toptal.com/api/talent_profile/graphql",
    variables: {
      profileId: "<resolved-at-apply-time>",
      bio: "Senior backend engineer with 8 years of TypeScript + PostgreSQL experience.",
    },
    headers: {
      authorization: "Token token=<redacted>",
      "content-type": "application/json",
      "user-agent": "Chrome/146",
    },
  };

  const PREVIEW_MOBILE_GATEWAY: DryRunPreview = {
    operationName: "getSkillSetsWithConnectionsWithConnectionsCount",
    surface: "mobile-gateway",
    transport: "stock",
    endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
    variables: { profileId: "<resolved-at-apply-time>" },
    headers: {
      authorization: "Token token=<redacted>",
      "content-type": "application/json",
    },
  };

  it("dry-run envelope: talent-profile impersonated transport", () => {
    const env = buildDryRunEnvelope({
      operation: "profile.basic.set",
      preview: PREVIEW_TALENT_PROFILE,
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("dry-run envelope: mobile-gateway stock transport", () => {
    const env = buildDryRunEnvelope({
      operation: "profile.skills.list",
      preview: PREVIEW_MOBILE_GATEWAY,
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("dry-run envelope: with notice", () => {
    const env = buildDryRunEnvelope({
      operation: "profile.basic.set",
      preview: PREVIEW_TALENT_PROFILE,
      notice: "Apply path would also clear cached basicInfo.",
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});

// =======================================================================
// List envelope (#128, #138)
// =======================================================================

describe("envelope JSON snapshots — list", () => {
  it("list envelope: empty items", () => {
    const env = wrapListEnvelope([] as SkillEntity[]);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: single item", () => {
    const env = wrapListEnvelope([SKILL_FULL]);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: multiple items, no pageInfo", () => {
    const env = wrapListEnvelope([SKILL_FULL, SKILL_PARTIAL]);
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: with pageInfo (currentPage + perPage + totalPages + hasNextPage)", () => {
    const env = wrapListEnvelope([SKILL_FULL], {
      currentPage: 1,
      perPage: 25,
      totalPages: 4,
      hasNextPage: true,
    });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });

  it("list envelope: with partial pageInfo (hasNextPage only — cursor-style backend)", () => {
    const env = wrapListEnvelope([SKILL_FULL], { hasNextPage: false });
    expect(JSON.stringify(env)).toMatchSnapshot();
  });
});
