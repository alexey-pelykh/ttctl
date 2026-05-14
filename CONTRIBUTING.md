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
- **pnpm** 9.15.4

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
pnpm lint             # Lint all packages and root config files
pnpm license-check    # Verify dependency licenses
pnpm dev              # Watch mode
```

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
roll-forward), the `deprecate-release` workflow, MCP-registry / Smithery
coordination, and consumer-communication templates — see
[`docs/operations/release-rollback.md`](docs/operations/release-rollback.md).

### Submitting Changes

1. Fork and create a feature branch
2. Make changes following project conventions
3. Commit with descriptive message (see CLAUDE.md for format)
4. Open a pull request

## Code of Conduct

This project adopts the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md) (version 3.0). Please read it before participating.

### Reporting a Concern

To report a concern about behavior in project spaces (issues, pull requests, MCP server interactions, or any other channel), email <alexey.pelykh@gmail.com>. Pseudonymous reports are accepted; truly anonymous reports are not feasible. Best-effort response within 7 days. See the [Code of Conduct](CODE_OF_CONDUCT.md) for the full reporting procedure, privacy commitments, and enforcement ladder.

## Questions?

Open an issue for discussion before starting significant work.
