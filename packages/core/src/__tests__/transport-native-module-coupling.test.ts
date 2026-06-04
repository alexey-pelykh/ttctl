// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the native-module-error coupling (issue #708).
 *
 * `isNativeModuleLoadError` (transport.ts) recognises node-wreq's native-binding
 * load failure by matching two message substrings — the only signal available,
 * since node-wreq throws a plain `Error`, not a typed class. If a node-wreq bump
 * rewords those messages, the translation silently regresses to the raw error on
 * unsupported platforms. This reads node-wreq's actual binding loader and fails
 * loudly when either phrase disappears, so the detector substrings get
 * re-verified at bump time. `createRequire`/`readFileSync` resolve the real
 * on-disk module (no `vi.mock` here), independent of pnpm layout.
 */
describe("node-wreq native-load message coupling (#708)", () => {
  it("node-wreq's binding loader still throws the two messages the detector matches", () => {
    const require = createRequire(import.meta.url);
    const bindingPath = resolve(dirname(require.resolve("node-wreq")), "native/binding.js");
    const src = readFileSync(bindingPath, "utf8");
    // Keep these in sync with isNativeModuleLoadError() in transport.ts.
    expect(src).toContain("Failed to load native module");
    expect(src).toContain("Unsupported platform");
  });
});
