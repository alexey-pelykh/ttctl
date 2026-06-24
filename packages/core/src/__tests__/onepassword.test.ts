// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";

import { OnePasswordError, resolveOnePasswordField, resolveOnePasswordReference } from "../onepassword.js";

const mockedExec = vi.mocked(execFileSync);

interface OpField {
  id?: string;
  label?: string;
  purpose?: string;
  value?: string;
}

function reply(fields: OpField[]): void {
  mockedExec.mockReturnValueOnce(JSON.stringify(fields));
}

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`Expected an Error, got: ${String(err)}`, { cause: err });
  }
  throw new Error("Expected fn to throw, but it returned normally");
}

describe("resolveOnePasswordReference", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  describe("reference parsing", () => {
    it("rejects references that do not match op://[account/]VAULT/ITEM", () => {
      expect(() => resolveOnePasswordReference("not-a-ref")).toThrow(OnePasswordError);
      expect(() => resolveOnePasswordReference("op://only-vault")).toThrow(OnePasswordError);
      expect(() => resolveOnePasswordReference("op://account/vault/item/extra")).toThrow(OnePasswordError);
      expect(() => resolveOnePasswordReference("op://account//item")).toThrow(OnePasswordError);
      expect(mockedExec).not.toHaveBeenCalled();
    });
  });

  describe("field matching by purpose (canonical LOGIN-category identifier)", () => {
    // Fixture A — clean-label item: label happens to equal "username"/"password".
    // Confirms backward compatibility: items with canonical labels still resolve.
    it("resolves a clean-label LOGIN item (label=username, purpose=USERNAME)", () => {
      reply([
        { id: "username", label: "username", purpose: "USERNAME", value: "user@example.com" },
        { id: "password", label: "password", purpose: "PASSWORD", value: "hunter2" },
      ]);

      const creds = resolveOnePasswordReference("op://Personal/ttctl");

      expect(creds).toEqual({ email: "user@example.com", password: "hunter2" });
    });

    // Fixture B — form-scraped item: label is the HTML form input name (e.g. user[email]).
    // This is the bug from #53. Currently fails; must pass after fix.
    it("resolves a browser-autosaved item (label=user[email], purpose=USERNAME)", () => {
      reply([
        { id: "username", label: "user[email]", purpose: "USERNAME", value: "user@example.com" },
        { id: "password", label: "user[password]", purpose: "PASSWORD", value: "hunter2" },
      ]);

      const creds = resolveOnePasswordReference("op://Personal/ttctl");

      expect(creds).toEqual({ email: "user@example.com", password: "hunter2" });
    });

    // Fixture C — fields lack purpose: not a LOGIN-category item (e.g. Server, custom).
    // Resolution fails with a message that points the user at the LOGIN category.
    it("throws OnePasswordError when fields have no USERNAME/PASSWORD purpose (non-LOGIN item)", () => {
      reply([
        { id: "host", label: "host", value: "example.com" },
        { id: "port", label: "port", value: "5432" },
      ]);

      const err = captureError(() => resolveOnePasswordReference("op://Personal/db"));
      expect(err).toBeInstanceOf(OnePasswordError);
      expect(err.message).toMatch(/USERNAME and PASSWORD purposes/);
      expect(err.message).toMatch(/LOGIN/);
    });

    // Fixture D — only USERNAME present (no PASSWORD field): partial item.
    it("throws OnePasswordError when PASSWORD purpose is missing", () => {
      reply([{ id: "username", label: "user[email]", purpose: "USERNAME", value: "user@example.com" }]);

      const err = captureError(() => resolveOnePasswordReference("op://Personal/incomplete"));
      expect(err).toBeInstanceOf(OnePasswordError);
      expect(err.message).toMatch(/USERNAME and PASSWORD purposes/);
    });

    it("throws OnePasswordError when USERNAME purpose is missing", () => {
      reply([{ id: "password", label: "user[password]", purpose: "PASSWORD", value: "hunter2" }]);

      const err = captureError(() => resolveOnePasswordReference("op://Personal/incomplete"));
      expect(err).toBeInstanceOf(OnePasswordError);
      expect(err.message).toMatch(/USERNAME and PASSWORD purposes/);
    });
  });

  describe("op CLI invocation", () => {
    it("shells out to `op item get` with vault and item parsed from the reference", () => {
      reply([
        { id: "username", label: "username", purpose: "USERNAME", value: "u" },
        { id: "password", label: "password", purpose: "PASSWORD", value: "p" },
      ]);

      resolveOnePasswordReference("op://MyVault/MyItem");

      expect(mockedExec).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockedExec.mock.calls[0] ?? [];
      expect(cmd).toBe("op");
      expect(args).toContain("item");
      expect(args).toContain("get");
      expect(args).toContain("MyItem");
      expect(args).toContain("--vault");
      expect(args).toContain("MyVault");
      expect(args).toContain("--format");
      expect(args).toContain("json");
    });

    it("does NOT pass --account when the reference has only 2 segments", () => {
      reply([
        { id: "username", purpose: "USERNAME", value: "u" },
        { id: "password", purpose: "PASSWORD", value: "p" },
      ]);

      resolveOnePasswordReference("op://MyVault/MyItem");

      const args = (mockedExec.mock.calls[0]?.[1] ?? []) as readonly string[];
      expect(args).not.toContain("--account");
    });

    it("passes --account when the reference includes an account segment", () => {
      reply([
        { id: "username", purpose: "USERNAME", value: "u" },
        { id: "password", purpose: "PASSWORD", value: "p" },
      ]);

      resolveOnePasswordReference("op://my-account/MyVault/MyItem");

      expect(mockedExec).toHaveBeenCalledTimes(1);
      const args = (mockedExec.mock.calls[0]?.[1] ?? []) as readonly string[];
      expect(args).toContain("--account");
      expect(args).toContain("my-account");
      // --account must precede its value
      expect(args.indexOf("my-account")).toBe(args.indexOf("--account") + 1);
      expect(args).toContain("MyVault");
      expect(args).toContain("MyItem");
    });

    it("forwards a UUID account verbatim", () => {
      reply([
        { id: "username", purpose: "USERNAME", value: "u" },
        { id: "password", purpose: "PASSWORD", value: "p" },
      ]);

      resolveOnePasswordReference("op://FB4OMM7TV5GW7HGY2A2NCC7PP4/Private/Toptal");

      const args = (mockedExec.mock.calls[0]?.[1] ?? []) as readonly string[];
      expect(args).toContain("--account");
      expect(args).toContain("FB4OMM7TV5GW7HGY2A2NCC7PP4");
    });

    it("forwards an email account verbatim", () => {
      reply([
        { id: "username", purpose: "USERNAME", value: "u" },
        { id: "password", purpose: "PASSWORD", value: "p" },
      ]);

      resolveOnePasswordReference("op://oleksii@example.com/Private/Toptal");

      const args = (mockedExec.mock.calls[0]?.[1] ?? []) as readonly string[];
      expect(args).toContain("--account");
      expect(args).toContain("oleksii@example.com");
    });

    it("translates ENOENT (op CLI not installed) into a friendly OnePasswordError", () => {
      const enoent = new Error("spawn op ENOENT") as NodeJS.ErrnoException;
      enoent.code = "ENOENT";
      mockedExec.mockImplementationOnce(() => {
        throw enoent;
      });

      const err = captureError(() => resolveOnePasswordReference("op://Personal/ttctl"));
      expect(err).toBeInstanceOf(OnePasswordError);
      expect(err.message).toMatch(/1Password CLI .* not found/);
    });

    it("wraps generic op exec failures (not ENOENT) into OnePasswordError", () => {
      const failure = new Error("authentication required") as NodeJS.ErrnoException;
      mockedExec.mockImplementationOnce(() => {
        throw failure;
      });

      const err = captureError(() => resolveOnePasswordReference("op://Personal/ttctl"));
      expect(err).toBeInstanceOf(OnePasswordError);
      expect(err.message).toMatch(/op item get failed: authentication required/);
    });

    it("throws on non-JSON output from op", () => {
      mockedExec.mockReturnValueOnce("not json at all");

      const err = captureError(() => resolveOnePasswordReference("op://Personal/ttctl"));
      expect(err).toBeInstanceOf(OnePasswordError);
      expect(err.message).toMatch(/non-JSON output/);
    });

    // The reply() helper above exercises the bare-array shape on every test
    // (it returns `JSON.stringify(fieldsArray)`); this test pins the wrapped
    // `{fields: [...]}` shape explicitly so the normalization branch is
    // covered against silent regression.
    it("normalizes the wrapped {fields: [...]} JSON shape from op", () => {
      mockedExec.mockReturnValueOnce(
        JSON.stringify({
          fields: [
            { id: "username", purpose: "USERNAME", value: "u@example.com" },
            { id: "password", purpose: "PASSWORD", value: "p" },
          ],
        }),
      );

      const creds = resolveOnePasswordReference("op://Personal/ttctl");
      expect(creds).toEqual({ email: "u@example.com", password: "p" });
    });
  });
});

