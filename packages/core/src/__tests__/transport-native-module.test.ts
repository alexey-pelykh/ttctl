// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-wreq", () => ({
  fetch: vi.fn(),
}));

import { fetch as wreqFetch } from "node-wreq";

import { TtctlError } from "../auth/errors.js";
import { impersonatedMultipartTransport, impersonatedTransport, NativeModuleUnavailableError } from "../transport.js";

const mockedFetch = vi.mocked(wreqFetch);

// The two distinct messages node-wreq@2.4.1's `dist/native/binding.js`
// throws from its lazy `getBinding()` resolver — one per missing-binary
// failure mode. `linux-arm64-musl` (Alpine ARM64) hits the second;
// `win32-arm64` (Windows ARM) hits the first.
const UNSUPPORTED_PLATFORM_MSG =
  "Unsupported platform: win32-arm64. Supported platforms: darwin-x64, darwin-arm64, " +
  "linux-x64-gnu, linux-x64-musl, linux-arm64-gnu, win32-x64-msvc";
const LOAD_FAILURE_MSG =
  "Failed to load native module for linux-arm64. Tried: @node-wreq/linux-arm64-gnu. " +
  "Make sure the matching @node-wreq platform package is installed or build the local native module.";

const jsonRequest = {
  surface: "talent-profile" as const,
  body: { operationName: "Viewer", variables: {} },
};

describe("NativeModuleUnavailableError", () => {
  it("is a TtctlError with the stable code and a recovery hint", () => {
    const err = new NativeModuleUnavailableError("linux", "arm64");
    expect(err).toBeInstanceOf(TtctlError);
    expect(err.code).toBe("NATIVE_MODULE_UNAVAILABLE");
    expect(err.name).toBe("NativeModuleUnavailableError");
    expect(err.platform).toBe("linux");
    expect(err.arch).toBe("arm64");
    expect(err.recovery).toContain("https://github.com/alexey-pelykh/ttctl/issues");
  });

  it("names the platform-arch and the supported set + known gaps in the message", () => {
    const msg = new NativeModuleUnavailableError("win32", "arm64").message;
    expect(msg).toContain("win32-arm64");
    expect(msg).toContain("Supported platforms:");
    expect(msg).toContain("linux-arm64-musl");
    expect(msg).toContain("Windows on ARM");
  });

  it("preserves the original node-wreq error as cause", () => {
    const cause = new Error(LOAD_FAILURE_MSG);
    const err = new NativeModuleUnavailableError("linux", "arm64", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("impersonatedTransport native-module translation (#708)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("translates a 'Failed to load native module' failure into NativeModuleUnavailableError", async () => {
    mockedFetch.mockRejectedValue(new Error(LOAD_FAILURE_MSG));
    await expect(impersonatedTransport(jsonRequest)).rejects.toBeInstanceOf(NativeModuleUnavailableError);
    // No retry — the native-load failure is deterministic, not transient.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("translates an 'Unsupported platform' failure into NativeModuleUnavailableError", async () => {
    mockedFetch.mockRejectedValue(new Error(UNSUPPORTED_PLATFORM_MSG));
    await expect(impersonatedTransport(jsonRequest)).rejects.toBeInstanceOf(NativeModuleUnavailableError);
  });

  it("carries the current process platform/arch and the original error as cause", async () => {
    const original = new Error(LOAD_FAILURE_MSG);
    mockedFetch.mockRejectedValue(original);
    const err = await impersonatedTransport(jsonRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NativeModuleUnavailableError);
    const native = err as NativeModuleUnavailableError;
    expect(native.platform).toBe(process.platform);
    expect(native.arch).toBe(process.arch);
    expect(native.cause).toBe(original);
  });

  it("does NOT translate unrelated transport errors (network failure propagates verbatim)", async () => {
    const network = new Error("ECONNRESET");
    mockedFetch.mockRejectedValue(network);
    const err = await impersonatedTransport(jsonRequest).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NativeModuleUnavailableError);
    expect(err).toBe(network);
  });
});

describe("impersonatedMultipartTransport native-module translation (#708)", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("translates a native-module load failure on the photo/file upload path too", async () => {
    mockedFetch.mockRejectedValue(new Error(LOAD_FAILURE_MSG));
    await expect(
      impersonatedMultipartTransport({
        surface: "talent-profile",
        body: { operationName: "uploadResume", variables: { input: { file: null } } },
        files: { "0": { filename: "cv.pdf", content: Buffer.from("x") } },
        map: { "0": ["variables.input.file"] },
      }),
    ).rejects.toBeInstanceOf(NativeModuleUnavailableError);
  });
});
