// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UPLOAD_CATEGORIES, decodeFileUploadInput, validateUploadPath } from "../tools/file-upload.js";

/**
 * Save and restore the env var across tests so a stray `=1` setting can't
 * leak from one test into another. Most tests run with the sandbox active
 * (bypass unset). The literal env-var name is used in `process.env`
 * access expressions so ESLint's `@typescript-eslint/no-dynamic-delete`
 * stays happy (a const-bound dynamic property would flag).
 */
let savedBypassEnv: string | undefined;

beforeEach(() => {
  savedBypassEnv = process.env["TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY"];
  delete process.env["TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY"];
});

afterEach(() => {
  if (savedBypassEnv === undefined) {
    delete process.env["TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY"];
  } else {
    process.env["TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY"] = savedBypassEnv;
  }
});

function sandboxedPath(...segments: string[]): string {
  return path.join(os.homedir(), "Documents", ...segments);
}

describe("decodeFileUploadInput", () => {
  it("returns a path resolution for a `filePath` input inside the sandbox with allowed extension", () => {
    const file = sandboxedPath("resume.pdf");
    const result = decodeFileUploadInput({ filePath: file }, UPLOAD_CATEGORIES.resume);
    expect(result).toEqual({ kind: "path", path: file });
  });

  it("decodes base64 `content` into a Buffer with the supplied filename (extension allowed)", () => {
    const result = decodeFileUploadInput(
      {
        content: Buffer.from("hello").toString("base64"),
        filename: "x.pdf",
      },
      UPLOAD_CATEGORIES.resume,
    );
    if ("isError" in result) throw new Error("expected non-error result");
    expect(result.kind).toBe("buffer");
    if (result.kind !== "buffer") throw new Error("kind narrowed to non-buffer");
    expect(result.filename).toBe("x.pdf");
    expect(result.content.toString()).toBe("hello");
    expect(result.contentType).toBeUndefined();
  });

  it("preserves a supplied contentType on buffer-mode results", () => {
    const result = decodeFileUploadInput(
      {
        content: Buffer.from("x").toString("base64"),
        filename: "x.pdf",
        contentType: "application/pdf",
      },
      UPLOAD_CATEGORIES.resume,
    );
    if ("isError" in result) throw new Error("expected non-error result");
    if (result.kind !== "buffer") throw new Error("kind narrowed to non-buffer");
    expect(result.contentType).toBe("application/pdf");
  });

  it("rejects neither path nor content with VALIDATION_ERROR", () => {
    const result = decodeFileUploadInput({}, UPLOAD_CATEGORIES.resume);
    expect("isError" in result).toBe(true);
    if (!("isError" in result)) return;
    expect(result.content[0].text).toContain("(Code: VALIDATION_ERROR)");
  });

  it("rejects both path AND content with VALIDATION_ERROR", () => {
    const result = decodeFileUploadInput(
      {
        filePath: sandboxedPath("x.pdf"),
        content: "abcd",
        filename: "x.pdf",
      },
      UPLOAD_CATEGORIES.resume,
    );
    expect("isError" in result).toBe(true);
    if (!("isError" in result)) return;
    expect(result.content[0].text).toContain("mutually exclusive");
  });

  it("rejects content without filename", () => {
    const result = decodeFileUploadInput({ content: "abcd" }, UPLOAD_CATEGORIES.resume);
    expect("isError" in result).toBe(true);
    if (!("isError" in result)) return;
    expect(result.content[0].text).toContain("filename");
  });

  it("rejects an empty filePath as if not supplied", () => {
    const result = decodeFileUploadInput({ filePath: "" }, UPLOAD_CATEGORIES.resume);
    expect("isError" in result).toBe(true);
  });

  it("rejects content that decodes to zero bytes (filename matches allowlist)", () => {
    const result = decodeFileUploadInput({ content: "", filename: "x.pdf" }, UPLOAD_CATEGORIES.resume);
    expect("isError" in result).toBe(true);
  });

  it("rejects content whose filename extension is not in the category allowlist", () => {
    const result = decodeFileUploadInput(
      {
        content: Buffer.from("x").toString("base64"),
        filename: "id_rsa",
      },
      UPLOAD_CATEGORIES.resume,
    );
    expect("isError" in result).toBe(true);
    if (!("isError" in result)) return;
    expect(result.content[0].text).toContain("extension");
    expect(result.content[0].text).toContain("not allowed");
  });

  it("accepts case-insensitive extensions on filePath (`.PDF` matches `.pdf`)", () => {
    const file = sandboxedPath("resume.PDF");
    const result = decodeFileUploadInput({ filePath: file }, UPLOAD_CATEGORIES.resume);
    expect("kind" in result && result.kind === "path").toBe(true);
  });

  it("accepts case-insensitive extensions on filename in buffer mode", () => {
    const result = decodeFileUploadInput(
      {
        content: Buffer.from("x").toString("base64"),
        filename: "Resume.PDF",
      },
      UPLOAD_CATEGORIES.resume,
    );
    expect("kind" in result && result.kind === "buffer").toBe(true);
  });
});

