// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import {
  AuthRevokedError,
  Cf403Error,
  Cf403PersistentError,
  NativeModuleUnavailableError,
  SchedulerBearerExpired,
} from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { exitCodeForTtctlError, formatTtctlErrorMessage } from "../errors.js";

describe("formatTtctlErrorMessage (#77 CLI presentation)", () => {
  it("emits the Error / Recovery / Code three-block layout", () => {
    const err = new AuthRevokedError("Session is invalid or expired.");
    const text = formatTtctlErrorMessage(err);
    expect(text).toBe(
      [
        "Error: Session is invalid or expired.",
        "",
        "Recovery: Run `ttctl auth signin` to re-authenticate.",
        "",
        "(Code: AUTH_REVOKED)",
      ].join("\n"),
    );
  });

  it("preserves multi-line messages from Cf403Error verbatim in the Error block", () => {
    const err = new Cf403Error("talent-profile", "https://example.com/api");
    const text = formatTtctlErrorMessage(err);
    // The first line must start with `Error: ` and be followed by the multi-line message
    // structure from `Cf403Error.formatMessage`. Both the link and the surface name appear.
    expect(text).toMatch(/^Error: Cloudflare returned HTTP 403 from surface "talent-profile"/);
    expect(text).toContain("https://github.com/alexey-pelykh/ttctl/issues");
    // Recovery block is the canonical recovery hint, separated by a blank line.
    expect(text).toContain("\n\nRecovery: ");
    // Code tag at the end
    expect(text.trimEnd().endsWith("(Code: CF_403_CLEARANCE)")).toBe(true);
  });

  it("renders Cf403PersistentError with the SECURITY.md break-glass recovery", () => {
    const err = new Cf403PersistentError("scheduler", "https://example.com/api");
    const text = formatTtctlErrorMessage(err);
    expect(text).toMatch(/SECURITY\.md|cookie-jar/i);
    expect(text).toContain("(Code: CF_403_PERSISTENT)");
  });

  it("renders SchedulerBearerExpired with the auto-recovery hint", () => {
    const err = new SchedulerBearerExpired();
    const text = formatTtctlErrorMessage(err);
    expect(text).toContain("re-minted automatically");
    expect(text).toContain("(Code: SCHEDULER_BEARER_EXPIRED)");
  });

  it("renders NativeModuleUnavailableError naming the platform and supported set", () => {
    const err = new NativeModuleUnavailableError("linux", "arm64");
    const text = formatTtctlErrorMessage(err);
    expect(text).toMatch(/^Error: Failed to load TTCtl's native TLS-impersonation module .* for linux-arm64/);
    expect(text).toContain("Supported platforms:");
    expect(text).toContain("linux-arm64-musl");
    expect(text).toContain("(Code: NATIVE_MODULE_UNAVAILABLE)");
  });
});

describe("exitCodeForTtctlError", () => {
  it("auth-related errors exit 1 (user-actionable)", () => {
    expect(exitCodeForTtctlError(new AuthRevokedError())).toBe(1);
    expect(exitCodeForTtctlError(new SchedulerBearerExpired())).toBe(1);
  });

  it("Cloudflare-403 errors exit 2 (transport-level, transient/retryable)", () => {
    expect(exitCodeForTtctlError(new Cf403Error("talent-profile", "https://x"))).toBe(2);
    expect(exitCodeForTtctlError(new Cf403PersistentError("talent-profile", "https://x"))).toBe(2);
  });

  it("native-module-unavailable exits 1 (hard platform failure, not retryable)", () => {
    expect(exitCodeForTtctlError(new NativeModuleUnavailableError("win32", "arm64"))).toBe(1);
  });
});
