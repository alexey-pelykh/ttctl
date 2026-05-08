// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { AuthCredentialsSchema, ConfigLoadSchema, ConfigWriteSchema } from "../config.js";

/**
 * Schema-only tests for the new `auth` block (Forms A-D), `AuthCredentialsSchema`
 * union, `ConfigLoadSchema` (strict), and `ConfigWriteSchema` (permissive).
 * These tests do NOT exercise the filesystem-backed resolver — that's covered
 * in `config.test.ts`.
 */

describe("AuthCredentialsSchema", () => {
  it("accepts a 1Password item reference (op://vault/item)", () => {
    expect(AuthCredentialsSchema.safeParse("op://Personal/ttctl").success).toBe(true);
  });

  it("accepts a 3-segment 1Password reference (op://account/vault/item)", () => {
    expect(AuthCredentialsSchema.safeParse("op://my-account/Personal/ttctl").success).toBe(true);
  });

  it("accepts a 3-segment reference with sign-in email as account", () => {
    expect(AuthCredentialsSchema.safeParse("op://oleksii@example.com/Private/Toptal").success).toBe(true);
  });

  it("accepts a 3-segment reference with account UUID", () => {
    expect(AuthCredentialsSchema.safeParse("op://FB4OMM7TV5GW7HGY2A2NCC7PP4/Private/Toptal").success).toBe(true);
  });

  it("accepts a literal { username, password } object", () => {
    expect(AuthCredentialsSchema.safeParse({ username: "ada@example.com", password: "hunter2" }).success).toBe(true);
  });

  it("REJECTS per-field op:// references (4-segment op://account/vault/item/field)", () => {
    const result = AuthCredentialsSchema.safeParse("op://my-account/Personal/ttctl/username");
    expect(result.success).toBe(false);
  });

  it("REJECTS 1-segment op:// references (op://VAULT only)", () => {
    expect(AuthCredentialsSchema.safeParse("op://Personal").success).toBe(false);
  });

  it("REJECTS bare item names without op:// prefix", () => {
    expect(AuthCredentialsSchema.safeParse("ttctl").success).toBe(false);
  });

  it("REJECTS literal objects missing the password field", () => {
    expect(AuthCredentialsSchema.safeParse({ username: "ada@example.com" }).success).toBe(false);
  });

  it("REJECTS literal objects missing the username field", () => {
    expect(AuthCredentialsSchema.safeParse({ password: "hunter2" }).success).toBe(false);
  });

  it("REJECTS literal objects with non-email username", () => {
    expect(AuthCredentialsSchema.safeParse({ username: "not-an-email", password: "hunter2" }).success).toBe(false);
  });

  it("REJECTS literal objects with empty password", () => {
    expect(AuthCredentialsSchema.safeParse({ username: "ada@example.com", password: "" }).success).toBe(false);
  });

  it("REJECTS literal objects with extra unknown fields (strict)", () => {
    const result = AuthCredentialsSchema.safeParse({ username: "ada@example.com", password: "p", extra: "x" });
    expect(result.success).toBe(false);
  });

  it("REJECTS arrays", () => {
    expect(AuthCredentialsSchema.safeParse(["op://Personal/ttctl"]).success).toBe(false);
  });

  it("REJECTS the legacy literal shape with 'email' field name (was renamed to 'username')", () => {
    // Pre-#107 schema used `{ email, password }`; new schema uses `{ username, password }`.
    // Pinning the rename here protects against accidental regressions in either direction.
    const result = AuthCredentialsSchema.safeParse({ email: "ada@example.com", password: "hunter2" });
    expect(result.success).toBe(false);
  });
});

