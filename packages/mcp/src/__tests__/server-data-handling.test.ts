// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DATA_HANDLING_FOOTER, HIGH_RISK_TOOLS, THIRDPARTY_FREETEXT_FOOTER } from "../data-handling.js";
import { buildServer } from "../server.js";

/**
 * Integration tests for the response-side data-handling guidance wiring
 * (issue #265). The `data-handling.test.ts` companion suite covers the
 * pure-function primitives (composition, idempotency, set membership);
 * this file verifies the integration of those primitives with the
 * server's `registerTool` monkey-patch — i.e. that the augmentation
 * actually applies to every tool registered through `buildServer`.
 *
 * Without this file, a regression in `server.ts` (e.g. accidentally
 * removing the `patchedConfig` branch from the monkey-patch, or
 * breaking the `composeDescription` import) would silently disable
 * description augmentation across all 97 registered tools — no unit
 * test would notice. M2 finding from the validate phase for issue
 * #265 made this gap explicit; this suite closes it.
 *
 * The MCP SDK does not expose a stable public API for "read a
 * registered tool's description". We reach into the same internal
 * `_registeredTools` map that `tools.test.ts`, `dryrun-smoke.test.ts`,
 * and `server-diagnostic.test.ts` use to read the post-monkey-patch
 * handler. If a future SDK version renames or restructures that field,
 * update the helper below; the rest of the test is structural.
 */

type RegisteredToolEntry = {
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => unknown;
};

function readRegisteredDescription(server: ReturnType<typeof buildServer>, name: string): string | undefined {
  const internals = server as unknown as { _registeredTools: Record<string, RegisteredToolEntry> };
  const entry = internals._registeredTools[name];
  if (entry === undefined) throw new Error(`tool ${name} not registered`);
  return entry.description;
}

function listRegisteredToolNames(server: ReturnType<typeof buildServer>): string[] {
  const internals = server as unknown as { _registeredTools: Record<string, RegisteredToolEntry> };
  return Object.keys(internals._registeredTools);
}

describe("buildServer — response-side data-handling augmentation wiring (#265)", () => {
  let tmpRoot: string;
  let savedEnv: { TTCTL_CONFIG_FILE?: string; HOME?: string; USERPROFILE?: string };
  let server: ReturnType<typeof buildServer>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ttctl-mcp-data-handling-test-"));
    savedEnv = {
      ...(process.env["TTCTL_CONFIG_FILE"] !== undefined
        ? { TTCTL_CONFIG_FILE: process.env["TTCTL_CONFIG_FILE"] }
        : {}),
      ...(process.env["HOME"] !== undefined ? { HOME: process.env["HOME"] } : {}),
      ...(process.env["USERPROFILE"] !== undefined ? { USERPROFILE: process.env["USERPROFILE"] } : {}),
    };
    delete process.env["TTCTL_CONFIG_FILE"];
    process.env["HOME"] = tmpRoot;
    process.env["USERPROFILE"] = tmpRoot;

    const configPath = join(tmpRoot, "config.yaml");
    writeFileSync(configPath, "auth:\n  token: test-token\n", { mode: 0o600 });
    server = buildServer({ configPath });
  });

  afterEach(() => {
    if (savedEnv.TTCTL_CONFIG_FILE !== undefined) process.env["TTCTL_CONFIG_FILE"] = savedEnv.TTCTL_CONFIG_FILE;
    else delete process.env["TTCTL_CONFIG_FILE"];
    if (savedEnv.HOME !== undefined) process.env["HOME"] = savedEnv.HOME;
    else delete process.env["HOME"];
    if (savedEnv.USERPROFILE !== undefined) process.env["USERPROFILE"] = savedEnv.USERPROFILE;
    else delete process.env["USERPROFILE"];
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("appends the default data-handling footer to a low-risk tool's description", () => {
    const description = readRegisteredDescription(server, "ttctl_profile_basic_show");
    expect(description).toBeDefined();
    expect(description).toContain(DATA_HANDLING_FOOTER);
    // Low-risk tools must NOT carry the third-party warning — over-warning dilutes the signal.
    expect(description).not.toContain(THIRDPARTY_FREETEXT_FOOTER);
  });

  it("appends BOTH footers to a high-risk tool's description", () => {
    // Pick a tool that's in HIGH_RISK_TOOLS — applications_list is canonical.
    const description = readRegisteredDescription(server, "ttctl_applications_list");
    expect(description).toBeDefined();
    expect(description).toContain(DATA_HANDLING_FOOTER);
    expect(description).toContain(THIRDPARTY_FREETEXT_FOOTER);
  });

  it("preserves the original tool description content above the footer", () => {
    // The pre-existing description text must still appear — augmentation is additive, not destructive.
    // `profile_basic_show`'s description starts with "Fetch the signed-in user's Toptal Talent profile"
    // (see `packages/mcp/src/tools/profile_basic_show.ts` line ~42).
    const description = readRegisteredDescription(server, "ttctl_profile_basic_show");
    expect(description).toMatch(/Fetch the signed-in user's Toptal Talent profile/);
  });

  it("augments EVERY registered tool's description (no tool is silently missed)", () => {
    // The cross-cutting invariant: regardless of which tool file declared the tool, the
    // monkey-patch is the single chokepoint at registration time. Catches a regression where
    // a new registrar accidentally bypasses the patched `registerTool` (e.g. by calling
    // the SDK's private `_createRegisteredTool` directly).
    const names = listRegisteredToolNames(server);
    expect(names.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const name of names) {
      const description = readRegisteredDescription(server, name);
      if (description === undefined || !description.includes(DATA_HANDLING_FOOTER)) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("augments every HIGH_RISK_TOOLS member with the third-party footer", () => {
    // Symmetric check for the elevated tier — every tool listed in the threat-model § 5
    // High-injection row must carry both footers. Catches drift between
    // `data-handling.ts`'s HIGH_RISK_TOOLS membership and the actual registered surface
    // (e.g. a rename that breaks set membership without test failure).
    const registered = new Set(listRegisteredToolNames(server));
    for (const name of HIGH_RISK_TOOLS) {
      expect(registered.has(name)).toBe(true);
      const description = readRegisteredDescription(server, name);
      expect(description).toContain(THIRDPARTY_FREETEXT_FOOTER);
    }
  });

  it("does NOT add the third-party footer to non-high-risk tools", () => {
    // Spot-check the over-warning failure mode: payments_rate_show is High-disclosure
    // (financial PII) but Low-injection (no third-party free-text). Augmenting it with
    // the third-party warning would dilute the injection-specific signal.
    const description = readRegisteredDescription(server, "ttctl_payments_rate_show");
    expect(description).toContain(DATA_HANDLING_FOOTER);
    expect(description).not.toContain(THIRDPARTY_FREETEXT_FOOTER);

    // Also `contracts_show` — re-classified Low-injection in the M1 audit revision.
    const contractsDescription = readRegisteredDescription(server, "ttctl_contracts_show");
    expect(contractsDescription).toContain(DATA_HANDLING_FOOTER);
    expect(contractsDescription).not.toContain(THIRDPARTY_FREETEXT_FOOTER);
  });
});
