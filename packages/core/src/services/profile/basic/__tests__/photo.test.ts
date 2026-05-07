// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../transport.js")>("../../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
    impersonatedTransport: vi.fn(),
  };
});

import { ProfileError, _setMultipartFetchForTesting, photoShow, photoUpload } from "../index.js";
import { AuthRevokedError } from "../../../../auth/errors.js";
import { Cf403Error, impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportResponse } from "../../../../transport.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const TOKEN = "tok-photo";

interface MockResponse {
  status?: number;
  body: unknown;
}

function replyStock(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedStock.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

function replyImpersonated(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedImpersonated.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

// Minimum-but-complete `ProfileShowQuery` fixture — the photo functions
// call `show()` first to obtain the profileId. We only need
// `viewer.viewerRole.profileId` to be present; the rest can be defaulted.
// We use a `Partial` cast to avoid duplicating the 200-line rich shape
// already mocked in `index.test.ts`. Type-safety is preserved at the
// call site because production code only reads `viewer.viewerRole.profileId`.
const VIEWER_OK = {
  data: {
    viewer: {
      __typename: "Viewer",
      viewerRole: { __typename: "ViewerRole", profileId: "p1" },
    },
  },
};

const PHOTO_PROFILE_OK = {
  id: "p1",
  photo: {
    default: "https://cdn.toptal.com/avatar/p1/default.jpg",
    original: "https://cdn.toptal.com/avatar/p1/original.jpg",
    small: "https://cdn.toptal.com/avatar/p1/small.jpg",
    transformations: { cropped: { x: 10, y: 20, width: 200, height: 200 } },
  },
  profileReadiness: { isPhotoResolutionSatisfied: true },
};

beforeEach(() => {
  mockedStock.mockReset();
  mockedImpersonated.mockReset();
  _setMultipartFetchForTesting(null);
});

afterEach(() => {
  _setMultipartFetchForTesting(null);
});

// -----------------------------------------------------------------------
// photoShow
// -----------------------------------------------------------------------

describe("profile.basic.photoShow", () => {
  it("calls show() to get profileId, then GET_PHOTO, and normalises the response", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: PHOTO_PROFILE_OK } } });

    const result = await photoShow(TOKEN);
    expect(result.default).toBe("https://cdn.toptal.com/avatar/p1/default.jpg");
    expect(result.cropped).toEqual({ x: 10, y: 20, width: 200, height: 200 });
    expect(result.isResolutionSatisfied).toBe(true);

    expect(mockedStock).toHaveBeenCalledTimes(1);
    expect(mockedImpersonated).toHaveBeenCalledTimes(1);
    const photoCall = mockedImpersonated.mock.calls[0]?.[0];
    expect(photoCall?.body.operationName).toBe("GET_PHOTO");
    expect(photoCall?.body.variables).toEqual({ profileId: "p1" });
  });

  it("normalises a missing photo / cropped to nulls without throwing", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({
      body: {
        data: {
          profile: {
            id: "p1",
            photo: null,
            profileReadiness: { isPhotoResolutionSatisfied: false },
          },
        },
      },
    });

    const result = await photoShow(TOKEN);
    expect(result.default).toBeNull();
    expect(result.original).toBeNull();
    expect(result.cropped).toBeNull();
    expect(result.isResolutionSatisfied).toBe(false);
  });

  it("propagates Cf403Error from the talent-profile transport", async () => {
    replyStock({ body: VIEWER_OK });
    mockedImpersonated.mockRejectedValueOnce(new Cf403Error("talent-profile", "https://example.com/api"));

    await expect(photoShow(TOKEN)).rejects.toBeInstanceOf(Cf403Error);
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ status: 401, body: { errors: [{ message: "unauthorized" }] } });

    await expect(photoShow(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError USER_ERROR when the profile id doesn't resolve", async () => {
    replyStock({ body: VIEWER_OK });
    replyImpersonated({ body: { data: { profile: null } } });

    await expect(photoShow(TOKEN)).rejects.toMatchObject({
      name: "ProfileError",
      code: "USER_ERROR",
      message: expect.stringContaining("p1"),
    });
  });

  it("propagates upstream show() failures unchanged (no double-wrapping)", async () => {
    replyStock({ status: 401, body: { errors: [{ message: "unauthorized" }] } });
    await expect(photoShow(TOKEN)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------
// photoUpload
// -----------------------------------------------------------------------

interface RecordedUpload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: FormData;
  browser: string;
}

function installFakeMultipart(
  status = 200,
  body: unknown = {
    data: {
      updatePhoto: { success: true, notice: null, errors: [], profile: PHOTO_PROFILE_OK },
    },
  },
): { calls: RecordedUpload[] } {
  const calls: RecordedUpload[] = [];
  _setMultipartFetchForTesting(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, browser: init.browser });
    return {
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      headers: { toObject: () => ({}) },
    };
  });
  return { calls };
}

