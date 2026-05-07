// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { AuthRevokedError, TtctlError } from "../auth/errors.js";
import { Cf403Error, Cf403PersistentError, SchedulerBearerExpired } from "../transport.js";

describe("TtctlError hierarchy (#77)", () => {
  it("is the abstract base for every typed auth error", () => {
    expect(new AuthRevokedError()).toBeInstanceOf(TtctlError);
    expect(new Cf403Error("talent-profile", "https://example.com/api")).toBeInstanceOf(TtctlError);
    expect(new Cf403PersistentError("talent-profile", "https://example.com/api")).toBeInstanceOf(TtctlError);
    expect(new SchedulerBearerExpired()).toBeInstanceOf(TtctlError);
  });

  it("every TtctlError subclass also extends the standard Error class", () => {
    expect(new AuthRevokedError()).toBeInstanceOf(Error);
    expect(new Cf403Error("talent-profile", "https://example.com/api")).toBeInstanceOf(Error);
    expect(new Cf403PersistentError("talent-profile", "https://example.com/api")).toBeInstanceOf(Error);
    expect(new SchedulerBearerExpired()).toBeInstanceOf(Error);
  });

  it("every TtctlError subclass exposes a stable `code` and a `recovery` hint", () => {
    const cases: { err: TtctlError; code: string }[] = [
      { err: new AuthRevokedError(), code: "AUTH_REVOKED" },
      { err: new Cf403Error("talent-profile", "https://example.com/api"), code: "CF_403_CLEARANCE" },
      { err: new Cf403PersistentError("talent-profile", "https://example.com/api"), code: "CF_403_PERSISTENT" },
      { err: new SchedulerBearerExpired(), code: "SCHEDULER_BEARER_EXPIRED" },
    ];
    for (const { err, code } of cases) {
      expect(err.code).toBe(code);
      expect(err.recovery).toBeTypeOf("string");
      expect(err.recovery.length).toBeGreaterThan(0);
    }
  });

  it("autoRecover defaults to false; SchedulerBearerExpired opts in", () => {
    expect(new AuthRevokedError().autoRecover).toBe(false);
    expect(new Cf403Error("talent-profile", "https://example.com/api").autoRecover).toBe(false);
    expect(new Cf403PersistentError("talent-profile", "https://example.com/api").autoRecover).toBe(false);
    expect(new SchedulerBearerExpired().autoRecover).toBe(true);
  });
});

describe("AuthRevokedError", () => {
  it("uses code AUTH_REVOKED and the canonical signin recovery hint", () => {
    const err = new AuthRevokedError();
    expect(err.code).toBe("AUTH_REVOKED");
    expect(err.recovery).toBe("Run `ttctl auth signin` to re-authenticate.");
  });

  it("name is AuthRevokedError so error logs identify the class", () => {
    expect(new AuthRevokedError().name).toBe("AuthRevokedError");
  });

  it("accepts an optional message; falls back to a sensible default", () => {
    expect(new AuthRevokedError().message).toBe("Session is invalid or expired.");
    expect(new AuthRevokedError("custom").message).toBe("custom");
  });

  it("forwards `cause` through the Error constructor for diagnostics", () => {
    const cause = new Error("underlying network error");
    const err = new AuthRevokedError("Session is invalid or expired.", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("Cf403Error (refined under #77)", () => {
  it("carries surface and endpoint as readable fields", () => {
    const err = new Cf403Error("talent-profile", "https://www.toptal.com/api/talent_profile/graphql");
    expect(err.surface).toBe("talent-profile");
    expect(err.endpoint).toBe("https://www.toptal.com/api/talent_profile/graphql");
  });

  it("uses code CF_403_CLEARANCE and a non-empty recovery", () => {
    const err = new Cf403Error("talent-profile", "https://example.com/api");
    expect(err.code).toBe("CF_403_CLEARANCE");
    expect(err.recovery).toMatch(/file an issue/i);
  });

  it("preserves the existing multi-line message format", () => {
    const err = new Cf403Error("talent-profile", "https://example.com/api");
    expect(err.message).toContain('Cloudflare returned HTTP 403 from surface "talent-profile"');
    expect(err.message).toContain("https://example.com/api");
    expect(err.message).toContain("Chrome TLS impersonation alone passes Cloudflare");
    expect(err.message).toContain("https://github.com/alexey-pelykh/ttctl/issues");
  });

  it("message stays free of cf_clearance / DevTools / cookie references (#59 contract)", () => {
    // The refinement under #77 must not reintroduce the cookie-refresh
    // walkthrough that #59 deliberately removed when bearer-token auth
    // replaced the cookie code path.
    const err = new Cf403Error("talent-profile", "https://example.com/api");
    expect(err.message).not.toMatch(/cf_clearance/i);
    expect(err.message).not.toMatch(/DevTools/);
    expect(err.message).not.toMatch(/session\.cookies/);
  });
});

describe("Cf403PersistentError", () => {
  it("uses code CF_403_PERSISTENT and points to SECURITY.md break-glass", () => {
    const err = new Cf403PersistentError("talent-profile", "https://example.com/api");
    expect(err.code).toBe("CF_403_PERSISTENT");
    expect(err.recovery).toMatch(/SECURITY\.md|cookie-jar/i);
  });

  it("carries surface and endpoint like Cf403Error", () => {
    const err = new Cf403PersistentError("scheduler", "https://scheduler.toptal.com/api/graphql");
    expect(err.surface).toBe("scheduler");
    expect(err.endpoint).toBe("https://scheduler.toptal.com/api/graphql");
  });
});

describe("SchedulerBearerExpired (scaffolded for post-v1)", () => {
  it("uses code SCHEDULER_BEARER_EXPIRED and signals automated recovery", () => {
    const err = new SchedulerBearerExpired();
    expect(err.code).toBe("SCHEDULER_BEARER_EXPIRED");
    expect(err.autoRecover).toBe(true);
  });

  it("default message describes bearer expiry", () => {
    expect(new SchedulerBearerExpired().message).toMatch(/bearer/i);
  });
});
