// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";
import type { profile } from "@ttctl/core";

import { formatPhotoTable, formatPhotoText } from "../photo-show.js";
import { formatUploadResult } from "../photo-upload.js";

const PHOTO_OK: profile.basic.PhotoUrl = {
  default: "https://cdn.toptal.com/avatar/p1/default.jpg",
  original: "https://cdn.toptal.com/avatar/p1/original.jpg",
  small: "https://cdn.toptal.com/avatar/p1/small.jpg",
  cropped: { x: 10, y: 20, width: 200, height: 200 },
  isResolutionSatisfied: true,
};

const PHOTO_EMPTY: profile.basic.PhotoUrl = {
  default: null,
  original: null,
  small: null,
  cropped: null,
  isResolutionSatisfied: false,
};

// -----------------------------------------------------------------------
// formatPhotoText
// -----------------------------------------------------------------------

describe("formatPhotoText", () => {
  it("emits one labelled line per non-null URL plus the cropped & resolution lines", () => {
    const out = formatPhotoText(PHOTO_OK);
    const lines = out.split("\n");
    expect(lines).toContain(`default:  ${PHOTO_OK.default}`);
    expect(lines).toContain(`original: ${PHOTO_OK.original}`);
    expect(lines).toContain(`small:    ${PHOTO_OK.small}`);
    expect(lines.some((l) => l.startsWith("cropped:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("resolution:"))).toBe(true);
  });

  it('falls back to "(no photo set)" when every variant URL is null', () => {
    const out = formatPhotoText(PHOTO_EMPTY);
    expect(out).toContain("(no photo set)");
    expect(out).toContain("resolution: below requirements");
  });

  it("renders the cropped rectangle as `x= y= W×H`", () => {
    const out = formatPhotoText(PHOTO_OK);
    expect(out).toMatch(/cropped:\s+x=10 y=20 200×200/);
  });
});

// -----------------------------------------------------------------------
// formatPhotoTable
// -----------------------------------------------------------------------

describe("formatPhotoTable", () => {
  it("renders the URLs and the resolution row", () => {
    const out = formatPhotoTable(PHOTO_OK, 100);
    expect(out).toContain("default");
    expect(out).toContain(PHOTO_OK.default ?? "");
    expect(out).toContain("resolution_ok");
    expect(out).toContain("true");
  });

  it("uses (unset) for missing URL variants", () => {
    const out = formatPhotoTable(PHOTO_EMPTY, 100);
    expect(out).toContain("(unset)");
    expect(out).toContain("false");
  });
});

// -----------------------------------------------------------------------
// formatUploadResult
// -----------------------------------------------------------------------

describe("formatUploadResult (text)", () => {
  it('leads with "Photo updated." and includes the formatted detail block', () => {
    const out = formatUploadResult(PHOTO_OK, "text");
    expect(out.startsWith("Photo updated.\n")).toBe(true);
    expect(out).toContain(`default:  ${PHOTO_OK.default}`);
  });
});

describe("formatUploadResult (json)", () => {
  it("returns the raw payload as pretty-printed JSON", () => {
    const out = formatUploadResult(PHOTO_OK, "json");
    expect(JSON.parse(out)).toEqual(PHOTO_OK);
  });
});

describe("formatUploadResult (table)", () => {
  it("renders the same table as `formatPhotoTable`", () => {
    const out = formatUploadResult(PHOTO_OK, "table");
    expect(out).toContain("default");
    expect(out).toContain(PHOTO_OK.default ?? "");
  });
});