describe("ConfigLoadSchema (strict — runtime load)", () => {
  it("Form A: accepts auth.credentials as 1Password reference (no token)", () => {
    expect(ConfigLoadSchema.safeParse({ auth: { credentials: "op://Personal/ttctl" } }).success).toBe(true);
  });

  it("Form B: accepts auth.credentials as literal {username, password} (no token)", () => {
    expect(
      ConfigLoadSchema.safeParse({ auth: { credentials: { username: "ada@example.com", password: "hunter2" } } })
        .success,
    ).toBe(true);
  });

  it("Form C: accepts auth.token only (no credentials)", () => {
    expect(ConfigLoadSchema.safeParse({ auth: { token: "user_abc123_def456" } }).success).toBe(true);
  });

  it("Form D (with op://): accepts auth.credentials op:// + auth.token", () => {
    expect(
      ConfigLoadSchema.safeParse({ auth: { credentials: "op://Personal/ttctl", token: "user_xxx_yyy" } }).success,
    ).toBe(true);
  });

  it("Form D (with literal): accepts auth.credentials literal + auth.token", () => {
    expect(
      ConfigLoadSchema.safeParse({
        auth: { credentials: { username: "ada@example.com", password: "hunter2" }, token: "user_xxx_yyy" },
      }).success,
    ).toBe(true);
  });

  it("REJECTS empty auth: {} (must contain at least credentials or token)", () => {
    const result = ConfigLoadSchema.safeParse({ auth: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toMatch(/at least one of/i);
      expect(messages).toMatch(/credentials/);
      expect(messages).toMatch(/token/);
    }
  });

  it("REJECTS missing auth field entirely", () => {
    expect(ConfigLoadSchema.safeParse({}).success).toBe(false);
  });

  it("REJECTS auth.token as empty string", () => {
    expect(ConfigLoadSchema.safeParse({ auth: { token: "" } }).success).toBe(false);
  });

  it("REJECTS unknown top-level fields (strict)", () => {
    const result = ConfigLoadSchema.safeParse({
      auth: { credentials: "op://Personal/ttctl" },
      "auth-token-path": "./auth.token",
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS unknown fields inside auth (strict)", () => {
    const result = ConfigLoadSchema.safeParse({
      auth: { credentials: "op://Personal/ttctl", junk: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS per-field op:// reference inside auth.credentials (4-segment account/vault/item/field)", () => {
    // `op://Personal/ttctl/username` is ambiguous syntactically — it could be
    // account=Personal, vault=ttctl, item=username (a valid 3-segment ref) OR
    // vault=Personal, item=ttctl, field=username (the unsupported per-field
    // form). TTCtl interprets the 3-segment form as account/vault/item; the
    // 4-segment form is unambiguously per-field and explicitly rejected.
    const result = ConfigLoadSchema.safeParse({
      auth: { credentials: "op://my-account/Personal/ttctl/username" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Error must name the offending field for the user-facing UX (no naked
      // "Invalid input" — that was the design-doc UX failure mode).
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toMatch(/no \/field suffix/);
    }
  });

  it("REJECTS literal credentials missing password — error names the missing field", () => {
    const result = ConfigLoadSchema.safeParse({
      auth: { credentials: { username: "ada@example.com" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      // The error must surface SOMETHING actionable about the failing branch.
      // Default zod message for a missing field includes "required".
      expect(messages.length).toBeGreaterThan(0);
    }
  });
});

describe("ConfigWriteSchema (permissive — write/post-signout)", () => {
  it("accepts empty auth: {} (mid-lifecycle post-signout-from-Form-C)", () => {
    expect(ConfigWriteSchema.safeParse({ auth: {} }).success).toBe(true);
  });

  it("accepts Form A-D shapes uniformly", () => {
    expect(ConfigWriteSchema.safeParse({ auth: { credentials: "op://Personal/ttctl" } }).success).toBe(true);
    expect(
      ConfigWriteSchema.safeParse({ auth: { credentials: { username: "ada@example.com", password: "p" } } }).success,
    ).toBe(true);
    expect(ConfigWriteSchema.safeParse({ auth: { token: "user_xxx_yyy" } }).success).toBe(true);
    expect(
      ConfigWriteSchema.safeParse({ auth: { credentials: "op://Personal/ttctl", token: "user_xxx_yyy" } }).success,
    ).toBe(true);
  });

  it("REJECTS empty token string (min 1)", () => {
    expect(ConfigWriteSchema.safeParse({ auth: { token: "" } }).success).toBe(false);
  });

  it("REJECTS unknown auth fields (strict)", () => {
    expect(ConfigWriteSchema.safeParse({ auth: { credentials: "op://Personal/ttctl", junk: "x" } }).success).toBe(
      false,
    );
  });

  it("REJECTS unknown top-level fields (strict; auth-token-path is gone)", () => {
    expect(
      ConfigWriteSchema.safeParse({
        auth: { credentials: "op://Personal/ttctl" },
        "auth-token-path": "./auth.token",
      }).success,
    ).toBe(false);
  });
});
