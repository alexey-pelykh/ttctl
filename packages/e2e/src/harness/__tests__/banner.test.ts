// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { printPreflightBanner, resetBannerForTesting } from "../banner.js";

afterEach(() => {
  resetBannerForTesting();
});

class CaptureStream extends Writable {
  chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, callback: (err?: Error | null) => void): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

describe("printPreflightBanner", () => {
  it("emits a multi-line banner on the supplied stream", () => {
    const stream = new CaptureStream();
    printPreflightBanner({ stream });
    const text = stream.text();

    expect(text).toContain("TTCtl E2E HARNESS");
    expect(text).toContain("E2E will sign in to Toptal");
    expect(text).toContain("Any concurrent browser session may be invalidated");
    expect(text).toContain(".tmp/e2e/session.cookies");
    expect(text).toContain("~/.ttctl/session.cookies");
    // Multi-line — contains at least 5 newlines (banner is ~10 lines)
    expect(text.split("\n").length).toBeGreaterThanOrEqual(5);
  });

  it("emits exactly once per process — second call is a no-op", () => {
    const stream = new CaptureStream();
    printPreflightBanner({ stream });
    const firstText = stream.text();

    printPreflightBanner({ stream });
    const secondText = stream.text();

    expect(secondText).toBe(firstText);
  });

  it("respects resetBannerForTesting (test-only escape hatch)", () => {
    const stream = new CaptureStream();
    printPreflightBanner({ stream });
    const firstText = stream.text();

    resetBannerForTesting();

    const stream2 = new CaptureStream();
    printPreflightBanner({ stream: stream2 });
    expect(stream2.text()).toBe(firstText); // same content, fresh emission
  });

  it("the first call's stream wins; later calls are no-ops regardless of stream", () => {
    const first = new CaptureStream();
    const second = new CaptureStream();
    printPreflightBanner({ stream: first });
    printPreflightBanner({ stream: second });

    expect(first.text()).toContain("TTCtl E2E HARNESS");
    expect(second.text()).toBe("");
  });

  it("defaults to process.stderr when stream is not provided (smoke — does not throw)", () => {
    expect(() => printPreflightBanner()).not.toThrow();
  });
});
