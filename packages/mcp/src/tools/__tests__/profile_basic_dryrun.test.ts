// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock of @ttctl/core — only override the per-tool core
// functions whose apply paths we want to assert NEVER fire on the
// dry-run branch. The `buildDryRunPreview` primitive is left untouched
// so the produced preview is the real wire shape.
vi.mock("@ttctl/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ttctl/core")>();
  return {
    ...actual,
    profile: {
      ...actual.profile,
      basic: {
        ...actual.profile.basic,
        show: vi.fn(),
        getBasicInfo: vi.fn(),
        photoShow: vi.fn(),
        photoUpload: vi.fn(),
      },
    },
  };
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { profile } from "@ttctl/core";
import type { DryRunPreview } from "@ttctl/core";

import type { ToolRegistrationContext } from "../_shared.js";
import { registerProfileBasicPhotoShowTool } from "../profile_basic_photo_show.js";
import { registerProfileBasicPhotoUploadTool } from "../profile_basic_photo_upload.js";
import { registerProfileBasicShowTool } from "../profile_basic_show.js";

/**
 * Per-tool dry-run path assertions for the three read-only / MCP-level
 * profile.basic tools (issue #165). The mutating `profile_basic_update`
 * uses core's passthrough dryRun and is pinned in
 * `profile_basic_update.test.ts` separately.
 *
 * Each test asserts the issue's AC:
 *
 *   GIVEN: tool called with `dryRun: true`
 *   WHEN: handler executes
 *   THEN: response is `{ ok: true, dryRun: true, preview }` with the
 *         expected operationName / surface / variables
 *   AND: the underlying core function is NEVER invoked (no transport)
 */

const MOCKED_SHOW = profile.basic.show as ReturnType<typeof vi.fn>;
const MOCKED_GET_BASIC_INFO = profile.basic.getBasicInfo as ReturnType<typeof vi.fn>;
const MOCKED_PHOTO_SHOW = profile.basic.photoShow as ReturnType<typeof vi.fn>;
const MOCKED_PHOTO_UPLOAD = profile.basic.photoUpload as ReturnType<typeof vi.fn>;

function buildTokenSuccessCtx(token = "user_test_token"): ToolRegistrationContext {
  return {
    loadTokenForTool: vi.fn().mockResolvedValue({ token }),
    resolveToolAuth: vi.fn(() => {
      throw new Error("resolveToolAuth must not be called by these tools");
    }),
    resolveTokenForTool: vi.fn(() => {
      throw new Error("resolveTokenForTool must not be called by these tools");
    }),
  };
}

function getToolHandler(server: McpServer, name: string): (input: unknown, extra: unknown) => Promise<unknown> {
  const internals = server as unknown as { _registeredTools: Record<string, { handler: unknown }> };
  const entry = internals._registeredTools[name];
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return entry.handler as (input: unknown, extra: unknown) => Promise<unknown>;
}

interface ToolSuccessShape {
  content: { type: string; text: string }[];
}

interface DryRunEnvelope {
  ok: boolean;
  dryRun: boolean;
  preview: DryRunPreview;
}

