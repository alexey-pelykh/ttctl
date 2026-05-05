// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import { AuthSchema, ConfigSchema } from "../config.js";

describe("AuthSchema", () => {
  it("accepts a 1Password item reference (op://vault/item)", () => {
    const result = AuthSchema.safeParse("op://Personal/ttctl");
    expect(result.success).toBe(true);
  });

  it("accepts a literal { email, password } object", () => {
    const result = AuthSchema.safeParse({ email: "user@example.com", password: "hunter2" });
    expect(result.success).toBe(true);
  });

  it("REJECTS per-field op:// references (op://vault/item/field)", () => {
    const result = AuthSchema.safeParse("op://Personal/ttctl/username");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/no \/field suffix/);
    }
  });

  it("REJECTS bare item names without op:// prefix", () => {
    const result = AuthSchema.safeParse("ttctl");
    expect(result.success).toBe(false);
  });

  it("REJECTS malformed objects (missing password)", () => {
    const result = AuthSchema.safeParse({ email: "user@example.com" });
    expect(result.success).toBe(false);
  });

  it("REJECTS objects with non-email values", () => {
    const result = AuthSchema.safeParse({ email: "not-an-email", password: "x" });
    expect(result.success).toBe(false);
  });

  it("REJECTS arrays", () => {
    const result = AuthSchema.safeParse(["op://Personal/ttctl"]);
    expect(result.success).toBe(false);
  });
});

describe("ConfigSchema", () => {
  it("validates a minimal config with op:// auth", () => {
    const result = ConfigSchema.safeParse({ auth: "op://Personal/ttctl" });
    expect(result.success).toBe(true);
  });

  it("validates a config with literal auth", () => {
    const result = ConfigSchema.safeParse({
      auth: { email: "user@example.com", password: "hunter2" },
    });
    expect(result.success).toBe(true);
  });

  it("REJECTS missing auth", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
