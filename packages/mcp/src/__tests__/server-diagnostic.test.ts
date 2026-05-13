// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type McpAuthResolveRecord,
  type McpDebugRecord,
  type McpToolInvokeEndRecord,
  type McpToolInvokeStartRecord,
  resetMcpDiagnosticLogger,
  setMcpDiagnosticLogger,
} from "../diagnostic.js";
import { buildServer } from "../server.js";

/**
 * End-to-end wiring tests for issue #224. Verifies the
 * `buildServer` -> `registerAllTools` -> per-tool callback chain emits
 * the expected MCP diagnostic events when a tool is invoked.
 *
 * The MCP SDK doesn't expose a stable public API for "invoke a
 * registered tool's callback by name", so we reach into
 * `server._registeredTools[name].callback` — the same internal map the
 * existing `tools.test.ts` and `dryrun-smoke.test.ts` use. If a future
 * SDK version renames that field, update the helper below; the rest of
 * the test is structural.
 */

type RegisteredToolEntry = {
  // The SDK stores the post-monkey-patch handler here, so invoking it
  // exercises the diagnostic-instrumentation contract. Field name
  // matches the SDK's internal `_registeredTools` map (also used by
  // `dryrun-smoke.test.ts` and `tools.test.ts`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => unknown;
};

function getRegisteredToolCallback(
  server: ReturnType<typeof buildServer>,
  name: string,
): RegisteredToolEntry["handler"] {
  const internals = server as unknown as { _registeredTools: Record<string, RegisteredToolEntry> };
  const entry = internals._registeredTools[name];
  if (entry === undefined) throw new Error(`tool ${name} not registered`);
  return entry.handler;
}

