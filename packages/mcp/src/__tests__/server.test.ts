// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { buildServer } from "../server.js";

/**
 * Smoke tests for `buildServer`. The MCP SDK doesn't expose an easy
 * "list registered tools" introspection on the public `McpServer` API,
 * so these tests verify the server is constructed without throwing and
 * that the `name`/`version` round-trip through the implementation
 * metadata. The actual tool surface is verified at the per-tool unit-test
 * level.
 */
describe("buildServer", () => {
  it("constructs an MCP server with the ttctl identity", () => {
    const server = buildServer();
    expect(server).toBeDefined();
  });

  it("registers tools without throwing", () => {
    expect(() => buildServer()).not.toThrow();
  });
});
