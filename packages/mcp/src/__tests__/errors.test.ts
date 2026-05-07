// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { AuthRevokedError, Cf403Error, Cf403PersistentError, SchedulerBearerExpired } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { ttctlErrorToToolResponse, ttctlErrorToToolResponseOrNull } from "../errors.js";

describe("ttctlErrorToToolResponse (#77 MCP presentation)", () => {
  it("renders AuthRevokedError as a structured isError response with Error/Recovery/Code blocks", () => {
    const response = ttctlErrorToToolResponse(new AuthRevokedError("Session is invalid or expired."));

    expect(response).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: [
            "Error: Session is invalid or expired.",
            "",
            "Recovery: Run `ttctl auth signin` to re-authenticate.",
            "",
            "(Code: AUTH_REVOKED)",
          ].join("\n"),
        },
      ],
    });
  });

  it("preserves Cf403Error multi-line message verbatim in the text content", () => {
    const err = new Cf403Error("talent-profile", "https://example.com/api");
    const response = ttctlErrorToToolResponse(err);
    const text = response.content[0].text;

    expect(response.isError).toBe(true);
    expect(response.content[0].type).toBe("text");
    expect(text).toContain('Error: Cloudflare returned HTTP 403 from surface "talent-profile"');
    expect(text).toContain("Recovery: ");
    expect(text).toContain("(Code: CF_403_CLEARANCE)");
  });

  it("renders Cf403PersistentError with the persistent-block code", () => {
    const response = ttctlErrorToToolResponse(new Cf403PersistentError("scheduler", "https://example.com/api"));
    expect(response.content[0].text).toContain("(Code: CF_403_PERSISTENT)");
  });

  it("renders SchedulerBearerExpired with the bearer-expiry recovery hint", () => {
    const response = ttctlErrorToToolResponse(new SchedulerBearerExpired());
    expect(response.content[0].text).toContain("re-minted automatically");
    expect(response.content[0].text).toContain("(Code: SCHEDULER_BEARER_EXPIRED)");
  });
});

describe("ttctlErrorToToolResponseOrNull", () => {
  it("returns the tool response for any TtctlError subclass", () => {
    expect(ttctlErrorToToolResponseOrNull(new AuthRevokedError())).not.toBeNull();
    expect(ttctlErrorToToolResponseOrNull(new Cf403Error("talent-profile", "x"))).not.toBeNull();
    expect(ttctlErrorToToolResponseOrNull(new Cf403PersistentError("talent-profile", "x"))).not.toBeNull();
    expect(ttctlErrorToToolResponseOrNull(new SchedulerBearerExpired())).not.toBeNull();
  });

  it("returns null for non-TtctlError values so callers can fall through", () => {
    expect(ttctlErrorToToolResponseOrNull(new Error("generic"))).toBeNull();
    expect(ttctlErrorToToolResponseOrNull("string error")).toBeNull();
    expect(ttctlErrorToToolResponseOrNull(null)).toBeNull();
    expect(ttctlErrorToToolResponseOrNull(undefined)).toBeNull();
  });
});