describe("validateUploadPath — extension allowlist (defense-in-depth, issue #221)", () => {
  it("accepts a path whose extension is in the category's allowlist", () => {
    const result = validateUploadPath(sandboxedPath("photo.png"), UPLOAD_CATEGORIES.basicPhoto);
    expect(result).toBeNull();
  });

  it("rejects a path whose extension is not in the category's allowlist", () => {
    const result = validateUploadPath(sandboxedPath("secret.txt"), UPLOAD_CATEGORIES.basicPhoto);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("(Code: VALIDATION_ERROR)");
    expect(result.content[0].text).toContain('extension ".txt"');
    expect(result.content[0].text).toContain("basic-photo");
  });

  it("rejects a path with no extension (canonical secret-file shape: id_rsa, credentials)", () => {
    const result = validateUploadPath(sandboxedPath("id_rsa"), UPLOAD_CATEGORIES.resume);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('extension "<none>"');
  });

  it("rejects a path with a sensitive extension that is not in the portfolioFile allowlist (.pub)", () => {
    const result = validateUploadPath(sandboxedPath("id_rsa.pub"), UPLOAD_CATEGORIES.portfolioFile);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('extension ".pub"');
  });

  it("rejects .env files even via portfolioFile (the broadest allowlist)", () => {
    const result = validateUploadPath(sandboxedPath(".env"), UPLOAD_CATEGORIES.portfolioFile);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.isError).toBe(true);
  });
});

