// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getDiagnosticLogger,
  logTransportRequest,
  logTransportResponse,
  resetDiagnosticLogger,
  setDiagnosticLogger,
} from "../diagnostic-log.js";
import { REDACTED } from "../redact.js";

/**
 * Capture every `process.stderr.write` and `process.stdout.write`
 * invocation. The diagnostic logger MUST never touch stdout (AC #5 of
 * issue #139) — the stdout capture exists to prove negative.
 */
function captureStreams(): { stderr: string[]; stdout: string[] } {
  const stderr: string[] = [];
  const stdout: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return { stderr, stdout };
}

const BEARER = "user_abc123def456789012345678_abcdefghij1234567890";

const SAMPLE_REQUEST_HEADERS = {
  accept: "*/*",
  authorization: `Token token=${BEARER}`,
  "content-type": "application/json",
  cookie: "sid=secretvalue",
  "user-agent": "Mozilla/5.0 ... Chrome/145.0.0.0",
};

const SAMPLE_RESPONSE_HEADERS = {
  "content-type": "application/json",
  "set-cookie": "session=newvalue; HttpOnly; Secure",
  date: "Tue, 12 May 2026 10:00:00 GMT",
};

beforeEach(() => {
  resetDiagnosticLogger();
  vi.restoreAllMocks();
});

afterEach(() => {
  resetDiagnosticLogger();
  vi.restoreAllMocks();
});

describe("setDiagnosticLogger / getDiagnosticLogger / resetDiagnosticLogger", () => {
  it("defaults to 'none'", () => {
    expect(getDiagnosticLogger()).toBe("none");
  });

  it("captures 'verbose' when set", () => {
    setDiagnosticLogger("verbose");
    expect(getDiagnosticLogger()).toBe("verbose");
  });

  it("captures 'debug' when set", () => {
    setDiagnosticLogger("debug");
    expect(getDiagnosticLogger()).toBe("debug");
  });

  it("reset returns to 'none'", () => {
    setDiagnosticLogger("debug");
    resetDiagnosticLogger();
    expect(getDiagnosticLogger()).toBe("none");
  });
});

describe("logTransportRequest with level='none'", () => {
  it("is a no-op (no stderr / stdout writes)", () => {
    const streams = captureStreams();
    logTransportRequest({
      surface: "talent-profile",
      endpoint: "https://www.toptal.com/api/talent_profile/graphql",
      transport: "impersonated",
      method: "POST",
      operationName: "UpdateBasicInfo",
      headers: SAMPLE_REQUEST_HEADERS,
      body: { operationName: "UpdateBasicInfo", variables: { input: { bio: "x" } } },
    });
    expect(streams.stderr).toEqual([]);
    expect(streams.stdout).toEqual([]);
  });
});

describe("logTransportRequest with level='verbose'", () => {
  it("emits one line of `<METHOD> <endpoint> operation=<op>`", () => {
    setDiagnosticLogger("verbose");
    const streams = captureStreams();
    logTransportRequest({
      surface: "mobile-gateway",
      endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
      transport: "stock",
      method: "POST",
      operationName: "ProfileShow",
      headers: SAMPLE_REQUEST_HEADERS,
      body: { operationName: "ProfileShow" },
    });
    expect(streams.stdout).toEqual([]);
    expect(streams.stderr.length).toBe(1);
    expect(streams.stderr[0]).toBe(
      "POST https://www.toptal.com/gateway/graphql/talent/graphql operation=ProfileShow\n",
    );
  });

  it("does NOT include the bearer or cookie verbatim in the verbose line", () => {
    setDiagnosticLogger("verbose");
    const streams = captureStreams();
    logTransportRequest({
      surface: "mobile-gateway",
      endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
      transport: "stock",
      method: "POST",
      operationName: "ProfileShow",
      headers: SAMPLE_REQUEST_HEADERS,
      body: { operationName: "ProfileShow" },
    });
    const all = streams.stderr.join("");
    expect(all).not.toContain(BEARER);
    expect(all).not.toContain("secretvalue");
  });
});