describe("buildServer — diagnostic instrumentation wiring (#224)", () => {
  let tmpRoot: string;
  let captured: McpDebugRecord[];
  let savedEnv: { TTCTL_CONFIG_FILE?: string; HOME?: string; USERPROFILE?: string };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-mcp-server-diag-test-"));
    captured = [];
    setMcpDiagnosticLogger((record): void => {
      captured.push(record);
    });
    savedEnv = {
      ...(process.env["TTCTL_CONFIG_FILE"] !== undefined
        ? { TTCTL_CONFIG_FILE: process.env["TTCTL_CONFIG_FILE"] }
        : {}),
      ...(process.env["HOME"] !== undefined ? { HOME: process.env["HOME"] } : {}),
      ...(process.env["USERPROFILE"] !== undefined ? { USERPROFILE: process.env["USERPROFILE"] } : {}),
    };
    delete process.env["TTCTL_CONFIG_FILE"];
    process.env["HOME"] = tmpRoot;
    process.env["USERPROFILE"] = tmpRoot;
  });

  afterEach(() => {
    resetMcpDiagnosticLogger();
    if (savedEnv.TTCTL_CONFIG_FILE !== undefined) process.env["TTCTL_CONFIG_FILE"] = savedEnv.TTCTL_CONFIG_FILE;
    else delete process.env["TTCTL_CONFIG_FILE"];
    if (savedEnv.HOME !== undefined) process.env["HOME"] = savedEnv.HOME;
    else delete process.env["HOME"];
    if (savedEnv.USERPROFILE !== undefined) process.env["USERPROFILE"] = savedEnv.USERPROFILE;
    else delete process.env["USERPROFILE"];
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("wraps every tool callback so invocation emits start + end events", async () => {
    // A config with NO token forces an `unauthenticated` early-return,
    // which is the cheapest tool invocation we can drive — no transport
    // call, no live API. The diagnostic-instrumentation contract must
    // still fire start + end + auth_resolve.
    const configPath = join(tmpRoot, "no-token.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    const server = buildServer({ configPath });
    const cb = getRegisteredToolCallback(server, "ttctl_profile_basic_show");

    // The MCP SDK's tool callback signature is `(input, extra)`. The
    // `extra` parameter is RequestHandlerExtra; we pass a minimal stub
    // that covers the surface the basic_show tool reads (which is
    // nothing today — the tool only uses `input`).
    await cb({}, { signal: new AbortController().signal });

    const events = captured.map((r) => r.event);
    expect(events).toContain("mcp_tool_invoke_start");
    expect(events).toContain("mcp_tool_invoke_end");
    expect(events).toContain("mcp_auth_resolve");

    const start = captured.find((r) => r.event === "mcp_tool_invoke_start") as McpToolInvokeStartRecord;
    expect(start.tool).toBe("ttctl_profile_basic_show");

    const end = captured.find((r) => r.event === "mcp_tool_invoke_end") as McpToolInvokeEndRecord;
    expect(end.tool).toBe("ttctl_profile_basic_show");
    // unauthenticated returns isError: true → status = "error" (NOT "throw")
    expect(end.status).toBe("error");
  });

  it("emits mcp_auth_resolve with outcome='unauthenticated' when token is missing", async () => {
    const configPath = join(tmpRoot, "no-token.yaml");
    writeFileSync(configPath, "auth:\n  credentials: op://Personal/ttctl\n", { mode: 0o600 });

    const server = buildServer({ configPath });
    const cb = getRegisteredToolCallback(server, "ttctl_profile_basic_show");

    await cb({}, { signal: new AbortController().signal });

    const auth = captured.find((r) => r.event === "mcp_auth_resolve") as McpAuthResolveRecord;
    expect(auth.outcome).toBe("unauthenticated");
    expect(auth.token_fresh).toBe(false);
  });

  it("emits mcp_auth_resolve with outcome='ok' when token is present", async () => {
    const configPath = join(tmpRoot, "with-token.yaml");
    writeFileSync(configPath, "auth:\n  token: user_aaaaaaaaaaaaaaaaaaaaaaaaa_AAAAAAAAAAAAAAAAAAAA\n", {
      mode: 0o600,
    });

    const server = buildServer({ configPath });
    // Use a dryRun call so we don't fire a live HTTP request — basic_show
    // supports `dryRun: true` and short-circuits before transport.
    const cb = getRegisteredToolCallback(server, "ttctl_profile_basic_show");

    await cb({ dryRun: true }, { signal: new AbortController().signal });

    const auth = captured.find((r) => r.event === "mcp_auth_resolve") as McpAuthResolveRecord;
    expect(auth.outcome).toBe("ok");
    expect(auth.token_fresh).toBe(true);
  });

  it("does NOT leak the bearer in any emitted record", async () => {
    const FAKE_BEARER = "user_aaaaaaaaaaaaaaaaaaaaaaaaa_AAAAAAAAAAAAAAAAAAAA";
    const configPath = join(tmpRoot, "with-token.yaml");
    writeFileSync(configPath, `auth:\n  token: ${FAKE_BEARER}\n`, { mode: 0o600 });

    const server = buildServer({ configPath });
    const cb = getRegisteredToolCallback(server, "ttctl_profile_basic_show");

    await cb({ dryRun: true }, { signal: new AbortController().signal });

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain(FAKE_BEARER);
  });

  it("emits status='throw' and mcp_transport_error when callback throws a Cf403Error-like error", async () => {
    // Drive a synthetic Cf403Error through the wrapper by registering a
    // throwaway tool that simulates the transport throw. The instrument
    // applies BEFORE registerAllTools runs, so any tool registered after
    // buildServer's setup phase will also be wrapped — verifying the
    // patch applies to ALL registerTool calls (not just the bundled set).
    const configPath = join(tmpRoot, "with-token.yaml");
    writeFileSync(configPath, "auth:\n  token: user_aaaaaaaaaaaaaaaaaaaaaaaaa_AAAAAAAAAAAAAAAAAAAA\n", {
      mode: 0o600,
    });
    const server = buildServer({ configPath });

    // Register the synthetic tool AFTER buildServer; the monkey-patch is
    // applied to the same server instance.
    class Cf403Error extends Error {
      override readonly name = "Cf403Error";
      readonly surface = "talent-profile";
    }
    server.registerTool(
      "ttctl_synthetic_cf403",
      { title: "synthetic cf403", description: "synthetic", inputSchema: {} },
      async () => {
        await Promise.resolve();
        throw new Cf403Error("Cf403 synthetic");
      },
    );

    const cb = getRegisteredToolCallback(server, "ttctl_synthetic_cf403");
    await expect(cb({}, { signal: new AbortController().signal })).rejects.toThrow("Cf403 synthetic");

    const events = captured.map((r) => r.event);
    expect(events).toContain("mcp_tool_invoke_start");
    expect(events).toContain("mcp_tool_invoke_end");
    expect(events).toContain("mcp_transport_error");

    const end = captured.find((r) => r.event === "mcp_tool_invoke_end") as McpToolInvokeEndRecord;
    expect(end.status).toBe("throw");
  });
});
