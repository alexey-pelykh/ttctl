// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { Cookie, CookieJar, MemoryCookieStore } from "tough-cookie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCookieJar, discoverCookieJarPath, loadCookieJar, saveCookieJar } from "../cookieJar.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ttctl-cookiejar-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeCookie(args: {
  key: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: Date | "Infinity";
  hostOnly?: boolean;
}): Cookie {
  return new Cookie({
    key: args.key,
    value: args.value,
    domain: args.domain,
    path: args.path ?? "/",
    secure: args.secure ?? false,
    httpOnly: args.httpOnly ?? false,
    expires: args.expires ?? "Infinity",
    hostOnly: args.hostOnly ?? true,
  });
}

async function jarFromCookies(cookies: Cookie[]): Promise<CookieJar> {
  const store = new MemoryCookieStore();
  const jar = new CookieJar(store);
  for (const c of cookies) await store.putCookie(c);
  return jar;
}

async function getAllCookies(jar: CookieJar): Promise<Cookie[]> {
  const serialized = await jar.serialize();
  const cookies: Cookie[] = [];
  for (const sc of serialized.cookies) {
    const c = Cookie.fromJSON(sc);
    if (c !== undefined) cookies.push(c);
  }
  return cookies;
}

/** First non-blank, non-comment line of a Mozilla cookies file; throws if absent. */
function firstDataLine(text: string): string {
  const line = text.split("\n").find((l) => l !== "" && !l.startsWith("#"));
  if (line === undefined) throw new Error("expected at least one data row");
  return line;
}

describe("discoverCookieJarPath", () => {
  it("returns ~/.ttctl/session.cookies on Linux when XDG_DATA_HOME is unset", () => {
    const path = discoverCookieJarPath({
      env: {},
      platform: "linux",
      homeDir: "/home/u",
    });
    expect(path).toBe(join("/home/u", ".ttctl", "session.cookies"));
  });

  it("honors XDG_DATA_HOME on Linux when set", () => {
    const path = discoverCookieJarPath({
      env: { XDG_DATA_HOME: "/var/data/me" },
      platform: "linux",
      homeDir: "/home/u",
    });
    expect(path).toBe(join("/var/data/me", "ttctl", "session.cookies"));
  });

  it("treats empty XDG_DATA_HOME as unset (per XDG spec)", () => {
    const path = discoverCookieJarPath({
      env: { XDG_DATA_HOME: "" },
      platform: "linux",
      homeDir: "/home/u",
    });
    expect(path).toBe(join("/home/u", ".ttctl", "session.cookies"));
  });

  it("uses ~/.ttctl on macOS", () => {
    const path = discoverCookieJarPath({
      env: {},
      platform: "darwin",
      homeDir: "/Users/u",
    });
    expect(path).toBe(join("/Users/u", ".ttctl", "session.cookies"));
  });

  it("uses %APPDATA% on Windows when set", () => {
    const path = discoverCookieJarPath({
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      platform: "win32",
      homeDir: "C:\\Users\\u",
    });
    expect(path.endsWith(`ttctl${sep}session.cookies`)).toBe(true);
    expect(path).toContain("AppData");
    expect(path).toContain("Roaming");
  });

  it("falls back to %USERPROFILE%\\AppData\\Roaming on Windows when APPDATA is unset", () => {
    const path = discoverCookieJarPath({
      env: { USERPROFILE: "C:\\Users\\u" },
      platform: "win32",
      homeDir: "C:\\Users\\u",
    });
    expect(path).toContain("AppData");
    expect(path).toContain("Roaming");
    expect(path).toContain("ttctl");
  });
});

describe("createCookieJar", () => {
  it("returns a fresh jar with no cookies", async () => {
    const jar = createCookieJar();
    const cookies = await getAllCookies(jar);
    expect(cookies).toEqual([]);
  });

  it("returns independent jar instances on each call (no shared store)", async () => {
    const a = createCookieJar();
    const b = createCookieJar();
    await a.setCookie("k=v; Path=/", "https://example.com/");
    expect((await getAllCookies(a)).map((c) => c.key)).toEqual(["k"]);
    expect(await getAllCookies(b)).toEqual([]);
  });

  it("returns a jar that round-trips through save → load (smoke test for store compatibility)", async () => {
    const path = join(workDir, "fresh.cookies");
    const jar = createCookieJar();
    await jar.setCookie("hello=world; Path=/", "https://example.com/");
    await saveCookieJar(path, jar);
    const restored = await loadCookieJar(path);
    expect((await getAllCookies(restored)).map((c) => c.key)).toEqual(["hello"]);
  });
});

