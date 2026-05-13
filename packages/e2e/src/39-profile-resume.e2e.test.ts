// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile resume` (#219, audit CRIT-004 /
 * TEST-001).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * resume sub-domain has two operations, both against
 * Cloudflare-protected `talent-profile` and both `[INFERRED]` per
 * `research/notes/10-mutation-input-patterns.md`.
 *
 * Coverage strategy:
 *
 *   - **`cancelResumeUpload`**: round-trip-safe by design — the service
 *     module documents it as **idempotent** (`resume/index.ts:218-223`).
 *     The server returns `success: true` even when no upload is in
 *     flight, which is the canonical no-op signal. The test calls
 *     `cancel-upload` against a quiescent state and asserts the
 *     post-call envelope.
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
 * **Skip conditions**: none. `cancelResumeUpload`'s idempotency
 * guarantees the test runs cleanly regardless of test account state.
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

  it.skipIf(!e2eEnabled)("cancelResumeUpload is idempotent — returns success against a quiescent state", async () => {
    const result = await cli.run(["profile", "resume", "cancel-upload", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok?: boolean;
      operation?: string;
      updated?: { success?: boolean };
    };
    expect(payload.ok).toBe(true);
    expect(payload.operation).toBe("profile.resume.cancel-upload");
    // The mutation's documented contract (resume/index.ts:218-223):
    // success is `true` even when no upload is in flight. A `false`
    // value here would mean the server's idempotency contract has
    // changed and the service module's narration is stale.
    expect(payload.updated?.success).toBe(true);
  });
});
