# @ttctl/e2e

End-to-end test harness for TTCtl. Runs against the **live** Toptal Talent platform using the maintainer's real session — there is no public sandbox to test against.

This package is **private** (not published to npm). Test cases that exercise it live alongside the harness as `*.e2e.test.ts` files.

## Live-account safety policy

Because E2E runs against a real Toptal Talent profile, the harness is engineered to be safe-by-default. The user MUST be able to run E2E without losing or corrupting their everyday session.

### Isolation guarantees

- **Isolated single-file sandbox** (post-#107) — the harness writes ONE fixture at `<repo-root>/.tmp/e2e/.ttctl.yaml` carrying ONLY the captured bearer (Form C shape — token, no credentials). Source credentials NEVER enter `.tmp/e2e/`. Spawned CLI / MCP subprocesses get `TTCTL_CONFIG_FILE=<repo-root>/.tmp/e2e/.ttctl.yaml` injected into their env. The CLI's `resolveConfig` reads that path verbatim; signin / signout / status all operate against this single YAML. Your everyday session at `~/.ttctl.yaml` is untouched before, during, and after the run. Blast radius if the sandbox config leaks = one revocable bearer (24-72h surface), not the credential vault ref.
- **Run-level lockfile** — `<repo-root>/.tmp/e2e/.lock` records the PID of the active harness invocation. Concurrent invocations on the same machine are refused with a clear error message naming the holding PID. Stale lockfiles (PID no longer alive) are auto-cleared with a warning. The lock is acquired ONCE per `pnpm test:e2e` invocation by `globalSetup` and held for the entire run.
- **Two signins per run** — `globalSetup` performs ONE shared signin at run start; an adversarial test (`50-auth-error-revoked.e2e.test.ts`) performs ONE additional isolated signin via `withFreshSession()` so its token corruption never leaks into the shared session. Adding more `getSharedSession()`-using files does NOT add more signins. Signin count is bounded structurally, not per-file.
- **Cool-off after signout** — both `runGlobalTeardown` (post-#171) AND `withFreshSession()`'s afterAll wait ≥5s, spacing successive runs to avoid Toptal's rate-limit / abuse heuristics.
- **Crash-safe cleanup** (post-#171) — the asserted cleanup action lives in the parent-process `runGlobalTeardown`, not in a worker-fork test file. If a worker exits abnormally (segfault, OOM, `process.exit()`, sync throw, hang past timeout), vitest's parent still invokes the registered teardown function. Filesystem state (sandbox token, shared-session metadata, lockfile) is therefore unconditionally cleaned up; `<sandbox>/.teardown-receipt.json` is the post-mortem evidence. See `pnpm test:e2e:crash-recovery` for the regression-detection wrapper.
- **Pre-flight banner** — globalSetup prints a visible warning on stderr **before** any network call: "E2E will sign in to Toptal as the configured account. Any concurrent browser session may be invalidated."
- **Failure output redaction** — assertion diffs and log helpers scrub `cookie`, `email`, `password`, `token` keys; profile-shaped objects collapse to `[redacted profile]`. Tests assert specific fields, not whole snapshots.
- **Bearer-pattern CI guard** — `scripts/check-secret-leakage.ts` (wired into `pnpm lint`; run via `tsx`, consumes `BEARER_PATTERN_SOURCE` from `packages/core/src/lib/redact.ts` as the single source of truth) refuses to ship a build with any `user_<24hex>_<20alnum>` pattern outside `.tmp/`. Catches accidental fixture leaks where a bearer was written to a tracked file.

### What "SignOut" means here

The Toptal mobile gateway has no terminal server-side signout that TTCtl currently wires up — see issue #171 follow-up for the planned `LogOut` mutation against `talent_profile`. The session is "ended" today by removing the `auth.token` field from the sandbox YAML — which is exactly what `ttctl auth signout` does (via `clearAuthToken`'s `yaml.parseDocument` + `deleteIn`).

Post-#171 the asserted cleanup action lives in the parent-process `runGlobalTeardown` (see `src/harness/globalTeardown.ts`), not in a worker-fork test. The terminal smoke test (`99-auth-signout.e2e.test.ts`) is now ASSERTION-ONLY — it confirms the shared bearer is live BEFORE teardown runs. Post-teardown state is recorded in `<sandbox>/.teardown-receipt.json`:

```json
{
  "ranAt": "2026-05-12T...",
  "cleared": true,
  "lockReleased": true,
  "succeeded": true,
  "error": null
}
```

The receipt's PRESENCE proves teardown actually fired (no test can observe its own teardown). Its `cleared` and `lockReleased` flags record per-step outcomes; `succeeded` is the AND of the lot.

### Crash-recovery verification

`pnpm test:e2e:crash-recovery` (alias for `pnpm --filter @ttctl/e2e test:e2e:crash-recovery`) is the regression-detection wrapper for the #171 contract. It:

1. Clears any stale `<sandbox>/.teardown-receipt.json`.
2. Spawns `pnpm test:e2e` with `TTCTL_E2E_INJECT_CRASH=1` so `98-crash-injection.e2e.test.ts` calls `process.exit(1)` in the worker fork.
3. EXPECTS vitest to exit non-zero (the crash test was supposed to crash).
4. Verifies the receipt was written, `cleared: true`, AND the sandbox YAML has no `auth.token` field. Failure modes map to distinct exit codes (2-6); see `scripts/run-crash-recovery.mjs`.

The script requires real Toptal credentials (just like `pnpm test:e2e`) because `globalSetup` must succeed before crash injection is reached. Without credentials it exits non-zero with a useful diagnostic via the wrapper's stdio inheritance.

### What's NOT protected

- **Cross-machine concurrency** — the lockfile is local-only. Two developers running E2E against the same Toptal account simultaneously WILL clobber each other's session token. This project assumes single-developer use.

## Test file naming convention (numeric prefixes)

E2E test files use `NN-name.e2e.test.ts` numeric prefixes to bind logical execution order to alphabetical-by-filename ordering:

| Prefix range  | Purpose                                                                                               | Example                             |
| ------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `01-` … `49-` | Shared-session read-side cases (consume `getSharedSession()`)                                         | `01-auth-signin.e2e.test.ts`        |
| `50-` … `89-` | Adversarial / mutation-bearing cases (use `withFreshSession()` for isolation)                         | `50-auth-error-revoked.e2e.test.ts` |
| `90-` … `97-` | Reserved for future terminal-phase cases (run after adversarial)                                      | _none yet_                          |
| `98-`         | Opt-in crash-injection (gated by `TTCTL_E2E_INJECT_CRASH=1`; skipped on default `pnpm test:e2e` runs) | `98-crash-injection.e2e.test.ts`    |
| `99-`         | Pre-teardown smoke test (assertion-only post-#171; the cleanup action lives in `runGlobalTeardown`)   | `99-auth-signout.e2e.test.ts`       |

The ordering invariant is enforced two ways:

1. `vitest.e2e.config.ts` pins `sequence.sequencer: BaseSequencer` (alphabetical-by-filename) and `sequence.shuffle: false`. Vitest's CURRENT default is also `BaseSequencer`, but pinning makes the dependency explicit and survives default changes across minor versions.
2. `harness/__tests__/file-ordering.test.ts` asserts (a) the sequencer pin is present in the config, and (b) every `*.e2e.test.ts` file matches `NN-name.e2e.test.ts` with strictly-increasing prefixes when sorted alphabetically. Removing the sequencer pin causes this unit test to FAIL.

The `99-auth-signout.e2e.test.ts` case runs last by convention — post-#171 it's a pre-teardown smoke test, not a destructive operation. Read-side cases placed after `99-` would still find a valid token (cleanup runs in the parent process AFTER all worker tests), but the convention reserves `9N-` for terminal-phase cases.

## When to use `getSharedSession()` vs `withFreshSession()`

| Scenario                                                                                          | Use                                         | Why                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Test only READS the live session (auth status, profile show, downstream RPC calls)                | `getSharedSession()`                        | Amortizes the live signin across all consumers — exactly one shared signin per run regardless of file count                           |
| Test MUTATES the on-disk auth token (e.g. corruption, deletion, re-write to test rejection paths) | `withFreshSession()`                        | Each call writes to its own `<sandbox>/isolated-<id>/auth.token`, so corruption never leaks into the shared session                   |
| Test asserts the pre-teardown state of the shared session (smoke test)                            | `getSharedSession()` + numeric prefix `9N-` | The convention reserves `9N-` for terminal-phase smoke tests; the cleanup action itself lives in `runGlobalTeardown` (parent process) |

`getSharedSession()` reads the metadata file at `<sandbox>/.session.json` that `globalSetup` wrote. It throws if the file is missing — that means either `TTCTL_E2E !== "1"` (suite gated off) OR `vitest.e2e.config.ts` is missing the `globalSetup` wiring. Wrap test bodies in `it.skipIf(process.env.TTCTL_E2E !== "1")` to handle the env-gated case cleanly.

## Single-fork pool implications

`vitest.e2e.config.ts` pins `pool: "forks"` + `forks.singleFork: true` + `fileParallelism: false` — exactly ONE Node process runs ALL test files sequentially. This has consequences:

- **Module-level state persists across files.** A module-scoped `let` (e.g., the `printed` flag in `banner.ts`, the `handleCount` counter in `session.ts`, the `isolationCounter` in `session.ts`) keeps its value from one file to the next. The harness audits this carefully — see `globalSetup.ts` for the transport-state audit comment.
- **`globalSetup` runs in a SEPARATE process** from the test workers. Variables cannot be passed in-memory; the handoff is filesystem-mediated via `<sandbox>/.session.json`.
- **Adversarial tests' isolation is path-based, not process-based.** `withFreshSession()` writes to a per-call subdirectory (`<sandbox>/isolated-<N>/`); the corruption is isolated by being on a different file path, not in a different process. If `packages/core/src/transport.ts` ever introduces module-level mutable state (TLS client cache, cookie-jar handle, agent instance), that state COULD leak across files — re-audit on transport changes.

## Running the harness

### Prerequisites

- A `.ttctl.yaml` resolvable via standard discovery (`TTCTL_CONFIG_FILE` env var → `~/.ttctl.yaml`) with valid Toptal credentials in `auth.credentials`. Both `op://VAULT/ITEM` and `op://ACCOUNT/VAULT/ITEM` (3-segment) forms are supported by the resolver. Note: post-#107 XDG paths and the legacy CWD `./.ttctl.yaml` are no longer auto-discovered; set `TTCTL_CONFIG_FILE=<path>` (typically via direnv) if you keep your config at a non-standard location.
- 1Password CLI (`op`) installed and signed in if you use the `op://` form.
- A built workspace — `pnpm build` before invoking E2E.
- `TTCTL_E2E=1` set in the environment.

### Local run

```sh
pnpm build
TTCTL_E2E=1 pnpm test:e2e
```

Without `TTCTL_E2E=1`, `pnpm test:e2e` skips silently (exits 0, no live calls).

### Crash-recovery regression check

```sh
pnpm test:e2e:crash-recovery
```

Spawns the suite with `TTCTL_E2E_INJECT_CRASH=1`, expects vitest to exit non-zero (a worker test crashes deliberately), and verifies that `runGlobalTeardown` STILL fired by inspecting `<sandbox>/.teardown-receipt.json`. Exit code `0` means the regression-detection contract holds; any other code surfaces a specific failure mode (receipt missing, token not cleared, etc. — see `scripts/run-crash-recovery.mjs`).

### Unit tests of the harness modules

The harness's pure-function modules (lockfile, redaction, paths, banner, clients, file-ordering invariant, globalSetup structure) have unit tests that DO NOT make live calls and DO NOT need `TTCTL_E2E=1`:

```sh
pnpm --filter @ttctl/e2e test
```

These run as part of `pnpm test` at the workspace root and on every CI matrix entry.

## Public API

```ts
import { withFreshSession, getSharedSession, getCliClient, getMcpClient, redact, formatRedacted } from "@ttctl/e2e";

// Shared-session consumer (read-side test):
describe("my read-only E2E case", () => {
  it.skipIf(process.env.TTCTL_E2E !== "1")("does the thing", async () => {
    const { sandboxConfigPath } = getSharedSession();
    const cli = getCliClient({ configPath: sandboxConfigPath });
    const result = await cli.run(["auth", "status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("@");
  });
});

// Isolated-session consumer (adversarial / mutation-bearing test):
const session = withFreshSession();

describe("my adversarial E2E case", () => {
  it.skipIf(process.env.TTCTL_E2E !== "1")("corrupts the token", async () => {
    const { sandboxConfigPath } = session.getContext();
    // Mutate auth.token in `sandboxConfigPath` freely — the file lives
    // under <sandbox>/isolated-<id>/ and the corruption is contained
    // there. The shared session at <sandbox>/.ttctl.yaml is untouched.
  });
});
```

The session contexts (both shared and isolated) expose `sandboxDir`, `sandboxConfigPath`, `email`, and `repoRoot`. For shared sessions, paths point under `<sandbox>/`; for isolated sessions, under `<sandbox>/isolated-<id>/`. Post-#107 there is **no** `tokenPath` — the captured bearer lives inline in `sandboxConfigPath` under `auth.token`.

## CI behavior

CI does NOT have real Toptal session credentials and MUST NOT attempt live signin. The CI workflow runs `pnpm test` (unit tests, including harness module tests). It does not run `pnpm test:e2e`. The env-gate (`TTCTL_E2E=1`) is the second layer of defense — even if a future CI workflow accidentally invoked `pnpm test:e2e`, it would skip silently because both `vitest.e2e.config.ts`'s `include` AND `globalSetup`'s body env-gate on `TTCTL_E2E === "1"`.
