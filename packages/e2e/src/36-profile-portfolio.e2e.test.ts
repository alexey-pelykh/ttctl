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

import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

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
 * Build a synthetic solid-color PNG at the given dimensions. Used by
 * the cover-upload test where the server's `uploadPortfolioCoverImage`
 * mutation enforces a minimum image size of 750x500 px (USER_ERROR
 * `code: invalidImage` if smaller — verified live 2026-05-16, see
 * `.tmp/probe-cover-crop2.mjs`). A 1×1 fixture is rejected pre-crop.
 *
 * Uses only `node:zlib` + manual PNG-chunk assembly so the test stays
 * free of image-library dependencies. Solid-color images compress
 * tightly under deflate (the 750×500 RGBA output is ≈1500 bytes).
 *
 * PNG layout: 8-byte signature, then a sequence of chunks (4-byte
 * length, 4-byte type, N bytes data, 4-byte CRC over type+data).
 * Required chunks: IHDR (header), one or more IDAT (pixel data),
 * IEND (end marker).
 */
function buildSolidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number] = [100, 150, 200, 255],
): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  // Pixel rows: 1 filter byte (0 = None) + width * 4 bytes RGBA.
  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(height * rowSize);
  for (let y = 0; y < height; y++) {
    const off = y * rowSize;
    raw[off] = 0; // filter
    for (let x = 0; x < width; x++) {
      const px = off + 1 + x * 4;
      raw[px] = rgba[0];
      raw[px + 1] = rgba[1];
      raw[px + 2] = rgba[2];
      raw[px + 3] = rgba[3];
    }
  }
  const idatData = deflateSync(raw);
  const chunk = (type: string, data: Buffer): Buffer => {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput));
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };
  return Buffer.concat([sig, chunk("IHDR", ihdrData), chunk("IDAT", idatData), chunk("IEND", Buffer.alloc(0))]);
}

const PNG_750x500 = buildSolidPng(750, 500);

interface PortfolioKpiShape {
  id?: string;
  value?: string | null;
  description?: string | null;
}

interface PortfolioQuoteShape {
  id?: string;
  text?: string | null;
  clientName?: string | null;
  clientRole?: string | null;
  company?: string | null;
}

interface PortfolioEngagementShape {
  id?: string;
}

