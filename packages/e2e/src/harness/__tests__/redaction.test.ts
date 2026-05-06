// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { formatRedacted, redact } from "../redaction.js";

describe("redact — primitives", () => {
  it("passes strings through unchanged (no scanning of values, only keys)", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact("eyJhbGciOiJIUzI1NiJ9.foo.bar")).toBe("eyJhbGciOiJIUzI1NiJ9.foo.bar");
  });

  it("passes numbers, booleans, null, undefined through unchanged", () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBeUndefined();
  });
});

describe("redact — known secret keys", () => {
  it("redacts top-level email, password, cookie", () => {
    const out = redact({
      email: "ada@example.com",
      password: "hunter2",
      cookie: "_toptal_session_id=abc123",
      other: "kept",
    });
    expect(out).toEqual({
      email: "[REDACTED]",
      password: "[REDACTED]",
      cookie: "[REDACTED]",
      other: "kept",
    });
  });

  it("redacts case-insensitively (Authorization, COOKIE, eMail)", () => {
    const out = redact({ Authorization: "Bearer xyz", COOKIE: "k=v", eMail: "u@e.com" });
    expect(out).toEqual({ Authorization: "[REDACTED]", COOKIE: "[REDACTED]", eMail: "[REDACTED]" });
  });

  it("redacts nested secret keys at any depth", () => {
    const out = redact({
      request: {
        headers: { cookie: "k=v", "user-agent": "ttctl" },
      },
    });
    expect(out).toEqual({
      request: {
        headers: { cookie: "[REDACTED]", "user-agent": "ttctl" },
      },
    });
  });

  it("redacts secret keys inside arrays", () => {
    const out = redact([
      { name: "a", token: "t1" },
      { name: "b", token: "t2" },
    ]);
    expect(out).toEqual([
      { name: "a", token: "[REDACTED]" },
      { name: "b", token: "[REDACTED]" },
    ]);
  });

  it("preserves non-secret keys verbatim including their nested objects", () => {
    const out = redact({
      meta: { requestId: "abc-123", durationMs: 42 },
      auth: "should be redacted",
    });
    expect(out).toEqual({
      meta: { requestId: "abc-123", durationMs: 42 },
      auth: "[REDACTED]",
    });
  });
});

describe("redact — profile collapse", () => {
  it("collapses any object with a `bio` key to '[redacted profile]'", () => {
    const out = redact({ id: 1, bio: "Long prose about the user…" });
    expect(out).toBe("[redacted profile]");
  });

  it("collapses objects with `headline` key (Toptal's `quote` synonym)", () => {
    const out = redact({ id: 1, headline: "Senior backend engineer" });
    expect(out).toBe("[redacted profile]");
  });

  it("collapses objects with `quote` key (server-side profile shape)", () => {
    const out = redact({ id: 1, quote: "Senior backend engineer", about: "..." });
    expect(out).toBe("[redacted profile]");
  });

  it("collapses objects with `skillSets`/`skills` arrays", () => {
    const out = redact({ id: 1, skillSets: { nodes: [] } });
    expect(out).toBe("[redacted profile]");
  });

  it("collapses ProfileShowQuery-shaped responses (viewer.viewerRole.profile)", () => {
    const response = {
      data: {
        viewer: {
          viewerRole: {
            email: "ada@example.com",
            profile: { bio: "x", headline: "y", skillSets: { nodes: [] } },
          },
        },
      },
    };
    const out = redact(response) as { data: { viewer: { viewerRole: Record<string, unknown> } } };
    // Walks down to viewerRole, redacts `email`, then descends into
    // `profile` and collapses it because it has bio/headline/skillSets.
    expect(out.data.viewer.viewerRole.email).toBe("[REDACTED]");
    expect(out.data.viewer.viewerRole.profile).toBe("[redacted profile]");
  });

  it("does NOT collapse objects without profile-shaped keys", () => {
    const out = redact({ id: 1, name: "X", description: "ordinary object" });
    expect(out).toEqual({ id: 1, name: "X", description: "ordinary object" });
  });
});

describe("redact — defensive shapes", () => {
  it("does not mutate the input object", () => {
    const input = { email: "u@e.com", nested: { token: "t" } };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    redact(input);
    expect(input).toEqual(snapshot);
  });

  it("handles deeply nested arrays + objects without crashing", () => {
    const deep = {
      level1: {
        level2: [{ level3: { cookie: "redact me", name: "keep me" } }, { level3: { token: "redact me", id: 99 } }],
      },
    };
    expect(() => redact(deep)).not.toThrow();
    const out = redact(deep) as {
      level1: { level2: { level3: Record<string, unknown> }[] };
    };
    expect(out.level1.level2[0]?.level3["cookie"]).toBe("[REDACTED]");
    expect(out.level1.level2[0]?.level3["name"]).toBe("keep me");
  });
});

describe("formatRedacted", () => {
  it("pretty-prints redacted objects as JSON with 2-space indent", () => {
    const text = formatRedacted({ email: "a@b.com", id: 1 });
    expect(text).toContain('"email": "[REDACTED]"');
    expect(text).toContain('"id": 1');
    expect(text.split("\n").length).toBeGreaterThan(1);
  });

  it("returns redacted strings as-is (no JSON quoting)", () => {
    expect(formatRedacted({ bio: "x" })).toBe("[redacted profile]");
  });

  it("formats undefined as the literal string 'undefined'", () => {
    expect(formatRedacted(undefined)).toBe("undefined");
  });

  it("formats null as JSON 'null'", () => {
    expect(formatRedacted(null)).toBe("null");
  });
});