describe("profile.basic MCP tools — dry-run paths (#165)", () => {
  let server: McpServer;

  beforeEach(() => {
    MOCKED_SHOW.mockReset();
    MOCKED_GET_BASIC_INFO.mockReset();
    MOCKED_PHOTO_SHOW.mockReset();
    MOCKED_PHOTO_UPLOAD.mockReset();
    server = new McpServer({ name: "ttctl-test", version: "0.0.0" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ttctl_profile_basic_show emits the dry-run envelope and skips both apply-path calls", async () => {
    registerProfileBasicShowTool(server, buildTokenSuccessCtx("tok_show"));
    const handler = getToolHandler(server, "ttctl_profile_basic_show");
    const result = (await handler({ dryRun: true }, {})) as ToolSuccessShape;

    expect(MOCKED_SHOW).not.toHaveBeenCalled();
    expect(MOCKED_GET_BASIC_INFO).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("ProfileShow");
    expect(parsed.preview.surface).toBe("mobile-gateway");
    expect(parsed.preview.transport).toBe("stock");
    expect(parsed.preview.variables).toEqual({});
    expect(parsed.preview.headers["authorization"]).toBe("Token token=<redacted>");
  });

  it("ttctl_profile_basic_photo_show emits the dry-run envelope with a profileId placeholder and skips photoShow()", async () => {
    registerProfileBasicPhotoShowTool(server, buildTokenSuccessCtx("tok_ps"));
    const handler = getToolHandler(server, "ttctl_profile_basic_photo_show");
    const result = (await handler({ dryRun: true }, {})) as ToolSuccessShape;

    expect(MOCKED_PHOTO_SHOW).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("GET_PHOTO");
    expect(parsed.preview.surface).toBe("talent-profile");
    expect(parsed.preview.transport).toBe("impersonated");
    expect(parsed.preview.variables).toEqual({ profileId: profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER });
    expect(parsed.preview.headers["authorization"]).toBe("Token token=<redacted>");
  });

  it("ttctl_profile_basic_photo_upload emits the dry-run envelope with placeholders and skips photoUpload()", async () => {
    registerProfileBasicPhotoUploadTool(server, buildTokenSuccessCtx("tok_pu"));
    const handler = getToolHandler(server, "ttctl_profile_basic_photo_upload");
    const result = (await handler({ file: "/tmp/headshot.jpg", dryRun: true }, {})) as ToolSuccessShape;

    expect(MOCKED_PHOTO_UPLOAD).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content[0]?.text ?? "") as DryRunEnvelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("UploadProfilePhoto");
    expect(parsed.preview.surface).toBe("talent-profile");
    expect(parsed.preview.transport).toBe("impersonated");
    const input = (parsed.preview.variables as { input: { profileId: string; photo: unknown } }).input;
    expect(input.profileId).toBe(profile.basic.DRY_RUN_PROFILE_ID_PLACEHOLDER);
    expect(input.photo).toBeNull();
    expect(parsed.preview.headers["authorization"]).toBe("Token token=<redacted>");
  });

  it("ttctl_profile_basic_show apply path calls both show() and getBasicInfo() and returns the merged payload", async () => {
    MOCKED_SHOW.mockResolvedValueOnce({ viewer: { viewerRole: { profileId: "p1" } } });
    MOCKED_GET_BASIC_INFO.mockResolvedValueOnce({
      profileId: "p1",
      bio: "Senior engineer.",
      headline: "Reliable systems.",
      languages: [{ id: "lang_en", name: "English" }],
    });
    registerProfileBasicShowTool(server, buildTokenSuccessCtx());
    const handler = getToolHandler(server, "ttctl_profile_basic_show");
    const result = (await handler({}, {})) as ToolSuccessShape;

    expect(MOCKED_SHOW).toHaveBeenCalledTimes(1);
    expect(MOCKED_GET_BASIC_INFO).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      profile: { viewer: { viewerRole: { profileId: string } } };
      basicInfo: { bio: string | null; headline: string | null; languages: { id: string; name: string }[] } | null;
    };
    expect(parsed.profile.viewer.viewerRole.profileId).toBe("p1");
    expect(parsed.basicInfo?.bio).toBe("Senior engineer.");
    expect(parsed.basicInfo?.headline).toBe("Reliable systems.");
    expect(parsed.basicInfo?.languages).toEqual([{ id: "lang_en", name: "English" }]);
  });

  it("ttctl_profile_basic_show apply path degrades to basicInfo: null when getBasicInfo() throws a non-session error", async () => {
    MOCKED_SHOW.mockResolvedValueOnce({ viewer: { viewerRole: { profileId: "p1" } } });
    MOCKED_GET_BASIC_INFO.mockRejectedValueOnce(new profile.basic.ProfileError("GRAPHQL_ERROR", "talent-profile blip"));
    registerProfileBasicShowTool(server, buildTokenSuccessCtx());
    const handler = getToolHandler(server, "ttctl_profile_basic_show");
    const result = (await handler({}, {})) as ToolSuccessShape;

    expect(MOCKED_SHOW).toHaveBeenCalledTimes(1);
    expect(MOCKED_GET_BASIC_INFO).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      profile: { viewer: { viewerRole: { profileId: string } } };
      basicInfo: unknown;
    };
    expect(parsed.profile.viewer.viewerRole.profileId).toBe("p1");
    expect(parsed.basicInfo).toBeNull();
  });
});
