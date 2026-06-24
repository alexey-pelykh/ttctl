// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";

import { resolveCredentials } from "../auth/index.js";

const mockedExec = vi.mocked(execFileSync);

/**
 * Router-level coverage for `resolveCredentials` — the glue that collapses the
 * polymorphic `AuthCredentials` value into `{ email, password }`. The three
 * forms (single-item string, per-field object, literal object) route to three
 * distinct `op` invocations (or none), and that discrimination is the part the
 * schema and the field resolver do NOT individually exercise.
 */
describe("resolveCredentials routing", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("single-item (string) → `op item get` purpose-matching", () => {
    mockedExec.mockReturnValueOnce(
      JSON.stringify([
        { id: "username", purpose: "USERNAME", value: "user@example.com" },
        { id: "password", purpose: "PASSWORD", value: "hunter2" },
      ]),
    );

    const creds = resolveCredentials("op://Personal/ttctl");

    expect(creds).toEqual({ email: "user@example.com", password: "hunter2" });
    const args = (mockedExec.mock.calls[0]?.[1] ?? []) as readonly string[];
    expect(args.slice(0, 2)).toEqual(["item", "get"]);
  });

  it("per-field (object of op:// refs) → one `op read` per field", () => {
    mockedExec.mockReturnValueOnce("user@example.com").mockReturnValueOnce("hunter2");

    const creds = resolveCredentials({
      username: "op://Private/Toptal/username",
      password: "op://Private/Toptal/password",
    });

    expect(creds).toEqual({ email: "user@example.com", password: "hunter2" });
    expect(mockedExec).toHaveBeenCalledTimes(2);
    expect((mockedExec.mock.calls[0]?.[1] ?? [])[0]).toBe("read");
    expect((mockedExec.mock.calls[1]?.[1] ?? [])[0]).toBe("read");
    // username resolved before password (order is load-bearing for the mock map)
    expect(mockedExec.mock.calls[0]?.[1]).toContain("op://Private/Toptal/username");
    expect(mockedExec.mock.calls[1]?.[1]).toContain("op://Private/Toptal/password");
  });

  it("literal (object of email/password) → returned directly, no `op` call", () => {
    const creds = resolveCredentials({ username: "ada@example.com", password: "hunter2" });

    expect(creds).toEqual({ email: "ada@example.com", password: "hunter2" });
    expect(mockedExec).not.toHaveBeenCalled();
  });
});
