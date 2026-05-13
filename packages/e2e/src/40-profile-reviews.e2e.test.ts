// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile reviews` (#219, audit CRIT-004 /
 * TEST-001).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — the
 * reviews sub-domain has 4 operations against Cloudflare-protected
 * `talent-profile`. The read-side query (`sectionReviews`) is covered
 * here; the three mutations are exempt at source — see below.
 *
 * Coverage strategy:
 *
 *   - **`sectionReviews`** (pure read): list pending section reviews
 *     for the signed-in user. Asserts the v0.4 list envelope shape
 *     (`{version, items}`) and, when items are present, that each row
 *     carries the documented `{id, section, requestedAt, items[]}`
 *     projection. Empty list is the common case on a clean profile
 *     and is a valid passing condition — the envelope shape is
 *     verified regardless of cardinality.
 *
 * **Exempted at source** (`packages/core/src/services/profile/reviews/index.ts`):
 *
 *   - `ApproveItemReview`, `ApproveSectionReview`: approval is final
 *     per the platform's review semantics — once approved, the change
 *     is published and cannot be reverted from this surface. There is
 *     no safe round-trip on a live maintainer profile, and a fake-id
 *     wire probe (sending a sentinel `reviewId`) was explicitly
 *     declined for the reviews sub-domain.
 *   - `submitForReview`: triggers an actual platform-side re-review
 *     against the maintainer's profile when called against a
 *     submittable state. No safe reverse-trip. Wire shape is
 *     inferred from `research/notes/10` Pattern 2; covered by
 *     run-time monitoring if invoked.
 *
 * **Skip conditions**: none. The list envelope assertions hold
 * regardless of whether pending reviews exist on the test account.
 */

// e2e-covers: sectionReviews

import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

interface ReviewItemShape {
  id?: string;
  itemId?: string;
  requestedAt?: string | null;
}

interface SectionReviewShape {
  id?: string;
  section?: string | null;
  requestedAt?: string | null;
  items?: ReviewItemShape[];
}

describe("profile reviews (live talent-profile, INFERRED wire shape)", () => {
  let cli: CliClient;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
  });

  it.skipIf(!e2eEnabled)("sectionReviews returns the v1.0 list envelope (empty or populated)", async () => {
    const result = await cli.run(["profile", "reviews", "list", "-o", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { version?: string; items?: SectionReviewShape[] };
    expect(typeof payload).toBe("object");
    expect(payload.version).toBeDefined();
    expect(Array.isArray(payload.items)).toBe(true);

    // If reviews are pending, each row must carry the documented
    // projection. This is the wire-shape assertion: the response's
    // `sectionReviews` top-level field collected the rows with the
    // expected keys.
    if (Array.isArray(payload.items) && payload.items.length > 0) {
      for (const row of payload.items) {
        expect(typeof row.id).toBe("string");
        expect(row.id?.length).toBeGreaterThan(0);
        // `section` and `requestedAt` may be null per the service's
        // defensive narrowing.
        expect("section" in row).toBe(true);
        expect("requestedAt" in row).toBe(true);
        expect(Array.isArray(row.items)).toBe(true);
        for (const item of row.items ?? []) {
          expect(typeof item.id).toBe("string");
          expect(typeof item.itemId).toBe("string");
          expect("requestedAt" in item).toBe(true);
        }
      }
    } else {
      process.stderr.write(
        "info: no pending section reviews on test account — envelope shape verified, per-row projection assertions skipped\n",
      );
    }
  });
});
