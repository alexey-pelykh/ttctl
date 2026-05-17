// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../transport.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../transport.js")>("../../../../transport.js");
  return {
    ...actual,
    stockTransport: vi.fn(),
    impersonatedTransport: vi.fn(),
    impersonatedMultipartTransport: vi.fn(),
  };
});

import { AuthRevokedError } from "../../../../auth/errors.js";
import { impersonatedMultipartTransport, impersonatedTransport, stockTransport } from "../../../../transport.js";
import type { TransportRequest, TransportResponse } from "../../../../transport.js";
import { ResumeError, cancelUpload, upload } from "../index.js";

const mockedStock = vi.mocked(stockTransport);
const mockedImpersonated = vi.mocked(impersonatedTransport);
const mockedMultipart = vi.mocked(impersonatedMultipartTransport);
const TOKEN = "tok-resume";

interface MockResponse {
  status?: number;
  body: unknown;
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

function replyMultipart(...responses: MockResponse[]): void {
  for (const r of responses) {
    mockedMultipart.mockResolvedValueOnce({
      status: r.status ?? 200,
      headers: {},
      body: r.body,
    } satisfies TransportResponse);
  }
}

/**
 * Stub `show` (basic) to return a viewer with a stable profileId. The
 * resume service calls `show` only to extract the viewer's `profileId`
 * for the cancelResumeUpload input; we don't need a complete
 * `ProfileShowQuery` shape.
 */
/**
 * Stub the stock-transport reply consumed by `extractProfileId`'s internal
 * `basic.show()` round-trip. Only `data.viewer.viewerRole.profileId` is
 * inspected; we don't need a complete `ProfileShowQuery` shape on the wire.
 */
function stubProfileId(profileId: string = "p1"): void {
  mockedStock.mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: {
      data: {
        viewer: {
          viewerRole: { profileId } as never,
        } as never,
      },
    },
  } satisfies TransportResponse);
}

/**
 * Stub a stock-transport reply that carries a viewer with NO `profileId`
 * (the NO_VIEWER path through `extractProfileId`).
 */
function stubProfileIdMissing(): void {
  mockedStock.mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: {
      data: {
        viewer: {
          viewerRole: {} as never,
        } as never,
      },
    },
  } satisfies TransportResponse);
}

describe("resume.upload", () => {
  beforeEach(() => {
    mockedMultipart.mockReset();
  });

  it("issues uploadResume via multipart with file bound to variables.input.file", async () => {
    replyMultipart({
      body: { data: { uploadResume: { success: true, errors: null } } },
    });

    const result = await upload(TOKEN, {
      kind: "buffer",
      filename: "cv.pdf",
      content: Buffer.from("resume-bytes"),
      contentType: "application/pdf",
    });

    expect(result.success).toBe(true);
    const call = mockedMultipart.mock.calls[0]?.[0] as Parameters<typeof mockedMultipart>[0];
    expect(call.body.operationName).toBe("uploadResume");
    expect(call.surface).toBe("talent-profile");
    expect(call.map).toEqual({ "0": ["variables.input.file"] });
    expect(call.files["0"]?.filename).toBe("cv.pdf");
    expect(call.files["0"]?.contentType).toBe("application/pdf");
  });

  it("translates ENOENT into FILE_NOT_FOUND ResumeError before any network call", async () => {
    await expect(upload(TOKEN, { kind: "path", path: "/no/such/path/resume.pdf" })).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
    expect(mockedMultipart).not.toHaveBeenCalled();
  });

  it("translates server-reported success=false into USER_ERROR", async () => {
    replyMultipart({ body: { data: { uploadResume: { success: false, errors: null } } } });

    await expect(
      upload(TOKEN, { kind: "buffer", filename: "cv.pdf", content: Buffer.from("x") }),
    ).rejects.toMatchObject({ code: "USER_ERROR" });
  });

  it("translates HTTP 401 into AuthRevokedError", async () => {
    replyMultipart({ status: 401, body: {} });

    await expect(
      upload(TOKEN, { kind: "buffer", filename: "cv.pdf", content: Buffer.from("x") }),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("resume.cancelUpload", () => {
  beforeEach(() => {
    mockedImpersonated.mockReset();
    mockedStock.mockReset();
  });

  it("resolves profileId and issues cancelResumeUpload with input.profileId", async () => {
    stubProfileId("p-cancel");
    replyImpersonated({ body: { data: { cancelResumeUpload: { success: true, errors: null } } } });

    const result = await cancelUpload(TOKEN);

    expect(result.success).toBe(true);
    expect(mockedStock).toHaveBeenCalledTimes(1);
    const call = mockedImpersonated.mock.calls[0]?.[0] as TransportRequest;
    expect(call.body.operationName).toBe("cancelResumeUpload");
    expect(call.body.variables).toEqual({ input: { profileId: "p-cancel" } });
  });

  it("returns success=false when the server reports it (idempotent path is success=true)", async () => {
    stubProfileId();
    replyImpersonated({ body: { data: { cancelResumeUpload: { success: false, errors: null } } } });

    const result = await cancelUpload(TOKEN);

    expect(result.success).toBe(false);
  });

  it("propagates NO_VIEWER when the session response is missing the profile id", async () => {
    stubProfileIdMissing();

    await expect(cancelUpload(TOKEN)).rejects.toMatchObject({ code: "NO_VIEWER" });
    expect(mockedImpersonated).not.toHaveBeenCalled();
  });
});

describe("ResumeError", () => {
  it("carries a stable name and code", () => {
    const err = new ResumeError("FILE_NOT_FOUND", "missing");
    expect(err.name).toBe("ResumeError");
    expect(err.code).toBe("FILE_NOT_FOUND");
  });
});
