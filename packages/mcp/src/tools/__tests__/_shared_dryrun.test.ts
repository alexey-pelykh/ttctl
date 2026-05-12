// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { buildMcpDryRunPreview, dryRunResponse } from "../_shared.js";

/**
 * Pin the MCP-layer dry-run primitives introduced for issue #165:
 *
 *   - {@link dryRunResponse} — uniform `{ ok: true, dryRun: true, preview }`
 *     envelope every tool emits on its `dryRun: true` branch.
 *   - {@link buildMcpDryRunPreview} — constructs a {@link DryRunPreview}
 *     at the MCP layer for tools whose core service does NOT carry its
 *     own `dryRun` option.
 *
 * Transport invocations are NOT mocked here because both helpers are
 * pure — `buildDryRunPreview` (the underlying core primitive) is a
 * pure projection over the supplied {@link TransportRequest} and these
 * tests deliberately observe that.
 */
describe("dryRunResponse", () => {
  it("returns a JSON tool-success envelope with ok/dryRun/preview shape", () => {
    const result = dryRunResponse({
      surface: "mobile-gateway",
      transport: "stock",
      endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
      operationName: "TalentJobActivityList",
      variables: { first: 20 },
      headers: { authorization: "Token token=<redacted>" },
    });

    expect(result.content[0]?.type).toBe("text");
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      ok: boolean;
      dryRun: boolean;
      preview: { operationName: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.preview.operationName).toBe("TalentJobActivityList");
  });
});

describe("buildMcpDryRunPreview", () => {
  it("constructs a preview without invoking transport (stock surface)", () => {
    const preview = buildMcpDryRunPreview(
      "TalentJobActivityList",
      "mobile-gateway",
      { first: 20, keywords: ["typescript"] },
      "user_secret_bearer_token",
    );

    expect(preview.surface).toBe("mobile-gateway");
    expect(preview.transport).toBe("stock");
    expect(preview.endpoint).toBe("https://www.toptal.com/gateway/graphql/talent/graphql");
    expect(preview.operationName).toBe("TalentJobActivityList");
    expect(preview.variables).toEqual({ first: 20, keywords: ["typescript"] });
  });

  it("redacts the bearer token in headers (impersonated surface)", () => {
    const preview = buildMcpDryRunPreview(
      "UpdateBasicInfo",
      "talent-profile",
      { input: { profileId: "p1", profile: { about: "hi" } } },
      "user_secret_bearer_token_must_not_leak",
    );

    expect(preview.transport).toBe("impersonated");
    expect(preview.headers["authorization"]).toBe("Token token=<redacted>");
    // Defense-in-depth: no field on the preview should carry the literal bearer.
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain("user_secret_bearer_token_must_not_leak");
  });

  it("returns an empty variables object when no variables are supplied", () => {
    const preview = buildMcpDryRunPreview("Ping", "mobile-gateway", {}, "user_tok");
    expect(preview.variables).toEqual({});
  });
});
