# JSON-shape snapshot tests

> Author / reviewer guide for the per-command `--json` snapshot suite
> introduced by [#152](https://github.com/alexey-pelykh/ttctl/issues/152).

## Why this exists

TTCtl commits the `--json` byte stream to public-API stability post-`v1.0`.
Today, every hand-rolled GraphQL operation and every envelope helper
exposes its wire shape to two surfaces:

- the CLI `ttctl <verb> --json` output, and
- the MCP tool response payload (consumed by Claude Desktop / Cursor /
  Windsurf via `JSON.parse(result.content[0].text)`).

Without explicit shape pins, a contributor adding a returned field or
restructuring an envelope silently changes both wire streams — breaking
downstream consumers (`jq` pipelines, scripts, MCP integrations) without
a code-review signal.

The snapshot suite removes that failure mode: any change to a `--json`
shape (or an MCP payload shape) fails CI on snapshot mismatch, forcing
the change to be either reverted (unintended) or acknowledged via
`pnpm test -u` and a committed snapshot diff (intentional — surfaces in
PR review).

## Where the tests live

```
packages/cli/src/lib/__tests__/envelope-snapshots.test.ts
  └─ Foundation envelope ABI: add / update / remove / error / dryRun / list
     with representative `{id, name, rating}` fixture entities.

packages/cli/src/commands/profile/__tests__/read-snapshots.test.ts
  └─ Per-sub-domain read envelopes for the 11 profile sub-domains
     (skills, portfolio, employment, education, certifications,
     industries, visas, basic, external, resume, reviews).

packages/mcp/src/tools/__tests__/payload-snapshots.test.ts
  └─ MCP tool response payloads (raw entity JSON via `jsonResponse`),
     plus cross-cutting dry-run + error response envelopes.
```

Snapshot files land in sibling `__snapshots__/` directories, one
`<test-file>.snap` per test file. They are checked into git.

## When to add a snapshot

| Situation                                                      | What to do                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adding a new CLI command with `--json` output                  | Add a test case in the relevant sub-domain `describe` block (`read-snapshots.test.ts` for profile, or a sibling per-domain file for non-profile groups). For commands that emit a write envelope (`add` / `update` / `remove`), the envelope shape is already pinned in `envelope-snapshots.test.ts` — add a per-entity snapshot only if the entity payload shape differs from the representative `{id, name, rating}` fixture. |
| Adding a new MCP tool                                          | Add a test case in `payload-snapshots.test.ts` covering the tool's `jsonResponse(payload)` output. Use the same fixture (where available from `@ttctl/core` `__tests__/fixtures/profile`) so CLI ↔ MCP drift is visible side-by-side.                                                                                                                                                                                           |
| Adding a new envelope shape (e.g., a new success variant)      | Add a new `describe` block in `envelope-snapshots.test.ts` covering the new shape with representative fixture data.                                                                                                                                                                                                                                                                                                             |
| Refactoring an internal helper without changing the wire shape | No snapshot work — the tests pin what consumers see, not internal types. The tests will pass without changes; if they fail, the refactor leaked into the wire.                                                                                                                                                                                                                                                                  |

## Update workflow

When CI fails on a snapshot mismatch:

1. **Read the diff in the failure output.** Vitest renders the
   stringified envelope side-by-side. The change is either intentional
   (the wire shape evolved deliberately) or accidental (an internal
   change escaped to the wire).
2. **If accidental** — revert the offending change. Snapshots stay
   unchanged.
3. **If intentional**:
   - Run `pnpm test -u` (vitest `--update`) to regenerate the affected
     snapshot files.
   - `git add packages/**/__snapshots__/*.snap`
   - Commit the snapshot diff in the SAME commit as the wire-shape
     change so the relationship is clear.
   - In the PR description, check the **JSON output snapshots** gate
     box and explain the intent (added field? renamed? semver
     implications?).

## Pre-1.0 vs post-1.0

The `ENVELOPE_VERSION = "1.0"` constant in
[`packages/cli/src/lib/envelopes.ts`](../packages/cli/src/lib/envelopes.ts)
is the discriminator consumers branch on for forward-compat.

- **Pre-1.0** (`0.x` releases — current): snapshot updates are FREE per
  semver. The version field stays at `"1.0"` but the envelope itself
  may evolve breaking-ly between `0.x` releases. The snapshot diff IS
  the change-review surface — there is no separate "expect a major
  bump" gate.
- **Post-1.0** (`1.x` and beyond): any non-additive snapshot diff
  triggers a major version bump. Additive changes (new optional field
  alongside the existing shape) bump the envelope's `version` to
  `"1.1"` / `"1.2"` / … without a major release; consumers using
  `version === "1.0"` discrimination keep working. Renames, removals,
  type changes are major.

## Running the tests locally

```sh
# All snapshot tests (the entire test suite, in fact — snapshots are
# integrated with the unit-test runner).
pnpm test

# Just the snapshot files:
pnpm --filter @ttctl/cli exec vitest run snapshots
pnpm --filter @ttctl/mcp exec vitest run snapshots

# Regenerate snapshots after a deliberate wire-shape change:
pnpm --filter @ttctl/cli exec vitest run --update snapshots
pnpm --filter @ttctl/mcp exec vitest run --update snapshots
```

The first run from a clean state writes the snapshots silently (no diff
to review). Subsequent runs compare against the committed snapshots and
fail on mismatch — that is the normal flow.

## CLI ↔ MCP coupling

The CLI `--json` output wraps list payloads in the v0.4 list envelope
(`{version, items[]}` per [#128](https://github.com/alexey-pelykh/ttctl/issues/128)),
while the MCP tool currently emits the raw entity payload (skills
array, profile object, …).

The CLI ↔ MCP parity contract is tracked SEPARATELY from JSON-shape
stability:

- **JSON-shape stability** (this suite, #152): is the response shape
  of each surface stable across releases?
- **CLI ↔ MCP parity contract** ([#121](https://github.com/alexey-pelykh/ttctl/issues/121)
  dependencies): does each CLI command have a corresponding MCP tool?

Both layers ship snapshot coverage; the parity layer adds a separate
contract test. A future evolution may collapse the two — either by
having MCP tools emit the same envelope shape (then the CLI and MCP
snapshots would converge), or by adding an explicit cross-surface diff
in the parity test. Either path stays compatible with the snapshots
here: their job is to FAIL on shape change, not to enforce equivalence.