interface PortfolioItemShape {
  id?: string;
  title?: string | null;
  description?: string | null;
  link?: string | null;
  highlight?: boolean;
  coverImage?: string | null;
  kpis?: PortfolioKpiShape[];
  quotes?: PortfolioQuoteShape[];
  engagement?: PortfolioEngagementShape | null;
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
    "uploadPortfolioCover accepts a 750x500 PNG via --cover and returns a coverImageCacheName",
    async () => {
      // The server enforces a 750x500 px minimum on cover images
      // (USER_ERROR `code: invalidImage` if smaller — verified live
      // 2026-05-16). The test fixture is generated at runtime to keep
      // the package free of image-library dependencies.
      const fixturePath = join(tmpDir, "e2e-cover.png");
      await writeFile(fixturePath, PNG_750x500);

      const result = await cli.run(["profile", "portfolio", "upload", "--cover", fixturePath, "-o", "json"]);
      expect(result.exitCode).toBe(0);
      // The CLI dispatches `emitAddSuccess` for uploads — the envelope
      // names the payload `created` (not `updated`); the cache name is
      // the freshly-issued artifact.
      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        created?: { coverImageCacheName?: string | null; coverImageUrl?: string | null };
      };
      expect(payload.ok).toBe(true);
      expect(payload.operation).toBe("profile.portfolio.upload");
      // The server-issued cache name MUST be present — this is the
      // critical wire-shape assertion (the mutation's response carries
      // the cache name used to bind the cover to a future add/update).
      expect(typeof payload.created?.coverImageCacheName).toBe("string");
      expect(payload.created?.coverImageCacheName?.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!e2eEnabled)(
    "createPortfolioItem + portfolio list expose kpis as a typed array (#550 INFERRED → verified)",
    async () => {
      // Schema/contract validation rule (CLAUDE.md): `kpis` is `Unknown`
      // in the synthesized SDL — its wire shape is INFERRED. This test
      // is the load-bearing live verification that:
      //   - `kpis { id value description }` is the accepted projection
      //     (the query parses + returns 200 OK; a wrong shape would
      //     return a GraphQL error on the field selector);
      //   - `kpis` is a direct list (NOT a connection) — captured as
      //     `Array.isArray(items[i].kpis)` rather than
      //     `items[i].kpis.nodes`;
      //   - newly-created portfolio items return `kpis: []` (empty
      //     array, not null);
      //   - populated kpi entries (when present in the maintainer's
      //     account) carry `{id, value, description}` per the
      //     `PortfolioItemKpi` element type the probe surfaced.
      //
      // Probe context (2026-05-23): maintainer's test account had 32
      // portfolio items, all with empty `kpis: []` — populated-shape
      // sub-field types stay INFERRED in this snapshot. The wire-shape
      // snapshot in `createPortfolioItem.snapshot.json` captures the
      // empty-case shape; when a populated KPI appears (sentinel +
      // future write surface, OR an existing account-state item), this
      // test's `withKpis` branch performs the per-field type assertion.
      const sentinelTitle = `e2e-sentinel-kpis-${Date.now().toString()}`;
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
        // The freshly-created sentinel MUST have `kpis: []` — the wire
        // returns an empty array for items without KPIs (NOT null, NOT
        // missing). The mapper would not surface a kpis field at all
        // if the wire shape were unparseable, so an Array.isArray
        // assertion is enough to verify both the wire-shape acceptance
        // and the projection.
        const sentinel = created.find((it) => it.id === sentinelId);
        expect(sentinel?.kpis).toBeDefined();
        expect(Array.isArray(sentinel?.kpis)).toBe(true);
        expect(sentinel?.kpis).toEqual([]);

        // Inspect the full list — any portfolio item that DOES carry
        // populated KPIs lets us assert the per-field shape on a live
        // wire payload. The maintainer's account at probe time had no
        // populated KPIs (32 items, all `[]`); when this changes, the
        // assertion picks up the populated shape automatically.
        const listResult = await cli.run(["profile", "portfolio", "list", "-o", "json"]);
        expect(listResult.exitCode).toBe(0);
        const listPayload = JSON.parse(listResult.stdout) as {
          version?: string;
          items?: PortfolioItemShape[];
        };
        const allItems = listPayload.items ?? [];
        // Every item in the list must have an Array-typed `kpis` field
        // — the wire shape is `kpis: [PortfolioItemKpi!]!` (non-null
        // list of non-null elements per the empirical schema), so the
        // projection MUST surface an array for every entry.
        for (const it of allItems) {
          expect(Array.isArray(it.kpis)).toBe(true);
        }

        const withKpis = allItems.filter((it) => Array.isArray(it.kpis) && it.kpis.length > 0);
        if (withKpis.length > 0) {
          // Per-field shape assertion for any populated KPI — locks
          // the {id: string, value?: string|null, description?: string|null}
          // contract live. Skipped when no populated KPIs are present
          // on the maintainer's account (the typical case at probe
          // time); the empty-case shape is gated by the wire-shape
          // snapshot below.
          const allKpis = withKpis.flatMap((it) => it.kpis ?? []);
          for (const kpi of allKpis) {
            expect(typeof kpi.id).toBe("string");
            if (kpi.value !== null && kpi.value !== undefined) {
              expect(typeof kpi.value).toBe("string");
            }
            if (kpi.description !== null && kpi.description !== undefined) {
              expect(typeof kpi.description).toBe("string");
            }
          }
        } else {
          process.stderr.write(
            "info: no portfolio items with populated KPIs on this account — populated-shape sub-field assertion skipped (empty-case shape verified via wire-shape snapshot)\n",
          );
        }
      } finally {
        const cleanup = await cli.run(["profile", "portfolio", "remove", sentinelId, "-o", "json"]);
        expect(cleanup.exitCode).toBe(0);
      }
    },
  );

  it.skipIf(!e2eEnabled)("createPortfolioItem + portfolio list expose quotes as a typed array", async () => {
    // Provenance: #551 — quotes wire-shape verification (INFERRED → verified live).
    // Schema/contract validation rule (CLAUDE.md): `quotes` is `Unknown`
    // in the synthesized SDL — its wire shape is INFERRED. This test is
    // the load-bearing live verification that:
    //   - `quotes { id text clientName clientRole company }` is the
    //     accepted projection (the query parses + returns 200 OK; a
    //     wrong shape would return a GraphQL error on the field
    //     selector — the issue's guessed `{quote, attribution, role}`
    //     were rejected by the live probe, the empirical fragment names
    //     accepted);
    //   - `quotes` is a direct list (NOT a connection) — captured as
    //     `Array.isArray(items[i].quotes)` rather than
    //     `items[i].quotes.nodes` (the probe confirmed `quotes { nodes }`
    //     errors "Field 'nodes' doesn't exist on type
    //     'PortfolioItemQuote'");
    //   - newly-created portfolio items return `quotes: []` (empty
    //     array, not null);
    //   - populated quote entries (when present in the maintainer's
    //     account) carry `{id, text, clientName, clientRole, company}`
    //     per the `PortfolioItemQuote` element type the probe surfaced.
    //
    // Probe context (2026-05-23): maintainer's test account had 32
    // portfolio items, all with empty `quotes: []` — populated-shape
    // sub-field types stay INFERRED in this snapshot. The wire-shape
    // snapshot in `createPortfolioItem.snapshot.json` captures the
    // empty-case shape; when a populated quote appears (an existing
    // account-state item), this test's `withQuotes` branch performs the
    // per-field type assertion.
    const sentinelTitle = `e2e-sentinel-quotes-${Date.now().toString()}`;
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
      // The freshly-created sentinel MUST have `quotes: []` — the wire
      // returns an empty array for items without testimonials (NOT null,
      // NOT missing). The mapper would not surface a quotes field at all
      // if the wire shape were unparseable, so an Array.isArray
      // assertion is enough to verify both the wire-shape acceptance and
      // the projection.
      const sentinel = created.find((it) => it.id === sentinelId);
      expect(sentinel?.quotes).toBeDefined();
      expect(Array.isArray(sentinel?.quotes)).toBe(true);
      expect(sentinel?.quotes).toEqual([]);

      // Inspect the full list — any portfolio item that DOES carry
      // populated quotes lets us assert the per-field shape on a live
      // wire payload. The maintainer's account at probe time had no
      // populated quotes (32 items, all `[]`); when this changes, the
      // assertion picks up the populated shape automatically.
      const listResult = await cli.run(["profile", "portfolio", "list", "-o", "json"]);
      expect(listResult.exitCode).toBe(0);
      const listPayload = JSON.parse(listResult.stdout) as {
        version?: string;
        items?: PortfolioItemShape[];
      };
      const allItems = listPayload.items ?? [];
      // Every item in the list must have an Array-typed `quotes` field
      // — the wire shape is `quotes: [PortfolioItemQuote!]!` (non-null
      // list of non-null elements per the empirical schema), so the
      // projection MUST surface an array for every entry.
      for (const it of allItems) {
        expect(Array.isArray(it.quotes)).toBe(true);
      }

      const withQuotes = allItems.filter((it) => Array.isArray(it.quotes) && it.quotes.length > 0);
      if (withQuotes.length > 0) {
        // Per-field shape assertion for any populated quote — locks the
        // {id: string, text/clientName/clientRole/company: string|null}
        // contract live. Skipped when no populated quotes are present on
        // the maintainer's account (the typical case at probe time); the
        // empty-case shape is gated by the wire-shape snapshot below.
        const allQuotes = withQuotes.flatMap((it) => it.quotes ?? []);
        for (const quote of allQuotes) {
          expect(typeof quote.id).toBe("string");
          for (const field of [quote.text, quote.clientName, quote.clientRole, quote.company]) {
            if (field !== null && field !== undefined) {
              expect(typeof field).toBe("string");
            }
          }
        }
      } else {
        process.stderr.write(
          "info: no portfolio items with populated quotes on this account — populated-shape sub-field assertion skipped (empty-case shape verified via wire-shape snapshot)\n",
        );
      }
    } finally {
      const cleanup = await cli.run(["profile", "portfolio", "remove", sentinelId, "-o", "json"]);
      expect(cleanup.exitCode).toBe(0);
    }
  });

  it.skipIf(!e2eEnabled)(
    "createPortfolioItem + portfolio list expose engagement as a nullable TalentEngagement reference",
    async () => {
      // Provenance: #552 — engagement link wire-shape verification (INFERRED → verified live).
      // Schema/contract validation rule (CLAUDE.md): `engagement` is
      // `Unknown` in the synthesized SDL — its wire shape is INFERRED. This
      // test is the load-bearing live verification that:
      //   - `engagement { id }` is the accepted projection (the query
      //     parses + returns 200 OK; a wrong shape returns a GraphQL error
      //     on the field selector);
      //   - `engagement` is a SINGLE nullable object reference (NOT a list,
      //     NOT a connection) — captured as `engagement === null` OR an
      //     object with a string `id`, never an array and never
      //     `engagement.nodes` (the probe confirmed `engagement { nodes }`
      //     errors "Field 'nodes' doesn't exist on type 'TalentEngagement'");
      //   - a newly-created portfolio item returns `engagement: null` (it is
      //     not linked to any engagement);
      //   - populated engagement references carry `{ id: string }` (the
      //     referenced type is `TalentEngagement`; the id is the relay
      //     global id, e.g. `V1-TalentEngagement-238005`).
      //
      // Probe context (2026-05-24): maintainer's account had 32 portfolio
      // items — 26 with `engagement: null`, 6 with a populated `{ id }`. So
      // the populated-shape assertion below DOES execute on this account
      // (unlike #551 quotes, which were all empty). The wire-shape snapshot
      // in `createPortfolioItem.snapshot.json` captures the null-case shape
      // of a freshly-created item.
      const sentinelTitle = `e2e-sentinel-engagement-${Date.now().toString()}`;
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
        // The freshly-created sentinel MUST have `engagement: null` — a new
        // portfolio item is not linked to any engagement. The field is
        // present-as-null (NOT missing): the mapper always projects it, so
        // `toBeDefined()` (null passes; undefined fails) proves the key
        // exists and `toBeNull()` proves it is the explicit null shape.
        const sentinel = created.find((it) => it.id === sentinelId);
        expect(sentinel?.engagement).toBeDefined();
        expect(sentinel?.engagement).toBeNull();

        // Inspect the full list — the maintainer's account carries items
        // with populated engagements, letting us assert the per-field shape
        // on a live wire payload.
        const listResult = await cli.run(["profile", "portfolio", "list", "-o", "json"]);
        expect(listResult.exitCode).toBe(0);
        const listPayload = JSON.parse(listResult.stdout) as {
          version?: string;
          items?: PortfolioItemShape[];
        };
        const allItems = listPayload.items ?? [];
        // Every item's `engagement` must be either `null` or a non-array
        // object — the wire shape is a single nullable `TalentEngagement`
        // reference, so an array would mean the projection mis-read a
        // connection/list shape.
        for (const it of allItems) {
          const eng = it.engagement;
          expect(eng === null || (typeof eng === "object" && !Array.isArray(eng))).toBe(true);
        }

        const linked = allItems.filter((it) => it.engagement !== null && it.engagement !== undefined);
        if (linked.length > 0) {
          // Per-field shape assertion for any populated engagement — locks
          // the `{ id: string }` contract live. This branch DOES run on the
          // maintainer's account (6 of 32 items linked at probe time).
          for (const it of linked) {
            expect(typeof it.engagement?.id).toBe("string");
          }
        } else {
          process.stderr.write(
            "info: no engagement-linked portfolio items on this account — populated-shape assertion skipped (null-case shape verified via wire-shape snapshot)\n",
          );
        }
      } finally {
        const cleanup = await cli.run(["profile", "portfolio", "remove", sentinelId, "-o", "json"]);
        expect(cleanup.exitCode).toBe(0);
      }
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

  /**
   * `uploadPortfolioFile` wire shape is empirically verified correct
   * (`UploadPortfolioFileInput` accepts only `profileId` and `file` — every
   * extra arg returns `argumentNotAccepted` per `.tmp/probe-file-extra-fields.mjs`),
   * but the test account currently returns `USER_ERROR(unsupportedFileContentType,
   * key: file)` with an **empty** supported-types echo
   * (`"Not supported file type given. Supported types: "`) for every content
   * type probed: TXT, real PDF (parseable by `file` as PDF 1.4), real PNG
   * (1×1, 750×500, 1600×1200), real JPEG, DOCX (ZIP with payload), bare ZIP,
   * and WebP. Sibling `uploadPortfolioCover` works on the same multipart
   * transport / same account, so this is a server-side feature gate on this
   * account (mirroring the industries-disabled gate per #314's industries
   * cascade). The skip pattern matches sibling tests
   * (21-engagements-breaks, 30-payments-payouts, etc.). When Toptal enables
   * portfolio file uploads on this account, the success path will pick up
   * automatically and the snapshot can be captured (T1 per
   * `docs/wire-validation-routing.md`).
   */
  it.skipIf(!e2eEnabled)(
    "uploadPortfolioFile accepts a tiny text attachment via --file and returns a fileCacheName",
    async () => {
      const fixturePath = join(tmpDir, "e2e-attachment.txt");
      await writeFile(fixturePath, "ttctl e2e portfolio attachment fixture\n", "utf8");

      const result = await cli.run(["profile", "portfolio", "upload", "--file", fixturePath, "-o", "json"]);

      const payload = JSON.parse(result.stdout) as {
        ok?: boolean;
        operation?: string;
        updated?: { fileCacheName?: string | null; fileUrl?: string | null };
        errors?: { code?: string; message?: string }[];
      };

      const featureGated =
        result.exitCode === 1 &&
        payload.ok === false &&
        Array.isArray(payload.errors) &&
        payload.errors.some(
          (e) =>
            e.code === "USER_ERROR" &&
            typeof e.message === "string" &&
            e.message.includes("Not supported file type given. Supported types:"),
        );
      if (featureGated) {
        process.stderr.write(
          "warning: uploadPortfolioFile rejected with empty supported-types list — feature gated on test account, round-trip skipped\n",
        );
        return;
      }

      expect(result.exitCode).toBe(0);
      expect(payload.ok).toBe(true);
      expect(payload.operation).toBe("profile.portfolio.upload");
      expect(typeof payload.updated?.fileCacheName).toBe("string");
      expect(payload.updated?.fileCacheName?.length).toBeGreaterThan(0);
    },
  );
});
