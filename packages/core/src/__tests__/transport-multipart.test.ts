// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-wreq", () => ({
  fetch: vi.fn(),
}));

import { fetch as wreqFetch } from "node-wreq";

import { Cf403Error, buildGraphQLMultipart, impersonatedMultipartTransport } from "../transport/index.js";

interface FakeResponse {
  status: number;
  headers: { toObject(): Record<string, string> };
  text(): Promise<string>;
}

function fakeResponse(opts: { status: number; headers?: Record<string, string>; body: string }): FakeResponse {
  return {
    status: opts.status,
    headers: { toObject: () => opts.headers ?? {} },
    text: () => Promise.resolve(opts.body),
  };
}

const mockedFetch = vi.mocked(wreqFetch);

function getCallInit(callIndex = 0): { headers: Record<string, string>; body: FormData } {
  const call = mockedFetch.mock.calls[callIndex];
  if (!call) throw new Error(`Expected wreqFetch call at index ${callIndex.toString()}`);
  return call[1] as { headers: Record<string, string>; body: FormData };
}

describe("buildGraphQLMultipart", () => {
  it("emits operations + map + numbered file parts in spec order", () => {
    const form = buildGraphQLMultipart(
      { operationName: "uploadResume", query: "mutation X { x }", variables: { input: { file: null } } },
      { "0": { filename: "cv.pdf", content: Buffer.from("hello"), contentType: "application/pdf" } },
      { "0": ["variables.input.file"] },
    );

    const entries = Array.from(form.entries());
    expect(entries[0]?.[0]).toBe("operations");
    const operations = entries[0]?.[1];
    expect(typeof operations).toBe("string");
    expect(JSON.parse(String(operations))).toEqual({
      operationName: "uploadResume",
      query: "mutation X { x }",
      variables: { input: { file: null } },
    });

    expect(entries[1]?.[0]).toBe("map");
    expect(JSON.parse(String(entries[1]?.[1]))).toEqual({ "0": ["variables.input.file"] });

    expect(entries[2]?.[0]).toBe("0");
    const fileEntry = entries[2]?.[1] as Blob;
    expect(fileEntry).toBeInstanceOf(Blob);
    expect(fileEntry.type).toBe("application/pdf");
  });

  it("falls back to application/octet-stream when no contentType is supplied", () => {
    const form = buildGraphQLMultipart(
      { operationName: "X", query: "mutation X { x }" },
      { "0": { filename: "blob.bin", content: Buffer.from([1, 2, 3]) } },
      { "0": ["variables.file"] },
    );
    const entries = Array.from(form.entries());
    const fileEntry = entries[2]?.[1] as Blob;
    expect(fileEntry.type).toBe("application/octet-stream");
  });

  it("handles multiple files with distinct slot labels", () => {
    const form = buildGraphQLMultipart(
      { operationName: "X", query: "mutation X { x }" },
      {
        "0": { filename: "a.png", content: Buffer.from("a"), contentType: "image/png" },
        "1": { filename: "b.txt", content: Buffer.from("b"), contentType: "text/plain" },
      },
      { "0": ["variables.fileA"], "1": ["variables.fileB"] },
    );
    const slotNames = Array.from(form.entries())
      .filter(([k]) => k === "0" || k === "1")
      .map(([k]) => k);
    expect(slotNames).toEqual(["0", "1"]);
  });
});

describe("impersonatedMultipartTransport", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("POSTs to the talent-profile endpoint with a FormData body and chrome impersonation", async () => {
    mockedFetch.mockResolvedValueOnce(
      fakeResponse({ status: 200, body: '{"data":{"uploadResume":{"success":true}}}' }) as never,
    );

    await impersonatedMultipartTransport({
      surface: "talent-profile",
      authToken: "tok-xyz",
      body: { operationName: "uploadResume", query: "mutation X { x }", variables: { input: { file: null } } },
      files: { "0": { filename: "cv.pdf", content: Buffer.from("data"), contentType: "application/pdf" } },
      map: { "0": ["variables.input.file"] },
    });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const init = getCallInit();
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers["authorization"]).toBe("Token token=tok-xyz");
  });

  it("strips the JSON content-type so node-wreq sets the multipart boundary itself", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 200, body: "{}" }) as never);

    await impersonatedMultipartTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
      files: { "0": { filename: "a", content: Buffer.from("x") } },
      map: { "0": ["variables.x"] },
    });

    const init = getCallInit();
    expect(init.headers["content-type"]).toBeUndefined();
  });

  it("translates HTTP 403 to Cf403Error with the surface and endpoint", async () => {
    mockedFetch.mockResolvedValueOnce(fakeResponse({ status: 403, body: "Forbidden" }) as never);

    await expect(
      impersonatedMultipartTransport({
        surface: "talent-profile",
        body: { operationName: "X" },
        files: { "0": { filename: "a", content: Buffer.from("x") } },
        map: { "0": ["variables.x"] },
      }),
    ).rejects.toBeInstanceOf(Cf403Error);
  });

  it("returns a parsed JSON body and headers on success", async () => {
    mockedFetch.mockResolvedValueOnce(
      fakeResponse({ status: 200, headers: { server: "cf" }, body: '{"data":{"x":1}}' }) as never,
    );

    const res = await impersonatedMultipartTransport({
      surface: "talent-profile",
      body: { operationName: "X" },
      files: { "0": { filename: "a", content: Buffer.from("x") } },
      map: { "0": ["variables.x"] },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { x: 1 } });
    expect(res.headers).toEqual({ server: "cf" });
  });
});
