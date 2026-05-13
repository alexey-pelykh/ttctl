// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type McpAuthResolveRecord,
  type McpDebugRecord,
  type McpDiagnosticLogger,
  type McpToolInvokeEndRecord,
  type McpToolInvokeStartRecord,
  type McpTransportErrorRecord,
  emitMcpAuthResolve,
  emitMcpDebug,
  extractTransportStatus,
  extractTransportSurface,
  getMcpDiagnosticLogger,
  isTransportError,
  redactToolArgs,
  resetMcpDiagnosticLogger,
  setMcpDiagnosticLogger,
  wrapToolHandler,
} from "../diagnostic.js";

/**
 * Unit tests for the MCP-side diagnostic taxonomy (issue #224).
 *
 * Coverage tracks the four-event scope:
 *   - `mcp_tool_invoke_start` / `mcp_tool_invoke_end` (wrapped via
 *     `wrapToolHandler`)
 *   - `mcp_auth_resolve` (via `emitMcpAuthResolve`)
 *   - `mcp_transport_error` (emitted by `wrapToolHandler` on
 *     transport-class throws)
 *
 * Plus the cross-cutting bearer-absence invariant: no record variant
 * may carry a bearer token, and the runtime substring check covers
 * `args_redacted` (the only slot where client-supplied data flows in).
 *
 * Logger injection is the primary test affordance — every test installs
 * a `captured: McpDebugRecord[]` logger via `setMcpDiagnosticLogger`,
 * runs the path under test, and asserts on `captured` directly. The
 * env-gated default path is exercised through dynamic re-import so V8's
 * module-load capture of `TTCTL_DEBUG_MCP` reflects the per-test env
 * state.
 */