describe("validateUploadPath — path-prefix sandbox (defense-in-depth, issue #221)", () => {
  it("accepts paths inside ~/Documents", () => {
    const result = validateUploadPath(sandboxedPath("resume.pdf"), UPLOAD_CATEGORIES.resume);
    expect(result).toBeNull();
  });

  it("accepts paths inside ~/Downloads", () => {
    const result = validateUploadPath(path.join(os.homedir(), "Downloads", "resume.pdf"), UPLOAD_CATEGORIES.resume);
    expect(result).toBeNull();
  });

  it("accepts paths inside ~/Desktop", () => {
    const result = validateUploadPath(path.join(os.homedir(), "Desktop", "resume.pdf"), UPLOAD_CATEGORIES.resume);
    expect(result).toBeNull();
  });

  it("rejects ~/.ssh/id_rsa.pdf even though the extension is in the allowlist (the threat-model anchor)", () => {
    // Extension is allowlisted (.pdf), but the path is outside the
    // sandbox — sandbox is the second gate that catches it. This is the
    // canonical defense-in-depth case from the issue's threat model.
    const sshPath = path.join(os.homedir(), ".ssh", "id_rsa.pdf");
    const result = validateUploadPath(sshPath, UPLOAD_CATEGORIES.resume);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("outside of the MCP upload sandbox");
    expect(result.content[0].text).toContain("TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY");
  });

  it("rejects ~/.aws/credentials.pdf (extension allowlisted, path refused)", () => {
    const awsPath = path.join(os.homedir(), ".aws", "credentials.pdf");
    const result = validateUploadPath(awsPath, UPLOAD_CATEGORIES.resume);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("outside of the MCP upload sandbox");
  });

  it("rejects path-traversal attempts that resolve outside the sandbox", () => {
    const traversal = path.join(os.homedir(), "Documents", "..", ".ssh", "id_rsa.pdf");
    const result = validateUploadPath(traversal, UPLOAD_CATEGORIES.resume);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("outside of the MCP upload sandbox");
  });

  it("rejects a sibling-name lookalike (~/Documents_secret/x.pdf does NOT match ~/Documents)", () => {
    // The sibling-name guard is the reason the prefix check requires
    // `resolved === prefix || resolved.startsWith(prefix + path.sep)`
    // instead of a bare `startsWith(prefix)`.
    const sibling = path.join(os.homedir(), "Documents_secret", "x.pdf");
    const result = validateUploadPath(sibling, UPLOAD_CATEGORIES.resume);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.isError).toBe(true);
  });

  it("bypasses the sandbox when TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY=1 is set (extension still enforced)", () => {
    process.env["TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY"] = "1";
    const result = validateUploadPath("/tmp/x.pdf", UPLOAD_CATEGORIES.resume);
    expect(result).toBeNull();
  });

  it("still enforces extension allowlist when sandbox is bypassed (env override is sandbox-only)", () => {
    process.env["TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY"] = "1";
    const result = validateUploadPath("/tmp/id_rsa", UPLOAD_CATEGORIES.resume);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("extension");
  });

  it("ignores TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY values other than the literal string `1`", () => {
    for (const value of ["", "0", "true", "yes", "01", " 1"]) {
      process.env["TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY"] = value;
      const result = validateUploadPath("/tmp/x.pdf", UPLOAD_CATEGORIES.resume);
      expect(result).not.toBeNull();
      if (result === null) continue;
      expect(result.isError).toBe(true);
    }
  });
});

describe("UPLOAD_CATEGORIES — per-tool extension allowlists", () => {
  it("basicPhoto allows common image extensions only", () => {
    expect(UPLOAD_CATEGORIES.basicPhoto.allowedExtensions).toContain(".jpg");
    expect(UPLOAD_CATEGORIES.basicPhoto.allowedExtensions).toContain(".png");
    expect(UPLOAD_CATEGORIES.basicPhoto.allowedExtensions).not.toContain(".pdf");
    expect(UPLOAD_CATEGORIES.basicPhoto.allowedExtensions).not.toContain(".txt");
  });

  it("resume allows pdf and document formats but not images", () => {
    expect(UPLOAD_CATEGORIES.resume.allowedExtensions).toContain(".pdf");
    expect(UPLOAD_CATEGORIES.resume.allowedExtensions).toContain(".docx");
    expect(UPLOAD_CATEGORIES.resume.allowedExtensions).toContain(".txt");
    expect(UPLOAD_CATEGORIES.resume.allowedExtensions).not.toContain(".png");
    expect(UPLOAD_CATEGORIES.resume.allowedExtensions).not.toContain(".zip");
  });

  it("portfolioFile is the broadest allowlist but still excludes secret-file extensions", () => {
    const exts = UPLOAD_CATEGORIES.portfolioFile.allowedExtensions;
    expect(exts).toContain(".pdf");
    expect(exts).toContain(".png");
    expect(exts).toContain(".zip");
    // Defense-in-depth — never accept these via the portfolioFile category.
    expect(exts).not.toContain(".pub");
    expect(exts).not.toContain(".env");
    expect(exts).not.toContain(".db");
    expect(exts).not.toContain(".sqlite");
    expect(exts).not.toContain(".sh");
    expect(exts).not.toContain(".exe");
  });
});
