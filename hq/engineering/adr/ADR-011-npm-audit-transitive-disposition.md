# ADR-011 — npm-audit disposition: allowlist unreachable transitive MCP-SDK advisories

- **Status**: ACCEPTED
- **Date**: 2026-06-13
- **Deciders**: Claude (orchestrating); consulted: `security-architect`
- **Related**: #770, #212 (v0.1.0 stable cut), #223 (fast-uri override), rc.14 shell-quote override `4c10688`

> **Namespace note**: This is the ttctl-local ADR-011, filed at `hq/engineering/adr/` in this repo. Per the convention established by ADR-007 (ttctl), citing this ADR uses `ADR-011 (ttctl)`. HQ ADRs live in a separate namespace.

## Context

`pnpm audit --prod` reports **9 advisories** (8 moderate, 1 low) ahead of
the v0.1.0 stable cut. A security-aware engineer who runs `npm audit`
right after `npm i -g ttctl` sees "9 vulnerabilities" on day one of a
credential-handling, Cloudflare-TLS-impersonating tool — a first-contact
trust ding with no explanation attached.

All 9 are transitive through `@modelcontextprotocol/sdk` (resolved
`1.29.0`), entirely within its **HTTP/SSE transport stack**:

- `hono` arrives via `@hono/node-server` (the SDK's Node HTTP/SSE server
  adapter) and a direct SDK dependency.
- `express` + `express-rate-limit` are the SDK's HTTP transport server
  framework and rate limiter.
- `qs` arrives via `express > body-parser` (HTTP body parsing).
- `ip-address` arrives via `express-rate-limit` (client-IP parsing).

ttctl's MCP server uses the **stdio transport exclusively**. The only SDK
subpaths imported anywhere under `packages/mcp/src/` are
`@modelcontextprotocol/sdk/server/mcp.js` and `.../server/stdio.js`
(`server.ts:4-5`; `new StdioServerTransport()` at `server.ts:205`). There
is **no** import of `server/sse.js` or `server/streamableHttp.js`, so the
HTTP-transport modules — and their `hono`/`express`/`qs`/`ip-address`
dependencies — never enter ttctl's runtime module graph. Every one of the
9 advisories requires an active HTTP request handler (JWT/cookie/cache
middleware, IP-restriction rules, JSX SSR, express query-string parsing,
`Address6` HTML emission). None of those surfaces exist in a stdio MCP
server that reads framed JSON-RPC over stdin from a single trusted parent.

**Gate framing (important, and easy to misread).** The CI release audit
gate is `pnpm audit --audit-level=high` (`.github/workflows/release.yml`).
All 9 advisories are moderate/low, so they **do not fail any gate today** —
they are noise in the _unfiltered_ `pnpm audit` a developer or user runs
locally, not a blocked publish. There is no `pnpm audit` in `pnpm lint` or
the PR CI matrix; the only automated audit is the release-time high gate.

## Decision

Triage the 9 advisories as **present-but-unreachable** and suppress them
via a per-GHSA `auditConfig.ignoreGhsas` allowlist in `pnpm-workspace.yaml`
(pnpm 11.2.2's settings home, alongside the existing `overrides` and
`catalog`).

**Policy — overrides for reachable, allowlist for unreachable:**