describe("loadCookieJar / saveCookieJar — round-trip", () => {
  it("write 5 cookies → read → write again → read; final state matches", async () => {
    const path = join(workDir, "session.cookies");
    const original = [
      makeCookie({
        key: "_toptal_session_id",
        value: "abc123",
        domain: "talent.toptal.com",
        secure: true,
        httpOnly: true,
      }),
      makeCookie({ key: "current_role_id", value: "role-42", domain: "toptal.com", hostOnly: false }),
      makeCookie({
        key: "_csrf_token",
        value: '"quoted-token-value=="',
        domain: "talent.toptal.com",
        secure: true,
      }),
      makeCookie({
        key: "cf_clearance",
        value: "cleared-xyz",
        domain: "toptal.com",
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: false,
        expires: new Date(Date.UTC(2030, 0, 1, 0, 0, 0)),
      }),
      makeCookie({ key: "session_marker", value: "session-only", domain: "talent.toptal.com" }),
    ];

    await saveCookieJar(path, await jarFromCookies(original));
    const firstRead = await loadCookieJar(path);
    await saveCookieJar(path, firstRead);
    const finalRead = await loadCookieJar(path);

    const finalCookies = await getAllCookies(finalRead);
    expect(finalCookies).toHaveLength(5);

    const byKey = new Map(finalCookies.map((c) => [c.key, c]));

    const session = byKey.get("_toptal_session_id");
    expect(session?.value).toBe("abc123");
    expect(session?.domain).toBe("talent.toptal.com");
    expect(session?.path).toBe("/");
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(true);
    expect(session?.hostOnly).toBe(true);
    expect(session?.expires).toBe("Infinity");

    const role = byKey.get("current_role_id");
    expect(role?.value).toBe("role-42");
    expect(role?.domain).toBe("toptal.com");
    expect(role?.hostOnly).toBe(false);

    const csrf = byKey.get("_csrf_token");
    expect(csrf?.value).toBe('"quoted-token-value=="');
    expect(csrf?.domain).toBe("talent.toptal.com");
    expect(csrf?.secure).toBe(true);

    const cf = byKey.get("cf_clearance");
    expect(cf?.value).toBe("cleared-xyz");
    expect(cf?.domain).toBe("toptal.com");
    expect(cf?.path).toBe("/");
    expect(cf?.httpOnly).toBe(true);
    expect(cf?.secure).toBe(true);
    expect(cf?.hostOnly).toBe(false);
    // Expiry round-trip: Mozilla format stores UNIX seconds, so a Date with
    // sub-second precision will be truncated. The fixture uses a clean
    // second boundary (Y2030-01-01T00:00:00Z), so equality holds exactly.
    expect(cf?.expires).toEqual(new Date(Date.UTC(2030, 0, 1, 0, 0, 0)));

    const marker = byKey.get("session_marker");
    expect(marker?.value).toBe("session-only");
    expect(marker?.domain).toBe("talent.toptal.com");
    expect(marker?.expires).toBe("Infinity");
  });

  it("returns an empty jar when the file does not exist (first-run case)", async () => {
    const path = join(workDir, "missing.cookies");
    const jar = await loadCookieJar(path);
    const cookies = await getAllCookies(jar);
    expect(cookies).toHaveLength(0);
  });

  it("returns an empty jar when the file has only comment lines", async () => {
    const path = join(workDir, "comments.cookies");
    await writeFile(path, "# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n\n", "utf8");
    const jar = await loadCookieJar(path);
    const cookies = await getAllCookies(jar);
    expect(cookies).toHaveLength(0);
  });
});

