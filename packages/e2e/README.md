# @ttctl/e2e

End-to-end test harness for TTCtl. Runs against the **live** Toptal Talent platform using the maintainer's real session — there is no public sandbox to test against.

This package is **private** (not published to npm). Test cases that exercise it live alongside the harness as `*.e2e.test.ts` files.

## Live-account safety policy

Because E2E runs against a real Toptal Talent profile, the harness is engineered to be safe-by-default. The user MUST be able to run E2E without losing or corrupting their everyday session.

### Isolation guarantees

- **Isolated auth token** — the harness writes a fixture `.ttctl.yaml` at `<repo-root>/.tmp/e2e/.ttctl.yaml` with `auth-token-path: ./auth.token` and spawns CLI / MCP subprocesses with `cwd=<repo-root>/.tmp/e2e/`. CLI config discovery (which checks `./.ttctl.yaml` in CWD first) picks up the fixture; the relative `auth-token-path` resolves to `<repo-root>/.tmp/e2e/auth.token`. Your everyday session at `~/.ttctl/auth.token` is untouched before, during, and after the run. No environment variable is involved.
- **Run-level lockfile** — `<repo-root>/.tmp/e2e/.lock` records the PID of the active harness invocation. Concurrent invocations on the same machine are refused with a clear error message naming the holding PID. Stale lockfiles (PID no longer alive) are auto-cleared with a warning.
- **One signin per suite** — the harness exposes `withFreshSession()` which signs in once in `beforeAll` and signs out once in `afterAll`. Tests inherit the established session — no per-test login. Bounds account churn to **one** `EmailPasswordSignIn` event per `pnpm test:e2e` run.
- **Cool-off after signout** — the harness waits ≥5s after signout before exit, spacing successive runs to avoid Toptal's rate-limit / abuse heuristics.
- **Pre-flight banner** — the harness prints a visible warning on stderr **before** any network call: "E2E will sign in to Toptal as the configured account. Any concurrent browser session may be invalidated."
- **Failure output redaction** — assertion diffs and log helpers scrub `cookie`, `email`, `password`, `token` keys; profile-shaped objects collapse to `[redacted profile]`. Tests assert specific fields, not whole snapshots.

### What "SignOut" means here

The Toptal mobile gateway has no terminal `SignOut` GraphQL mutation. The session is "ended" by destroying the local auth token — which is exactly what `ttctl auth signout` does. The harness's `afterAll` deletes `<repo-root>/.tmp/e2e/auth.token`; that's the harness's "SignOut".

### What's NOT protected

- **Cross-machine concurrency** — the lockfile is local-only. Two developers running E2E against the same Toptal account simultaneously WILL clobber each other's session token. This project assumes single-developer use.
- **The maintainer's public profile data** — the `profile update` round-trip in #21 deliberately mutates the live bio with a minimal whitespace edit. The mutation is restored in `afterAll`, but a process crash mid-test can leave the bio in the mutated state. See #21 for the recovery procedure (`.tmp/e2e-restore/<run-id>.json` breadcrumbs).

## Running the harness

### Prerequisites

- A `.ttctl.yaml` file in the repo root (or `$XDG_CONFIG_HOME/ttctl/config.yaml`) with valid Toptal credentials. Both `op://VAULT/ITEM` and `op://ACCOUNT/VAULT/ITEM` (3-segment) forms are supported by the resolver.
- 1Password CLI (`op`) installed and signed in if you use the `op://` form.
- A built workspace — `pnpm build` before invoking E2E.
- `TTCTL_E2E=1` set in the environment.

### Local run

```sh
pnpm build
TTCTL_E2E=1 pnpm test:e2e
```

Without `TTCTL_E2E=1`, `pnpm test:e2e` skips silently (exits 0, no live calls).

### Unit tests of the harness modules

The harness's pure-function modules (lockfile, redaction, paths, banner, clients) have unit tests that DO NOT make live calls and DO NOT need `TTCTL_E2E=1`:

```sh
pnpm --filter @ttctl/e2e test
```

These run as part of `pnpm test` at the workspace root and on every CI matrix entry.

## Public API

```ts
import { withFreshSession, getCliClient, getMcpClient, redact, formatRedacted } from "@ttctl/e2e";

const session = withFreshSession();

describe("my E2E case", () => {
  it.skipIf(process.env.TTCTL_E2E !== "1")("does the thing", async () => {
    const { sandboxDir } = session.getContext();
    const cli = getCliClient({ cwd: sandboxDir });
    const result = await cli.run(["auth", "status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("@");
  });
});
```

The harness session also exposes `tokenPath` (`<repo-root>/.tmp/e2e/auth.token`) for existence assertions, `sandboxConfigPath` (`<repo-root>/.tmp/e2e/.ttctl.yaml`) for fixture inspection, and `repoRoot` for sibling-fixture lookups.

## Recovery from a crashed run

If a run crashes mid-`profile update` (#21's destructive case), the original bio is captured at `<repo-root>/.tmp/e2e-restore/<run-id>.json` BEFORE mutation. Recover with:

```sh
RESTORE_FILE=.tmp/e2e-restore/<run-id>.json
node packages/ttctl/dist/cli.js profile update --bio "$(jq -r .bio "$RESTORE_FILE")"
rm "$RESTORE_FILE"
```

(See #21 for the full restore protocol — the harness only owns the breadcrumb directory location.)

## CI behavior

CI does NOT have real Toptal session credentials and MUST NOT attempt live signin. The CI workflow runs `pnpm test` (unit tests, including harness module tests). It does not run `pnpm test:e2e`. The env-gate (`TTCTL_E2E=1`) is the second layer of defense — even if a future CI workflow accidentally invoked `pnpm test:e2e`, it would skip silently.