- `pnpm.overrides` version-forces a transitive dep to a patched range. It
  asserts "ttctl is exposed and is mitigating." Use it only for
  **reachable** advisories. Repo precedent: `shell-quote@^1.8.4` (critical,
  reachable via `@graphql-codegen/cli` at build time, `4c10688`) and
  `fast-uri@^3.1.2` (#223) were overridden because they sit on executed
  paths.
- `auditConfig.ignoreGhsas` records a deliberate, documented "acknowledged,
  triaged unreachable" disposition without touching the dependency graph.
  Use it for **unreachable** transitive advisories. Forcing versions on a
  dead path (the alternative) buys no security, adds resolution-conflict
  risk against the SDK's own pinned ranges, and goes stale silently.

**Granularity is per-GHSA, never per-package or per-path.** A brand-new
advisory in `hono`/`express`/`qs`/`ip-address` arrives as a new GHSA ID,
is not in the list, and therefore still surfaces. Package- or path-level
ignores would mask the future and are rejected.

The allowlist is a **noise-suppressor and disposition-record**, not a
gate-unblocker — nothing was blocked. This is stated explicitly so a future
maintainer does not read the allowlist as load-bearing for the build.

### Triage — all 9 advisories (each unreachable on stdio)

| Severity | Package    | GHSA                | Advisory                                                 | Proven path (sole root: `@modelcontextprotocol/sdk@1.29.0`) |
| -------- | ---------- | ------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| moderate | hono       | GHSA-qp7p-654g-cw7p | CSS Declaration Injection (JSX SSR)                      | `@hono/node-server > hono`; direct `sdk > hono`             |
| moderate | hono       | GHSA-p77w-8qqv-26rm | Cache Middleware ignores `Vary: Authorization`           | `@hono/node-server > hono`                                  |
| moderate | hono       | GHSA-xrhx-7g5j-rcj5 | IP Restriction bypass (non-canonical IPv6)               | `@hono/node-server > hono`                                  |
| moderate | hono       | GHSA-3hrh-pfw6-9m5x | Cookie helper `Set-Cookie` injection (sameSite/priority) | `@hono/node-server > hono`                                  |
| moderate | hono       | GHSA-f577-qrjj-4474 | JWT middleware accepts any Authorization scheme          | `@hono/node-server > hono`                                  |
| moderate | hono       | GHSA-2gcr-mfcq-wcc3 | `app.mount()` strips mount prefix (percent-encoded)      | `@hono/node-server > hono`                                  |
| low      | hono       | GHSA-hm8q-7f3q-5f36 | Improper NumericDate validation in JWT `verify()`        | `@hono/node-server > hono`                                  |
| moderate | ip-address | GHSA-v2v4-37r5-5v8g | XSS in `Address6` HTML-emitting methods                  | `express-rate-limit > ip-address`                           |
| moderate | qs         | GHSA-q8mj-m7cp-5q26 | `qs.stringify` DoS (null/undefined in comma arrays)      | `express > body-parser > qs`                                |

Each requires an active HTTP request handler; ttctl serves stdio only.

## Alternatives considered

- **Override-bump all 9 to patched versions** (`hono>=4.12.18`,
  `ip-address>=10.1.1`, `qs` patched). Rejected: it asserts exposure that
  does not exist (dishonest signal), version-forces packages on a path
  ttctl never executes, risks install-time resolution conflicts against the
  SDK's pinned ranges, and goes stale invisibly if a future SDK drops
  `express`/`hono`. Overriding is the right tool for the _reachable_
  precedents (`shell-quote`, `fast-uri`) and the wrong tool here.
- **Ignore by package or by dependency path.** Rejected: suppresses all
  _future_ advisories in those packages, masking a later genuinely-reachable
  one. Per-GHSA is the only granularity that fails safe.
- **Bump `@modelcontextprotocol/sdk`.** Does not help: any SDK version
  still ships the HTTP/SSE transport stack as optional deps; the unreachable
  packages remain present.
- **Do nothing.** Rejected: leaves a noisy "9 vulnerabilities" first-contact
  experience for a credential tool with no documented disposition.

## Reachability evidence

- **Source-import structure** (authoritative for "not imported"): the only
  SDK subpath imports under `packages/mcp/src/` are `server/mcp.js` and
  `server/stdio.js`; zero imports of `server/sse.js` /
  `server/streamableHttp.js` / any HTTP transport.
- **Dependency-graph proof**: `pnpm --filter @ttctl/mcp why <pkg>` on
  2026-06-13 shows `hono`, `express`, `express-rate-limit`, `ip-address`,
  and `qs` each rooting **solely** through `@modelcontextprotocol/sdk@1.29.0`
  — no other workspace consumer — and specifically through its
  `@hono/node-server` / `express` / `express-rate-limit` HTTP subtree.
- **Suppression smoke test** (pnpm silently ignores an unknown
  audit-config key): with the block in place, `pnpm audit --prod` exits `0`
  ("1 low (1 ignored) | 8 moderate (8 ignored)"); `pnpm audit --prod
--audit-level=high` exits `0` (high gate unaffected); removing one GHSA
  re-surfaces exactly that advisory with exit `1` — proving the key name is
  honored and the suppression is per-GHSA.

This claim is verified against `@modelcontextprotocol/sdk@1.29.0` under
pnpm `11.2.2`. The `ignoreGhsas` key location and name are version-sensitive
and fail _silently_ on mismatch; a pnpm major bump is an implicit re-review
trigger (re-run the smoke test).

## Re-review triggers (pre-committed)

The suppressed paths can become reachable — or the disposition stale —
without ttctl's own code changing. Revisit the allowlist when:

1. ttctl adds any HTTP / SSE / Streamable MCP transport.
2. `@modelcontextprotocol/sdk` takes a major-version bump — re-verify the
   subpath isolation (`pnpm why` the 5 packages).
3. A new dependency pulls `hono`/`express`/`qs`/`ip-address` into an
   executed path (the same GHSA, newly reachable via a different consumer).
4. A listed advisory escalates to high/critical or lands in CISA KEV. An
   ignored GHSA is removed from the report _before_ `--audit-level` is
   evaluated, so an escalation would be **silently swallowed at the release
   gate** — this is the allowlist's one real hazard.
5. At each release cut, prune entries whose package or advisory no longer
   applies. This manual prune is the **compensating control** for (4) — the
   only mechanism that re-surfaces drift, since no automated moderate-level
   audit runs.

## Consequences

- `npm audit` / `pnpm audit --prod` is clean for users and developers; the
  9 advisories carry a documented, auditable disposition (GHSA list +
  rationale in `pnpm-workspace.yaml`, posture note in `SECURITY.md`, this
  ADR).
- The dependency graph is untouched — no install-time instability is
  introduced into a credential-handling tool, and no forced resolution can
  go stale on the SDK's HTTP subtree.
- The release-gate masking hazard (trigger 4) is accepted in exchange, with
  the release-cut prune (trigger 5) as the standing compensating control.
- The override-vs-allowlist bright line (reachable → override, unreachable →
  allowlist) is now an explicit, precedent-backed policy for future
  transitive advisories.
