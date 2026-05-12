// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import {
  BEARER_PATTERN,
  BEARER_PATTERN_SOURCE,
  REDACTED,
  SECRET_BODY_FIELD_NAMES,
  SECRET_HEADER_NAMES,
  containsBearerToken,
  redactBody,
  redactCookieHeader,
  redactHeaders,
} from "../redact.js";

describe("BEARER_PATTERN / BEARER_PATTERN_SOURCE", () => {
  it("matches the canonical Toptal session bearer shape", () => {
    const bearer = "user_abc123def456789012345678_abcdefghij1234567890";
    expect(containsBearerToken(bearer)).toBe(true);
  });

  it("does not false-positive on unrelated `user_` prefixes", () => {
    expect(containsBearerToken("user_short")).toBe(false);
    expect(containsBearerToken("user_NOT_HEX_zzzzzzzzzzzzzzzzzzzzzzzz_abcdefghij1234567890")).toBe(false);
  });

  it("matches inside surrounding text (debug-log embedding case)", () => {
    const haystack = '  "authorization": "Token token=user_abc123def456789012345678_abcdefghij1234567890",';
    expect(containsBearerToken(haystack)).toBe(true);
  });

  it("BEARER_PATTERN is global (g flag) so multiple matches in one string scan", () => {
    const fresh = new RegExp(BEARER_PATTERN_SOURCE, "g");
    const haystack =
      "user_abc123def456789012345678_abcdefghij1234567890 second user_def456789012345678abc123_zzzz5678901234567890";
    const matches = haystack.match(fresh);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBe(2);
  });

  it("BEARER_PATTERN_SOURCE is the literal regex source (no flags) — for cross-module consumption", () => {
    expect(BEARER_PATTERN_SOURCE).toBe("user_[0-9a-f]{24}_[A-Za-z0-9]{20}");
  });

  it("BEARER_PATTERN is a RegExp with the global flag", () => {
    expect(BEARER_PATTERN.global).toBe(true);
  });
});

describe("REDACTED constant", () => {
  it("is the literal '***REDACTED***' marker", () => {
    expect(REDACTED).toBe("***REDACTED***");
  });
});

describe("SECRET_HEADER_NAMES", () => {
  it("includes the canonical auth header names (lowercased)", () => {
    expect(SECRET_HEADER_NAMES.has("authorization")).toBe(true);
    expect(SECRET_HEADER_NAMES.has("cookie")).toBe(true);
    expect(SECRET_HEADER_NAMES.has("set-cookie")).toBe(true);
    expect(SECRET_HEADER_NAMES.has("proxy-authorization")).toBe(true);
  });

  it("includes vendor-specific session header variants", () => {
    expect(SECRET_HEADER_NAMES.has("x-auth-token")).toBe(true);
    expect(SECRET_HEADER_NAMES.has("x-csrf-token")).toBe(true);
    expect(SECRET_HEADER_NAMES.has("x-session-token")).toBe(true);
  });

  it("does NOT match common non-secret headers", () => {
    expect(SECRET_HEADER_NAMES.has("user-agent")).toBe(false);
    expect(SECRET_HEADER_NAMES.has("content-type")).toBe(false);
    expect(SECRET_HEADER_NAMES.has("accept")).toBe(false);
  });
});

describe("SECRET_BODY_FIELD_NAMES", () => {
  it("includes password and token variants", () => {
    expect(SECRET_BODY_FIELD_NAMES.has("password")).toBe(true);
    expect(SECRET_BODY_FIELD_NAMES.has("token")).toBe(true);
    expect(SECRET_BODY_FIELD_NAMES.has("secret")).toBe(true);
    expect(SECRET_BODY_FIELD_NAMES.has("api_key")).toBe(true);
    expect(SECRET_BODY_FIELD_NAMES.has("apikey")).toBe(true);
  });

  it("includes auth/refresh token variants", () => {
    expect(SECRET_BODY_FIELD_NAMES.has("access_token")).toBe(true);
    expect(SECRET_BODY_FIELD_NAMES.has("refresh_token")).toBe(true);
    expect(SECRET_BODY_FIELD_NAMES.has("auth_token")).toBe(true);
  });
});

