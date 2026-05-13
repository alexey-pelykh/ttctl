// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// e2e-covers: LogOut

/**
 * Server-side LogOut wire-format E2E test (#180).
 *
 * Numeric prefix `97-` places this AFTER the adversarial `50-` case and
 * BEFORE the crash-injection (`98-`) and terminal smoke (`99-`) files.
 * Per the file-ordering invariant in `vitest.e2e.config.ts`, alphabetical
 * ordering is the logical run order: 50 < 97 < 98 < 99.
 *
 * This file uses `withFreshSession()` (NOT `getSharedSession()`) so its
 * deliberate LogOut call is ISOLATED to a per-file subdirectory under
 * `<sandbox>/isolated-<id>/`. Sibling `getSharedSession()`-using files
 * (`01-`, `99-`) read the SHARED token at `<sandbox>/.ttctl.yaml` written
 * by `globalSetup`, which this file never touches.
 *
 * What this asserts:
 *
 *   1. `withFreshSession()` performs an isolated signin, leaving a valid
 *      bearer token in the per-file isolated YAML config.
 *   2. The test captures the bearer string from the isolated YAML BEFORE
 *      running signout so it can probe gateway state after LogOut.
 *   3. `ttctl auth signout --output=json` runs against the isolated config.
 *      The JSON output is asserted to be `status: "signed-out"` plus the
 *      post-#180 `serverLogOut: "logged-out"` (best case) — the LogOut
 *      mutation against `talent_profile/graphql` returned
 *      `data.logOut.success === true`.
 *   4. The isolated YAML's `auth.token` field is absent post-signout.
 *   5. **Regression-pinning assertion** (post-validate Finding 3): the
 *      captured bearer remains `{ status: "valid" }` against
 *      `getAuthStatus` immediately after LogOut. This pins the empirical
 *      bearer-invalidation scope (see Live Discovery below). When/if
 *      Toptal ever wires up server-side bearer revocation, this assertion
 *      will fail — that flip is an actionable test signal, not silent
 *      drift.
 *
 * **Live discovery (#180, 2026-05-12)**: the `LogOut` mutation against
 * `talent_profile/graphql` succeeds (`data.logOut.success === true`) but
 * does NOT invalidate the bearer for subsequent mobile-gateway calls. The
 * delayed-probe investigation captured at `.tmp/180-delayed-probe-report.json`
 * (one-off script `packages/e2e/scripts/180-delayed-probe.mjs`, not
 * committed) probed `core.getAuthStatus(capturedBearer)` at
 * t = 0, 30, 60, 180, 300 seconds post-LogOut against a freshly issued
 * bearer; the bearer remained `{ status: "valid" }` for the entire 5-minute
 * window. The schema/decompile evidence aligns: `LogOutInput` is empty
 * by design (`{ _placeholder: String }`), no alternative revocation
 * mutation exists on either surface, and `research/notes/01-overview.md`
 * § Logout flow describes Android client-side cleanup (token clear +
 * Apollo cache reset) rather than server-side bearer invalidation. The
 * original AC #1 of issue #180 ("the bearer is no longer valid against
 * ViewerVerify (401/403)") is therefore FALSIFIED by live evidence; the
 * issue's ACs are formally amended (see issue #180 maintainer comment)
 * to reflect that `LogOut` is defense-in-depth: it terminates the
 * web-session/cookie state on the talent_profile side, emits the audit-log
 * signal to Toptal, and remains a forward-compatible call site if Toptal
 * ever wires up server-side bearer revocation. The 24-72h aging-out
 * documented in CLAUDE.md § Auth Model remains the load-bearing
 * revocation defense.
 *
 * This test therefore asserts:
 *   - LogOut returns success (the mutation wire format works as inferred)
 *   - Local token is cleared
 *   - Bearer remains valid post-LogOut (regression-pinning — flips when
 *     Toptal changes their server-side behavior)
 *   - Idempotent re-run path
 *
 * Schema/contract rule (CLAUDE.md § Schema/contract validation rule): the
 * `LogOut` mutation's input is Pattern 7 (trivial empty) per
 * `research/notes/10-mutation-input-patterns.md`, and `LogOutPayload`'s
 * fields are typed as `Unknown` in the synthesized SDL — so the wire
 * shape is INFERRED. This test exercises the live wire format. The PR
 * description carries the live transcript including the bearer-still-
 * valid observation as documented evidence supporting the AC amendment.
 *
 * Timing-window scope: the regression-pinning assertion at step 5 probes
 * IMMEDIATELY after LogOut returns. The delayed-probe investigation cited
 * above extends the observation to 5 minutes; further timing investigation
 * (1h, 24h) is not in scope here — the documented 24-72h natural aging-out
 * is the load-bearing defense and would naturally invalidate any stale
 * bearer over that window.
 *
 * Skip-gate: `.skipIf(!e2eEnabled)` matches the suite-wide pattern.
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

describe("auth signout — server-side LogOut against live Toptal (#180, isolated session)", () => {
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
