// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { decodeFileUploadInput } from "../tools/file-upload.js";

describe("decodeFileUploadInput", () => {
  it("returns a path resolution for a `filePath` input", () => {
    const result = decodeFileUploadInput({ filePath: "/tmp/x.pdf" });
    expect(result).toEqual({ kind: "path", path: "/tmp/x.pdf" });
  });

  it("decodes base64 `content` into a Buffer with the supplied filename", () => {
    const result = decodeFileUploadInput({
      content: Buffer.from("hello").toString("base64"),
      filename: "x.pdf",
    });
    if ("isError" in result) throw new Error("expected non-error result");
    expect(result.kind).toBe("buffer");
    if (result.kind !== "buffer") throw new Error("kind narrowed to non-buffer");
    expect(result.filename).toBe("x.pdf");
    expect(result.content.toString()).toBe("hello");
    expect(result.contentType).toBeUndefined();
  });

  it("preserves a supplied contentType on buffer-mode results", () => {
    const result = decodeFileUploadInput({
      content: Buffer.from("x").toString("base64"),
      filename: "x.pdf",
      contentType: "application/pdf",
    });
    if ("isError" in result) throw new Error("expected non-error result");
    if (result.kind !== "buffer") throw new Error("kind narrowed to non-buffer");
    expect(result.contentType).toBe("application/pdf");
  });

  it("rejects neither path nor content with VALIDATION_ERROR", () => {
    const result = decodeFileUploadInput({});
    expect("isError" in result).toBe(true);
    if (!("isError" in result)) return;
    expect(result.content[0].text).toContain("(Code: VALIDATION_ERROR)");
  });

  it("rejects both path AND content with VALIDATION_ERROR", () => {
    const result = decodeFileUploadInput({
      filePath: "/tmp/x",
      content: "abcd",
      filename: "x",
    });
    expect("isError" in result).toBe(true);
    if (!("isError" in result)) return;
    expect(result.content[0].text).toContain("mutually exclusive");
  });

  it("rejects content without filename", () => {
    const result = decodeFileUploadInput({ content: "abcd" });
    expect("isError" in result).toBe(true);
    if (!("isError" in result)) return;
    expect(result.content[0].text).toContain("filename");
  });

  it("rejects an empty filePath as if not supplied", () => {
    const result = decodeFileUploadInput({ filePath: "" });
    expect("isError" in result).toBe(true);
  });

  it("rejects content that decodes to zero bytes", () => {
    const result = decodeFileUploadInput({ content: "", filename: "x" });
    expect("isError" in result).toBe(true);
  });
});