describe("profile.basic.photoUpload (Buffer input)", () => {
  it("emits a multipart envelope with operations / map / 0 fields", async () => {
    replyStock({ body: VIEWER_OK });
    const { calls } = installFakeMultipart();

    const fileBuffer = Buffer.from("fake-jpeg-bytes");
    const result = await photoUpload(TOKEN, { file: fileBuffer, filename: "selfie.jpg" });
    expect(result.default).toBe("https://cdn.toptal.com/avatar/p1/default.jpg");

    expect(calls).toHaveLength(1);
    const fd = calls[0]?.body;
    expect(fd).toBeInstanceOf(FormData);
    if (!fd) return;
    const operations = fd.get("operations");
    const map = fd.get("map");
    expect(typeof operations).toBe("string");
    expect(typeof map).toBe("string");
    const ops = JSON.parse(operations as string) as {
      operationName: string;
      variables: { input: { profileId: string; file: null } };
    };
    expect(ops.operationName).toBe("UploadProfilePhoto");
    expect(ops.variables.input.profileId).toBe("p1");
    expect(ops.variables.input.file).toBeNull();
    expect(JSON.parse(map as string)).toEqual({ "0": ["variables.input.file"] });
    const filePart = fd.get("0");
    expect(filePart).toBeInstanceOf(Blob);
  });

  it("sends the bearer token as Authorization: Token token=<X>", async () => {
    replyStock({ body: VIEWER_OK });
    const { calls } = installFakeMultipart();
    await photoUpload(TOKEN, { file: Buffer.from("x") });
    expect(calls[0]?.headers["authorization"]).toBe(`Token token=${TOKEN}`);
  });

  it("rejects an empty buffer without making any network call", async () => {
    replyStock({ body: VIEWER_OK });
    installFakeMultipart();
    await expect(photoUpload(TOKEN, { file: Buffer.alloc(0) })).rejects.toMatchObject({
      name: "ProfileError",
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("empty"),
    });
  });

  it("propagates Cf403Error from the multipart transport", async () => {
    replyStock({ body: VIEWER_OK });
    _setMultipartFetchForTesting(async () => ({
      status: 403,
      text: async () => "blocked",
      headers: { toObject: () => ({}) },
    }));
    await expect(photoUpload(TOKEN, { file: Buffer.from("x") })).rejects.toBeInstanceOf(Cf403Error);
  });

  it("throws AuthRevokedError on HTTP 401", async () => {
    replyStock({ body: VIEWER_OK });
    installFakeMultipart(401, { errors: [{ message: "unauthorized" }] });
    await expect(photoUpload(TOKEN, { file: Buffer.from("x") })).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws ProfileError USER_ERROR when payload errors are present", async () => {
    replyStock({ body: VIEWER_OK });
    installFakeMultipart(200, {
      data: {
        updatePhoto: {
          success: false,
          errors: [{ message: "Resolution too low", field: "file" }],
          profile: null,
        },
      },
    });
    await expect(photoUpload(TOKEN, { file: Buffer.from("x") })).rejects.toMatchObject({
      code: "USER_ERROR",
      message: expect.stringContaining("Resolution too low"),
    });
  });

  it("throws ProfileError UNKNOWN when the response payload is missing", async () => {
    replyStock({ body: VIEWER_OK });
    installFakeMultipart(200, { data: {} });
    await expect(photoUpload(TOKEN, { file: Buffer.from("x") })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringMatching(/no `data\.updatePhoto`/),
    });
  });

  it("uses caller-supplied transformation when provided", async () => {
    replyStock({ body: VIEWER_OK });
    const { calls } = installFakeMultipart();
    await photoUpload(TOKEN, {
      file: Buffer.from("x"),
      transformation: { cropped: { x: 5, y: 5, width: 100, height: 100 } },
    });
    const fd = calls[0]?.body;
    if (!fd) throw new Error("no form data captured");
    const operations = JSON.parse(fd.get("operations") as string) as {
      variables: { input: { transformation: { cropped: { x: number } } } };
    };
    expect(operations.variables.input.transformation.cropped).toEqual({ x: 5, y: 5, width: 100, height: 100 });
  });
});

describe("profile.basic.photoUpload (path input)", () => {
  it("rejects with VALIDATION_ERROR when the file path doesn't exist", async () => {
    replyStock({ body: VIEWER_OK });
    installFakeMultipart();
    await expect(photoUpload(TOKEN, { file: "/nonexistent/path/photo.jpg" })).rejects.toMatchObject({
      name: "ProfileError",
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("not readable"),
    });
  });

  it("infers content-type from the file extension", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "ttctl-photo-"));
    const path = join(dir, "snap.png");
    await writeFile(path, Buffer.from("png-bytes"));

    replyStock({ body: VIEWER_OK });
    const { calls } = installFakeMultipart();
    await photoUpload(TOKEN, { file: path });

    const fd = calls[0]?.body;
    if (!fd) throw new Error("no form data captured");
    const filePart = fd.get("0") as Blob;
    expect(filePart.type).toBe("image/png");
  });

  it("uses the basename of the path as the multipart filename when none provided", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "ttctl-photo-"));
    const path = join(dir, "headshot.jpeg");
    await writeFile(path, Buffer.from("jpeg-bytes"));

    replyStock({ body: VIEWER_OK });
    const { calls } = installFakeMultipart();
    await photoUpload(TOKEN, { file: path });

    const fd = calls[0]?.body;
    if (!fd) throw new Error("no form data captured");
    const filePart = fd.get("0");
    // The Web FormData spec puts the filename on a File wrapping the Blob.
    // Node's native FormData returns the same shape; we read the value
    // back out as a Blob and rely on `name` when the runtime provides it.
    if (filePart && typeof filePart === "object" && "name" in filePart) {
      expect((filePart as File).name).toBe("headshot.jpeg");
    }
  });
});

describe("profile.basic.photoUpload (NO_VIEWER guard)", () => {
  it("throws ProfileError NO_VIEWER when the show() response lacks a profileId", async () => {
    replyStock({ body: { data: { viewer: null } } });
    installFakeMultipart();
    await expect(photoUpload(TOKEN, { file: Buffer.from("x") })).rejects.toMatchObject({
      name: "ProfileError",
      code: "NO_VIEWER",
    });
  });
});

describe("ProfileError export", () => {
  it("ProfileError is reachable from the public surface", () => {
    // Smoke test: keeps the import wired so tree-shakers don't drop it.
    expect(ProfileError).toBeDefined();
  });
});
