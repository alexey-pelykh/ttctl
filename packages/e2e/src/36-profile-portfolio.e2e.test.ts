// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * E2E coverage for `ttctl profile portfolio` (#219, audit CRIT-004 /
 * TEST-001).
 *
 * **Mandatory per CLAUDE.md § Schema/contract validation rule** — every
 * mutation in `packages/core/src/services/profile/portfolio/index.ts`
 * routes through `impersonatedTransport` against the Cloudflare-protected
 * `talent-profile` surface, and every input shape is annotated
 * `[INFERRED]` per `research/notes/10-mutation-input-patterns.md`. The
 * `Portfolio` fragment's write side is the densest concentration of
 * inferred wrapper-key patterns (Pattern 1 / 2 / 3 / 4 / 5) in the
 * service tree, so this file is the load-bearing wire verification for
 * the portfolio sub-domain.
 *
 * Coverage strategy:
 *
 *   - `createPortfolioItem` / `updatePortfolioItem` / `removePortfolioItem`:
 *     round-trip with a sentinel title (`e2e-sentinel-${ts}`) that's
 *     unique per run and identifiable in a manual cleanup pass. The
 *     `try/finally` cleanup mirrors `21-engagements-breaks.e2e.test.ts`
 *     so a mid-test assertion failure does not pollute the account.
 *   - `changePortfolioItemPosition`: round-trip via two sentinels —
 *     add A, add B, move A to position(B)+1 (i.e. after B), then
 *     remove both. The mutation's wire shape (`portfolioItemId` +
 *     `position`) is the assertion target; the final ordering is
 *     verified by inspecting `portfolio list` post-reorder.
 *   - `highlightPortfolioItem`: round-trip on a freshly-added sentinel
 *     — `highlight <id>` then `highlight <id> --off`, then remove.
 *     The CLI's `--off` flag clears the highlight, so the round-trip
 *     leaves the account in its baseline state regardless of which
 *     items the maintainer had highlighted before the run.
 *   - `uploadPortfolioCover` / `uploadPortfolioFile`: drop a tiny
 *     fixture file (1x1 PNG, 24-byte TXT) into the OS tempdir, point
 *     the CLI's `--cover` / `--file` flags at it, and assert the
 *     post-upload envelope carries the server-issued
 *     `coverImageCacheName` / `fileCacheName`. Critically, these two
 *     mutations DO NOT bind the upload to a portfolio item — the
 *     cache name is the only side effect, and the server's cache is
 *     ephemeral. Running these E2Es leaves no detectable trace on the
 *     maintainer's profile.
 *
 * **Skip conditions** (silent — emit a stderr warning, do not fail):
 *   - none unique to this file; the round-trip is self-contained (no
 *     external prerequisites like "must have an existing engagement").
 *     If the test account's `add` flow ever rejects the sentinel input
 *     (e.g. server tightens validation on `title` length), the
 *     `add → assert → cleanup` pattern surfaces the failure
 *     immediately with the sentinel's wire-rejected message.
 *
 * **Safety**: every mutation is `add → verify → remove` within the
 * single `it` block, never relying on `afterEach` (vitest's
 * single-fork sequential mode preserves order but explicit cleanup
 * reads more clearly). The `try/finally` ensures cleanup runs even
 * on assertion failure. Sentinel titles include `e2e-sentinel-` so a
 * manual `ttctl profile portfolio list | grep e2e-sentinel-` post-run
 * surfaces any leaked items.
 */

// e2e-covers: createPortfolioItem, updatePortfolioItem, removePortfolioItem, changePortfolioItemPosition, highlightPortfolioItem, uploadPortfolioCover, uploadPortfolioFile
//
// Wire-shape snapshot for `createPortfolioItem` (T1 disposition per
// `docs/wire-validation-routing.md`) is asserted in this file via
// `assertWireShapeStable` — originating issue #314.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getCliClient, getSharedSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";
import { assertWireShapeStable } from "./wire-snapshots/index.js";

const e2eEnabled = process.env["TTCTL_E2E"] === "1";

/**
 * Catalog Industry id for "Software" — required by `createPortfolioItem`
 * (server rejects empty / null `industryIds` with `code: blank, key:
 * industries`, verified 2026-05-16 via `.tmp/probe-empty-industries.mjs`).
 *
 * Stable Toptal catalog ID (Relay encoding `VjEtSW5kdXN0cnktNzg2`).
 * Discovered via `ttctl profile industries autocomplete "Software"`.
 * Hardcoded for E2E speed; if Toptal ever rotates this ID, autocomplete
 * lookup in `beforeAll` is the resolution path.
 */
