// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// e2e-covers: LogOut

/**
 * Server-side `LogOut` wire-format E2E.
 *
 * Uses `withFreshSession()` (NOT `getSharedSession()`) so the deliberate
 * LogOut is isolated to a per-file subdirectory under
 * `<sandbox>/isolated-<id>/`. The shared session at `<sandbox>/.ttctl.yaml`
 * is never touched.
 *
 * Asserts:
 *   1. Signout returns `status: "signed-out"` + `serverLogOut: "logged-out"`
 *      (LogOut mutation returned `data.logOut.success === true`).
 *   2. The isolated YAML's `auth.token` field is absent post-signout.
 *   3. Regression-pinning: the captured bearer remains
 *      `{ status: "valid" }` against `getAuthStatus` immediately after
 *      LogOut — see § Auth Model in CLAUDE.md for the empirical scope
 *      of LogOut (terminates web-session state on talent_profile side;
 *      does NOT invalidate the bearer for mobile-gateway calls; 24-72h
 *      natural aging-out is the load-bearing revocation). If/when
 *      Toptal wires up server-side bearer revocation, this assertion
 *      flips — actionable signal, not silent drift.
 *   4. Idempotent re-run path.
 */

import { readFileSync } from "node:fs";

import { ConfigLoadSchema, getAuthStatus } from "@ttctl/core";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";

import { getCliClient, withFreshSession } from "./harness/index.js";
import type { CliClient } from "./harness/index.js";

const session = withFreshSession();
const e2eEnabled = process.env["TTCTL_E2E"] === "1";

interface SignOutJsonResponse {
  status: "signed-out" | "error";
  removed?: boolean;
  path?: string;
  serverLogOut?: "logged-out" | "already-invalid" | "skipped" | "unreachable";
  message?: string;
}

describe("auth signout — server-side LogOut against live Toptal (isolated session)", () => {
  let cli: CliClient;
  let isolatedConfigPath: string;
  let capturedBearer: string;

  beforeAll(() => {
    if (!e2eEnabled) return;
    const ctx = session.getContext();
    isolatedConfigPath = ctx.sandboxConfigPath;
    cli = getCliClient({ configPath: isolatedConfigPath });

    // Capture the bearer from the isolated YAML BEFORE running signout.
    // The post-LogOut probe asserts the regression-pinning expectation
    // documented in the file-level docblock: the bearer remains valid for
    // mobile-gateway calls (the empirical reality circa 2026-05-12). If
    // Toptal ever wires up server-side bearer revocation the assertion
    // flips and surfaces an actionable signal.
    const raw = readFileSync(isolatedConfigPath, "utf8");
    const parsed: unknown = parseYaml(raw);
    const validated = ConfigLoadSchema.parse(parsed);
    if (validated.auth.token === undefined || validated.auth.token === "") {
      throw new Error(
        `withFreshSession produced an isolated config without a valid auth.token at ${isolatedConfigPath}; ` +
          `cannot proceed with the server-side LogOut assertion.`,
      );
    }
    capturedBearer = validated.auth.token;
  });

  it.skipIf(!e2eEnabled)(
    "ttctl auth signout: exits 0 with serverLogOut=logged-out, removes local token, bearer remains valid (regression-pinning)",
    async () => {
      // Step 1: run signout. Expect exit 0 and a JSON envelope showing
      // both the local-clear outcome (removed: true) AND the new post-
      // #180 serverLogOut field. The best outcome is `logged-out` — the
      // LogOut mutation returned `data.logOut.success === true`.
      // `already-invalid` would be acceptable on the (rare) path where
      // Toptal had already dropped the bearer before signout fired; the
      // negative case is `unreachable`, which would surface here as a
      // soft warning and is not an error.
      const result = await cli.run(["auth", "signout", "--output", "json"]);
      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout) as SignOutJsonResponse;
      expect(payload.status).toBe("signed-out");
      expect(payload.removed).toBe(true);
      expect(payload.path).toBe(isolatedConfigPath);
      // Server acknowledged the LogOut mutation. `already-invalid` is
      // also acceptable (bearer was already not valid against
      // talent_profile before we called); reject `unreachable` and
      // `skipped` here — both indicate the wire-format flow did not
      // complete as expected.
      expect(["logged-out", "already-invalid"]).toContain(payload.serverLogOut);

      // Step 2: assert the local YAML no longer carries `auth.token`.
      const raw = readFileSync(isolatedConfigPath, "utf8");
      const parsed = parseYaml(raw) as { auth?: Record<string, unknown> } | null;
      if (parsed && parsed.auth) {
        expect(parsed.auth["token"]).toBeUndefined();
      }

      // Step 3: regression-pinning assertion. Probe the captured bearer
      // against the live mobile-gateway Viewer surface immediately after
      // the LogOut returned. Empirical evidence (#180, 2026-05-12;
      // delayed-probe investigation at .tmp/180-delayed-probe-report.json
      // probed t=0/30/60/180/300s, all valid): the gateway continues to
      // accept the bearer. The LogOut mutation succeeds on the
      // talent_profile side but does NOT propagate to mobile-gateway
      // bearer invalidation. This assertion pins that finding — when/if
      // Toptal flips this behavior the test fails and forces
      // investigation.
      const status = await getAuthStatus(capturedBearer);
      expect(status.status).toBe("valid");
    },
  );

  it.skipIf(!e2eEnabled)("ttctl auth signout: re-running is idempotent (serverLogOut=skipped, exit 0)", async () => {
    // After the first signout the local token is gone, so a second invocation
    // should short-circuit to the "no token to call with" path: skipped on the
    // server side, removed=false locally, exit 0. This verifies the idempotent
    // contract holds with the new server-side behavior.
    const result = await cli.run(["auth", "signout", "--output", "json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as SignOutJsonResponse;
    expect(payload.status).toBe("signed-out");
    expect(payload.removed).toBe(false);
    expect(payload.serverLogOut).toBe("skipped");
  });
});