describe("resolveOnePasswordField (per-field form)", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("resolves a 3-segment field ref via `op read --no-newline` (no --account)", () => {
    mockedExec.mockReturnValueOnce("user@example.com");

    const value = resolveOnePasswordField("op://Private/Toptal/username");

    expect(value).toBe("user@example.com");
    expect(mockedExec).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockedExec.mock.calls[0] ?? [];
    expect(cmd).toBe("op");
    expect(args).toEqual(["read", "--no-newline", "op://Private/Toptal/username"]);
  });

  it("forwards --account and strips it from the ref for a 4-segment field ref (parity)", () => {
    mockedExec.mockReturnValueOnce("hunter2");

    const value = resolveOnePasswordField("op://my-account/Private/Toptal/password");

    expect(value).toBe("hunter2");
    const args = (mockedExec.mock.calls[0]?.[1] ?? []) as readonly string[];
    expect(args).toEqual(["read", "--no-newline", "--account", "my-account", "op://Private/Toptal/password"]);
  });

  // Pins the deliberate 4-segment interpretation: the leading segment is ALWAYS
  // the account, for parity with the single-item path. A native 1Password
  // SECTIONED field ref (op://vault/item/section/field — also 4-segment) is
  // therefore mis-parsed: its vault becomes --account. This is the documented
  // limitation (README § auth); the test makes the ambiguity visible so a future
  // change cannot flip it silently.
  it("reads a 4-segment ref as account-prefixed, NOT as a sectioned field ref", () => {
    mockedExec.mockReturnValueOnce("v");

    resolveOnePasswordField("op://Private/Toptal/Security/password");

    const args = (mockedExec.mock.calls[0]?.[1] ?? []) as readonly string[];
    // "Private" is taken as the account, NOT the vault of a sectioned ref.
    expect(args).toEqual(["read", "--no-newline", "--account", "Private", "op://Toptal/Security/password"]);
  });

  it("forwards a UUID account verbatim", () => {
    mockedExec.mockReturnValueOnce("u");

    resolveOnePasswordField("op://FB4OMM7TV5GW7HGY2A2NCC7PP4/Private/Toptal/username");

    const args = (mockedExec.mock.calls[0]?.[1] ?? []) as readonly string[];
    expect(args).toContain("--account");
    expect(args).toContain("FB4OMM7TV5GW7HGY2A2NCC7PP4");
    expect(args).toContain("op://Private/Toptal/username");
  });

  it("rejects shapes outside op://[account/]vault/item/field without shelling out", () => {
    expect(() => resolveOnePasswordField("not-a-ref")).toThrow(OnePasswordError);
    expect(() => resolveOnePasswordField("op://vault/item")).toThrow(OnePasswordError); // 2-seg item-level
    expect(() => resolveOnePasswordField("op://a/vault/item/field/extra")).toThrow(OnePasswordError); // 5-seg
    expect(() => resolveOnePasswordField("op://vault//field")).toThrow(OnePasswordError); // empty segment
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("translates ENOENT (op CLI not installed) into a friendly OnePasswordError", () => {
    const enoent = new Error("spawn op ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    mockedExec.mockImplementationOnce(() => {
      throw enoent;
    });

    const err = captureError(() => resolveOnePasswordField("op://Private/Toptal/username"));
    expect(err).toBeInstanceOf(OnePasswordError);
    expect(err.message).toMatch(/1Password CLI .* not found/);
  });

  it("wraps generic op read failures into OnePasswordError", () => {
    const failure = new Error("isn't an item") as NodeJS.ErrnoException;
    mockedExec.mockImplementationOnce(() => {
      throw failure;
    });

    const err = captureError(() => resolveOnePasswordField("op://Private/Toptal/nope"));
    expect(err).toBeInstanceOf(OnePasswordError);
    expect(err.message).toMatch(/op read failed/);
  });

  it("throws when op read returns an empty value", () => {
    mockedExec.mockReturnValueOnce("");

    const err = captureError(() => resolveOnePasswordField("op://Private/Toptal/username"));
    expect(err).toBeInstanceOf(OnePasswordError);
    expect(err.message).toMatch(/empty value/);
  });
});