describe("@ttctl/mcp diagnostic (issue #224)", () => {
  let captured: McpDebugRecord[];
  let logger: McpDiagnosticLogger;

  beforeEach(() => {
    captured = [];
    logger = (record): void => {
      captured.push(record);
    };
    setMcpDiagnosticLogger(logger);
  });

  afterEach(() => {
    resetMcpDiagnosticLogger();
  });

  describe("logger injection lifecycle", () => {
    it("setMcpDiagnosticLogger replaces the active logger", () => {
      expect(getMcpDiagnosticLogger()).toBe(logger);
    });

    it("resetMcpDiagnosticLogger restores the default logger", () => {
      resetMcpDiagnosticLogger();
      const restored = getMcpDiagnosticLogger();
      expect(restored).not.toBe(logger);
    });

    it("emitMcpDebug routes through the injected logger regardless of env", () => {
      emitMcpDebug(
        (): McpToolInvokeStartRecord => ({
          ts: "2026-05-13T00:00:00.000Z",
          event: "mcp_tool_invoke_start",
          tool: "ttctl_smoke_tool",
          args_redacted: { foo: "bar" },
        }),
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]?.event).toBe("mcp_tool_invoke_start");
    });
  });

  describe("wrapToolHandler — start/end events", () => {
    it("emits mcp_tool_invoke_start BEFORE the handler runs and mcp_tool_invoke_end AFTER", async () => {
      const callOrder: string[] = [];
      const handler = async (input: { foo: string }): Promise<{ content: [{ type: "text"; text: string }] }> => {
        callOrder.push("handler");
        await Promise.resolve();
        return { content: [{ type: "text", text: `got ${input.foo}` }] };
      };
      const wrapped = wrapToolHandler("ttctl_test_tool", handler);

      const result = await wrapped({ foo: "bar" });

      expect(result.content[0].text).toBe("got bar");
      expect(captured.map((r) => r.event)).toEqual(["mcp_tool_invoke_start", "mcp_tool_invoke_end"]);
      const start = captured[0] as McpToolInvokeStartRecord;
      expect(start.tool).toBe("ttctl_test_tool");
      expect(start.args_redacted).toEqual({ foo: "bar" });
      const end = captured[1] as McpToolInvokeEndRecord;
      expect(end.tool).toBe("ttctl_test_tool");
      expect(end.status).toBe("ok");
      expect(typeof end.duration_ms).toBe("number");
      expect(end.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("emits status='error' when handler returns isError: true", async () => {
      const handler = async (): Promise<{ isError: true; content: [{ type: "text"; text: string }] }> => {
        return Promise.resolve({ isError: true, content: [{ type: "text", text: "bad" }] });
      };
      const wrapped = wrapToolHandler("ttctl_err_tool", handler);

      await wrapped();

      const end = captured.find((r) => r.event === "mcp_tool_invoke_end") as McpToolInvokeEndRecord;
      expect(end.status).toBe("error");
    });

    it("emits status='throw' and re-throws on uncaught exception", async () => {
      const handler = async (): Promise<{ content: [{ type: "text"; text: string }] }> => {
        await Promise.resolve();
        throw new Error("boom");
      };
      const wrapped = wrapToolHandler("ttctl_throw_tool", handler);

      await expect(wrapped()).rejects.toThrow("boom");

      const end = captured.find((r) => r.event === "mcp_tool_invoke_end") as McpToolInvokeEndRecord;
      expect(end.status).toBe("throw");
    });

    it("emits mcp_transport_error AFTER mcp_tool_invoke_end when error is Cf403Error", async () => {
      class Cf403Error extends Error {
        override readonly name = "Cf403Error";
        readonly surface = "talent-profile";
      }
      const handler = async (): Promise<{ content: [{ type: "text"; text: string }] }> => {
        await Promise.resolve();
        throw new Cf403Error("Cloudflare 403");
      };
      const wrapped = wrapToolHandler("ttctl_cf_tool", handler);

      await expect(wrapped()).rejects.toThrow("Cloudflare 403");

      expect(captured.map((r) => r.event)).toEqual([
        "mcp_tool_invoke_start",
        "mcp_tool_invoke_end",
        "mcp_transport_error",
      ]);
      const transport = captured[2] as McpTransportErrorRecord;
      expect(transport.surface).toBe("talent-profile");
      expect(transport.error_class).toBe("Cf403Error");
      expect(transport.status).toBe(403);
      expect(transport.tool).toBe("ttctl_cf_tool");
    });

    it("does NOT emit mcp_transport_error for non-transport throws", async () => {
      const handler = async (): Promise<{ content: [{ type: "text"; text: string }] }> => {
        await Promise.resolve();
        throw new TypeError("not a transport thing");
      };
      const wrapped = wrapToolHandler("ttctl_type_tool", handler);

      await expect(wrapped()).rejects.toThrow("not a transport thing");

      const transportEvents = captured.filter((r) => r.event === "mcp_transport_error");
      expect(transportEvents).toHaveLength(0);
    });

    it("forwards the SDK's two-argument callback signature (input, extra)", async () => {
      let observedExtra: unknown;
      const handler = async (
        input: { foo: string },
        extra: { sessionId: string },
      ): Promise<{ content: [{ type: "text"; text: string }] }> => {
        observedExtra = extra;
        await Promise.resolve();
        return { content: [{ type: "text", text: input.foo }] };
      };
      const wrapped = wrapToolHandler("ttctl_two_arg_tool", handler);

      await wrapped({ foo: "x" }, { sessionId: "s1" });

      expect(observedExtra).toEqual({ sessionId: "s1" });
    });
  });

  describe("wrapToolHandler — bearer absence (R-7 invariant)", () => {
    /**
     * The bearer token must NEVER appear in any emission shape. The
     * type system enforces this at construction (no record variant has
     * a bearer slot), and the runtime substring check below catches
     * accidental leakage via `args_redacted` — the one slot where
     * client-supplied data flows into the record.
     */
    const FAKE_BEARER = "user_abc123def456abc123def456_0123456789ABCDEFGHIJ";

    it("redacts bearer-shaped strings in args_redacted", async () => {
      const handler = async (): Promise<{ content: [{ type: "text"; text: string }] }> => {
        return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
      };
      const wrapped = wrapToolHandler("ttctl_bearer_arg_tool", handler);

      await wrapped({ secretField: FAKE_BEARER });

      const serialized = JSON.stringify(captured);
      expect(serialized).not.toContain(FAKE_BEARER);
    });

    it("redacts secret-named fields (password, token) in args_redacted", async () => {
      const handler = async (): Promise<{ content: [{ type: "text"; text: string }] }> => {
        return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
      };
      const wrapped = wrapToolHandler("ttctl_secret_field_tool", handler);

      await wrapped({ password: "hunter2", token: "tok-xyz", visible: "ok" });

      const start = captured[0] as McpToolInvokeStartRecord;
      // redactBody from core replaces secret-named field values with
      // ***REDACTED*** — verify both that the literal values are absent
      // and that the field names themselves are preserved (so operators
      // can see what was sent).
      const serialized = JSON.stringify(start.args_redacted);
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("tok-xyz");
      expect(serialized).toContain("visible");
    });

    it("does not include bearer in mcp_transport_error error_class or status", async () => {
      class Cf403Error extends Error {
        override readonly name = "Cf403Error";
        readonly surface = "talent-profile";
      }
      const handler = async (): Promise<{ content: [{ type: "text"; text: string }] }> => {
        await Promise.resolve();
        throw new Cf403Error(`Cf403 (bearer ${FAKE_BEARER})`);
      };
      const wrapped = wrapToolHandler("ttctl_cf_bearer_tool", handler);

      await expect(wrapped()).rejects.toThrow();

      // The transport_error record carries error_class + status + surface
      // ONLY — never the message. Bearer-in-message is therefore not
      // a leak path.
      const transport = captured.find((r) => r.event === "mcp_transport_error") as McpTransportErrorRecord;
      const serialized = JSON.stringify(transport);
      expect(serialized).not.toContain(FAKE_BEARER);
    });
  });

  describe("emitMcpAuthResolve — config path mtime tracking", () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-mcp-diag-test-"));
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("emits mcp_auth_resolve with mtime_ms and outcome='ok' when token present", () => {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  token: smoke\n", { mode: 0o600 });

      emitMcpAuthResolve(configPath, "ok", true);

      expect(captured).toHaveLength(1);
      const record = captured[0] as McpAuthResolveRecord;
      expect(record.event).toBe("mcp_auth_resolve");
      expect(record.outcome).toBe("ok");
      expect(record.token_fresh).toBe(true);
      expect(typeof record.mtime_ms).toBe("number");
    });

    it("emits outcome='unauthenticated' with token_fresh=false when no token", () => {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  credentials: op://Personal/x\n", { mode: 0o600 });

      emitMcpAuthResolve(configPath, "unauthenticated", false);

      const record = captured[0] as McpAuthResolveRecord;
      expect(record.outcome).toBe("unauthenticated");
      expect(record.token_fresh).toBe(false);
    });

    it("emits outcome='config_error' with mtime_ms=null when path is missing", () => {
      const missing = join(tmpRoot, "nope.yaml");

      emitMcpAuthResolve(missing, "config_error", false);

      const record = captured[0] as McpAuthResolveRecord;
      expect(record.outcome).toBe("config_error");
      expect(record.mtime_ms).toBeNull();
      expect(record.token_fresh).toBe(false);
    });

    it("reports token_fresh=false on the SECOND resolve when mtime is unchanged", () => {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  token: smoke\n", { mode: 0o600 });

      emitMcpAuthResolve(configPath, "ok", true);
      captured = [];
      emitMcpAuthResolve(configPath, "ok", true);

      const second = captured[0] as McpAuthResolveRecord;
      expect(second.token_fresh).toBe(false);
    });

    it("reports token_fresh=true when mtime moves forward (post-rotation)", () => {
      const configPath = join(tmpRoot, ".ttctl.yaml");
      writeFileSync(configPath, "auth:\n  token: first\n", { mode: 0o600 });
      emitMcpAuthResolve(configPath, "ok", true);
      captured = [];

      // Bump mtime by an explicit utimes call (mtime resolution on some
      // filesystems is whole-seconds, so a microsecond-fast write may
      // not move mtime forward enough to register).
      const past = new Date(Date.now() + 5_000);
      utimesSync(configPath, past, past);

      emitMcpAuthResolve(configPath, "ok", true);

      const second = captured[0] as McpAuthResolveRecord;
      expect(second.token_fresh).toBe(true);
    });
  });

  describe("transport-error helpers", () => {
    it("isTransportError recognizes Cf403Error / Cf403PersistentError / SchedulerBearerExpired", () => {
      const cf403 = Object.assign(new Error("c"), { name: "Cf403Error" });
      const cfPersistent = Object.assign(new Error("c"), { name: "Cf403PersistentError" });
      const scheduler = Object.assign(new Error("s"), { name: "SchedulerBearerExpired" });
      const other = new TypeError("nope");
      expect(isTransportError(cf403)).toBe(true);
      expect(isTransportError(cfPersistent)).toBe(true);
      expect(isTransportError(scheduler)).toBe(true);
      expect(isTransportError(other)).toBe(false);
    });

    it("extractTransportSurface honors Cf403Error.surface and falls back to 'unknown'", () => {
      const tp = Object.assign(new Error("c"), { name: "Cf403Error", surface: "talent-profile" });
      const sched = Object.assign(new Error("s"), { name: "SchedulerBearerExpired" });
      const mystery = Object.assign(new Error("?"), { name: "Other" });
      expect(extractTransportSurface(tp)).toBe("talent-profile");
      expect(extractTransportSurface(sched)).toBe("scheduler");
      expect(extractTransportSurface(mystery)).toBe("unknown");
    });

    it("extractTransportStatus maps known classes to HTTP codes", () => {
      expect(extractTransportStatus(Object.assign(new Error(""), { name: "Cf403Error" }))).toBe(403);
      expect(extractTransportStatus(Object.assign(new Error(""), { name: "Cf403PersistentError" }))).toBe(403);
      expect(extractTransportStatus(Object.assign(new Error(""), { name: "SchedulerBearerExpired" }))).toBe(401);
      expect(extractTransportStatus(Object.assign(new Error(""), { status: 429 }))).toBe(429);
      expect(extractTransportStatus(new Error("no status"))).toBeNull();
    });
  });

  describe("redactToolArgs", () => {
    it("redacts the canonical bearer pattern (user_<24hex>_<20alnum>)", () => {
      const out = redactToolArgs({ note: "user_abc123def456abc123def456_0123456789ABCDEFGHIJ" });
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain("user_abc123def456abc123def456_0123456789ABCDEFGHIJ");
    });

    it("redacts secret-named fields by key", () => {
      const out = redactToolArgs({ password: "p", token: "t", visible: "v" });
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain('"p"');
      expect(serialized).not.toContain('"t"');
      expect(serialized).toContain("visible");
    });

    it("returns primitives and null unchanged", () => {
      expect(redactToolArgs(null)).toBeNull();
      expect(redactToolArgs(undefined)).toBeUndefined();
      expect(redactToolArgs(42)).toBe(42);
    });
  });

  describe("default logger — TTCTL_DEBUG_MCP env-gate (round-trip)", () => {
    /**
     * The default logger reads `TTCTL_DEBUG_MCP` at module load. To
     * exercise both env-set and env-unset paths in the SAME test file
     * we re-import the module after mutating `process.env` and resetting
     * the module registry. `setMcpDiagnosticLogger` is the preferred
     * test injection point — this section pins the env path for
     * regression coverage.
     */
    const originalEnv = process.env["TTCTL_DEBUG_MCP"];

    afterEach(() => {
      if (originalEnv === undefined) delete process.env["TTCTL_DEBUG_MCP"];
      else process.env["TTCTL_DEBUG_MCP"] = originalEnv;
    });

    it("emits NO stderr writes when TTCTL_DEBUG_MCP is unset", async () => {
      delete process.env["TTCTL_DEBUG_MCP"];
      vi.resetModules();
      const mod = await import("../diagnostic.js");

      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown): boolean => {
        if (typeof chunk === "string") writes.push(chunk);
        return true;
      }) as never);
      try {
        // Use the freshly-imported module's emit so the env capture is
        // re-evaluated. The default logger is in effect.
        mod.emitMcpDebug(
          (): McpToolInvokeStartRecord => ({
            ts: "2026-05-13T00:00:00.000Z",
            event: "mcp_tool_invoke_start",
            tool: "ttctl_env_off_tool",
            args_redacted: {},
          }),
        );
      } finally {
        spy.mockRestore();
      }
      expect(writes).toHaveLength(0);
    });

    it("emits JSON-per-line on stderr when TTCTL_DEBUG_MCP=1", async () => {
      process.env["TTCTL_DEBUG_MCP"] = "1";
      vi.resetModules();
      const mod = await import("../diagnostic.js");

      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown): boolean => {
        if (typeof chunk === "string") writes.push(chunk);
        else if (chunk instanceof Uint8Array) writes.push(Buffer.from(chunk).toString("utf8"));
        return true;
      }) as never);
      try {
        mod.emitMcpDebug(
          (): McpToolInvokeStartRecord => ({
            ts: "2026-05-13T00:00:00.000Z",
            event: "mcp_tool_invoke_start",
            tool: "ttctl_env_on_tool",
            args_redacted: {},
          }),
        );
      } finally {
        spy.mockRestore();
      }
      expect(writes).toHaveLength(1);
      expect(writes[0]?.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(writes[0]?.trim() ?? "") as McpDebugRecord;
      expect(parsed.event).toBe("mcp_tool_invoke_start");
    });

    it("emits NO records when TTCTL_DEBUG_MCP is empty string", async () => {
      process.env["TTCTL_DEBUG_MCP"] = "";
      vi.resetModules();
      const mod = await import("../diagnostic.js");

      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown): boolean => {
        if (typeof chunk === "string") writes.push(chunk);
        return true;
      }) as never);
      try {
        mod.emitMcpDebug(
          (): McpToolInvokeStartRecord => ({
            ts: "2026-05-13T00:00:00.000Z",
            event: "mcp_tool_invoke_start",
            tool: "ttctl_env_empty_tool",
            args_redacted: {},
          }),
        );
      } finally {
        spy.mockRestore();
      }
      expect(writes).toHaveLength(0);
    });
  });
});