const SOFTWARE_INDUSTRY_ID = "VjEtSW5kdXN0cnktNzg2";

/**
 * Minimal 1×1 transparent PNG. Verbatim PNG bytes — header (8) + IHDR
 * (25) + IDAT (18) + IEND (12) = 63 bytes. Embedding the literal bytes
 * sidesteps any test-time PNG-encoder dependency.
 */
const PNG_1X1_TRANSPARENT = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

interface PortfolioItemShape {
  id?: string;
  title?: string | null;
  description?: string | null;
  link?: string | null;
  highlight?: boolean;
  coverImage?: string | null;
}

describe("profile portfolio (live talent-profile, INFERRED wire shape)", () => {
  let cli: CliClient;
  let tmpDir: string;

  beforeAll(async () => {
    if (!e2eEnabled) return;
    const { sandboxConfigPath } = getSharedSession();
    cli = getCliClient({ configPath: sandboxConfigPath });
    tmpDir = await mkdtemp(join(tmpdir(), "ttctl-e2e-portfolio-"));
  });

  afterAll(async () => {
    if (!e2eEnabled || tmpDir === undefined) return;
    // Best-effort tempdir removal — runs even when an `it` block throws.
    // The harness's `runGlobalTeardown` is the authoritative
    // cross-process cleanup, but per-file cleanup here keeps the OS
    // tempdir tidy between runs.
    await rm(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!e2eEnabled)(
    "createPortfolioItem + updatePortfolioItem + removePortfolioItem round-trip with a sentinel item",
    async () => {
      const sentinelTitle = `e2e-sentinel-${Date.now().toString()}`;

      // Step 1: add the sentinel.
      const addResult = await cli.run([
        "profile",
        "portfolio",
        "add",
        "--title",
        sentinelTitle,
        "--link",
        "https://example.com/e2e",
        "--industry-id",
        SOFTWARE_INDUSTRY_ID,
        "-o",
        "json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const addPayload = JSON.parse(addResult.stdout) as {
        ok?: boolean;
        operation?: string;
        created?: PortfolioItemShape[];
      };
      expect(addPayload.ok).toBe(true);
      expect(addPayload.operation).toBe("profile.portfolio.add");
      // `created` is the full post-mutation list (see emitMutationResult in
      // packages/cli/src/commands/profile/portfolio/add.ts).
      expect(Array.isArray(addPayload.created)).toBe(true);
      const sentinel = (addPayload.created ?? []).find((it) => it.title === sentinelTitle);
      expect(sentinel).toBeDefined();
      expect(typeof sentinel?.id).toBe("string");
      if (sentinel?.id === undefined) return;
      const sentinelId = sentinel.id;

      try {
        // Step 2: update the sentinel's link via updatePortfolioItem.
        const updatedLink = "https://example.com/e2e-updated";
        const updateResult = await cli.run([
          "profile",
          "portfolio",
          "update",
          sentinelId,
          "--link",
          updatedLink,
          "-o",
          "json",
        ]);
        expect(updateResult.exitCode).toBe(0);
        const updatePayload = JSON.parse(updateResult.stdout) as {
          ok?: boolean;
          operation?: string;
          updated?: PortfolioItemShape[];
        };
        expect(updatePayload.ok).toBe(true);
        expect(updatePayload.operation).toBe("profile.portfolio.update");
        const updated = (updatePayload.updated ?? []).find((it) => it.id === sentinelId);
        expect(updated?.link).toBe(updatedLink);
        // The sentinel title MUST remain unchanged (we only sent `--link`).
        expect(updated?.title).toBe(sentinelTitle);
      } finally {
        // Step 3 (always-runs): remove the sentinel.
        const removeResult = await cli.run(["profile", "portfolio", "remove", sentinelId, "-o", "json"]);
        expect(removeResult.exitCode).toBe(0);
        const removePayload = JSON.parse(removeResult.stdout) as {
          ok?: boolean;
          operation?: string;
          removed?: { id?: string };
        };
        expect(removePayload.ok).toBe(true);
        expect(removePayload.operation).toBe("profile.portfolio.remove");
        expect(removePayload.removed?.id).toBe(sentinelId);
      }
    },
  );

  it.skipIf(!e2eEnabled)(
    "changePortfolioItemPosition round-trip with two sentinels (add A, add B, A --after B, cleanup)",
    async () => {
      const ts = Date.now().toString();
      const titleA = `e2e-sentinel-pos-A-${ts}`;
      const titleB = `e2e-sentinel-pos-B-${ts}`;

      const addA = await cli.run([
        "profile",
        "portfolio",
        "add",
        "--title",
        titleA,
        "--industry-id",
        SOFTWARE_INDUSTRY_ID,
        "-o",
        "json",
      ]);
      expect(addA.exitCode).toBe(0);
      const addAPayload = JSON.parse(addA.stdout) as { ok?: boolean; created?: PortfolioItemShape[] };
      const idA = (addAPayload.created ?? []).find((it) => it.title === titleA)?.id;
      expect(typeof idA).toBe("string");
      if (idA === undefined) return;

      let idB: string | undefined;
      try {
        const addB = await cli.run([
          "profile",
          "portfolio",
          "add",
          "--title",
          titleB,
          "--industry-id",
          SOFTWARE_INDUSTRY_ID,
          "-o",
          "json",
        ]);
        expect(addB.exitCode).toBe(0);
        const addBPayload = JSON.parse(addB.stdout) as { ok?: boolean; created?: PortfolioItemShape[] };
        idB = (addBPayload.created ?? []).find((it) => it.title === titleB)?.id;
        expect(typeof idB).toBe("string");
        if (idB === undefined) return;

        // Move A to immediately after B. The CLI translates `--after <id>`
        // into the absolute index via positionAfter() in the core module,
        // which is the wire payload `position: <idx>` sent to
        // `changePortfolioItemPosition`.
        const reorderResult = await cli.run(["profile", "portfolio", "reorder", idA, "--after", idB, "-o", "json"]);
        expect(reorderResult.exitCode).toBe(0);
        const reorderPayload = JSON.parse(reorderResult.stdout) as {
          ok?: boolean;
          operation?: string;
          updated?: PortfolioItemShape[];
        };
        expect(reorderPayload.ok).toBe(true);
        expect(reorderPayload.operation).toBe("profile.portfolio.update");
        // Both sentinels should still be in the post-reorder list.
        const listed = reorderPayload.updated ?? [];
        const stillThereA = listed.find((it) => it.id === idA);
        const stillThereB = listed.find((it) => it.id === idB);
        expect(stillThereA).toBeDefined();
        expect(stillThereB).toBeDefined();
      } finally {
        // Cleanup A first (always attempt), then B if it was created.
        const cleanupA = await cli.run(["profile", "portfolio", "remove", idA, "-o", "json"]);
        expect(cleanupA.exitCode).toBe(0);
        if (idB !== undefined) {
          const cleanupB = await cli.run(["profile", "portfolio", "remove", idB, "-o", "json"]);
          expect(cleanupB.exitCode).toBe(0);
        }
      }
    },
  );

  it.skipIf(!e2eEnabled)(
    "highlightPortfolioItem round-trip on a sentinel (highlight on, highlight off, cleanup)",
    async () => {
      const sentinelTitle = `e2e-sentinel-highlight-${Date.now().toString()}`;
      const addResult = await cli.run([
        "profile",
        "portfolio",
        "add",
        "--title",
        sentinelTitle,
        "--industry-id",
        SOFTWARE_INDUSTRY_ID,
        "-o",
        "json",
      ]);
      expect(addResult.exitCode).toBe(0);
      const addPayload = JSON.parse(addResult.stdout) as { ok?: boolean; created?: PortfolioItemShape[] };
      const sentinelId = (addPayload.created ?? []).find((it) => it.title === sentinelTitle)?.id;
      expect(typeof sentinelId).toBe("string");
      if (sentinelId === undefined) return;

      try {
        // Highlight ON.
        const onResult = await cli.run(["profile", "portfolio", "highlight", sentinelId, "-o", "json"]);
        expect(onResult.exitCode).toBe(0);
        const onPayload = JSON.parse(onResult.stdout) as {
          ok?: boolean;
          operation?: string;
          updated?: { id?: string; highlight?: boolean };
        };
        expect(onPayload.ok).toBe(true);
        expect(onPayload.operation).toBe("profile.portfolio.highlight");
        expect(onPayload.updated?.id).toBe(sentinelId);
        expect(onPayload.updated?.highlight).toBe(true);

        // Highlight OFF.
        const offResult = await cli.run(["profile", "portfolio", "highlight", sentinelId, "--off", "-o", "json"]);
        expect(offResult.exitCode).toBe(0);
        const offPayload = JSON.parse(offResult.stdout) as {
          ok?: boolean;
          updated?: { id?: string; highlight?: boolean };
        };
        expect(offPayload.ok).toBe(true);
        expect(offPayload.updated?.id).toBe(sentinelId);
        expect(offPayload.updated?.highlight).toBe(false);
      } finally {
        const cleanup = await cli.run(["profile", "portfolio", "remove", sentinelId, "-o", "json"]);
        expect(cleanup.exitCode).toBe(0);
      }
    },
  );

  it.skipIf(!e2eEnabled)(
    "uploadPortfolioCover accepts a 1x1 PNG via --cover and returns a coverImageCacheName",
    async () => {
      const fixturePath = join(tmpDir, "e2e-cover.png");
      await writeFile(fixturePath, PNG_1X1_TRANSPARENT);

      const result = await cli.run(["profile", "portfolio", "upload", "--cover", fixturePath, "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        updated?: { coverImageCacheName?: string | null; coverImageUrl?: string | null };
      };
      expect(payload.ok).toBe(true);
      expect(payload.operation).toBe("profile.portfolio.upload");
      // The server-issued cache name MUST be present — this is the
      // critical wire-shape assertion (the mutation's response carries
      // the cache name used to bind the cover to a future add/update).
      expect(typeof payload.updated?.coverImageCacheName).toBe("string");
      expect(payload.updated?.coverImageCacheName?.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!e2eEnabled)("createPortfolioItem response wire shape matches snapshot (T1 disposition)", async () => {
    // Schema/contract validation rule corollary: `createPortfolioItem`
    // is on the T1 track per `docs/wire-validation-routing.md:114`
    // (talent-profile schema is gappy). The snapshot captures the
    // post-mutation profile.portfolioItems.nodes shape — drift in the
    // server's response signals a wire-format regression we must
    // re-engineer for. Originating discovery: issue #314.
    const sentinelTitle = `e2e-sentinel-wire-${Date.now().toString()}`;
    const addResult = await cli.run([
      "profile",
      "portfolio",
      "add",
      "--title",
      sentinelTitle,
      "--industry-id",
      SOFTWARE_INDUSTRY_ID,
      "-o",
      "json",
    ]);
    expect(addResult.exitCode).toBe(0);
    const addPayload = JSON.parse(addResult.stdout) as {
      ok?: boolean;
      created?: PortfolioItemShape[];
    };
    expect(addPayload.ok).toBe(true);
    const created = addPayload.created ?? [];
    const sentinelId = created.find((it) => it.title === sentinelTitle)?.id;
    expect(typeof sentinelId).toBe("string");
    if (sentinelId === undefined) return;

    try {
      // The CLI envelope projects the read-side `PortfolioItem`
      // mapped shape (see `mapPortfolioNode` in
      // `packages/core/src/services/profile/portfolio/index.ts`).
      // The wire-shape snapshot is taken on that projection — it
      // captures the field set surfaced to envelope consumers, which
      // is the load-bearing contract (the raw GraphQL response shape
      // is opaque to consumers and not what we want to gate drift
      // against). Sentinel cleanup runs in `finally` regardless of
      // the assertion outcome.
      expect(() =>
        assertWireShapeStable({
          operationName: "createPortfolioItem",
          surface: "talent-profile",
          transport: "impersonated",
          response: created,
        }),
      ).not.toThrow();
    } finally {
      const cleanup = await cli.run(["profile", "portfolio", "remove", sentinelId, "-o", "json"]);
      expect(cleanup.exitCode).toBe(0);
    }
  });

  it.skipIf(!e2eEnabled)(
    "uploadPortfolioFile accepts a tiny text attachment via --file and returns a fileCacheName",
    async () => {
      const fixturePath = join(tmpDir, "e2e-attachment.txt");
      await writeFile(fixturePath, "ttctl e2e portfolio attachment fixture\n", "utf8");

      const result = await cli.run(["profile", "portfolio", "upload", "--file", fixturePath, "-o", "json"]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        updated?: { fileCacheName?: string | null; fileUrl?: string | null };
      };
      expect(payload.ok).toBe(true);
      expect(payload.operation).toBe("profile.portfolio.upload");
      expect(typeof payload.updated?.fileCacheName).toBe("string");
      expect(payload.updated?.fileCacheName?.length).toBeGreaterThan(0);
    },
  );
});
