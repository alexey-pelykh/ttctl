<!--
TTCtl pull request template.

Keep the body brief but answer the gate checkboxes below — they protect
the public-API contract and the inferred-schema verification rule from
CLAUDE.md.
-->

## Summary

<!-- One or two sentences. What changed and why. -->

## Gate checklist

- [ ] **JSON output snapshots** — If this PR changes any CLI `--json`
      output shape or MCP tool response payload, the snapshot diff is
      INTENTIONAL and a version bump has been considered (post-1.0
      triggers semver-major unless purely additive — see
      [`docs/snapshot-tests.md`](../docs/snapshot-tests.md)).
- [ ] **Inferred-schema E2E** — If this PR introduces or modifies a
      hand-rolled GraphQL operation, an inferred contract shape, or
      changes any `packages/core/src/auth/` or
      `packages/core/src/services/profile/` file, the schema /
      contract validation rule from
      [`CLAUDE.md`](../CLAUDE.md#schemacontract-validation-rule) was
      satisfied (E2E test path + transcript pasted below), OR the rule
      was NOT triggered (explicit statement here).
- [ ] **E2E coverage gate** — If this PR introduces a new
      `operationName: "X"` literal against `talent-profile` or
      `scheduler` from `packages/core/src/`, either (a) a matching
      `// e2e-covers: X` directive lives in a
      `packages/e2e/src/**/*.e2e.test.ts` file, OR (b) an
      `// e2e-exempt: <reason>` marker sits within 5 lines preceding the
      `operationName:` line, OR (c) the rule was NOT triggered (no new
      in-scope operations). Run `pnpm check-e2e-coverage` locally to
      verify; the gate is wired into `pnpm lint` and runs on every CI
      build. See [`scripts/check-e2e-coverage.ts`](../scripts/check-e2e-coverage.ts)
      for the marker protocol.
- [ ] **CLI/MCP parity** — If this PR adds, renames, or removes a CLI
      command (`packages/cli/src/commands/**`) or an MCP tool
      (`packages/mcp/src/tools/**`), the two surfaces stay coupled: a CLI
      leaf `ttctl <group> <sub-domain> <verb>` has a matching
      `ttctl_<group>_<sub-domain>_<verb>` MCP tool (and vice-versa), OR the
      divergence is declared in [`.mcp-exempt.yaml`](../.mcp-exempt.yaml)
      (or an inline `// mcp-exempt: <reason>` comment on the CLI command)
      with a reason. The `cli-mcp-parity` contract test
      ([`packages/ttctl/src/__tests__/cli-mcp-parity.test.ts`](../packages/ttctl/src/__tests__/cli-mcp-parity.test.ts))
      reports drift on every `pnpm test`; `CLI_MCP_PARITY_STRICT=1 pnpm test`
      fails on it.
- [ ] **Doc surface** — If this PR touches `packages/core/src/auth/**`,
      `packages/core/src/config.ts`,
      `packages/core/src/configWriter.ts`,
      `packages/core/src/configLock.ts`,
      `packages/core/src/onepassword.ts`,
      `packages/core/src/transport/**`,
      `packages/core/src/services/profile/**`, `codegen.config.ts`, or
      `research/graphql/gateway/schema.graphql`, the PR description
      contains EITHER of:

      - `**Doc surface**: no doc surface affected by this change`, OR
      - `**Doc surface**: updated <list of doc files>` (e.g. SECURITY.md,
        README, CLAUDE.md, ADR-005, server.json).

      The `doc-surface` job in
      [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) enforces
      this attestation. See
      [#225](https://github.com/alexey-pelykh/ttctl/issues/225) for the
      rationale (prevents recurrence of #107-class doc-drift).

## Test plan

<!--
Bulleted checklist of how the change was verified locally. For PRs that
trigger the inferred-schema E2E rule, paste the `TTCTL_E2E=1` transcript
or attach a screenshot.
-->

-

## Notes

<!-- Cross-references, follow-ups, anything reviewers should know. -->