describe("saveCookieJar — Mozilla format conformance", () => {
  it("emits the canonical Netscape header", async () => {
    const path = join(workDir, "session.cookies");
    await saveCookieJar(path, await jarFromCookies([]));
    const text = await readFile(path, "utf8");
    expect(text.startsWith("# Netscape HTTP Cookie File\n")).toBe(true);
    expect(text).toContain("# https://curl.se/docs/http-cookies.html");
  });

  it("uses tab-separated 7-field rows", async () => {
    const path = join(workDir, "session.cookies");
    await saveCookieJar(path, await jarFromCookies([makeCookie({ key: "k", value: "v", domain: "example.com" })]));
    const text = await readFile(path, "utf8");
    expect(firstDataLine(text).split("\t")).toHaveLength(7);
  });

  it("prefixes HttpOnly cookies with #HttpOnly_", async () => {
    const path = join(workDir, "session.cookies");
    await saveCookieJar(
      path,
      await jarFromCookies([
        makeCookie({
          key: "session",
          value: "hidden",
          domain: "talent.toptal.com",
          httpOnly: true,
        }),
      ]),
    );
    const text = await readFile(path, "utf8");
    expect(text).toContain("#HttpOnly_talent.toptal.com\t");
  });

  it("does NOT prefix non-HttpOnly cookies", async () => {
    const path = join(workDir, "session.cookies");
    await saveCookieJar(
      path,
      await jarFromCookies([makeCookie({ key: "k", value: "v", domain: "example.com", httpOnly: false })]),
    );
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("#HttpOnly_");
  });

  it("encodes session cookies (no expiry) as expires=0", async () => {
    const path = join(workDir, "session.cookies");
    await saveCookieJar(path, await jarFromCookies([makeCookie({ key: "k", value: "v", domain: "example.com" })]));
    const text = await readFile(path, "utf8");
    const fields = firstDataLine(text).split("\t");
    expect(fields[4]).toBe("0");
  });

  it("encodes Date expiry as UNIX seconds", async () => {
    const path = join(workDir, "session.cookies");
    const futureMs = Date.UTC(2030, 5, 15, 12, 0, 0);
    await saveCookieJar(
      path,
      await jarFromCookies([
        makeCookie({
          key: "k",
          value: "v",
          domain: "example.com",
          expires: new Date(futureMs),
        }),
      ]),
    );
    const text = await readFile(path, "utf8");
    const fields = firstDataLine(text).split("\t");
    expect(fields[4]).toBe(Math.floor(futureMs / 1000).toString());
  });

  it("preserves _csrf_token quoting verbatim (no normalization)", async () => {
    const path = join(workDir, "session.cookies");
    const quoted = '"abc==xyz=="';
    await saveCookieJar(
      path,
      await jarFromCookies([makeCookie({ key: "_csrf_token", value: quoted, domain: "talent.toptal.com" })]),
    );
    const text = await readFile(path, "utf8");
    expect(text).toContain(`\t_csrf_token\t${quoted}`);
  });

  it("encodes hostOnly=true as includeSubdomains=FALSE", async () => {
    const path = join(workDir, "session.cookies");
    await saveCookieJar(
      path,
      await jarFromCookies([makeCookie({ key: "k", value: "v", domain: "example.com", hostOnly: true })]),
    );
    const text = await readFile(path, "utf8");
    expect(firstDataLine(text).split("\t")[1]).toBe("FALSE");
  });

  it("encodes hostOnly=false as includeSubdomains=TRUE", async () => {
    const path = join(workDir, "session.cookies");
    await saveCookieJar(
      path,
      await jarFromCookies([makeCookie({ key: "k", value: "v", domain: "toptal.com", hostOnly: false })]),
    );
    const text = await readFile(path, "utf8");
    expect(firstDataLine(text).split("\t")[1]).toBe("TRUE");
  });
});

describe("saveCookieJar — atomic write", () => {
  it("writes to a sibling .tmp then renames; no .tmp remains after success", async () => {
    const path = join(workDir, "session.cookies");
    await saveCookieJar(path, await jarFromCookies([makeCookie({ key: "k", value: "v", domain: "example.com" })]));
    const tmpExists = await stat(`${path}.tmp`).catch(() => null);
    expect(tmpExists).toBeNull();
    const finalExists = await stat(path);
    expect(finalExists.isFile()).toBe(true);
  });

  it("a partial .tmp file does not corrupt a previously-valid jar", async () => {
    // Establish a valid jar.
    const path = join(workDir, "session.cookies");
    await saveCookieJar(path, await jarFromCookies([makeCookie({ key: "v1", value: "old", domain: "example.com" })]));
    const before = await readFile(path, "utf8");

    // Simulate a crashed write: a leftover *.tmp containing a half-formed
    // file. The next saveCookieJar must overwrite it cleanly; a subsequent
    // load must see the valid (post-rename) state, never the partial.
    await writeFile(`${path}.tmp`, "# garbage half-write", "utf8");

    // The old file is still readable (atomicity claim: previous valid state
    // survives until the rename point).
    const stillValid = await loadCookieJar(path);
    const cookies = await getAllCookies(stillValid);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.value).toBe("old");
    // And the on-disk content is unchanged.
    expect(await readFile(path, "utf8")).toBe(before);

    // A subsequent successful save replaces both the leftover tmp and the
    // file in one rename — no partial state observed.
    await saveCookieJar(path, await jarFromCookies([makeCookie({ key: "v2", value: "new", domain: "example.com" })]));
    const tmpAfter = await stat(`${path}.tmp`).catch(() => null);
    expect(tmpAfter).toBeNull();
    const reread = await loadCookieJar(path);
    const after = await getAllCookies(reread);
    expect(after).toHaveLength(1);
    expect(after[0]?.value).toBe("new");
  });

  it("creates parent directories that don't yet exist", async () => {
    const path = join(workDir, "nested", "deeper", "session.cookies");
    await saveCookieJar(path, await jarFromCookies([makeCookie({ key: "k", value: "v", domain: "example.com" })]));
    const s = await stat(path);
    expect(s.isFile()).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("saveCookieJar — Unix permissions", () => {
  it("writes session.cookies with 0600 permissions", async () => {
    const path = join(workDir, "session.cookies");
    await saveCookieJar(path, await jarFromCookies([makeCookie({ key: "k", value: "v", domain: "example.com" })]));
    const s = await stat(path);
    // Mask off file-type bits; assert exactly user-rw, group/other =  0.
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("re-saving an existing 0600 file preserves 0600", async () => {
    const path = join(workDir, "session.cookies");
    await saveCookieJar(path, await jarFromCookies([makeCookie({ key: "k", value: "v", domain: "example.com" })]));
    await saveCookieJar(path, await jarFromCookies([makeCookie({ key: "k", value: "v2", domain: "example.com" })]));
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o600);
  });
});
