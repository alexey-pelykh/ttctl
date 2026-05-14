// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core — assert the apply-path core calls NEVER
// fire when the sandbox/allowlist gate refuses. The mocks throw on
// invocation; an unintended call would surface as a test failure on the
// stack trace from the mock itself.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    profile: {
      ...actual.profile,
      basic: {
        ...actual.profile.basic,
        photoUpload: vi.fn(() => {
          throw new Error("profile.basic.photoUpload must NOT be called when the gate refuses");
        }),
      },
      resume: {
        ...actual.profile.resume,
        upload: vi.fn(() => {
          throw new Error("profile.resume.upload must NOT be called when the gate refuses");
        }),
      },
      portfolio: {
        ...actual.profile.portfolio,
        uploadCover: vi.fn(() => {
          throw new Error("profile.portfolio.uploadCover must NOT be called when the gate refuses");
        }),
        uploadFile: vi.fn(() => {
          throw new Error("profile.portfolio.uploadFile must NOT be called when the gate refuses");
        }),
      },
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerProfileBasicPhotoUploadTool } from "../profile_basic_photo_upload.js";
import { registerPortfolioTools } from "../profile/portfolio.js";
import { registerResumeTools } from "../profile/resume.js";

/**
 * MCP-layer defense-in-depth gate integration tests (issue #221, audit
 * CRIT-007). Verifies that the four file-upload tools refuse out-of-
 * sandbox paths and disallowed extensions BEFORE the apply path runs.
 *
 * The threat-model anchor: a prompt-injected agent invocation like
 *   ttctl_profile_resume_upload({ filePath: "/Users/<x>/.ssh/id_rsa" })
 * must fail with a `(VALIDATION_ERROR)` block at the MCP layer — never
 * reaching `profile.resume.upload()` and therefore never exfiltrating
 * the file to Toptal.
 */

