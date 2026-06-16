# Contributing to TTCtl

Thank you for your interest in contributing to TTCtl!

## Contributor License Agreement (CLA)

By submitting a pull request or otherwise contributing to this project, you agree to the following terms:

1. **Grant of Rights**: You grant the project maintainer(s) a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, modify, distribute, sublicense, and otherwise exploit your contribution in any form.

2. **Dual Licensing**: You acknowledge that the maintainer(s) may offer the software under alternative licenses (including commercial licenses) in addition to the AGPL-3.0 license, and your contribution may be included in such offerings.

3. **Original Work**: You represent that your contribution is your original work, or you have the right to submit it under these terms.

4. **No Warranty**: You provide your contribution "as is" without warranty of any kind.

### How to Agree

By submitting a pull request, you indicate agreement with this CLA. No separate signature is required.

For substantial contributions, please include the following sign-off in your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

You can add this automatically with `git commit -s`.

## Development

### Prerequisites

- **Node.js** >= 22.19.0
- **pnpm** 11.2.2

### Setup

```sh
git clone https://github.com/alexey-pelykh/ttctl.git
cd ttctl
pnpm install
pnpm build
```

### Development Commands

```sh
pnpm build            # Build all packages (via Turbo)
pnpm test             # Run unit tests
pnpm test:e2e         # Run E2E tests (sequential, requires API credentials)
pnpm lint             # Lint: Prettier format:check + ESLint + repo checks (pre-push gate)
pnpm format           # Auto-fix Prettier formatting
pnpm license-check    # Verify dependency licenses
pnpm dev              # Watch mode
```

`pnpm lint` is the canonical pre-push gate and bundles Prettier's
`format:check` with ESLint. Run `pnpm format` to auto-fix any
Prettier-reported issues before re-running `pnpm lint`.

### Project Structure

The repository is a pnpm monorepo with the following packages:

| Package          | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| `packages/core`  | Toptal Talent platform client, auth, services (published as `@ttctl/core`) |
| `packages/cli`   | CLI commands and program definition (published as `@ttctl/cli`)            |
| `packages/mcp`   | MCP server exposing Toptal Talent tools (published as `@ttctl/mcp`)        |
| `packages/ttctl` | Umbrella package combining CLI and MCP (published as `ttctl`)              |

### Conventions

Follow the project conventions documented in [CLAUDE.md](CLAUDE.md).

### Issue triage: wave labels

Open issues carry a wave label as a scheduling signal. **`wave-0`** is the
shippable-MVP tier — release-blocking work for the current stable cut.
**`wave-1`** is the actionable next-up tier — coverage round-out work that is
ready to start now, with no unmet precondition. **`wave-2`** is the
trigger-based deferred tier — work that is real but gated on a named external
condition (a blocker issue closing, an upstream wire change, a prerequisite
feature landing, or a vendor exposing a surface). An item is **promoted
`wave-2` → `wave-1` when its named trigger fires** — the maintainer relabels it
and records the trigger event in the issue body (e.g. "Trigger fired — #147
merged 2026-05-11; promoting to wave-1"). `wave-1` is kept honest: an item that
turns out to be blocked is demoted back to `wave-2` (retaining any `blocked`
label) so the tier always means "startable today." There is no automatic
demotion by age, but a periodic re-triage pass re-affirms or demotes each
`wave-1` item to prevent the tier from silently losing meaning.

Issues emitted from an audit brief are wave-labelled at creation, with the
suggested tier derived from the brief's effort class — see
[`docs/audit/audit-checklist.md` § When emitting issues from findings](docs/audit/audit-checklist.md#when-emitting-issues-from-findings).

### ADR citations in issues

Three separate ADR catalogs exist and their numbers collide — never cite a bare
`ADR-NNN` in an issue body. Qualify every citation by catalog, matching the
convention the ADR files themselves use:

- **`ADR-NNN (ttctl)`** — this repo's ADRs at `hq/engineering/adr/` (the public
  tree; ADR-006 onward).
- **`HQ ADR-NNN`** — the operational `alexey-pelykh/hq` sibling repo's ADRs
  (private).
- **`research ADR-NNN`** — the `ttctl/research` sibling repo's ADRs (private;
  ADR-001–005, covering TLS impersonation, cookie-jar auth, and the
  bearer-token model).

The numbers are per-catalog, not global: `ADR-010 (ttctl)` (Codecov OIDC) and
`HQ ADR-010` (service-layer layout) are different documents in different repos.

### Branch protection

The `main` branch is protected by a [GitHub ruleset][gh-rulesets]. The
canonical definitions live in [`.github/rulesets/`](.github/rulesets/); see
[`.github/rulesets/README.md`](.github/rulesets/README.md) for the manual
`gh api` sync, verification, and disaster-recovery commands. The GitHub-side
configuration must be kept in sync with the files in that directory.

[gh-rulesets]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets

### Release operations

Release publishing is automated by [`.github/workflows/release.yml`](.github/workflows/release.yml)
and fires on a published GitHub Release. For the operational playbook covering
**rollback** of a bad release — the decision tree (deprecate vs unpublish vs
roll-forward), the manual `npm deprecate` procedure, MCP-registry
coordination, and consumer-communication templates — see
[`docs/operations/release-rollback.md`](docs/operations/release-rollback.md).
Rollback is **maintainer-local** (npm OIDC does not authorize `npm deprecate`,
and version-scoped deprecation is CLI-only); maintainer reachability is a
release-readiness gate.

### Submitting Changes

1. Fork and create a feature branch
2. Make changes following project conventions
3. Commit with descriptive message (see CLAUDE.md for format)
4. Open a pull request

### Partial closures

The commit-message convention is `(type) lowercase message [(#NNN)]`. When a
PR's title or a commit references an OPEN **multi-step** issue with `(#NNN)` but
ships only PART of its scope, sync the parent issue within 24 hours of merge:
post a comment (or edit the body) summarizing what shipped and what remains.
This keeps the issue body honest for whoever picks it up next.

The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) carries a
gate-checklist row for this. It does not apply to full closures, PRs with no
`(#NNN)` reference, or single-step issues.

## Code of Conduct

This project adopts the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md) (version 3.0). Please read it before participating.

### Reporting a Concern

To report a concern about behavior in project spaces (issues, pull requests, MCP server interactions, or any other channel), email <alexey.pelykh@gmail.com>. Pseudonymous reports are accepted; truly anonymous reports are not feasible. Best-effort response within 7 days. See the [Code of Conduct](CODE_OF_CONDUCT.md) for the full reporting procedure, privacy commitments, and enforcement ladder.

## Questions?

Open an issue for discussion before starting significant work.
