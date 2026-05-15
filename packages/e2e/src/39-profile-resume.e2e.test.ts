// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile resume` (#219, audit CRIT-004 /
 * TEST-001; wire-shape correction #318).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * resume sub-domain has two operations, both against
 * Cloudflare-protected `talent-profile` and both `[INFERRED]` per
 * `research/notes/10-mutation-input-patterns.md`.
 *
 * Coverage strategy:
 *
 *   - **`cancelResumeUpload`**: tests the WIRE-SHAPE CONTRACT only.
 *     Per #318, the input requires `profileId: ID!` (the synthesized
 *     SDL marks the input as Pattern 7 — `_placeholder` only — but
 *     the live server rejects empty input with a GRAPHQL_ERROR
 *     "Variable $input ... profileId (Expected value to not be null)").
 *     The fix adds `profileId` via `resolveProfileId(token)` mirroring
 *     the sibling sub-domains.
 *
 *     The original speculation (PR #75 / PR #247) that the mutation
 *     is idempotent against a quiescent state — that the server
 *     returns `success: true` when no upload is in flight — is
 *     **empirically false** (#318 discovery, 2026-05-15). Against a
 *     quiescent state the server returns a deterministic
 *     `USER_ERROR` envelope (`key: "base"`, message: "Something went
 *     wrong. Please try again later."). The CLI surfaces this as
 *     exit 1 with the documented v1.0 error envelope.
 *
 *     The test therefore asserts:
 *       (a) The mutation's wire format is accepted by the server's
 *           GraphQL schema (no `GRAPHQL_ERROR` for missing `profileId`
 *           — the #318 regression that would re-fire if the fix
 *           regressed).
 *       (b) The server processes the input through to its
 *           application-level error layer (returns the `USER_ERROR`
 *           envelope shape).
 *
 *     Exercising the `success: true` path requires an in-flight
 *     upload, which is blocked by the `uploadResume` exemption (see
 *     below). Future work: if a non-destructive upload-state setup
 *     becomes available, extend this test to cover the success path.
 *
 * **Exempted at source** (`packages/core/src/services/profile/resume/index.ts`):
 *   - `uploadResume`: destructive — overwrites the maintainer's
 *     published resume file with no safe rollback path. The
 *     `cancelResumeUpload` semantic only clears half-uploaded
 *     server-side state; if the upload commits before cancel arrives,
 *     the file is replaced. The `impersonatedMultipartTransport` wire
 *     path is exercised in `36-profile-portfolio.e2e.test.ts` via
 *     `uploadPortfolioCover` / `uploadPortfolioFile`, so the
 *     multipart-spec contract has live coverage transitively. The
 *     JSON mutation wire shape for the resume sub-domain is verified
 *     here via `cancelResumeUpload`.
 *
 * **Skip conditions**: none. The wire-shape contract is verifiable
 * regardless of test account state.
 */

// e2e-covers: cancelResumeUpload

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

describe("profile resume (live talent-profile, INFERRED wire shape)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)(
    "cancelResumeUpload accepts a profileId-bearing input and the server reaches the application error layer (#318)",
    async () => {
      const result = await cli.run(["profile", "resume", "cancel-upload", "-o", "json"]);
      // Against a quiescent state (no in-flight upload), the live
      // server returns USER_ERROR (key: "base"). The CLI surfaces
      // this as exit 1 with the documented v1.0 error envelope.
      // The success path requires an in-flight upload — blocked by
      // the uploadResume exemption (see file header).
      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        errors?: { code?: string; message?: string }[];
      };
      expect(payload.ok).toBe(false);
      // First error MUST be USER_ERROR — NOT GRAPHQL_ERROR. A
      // GRAPHQL_ERROR here would mean the server's schema rejected
      // the input shape (the pre-#318 regression: missing profileId
      // triggered "Variable $input ... profileId (Expected value to
      // not be null)"). USER_ERROR proves the wire format passes
      // schema validation and the mutation reaches the server's
      // application-level error path.
      expect(payload.errors?.[0]?.code).toBe("USER_ERROR");
      expect(payload.errors?.[0]?.message).toMatch(/cancelResumeUpload rejected/);
    },
  );
});