describe("logTransportRequest with level='debug'", () => {
  it("emits one JSON-encoded line to stderr containing the redacted request envelope", () => {
    setDiagnosticLogger("debug");
    const streams = captureStreams();
    logTransportRequest({
      surface: "talent-profile",
      endpoint: "https://www.toptal.com/api/talent_profile/graphql",
      transport: "impersonated",
      method: "POST",
      operationName: "UpdateBasicInfo",
      headers: SAMPLE_REQUEST_HEADERS,
      body: {
        operationName: "UpdateBasicInfo",
        variables: { input: { password: "hunter2", bio: "I write code." } },
      },
    });
    expect(streams.stdout).toEqual([]);
    expect(streams.stderr.length).toBe(1);
    expect(streams.stderr[0]?.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(streams.stderr[0]?.trim() ?? "") as Record<string, unknown>;
    expect(parsed["kind"]).toBe("request");
    expect(parsed["surface"]).toBe("talent-profile");
    expect(parsed["transport"]).toBe("impersonated");
    expect(parsed["method"]).toBe("POST");
    expect(parsed["operationName"]).toBe("UpdateBasicInfo");

    const headers = parsed["headers"] as Record<string, string>;
    expect(headers["authorization"]).toBe(REDACTED);
    expect(headers["cookie"]).toBe(REDACTED);
    expect(headers["user-agent"]).toBe("Mozilla/5.0 ... Chrome/145.0.0.0");

    const body = parsed["body"] as { variables: { input: { password: string; bio: string } } };
    expect(body.variables.input.password).toBe(REDACTED);
    expect(body.variables.input.bio).toBe("I write code.");
  });

  it("the serialized debug line cannot contain the bearer or cookie value verbatim (AC #4)", () => {
    setDiagnosticLogger("debug");
    const streams = captureStreams();
    logTransportRequest({
      surface: "talent-profile",
      endpoint: "https://www.toptal.com/api/talent_profile/graphql",
      transport: "impersonated",
      method: "POST",
      operationName: "UpdateBasicInfo",
      headers: SAMPLE_REQUEST_HEADERS,
      body: { operationName: "UpdateBasicInfo", variables: { authToken: BEARER } },
    });
    const all = streams.stderr.join("");
    expect(all).not.toContain(BEARER);
    expect(all).not.toContain("secretvalue");
  });

  it("multipart info is included when provided", () => {
    setDiagnosticLogger("debug");
    const streams = captureStreams();
    logTransportRequest({
      surface: "talent-profile",
      endpoint: "https://www.toptal.com/api/talent_profile/graphql",
      transport: "impersonated-multipart",
      method: "POST",
      operationName: "uploadResume",
      headers: SAMPLE_REQUEST_HEADERS,
      body: { operationName: "uploadResume" },
      multipart: { files: ["0"], map: { "0": ["variables.input.file"] } },
    });
    const parsed = JSON.parse(streams.stderr[0]?.trim() ?? "") as Record<string, unknown>;
    expect(parsed["multipart"]).toEqual({ files: ["0"], map: { "0": ["variables.input.file"] } });
  });
});

describe("logTransportResponse with level='none'", () => {
  it("is a no-op", () => {
    const streams = captureStreams();
    logTransportResponse({
      surface: "mobile-gateway",
      endpoint: "https://x.example/y",
      operationName: "ProfileShow",
      status: 200,
      headers: SAMPLE_RESPONSE_HEADERS,
      body: { data: { viewer: null } },
      elapsedMs: 123.456,
    });
    expect(streams.stderr).toEqual([]);
    expect(streams.stdout).toEqual([]);
  });
});

describe("logTransportResponse with level='verbose'", () => {
  it("emits one line of `<status> <phrase> (elapsedMs=<n>, operation=<op>)`", () => {
    setDiagnosticLogger("verbose");
    const streams = captureStreams();
    logTransportResponse({
      surface: "mobile-gateway",
      endpoint: "https://x.example/y",
      operationName: "ProfileShow",
      status: 200,
      headers: SAMPLE_RESPONSE_HEADERS,
      body: { data: { viewer: null } },
      elapsedMs: 123.456,
    });
    expect(streams.stdout).toEqual([]);
    expect(streams.stderr.length).toBe(1);
    expect(streams.stderr[0]).toBe("200 OK (elapsedMs=123, operation=ProfileShow)\n");
  });

  it("renders '-' for uncatalogued status codes", () => {
    setDiagnosticLogger("verbose");
    const streams = captureStreams();
    logTransportResponse({
      surface: "mobile-gateway",
      endpoint: "https://x.example/y",
      operationName: "ProfileShow",
      status: 599,
      headers: {},
      body: null,
      elapsedMs: 10,
    });
    expect(streams.stderr[0]).toBe("599 - (elapsedMs=10, operation=ProfileShow)\n");
  });

  it("renders 401 / 403 / 404 reason phrases", () => {
    setDiagnosticLogger("verbose");
    const streams = captureStreams();
    for (const status of [401, 403, 404, 500]) {
      logTransportResponse({
        surface: "talent-profile",
        endpoint: "https://x.example/y",
        operationName: "X",
        status,
        headers: {},
        body: null,
        elapsedMs: 1,
      });
    }
    expect(streams.stderr).toEqual([
      "401 Unauthorized (elapsedMs=1, operation=X)\n",
      "403 Forbidden (elapsedMs=1, operation=X)\n",
      "404 Not Found (elapsedMs=1, operation=X)\n",
      "500 Internal Server Error (elapsedMs=1, operation=X)\n",
    ]);
  });
});

describe("logTransportResponse with level='debug'", () => {
  it("emits one JSON-encoded line with redacted headers and body", () => {
    setDiagnosticLogger("debug");
    const streams = captureStreams();
    logTransportResponse({
      surface: "talent-profile",
      endpoint: "https://x.example/y",
      operationName: "UpdateBasicInfo",
      status: 200,
      headers: SAMPLE_RESPONSE_HEADERS,
      body: { data: { token: BEARER, viewer: { id: 42 } } },
      elapsedMs: 87.4,
    });
    expect(streams.stdout).toEqual([]);
    expect(streams.stderr.length).toBe(1);

    const parsed = JSON.parse(streams.stderr[0]?.trim() ?? "") as Record<string, unknown>;
    expect(parsed["kind"]).toBe("response");
    expect(parsed["status"]).toBe(200);
    expect(parsed["elapsedMs"]).toBe(87);

    const headers = parsed["headers"] as Record<string, string>;
    expect(headers["set-cookie"]).toBe(REDACTED);
    expect(headers["content-type"]).toBe("application/json");

    const body = parsed["body"] as { data: { token: string; viewer: { id: number } } };
    expect(body.data.token).toBe(REDACTED);
    expect(body.data.viewer.id).toBe(42);
  });

  it("response body cannot leak a bearer that was echoed back (AC #4 — applies to both request AND response sides)", () => {
    setDiagnosticLogger("debug");
    const streams = captureStreams();
    logTransportResponse({
      surface: "talent-profile",
      endpoint: "https://x.example/y",
      operationName: "X",
      status: 200,
      headers: SAMPLE_RESPONSE_HEADERS,
      body: { data: { authToken: BEARER, token: BEARER } },
      elapsedMs: 0,
    });
    const all = streams.stderr.join("");
    expect(all).not.toContain(BEARER);
    expect(all).not.toContain("newvalue"); // set-cookie value
  });
});

describe("STDERR exclusivity invariant (AC #5)", () => {
  it("verbose mode: request + response writes go to stderr only, NEVER stdout", () => {
    setDiagnosticLogger("verbose");
    const streams = captureStreams();
    logTransportRequest({
      surface: "mobile-gateway",
      endpoint: "https://x.example/y",
      transport: "stock",
      method: "POST",
      operationName: "X",
      headers: {},
      body: { operationName: "X" },
    });
    logTransportResponse({
      surface: "mobile-gateway",
      endpoint: "https://x.example/y",
      operationName: "X",
      status: 200,
      headers: {},
      body: null,
      elapsedMs: 0,
    });
    expect(streams.stdout).toEqual([]);
    expect(streams.stderr.length).toBe(2);
  });

  it("debug mode: same invariant — stdout is untouched", () => {
    setDiagnosticLogger("debug");
    const streams = captureStreams();
    logTransportRequest({
      surface: "mobile-gateway",
      endpoint: "https://x.example/y",
      transport: "stock",
      method: "POST",
      operationName: "X",
      headers: SAMPLE_REQUEST_HEADERS,
      body: { operationName: "X" },
    });
    logTransportResponse({
      surface: "mobile-gateway",
      endpoint: "https://x.example/y",
      operationName: "X",
      status: 200,
      headers: SAMPLE_RESPONSE_HEADERS,
      body: { data: null },
      elapsedMs: 0,
    });
    expect(streams.stdout).toEqual([]);
    expect(streams.stderr.length).toBe(2);
  });
});