describe("redactHeaders", () => {
  it("redacts authorization header value, preserving key case", () => {
    const out = redactHeaders({ Authorization: "Token token=user_abc123def456789012345678_abcdefghij1234567890" });
    expect(out["Authorization"]).toBe(REDACTED);
  });

  it("is case-insensitive on the header key (HTTP headers are CI by spec)", () => {
    const out = redactHeaders({
      AUTHORIZATION: "Token token=...",
      Cookie: "sid=abc",
      "X-Auth-Token": "shhh",
    });
    expect(out["AUTHORIZATION"]).toBe(REDACTED);
    expect(out["Cookie"]).toBe(REDACTED);
    expect(out["X-Auth-Token"]).toBe(REDACTED);
  });

  it("passes non-secret headers through verbatim", () => {
    const out = redactHeaders({
      "user-agent": "Mozilla/5.0 ...",
      "content-type": "application/json",
      origin: "https://talent.toptal.com",
    });
    expect(out["user-agent"]).toBe("Mozilla/5.0 ...");
    expect(out["content-type"]).toBe("application/json");
    expect(out["origin"]).toBe("https://talent.toptal.com");
  });

  it("does NOT mutate the input headers object", () => {
    const input = { Authorization: "Token token=secret" };
    redactHeaders(input);
    expect(input["Authorization"]).toBe("Token token=secret");
  });

  it("returns a copy with all keys present, even when none are secret", () => {
    const input = { accept: "*/*", host: "example.com" };
    const out = redactHeaders(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it("bearer token cannot appear verbatim in the output (AC #4 invariant)", () => {
    const token = "user_abc123def456789012345678_abcdefghij1234567890";
    const out = redactHeaders({ Authorization: `Token token=${token}` });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(token);
  });
});

describe("redactBody", () => {
  it("redacts password field at top level (case-insensitive)", () => {
    const out = redactBody({ username: "alice", password: "hunter2" });
    expect(out).toEqual({ username: "alice", password: REDACTED });
  });

  it("redacts case-variant field names", () => {
    const out = redactBody({ Password: "x", APIKey: "y", AccessToken: "z" });
    expect(out).toEqual({ Password: REDACTED, APIKey: REDACTED, AccessToken: REDACTED });
  });

  it("walks nested objects (GraphQL variables shape)", () => {
    const out = redactBody({
      operationName: "EmailPasswordSignIn",
      variables: {
        input: {
          credentials: { username: "alice", password: "hunter2" },
        },
      },
    });
    expect(out).toEqual({
      operationName: "EmailPasswordSignIn",
      variables: {
        input: {
          credentials: { username: "alice", password: REDACTED },
        },
      },
    });
  });

  it("walks arrays", () => {
    const out = redactBody({
      items: [
        { name: "a", token: "t1" },
        { name: "b", token: "t2" },
      ],
    });
    expect(out).toEqual({
      items: [
        { name: "a", token: REDACTED },
        { name: "b", token: REDACTED },
      ],
    });
  });

  it("preserves scalars (string / number / boolean / null)", () => {
    expect(redactBody("hello")).toBe("hello");
    expect(redactBody(42)).toBe(42);
    expect(redactBody(true)).toBe(true);
    expect(redactBody(null)).toBe(null);
    expect(redactBody(undefined)).toBe(undefined);
  });

  it("does NOT mutate the input", () => {
    const input = { password: "hunter2", nested: { token: "x" } };
    redactBody(input);
    expect(input.password).toBe("hunter2");
    expect(input.nested.token).toBe("x");
  });

  it("bearer token in a non-secret field passes through (only structural redaction; pattern-level is the caller's job)", () => {
    // The redactBody function is structural (redacts by KEY name), not
    // pattern-based. A bearer literal in a non-secret-keyed field is the
    // caller's responsibility to detect — but this case is what the
    // BEARER_PATTERN check covers separately. This test pins the
    // structural-only behavior so a future change that adds pattern-based
    // body redaction is a conscious decision.
    const out = redactBody({ free_text: "user_abc123def456789012345678_abcdefghij1234567890" });
    expect(out).toEqual({ free_text: "user_abc123def456789012345678_abcdefghij1234567890" });
  });
});

describe("redactCookieHeader", () => {
  it("redacts all named cookie values, preserving names and delimiters", () => {
    expect(redactCookieHeader("sid=abc; tracking=xyz")).toBe(`sid=${REDACTED}; tracking=${REDACTED}`);
  });

  it("preserves valueless attribute-style entries (Secure, HttpOnly)", () => {
    expect(redactCookieHeader("sid=abc; Secure; HttpOnly")).toBe(`sid=${REDACTED}; Secure; HttpOnly`);
  });

  it("handles single-cookie input", () => {
    expect(redactCookieHeader("cf_clearance=longvalue")).toBe(`cf_clearance=${REDACTED}`);
  });

  it("ignores empty entries from trailing semicolons", () => {
    expect(redactCookieHeader("sid=abc; ")).toBe(`sid=${REDACTED}`);
  });
});

describe("containsBearerToken", () => {
  it("returns true on a string containing the bearer pattern", () => {
    expect(containsBearerToken("prefix user_abc123def456789012345678_abcdefghij1234567890 suffix")).toBe(true);
  });

  it("returns false on a string with no bearer", () => {
    expect(containsBearerToken("nothing to see here")).toBe(false);
  });

  it("does not share lastIndex with BEARER_PATTERN (defensive isolation)", () => {
    // Advance the shared BEARER_PATTERN's cursor so a subsequent .test()
    // against the same string would falsely return false. containsBearerToken
    // builds a fresh regex per call and must not be affected.
    const seed = "user_abc123def456789012345678_abcdefghij1234567890";
    BEARER_PATTERN.lastIndex = 0;
    expect(BEARER_PATTERN.exec(seed)).not.toBeNull();
    // cursor is now past the match
    expect(containsBearerToken(seed)).toBe(true);
    BEARER_PATTERN.lastIndex = 0;
  });
});