/**
 * Literal env-var name in `process.env` access expressions so ESLint's
 * `@typescript-eslint/no-dynamic-delete` stays happy.
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
  vi.restoreAllMocks();
});

function buildAuthSuccessCtx(token = "user_test_token"): ToolRegistrationContext {
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token }),
    resolveToolAuth: vi.fn().mockResolvedValue({ ok: true, token }),
    resolveTokenForTool: vi.fn().mockResolvedValue({ token }),
  };
}

function getToolHandler(server: McpServer, name: string): (input: unknown, extra: unknown) => Promise<unknown> {
  const internals = server as unknown as { _registeredTools: Record<string, { handler: unknown }> };
  const entry = internals._registeredTools[name];
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return entry.handler as (input: unknown, extra: unknown) => Promise<unknown>;
}

interface ToolErrorShape {
  isError: boolean;
  content: { type: string; text: string }[];
}

function assertGateRefusal(result: unknown): asserts result is ToolErrorShape {
  const shape = result as ToolErrorShape;
  expect(shape.isError).toBe(true);
  expect(shape.content[0]?.text ?? "").toContain("(Code: VALIDATION_ERROR)");
}

describe("MCP file-upload tools — defense-in-depth path/extension gate (#221)", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
  });

  describe("ttctl_profile_basic_photo_upload", () => {
    it("refuses ~/.ssh/id_rsa with the threat-model anchor message", async () => {
      registerProfileBasicPhotoUploadTool(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_basic_photo_upload");
      const result = await handler({ file: path.join(os.homedir(), ".ssh", "id_rsa") }, {});
      assertGateRefusal(result);
      // Extension gate fires first (cheap + clear), so the message
      // surfaces extension-not-allowed rather than sandbox refusal.
      expect(result.content[0]?.text).toContain("extension");
      expect(result.content[0]?.text).toContain("basic-photo");
    });

    it("refuses a sandbox-internal path with a non-image extension", async () => {
      registerProfileBasicPhotoUploadTool(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_basic_photo_upload");
      const result = await handler({ file: path.join(os.homedir(), "Documents", "resume.pdf") }, {});
      assertGateRefusal(result);
      expect(result.content[0]?.text).toContain('extension ".pdf"');
    });

    it("refuses image extension outside sandbox (canonical defense-in-depth case)", async () => {
      registerProfileBasicPhotoUploadTool(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_basic_photo_upload");
      // Image extension passes the allowlist but the path is outside
      // the sandbox — sandbox catches it.
      const result = await handler({ file: path.join(os.homedir(), ".secret", "leak.png") }, {});
      assertGateRefusal(result);
      expect(result.content[0]?.text).toContain("outside of the MCP upload sandbox");
    });

    it("dryRun path skips the gate (no file is read in preview mode)", async () => {
      registerProfileBasicPhotoUploadTool(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_basic_photo_upload");
      const result = (await handler({ file: path.join(os.homedir(), ".ssh", "id_rsa"), dryRun: true }, {})) as {
        content: { text: string }[];
      };
      // Dry-run envelope ships even though `file` would have failed the
      // gate — the gate runs only on the apply path. This is intentional:
      // dry-run never reads the file, so the exfiltration surface is
      // absent. Operators can probe the wire shape without disabling
      // the gate.
      const text = result.content[0]?.text ?? "";
      const parsed = JSON.parse(text) as { ok: boolean; dryRun: boolean };
      expect(parsed.ok).toBe(true);
      expect(parsed.dryRun).toBe(true);
    });
  });

  describe("ttctl_profile_resume_upload", () => {
    it("refuses ~/.ssh/id_rsa (threat-model anchor)", async () => {
      registerResumeTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_resume_upload");
      const result = await handler({ filePath: path.join(os.homedir(), ".ssh", "id_rsa") }, {});
      assertGateRefusal(result);
      expect(result.content[0]?.text).toContain("resume");
    });

    it("refuses ~/.aws/credentials (no extension, outside sandbox)", async () => {
      registerResumeTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_resume_upload");
      const result = await handler({ filePath: path.join(os.homedir(), ".aws", "credentials") }, {});
      assertGateRefusal(result);
    });

    it("refuses base64 buffer mode with `id_rsa` as filename (no extension)", async () => {
      registerResumeTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_resume_upload");
      const result = await handler({ content: Buffer.from("PRIVATE KEY").toString("base64"), filename: "id_rsa" }, {});
      assertGateRefusal(result);
      expect(result.content[0]?.text).toContain('extension "<none>"');
    });

    it("refuses base64 buffer mode with `secret.png` (wrong category)", async () => {
      // Resume category does NOT allow `.png` — even though the file
      // content is base64 (no path involved), category mismatch is a
      // clean refusal.
      registerResumeTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_resume_upload");
      const result = await handler({ content: Buffer.from("x").toString("base64"), filename: "secret.png" }, {});
      assertGateRefusal(result);
      expect(result.content[0]?.text).toContain('extension ".png"');
    });
  });

  describe("ttctl_profile_portfolio_upload_cover", () => {
    it("refuses ~/.ssh/id_rsa", async () => {
      registerPortfolioTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_portfolio_upload_cover");
      const result = await handler({ filePath: path.join(os.homedir(), ".ssh", "id_rsa") }, {});
      assertGateRefusal(result);
    });

    it("refuses .pdf for the portfolio cover category (image-only)", async () => {
      registerPortfolioTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_portfolio_upload_cover");
      const result = await handler({ filePath: path.join(os.homedir(), "Documents", "x.pdf") }, {});
      assertGateRefusal(result);
      expect(result.content[0]?.text).toContain("portfolio-cover");
      expect(result.content[0]?.text).toContain('extension ".pdf"');
    });
  });

  describe("ttctl_profile_portfolio_upload_file", () => {
    it("refuses ~/.ssh/id_rsa", async () => {
      registerPortfolioTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_portfolio_upload_file");
      const result = await handler({ filePath: path.join(os.homedir(), ".ssh", "id_rsa") }, {});
      assertGateRefusal(result);
    });

    it("refuses .env files via portfolioFile (the broadest allowlist)", async () => {
      registerPortfolioTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_portfolio_upload_file");
      const result = await handler({ filePath: path.join(os.homedir(), "Documents", ".env") }, {});
      assertGateRefusal(result);
    });

    it("refuses base64 buffer mode with `.sh` filename via portfolio-file", async () => {
      registerPortfolioTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_portfolio_upload_file");
      const result = await handler({ content: Buffer.from("#!/bin/sh").toString("base64"), filename: "evil.sh" }, {});
      assertGateRefusal(result);
      expect(result.content[0]?.text).toContain('extension ".sh"');
    });
  });

  describe("Sandbox env override", () => {
    it("TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY=1 permits a sandbox-outside path when extension still matches", async () => {
      process.env["TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY"] = "1";
      registerResumeTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_resume_upload");
      // /tmp is outside the default sandbox. Extension `.pdf` is in the
      // resume allowlist. With bypass set, the gate accepts the path
      // and the apply path runs — the resume.upload mock throws on call
      // and the resume tool's try/catch maps the throw to a
      // (UNKNOWN)-coded ToolErrorResponse (NOT VALIDATION_ERROR). The
      // distinguishing assertion: error code is UNKNOWN (apply-path
      // failure), not VALIDATION_ERROR (gate refusal).
      const result = (await handler({ filePath: "/tmp/resume.pdf" }, {})) as ToolErrorShape;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text ?? "").toContain("(Code: UNKNOWN)");
      expect(result.content[0]?.text ?? "").toContain("must NOT be called when the gate refuses");
      expect(result.content[0]?.text ?? "").not.toContain("(Code: VALIDATION_ERROR)");
    });

    it("TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY=1 does NOT relax the extension allowlist (defense-in-depth)", async () => {
      process.env["TTCTL_MCP_FILE_UPLOAD_ALLOW_ANY"] = "1";
      registerResumeTools(server, buildAuthSuccessCtx());
      const handler = getToolHandler(server, "ttctl_profile_resume_upload");
      // Even with bypass set, `/tmp/id_rsa` (no extension) is refused
      // by the extension gate.
      const result = await handler({ filePath: "/tmp/id_rsa" }, {});
      assertGateRefusal(result);
      expect(result.content[0]?.text).toContain('extension "<none>"');
    });
  });
});
