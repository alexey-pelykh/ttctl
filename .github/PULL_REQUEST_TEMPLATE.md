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
      changes `packages/core/src/auth.ts` or any
      `packages/core/src/services/profile/` service, the schema /
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

## Test plan

<!--
Bulleted checklist of how the change was verified locally. For PRs that
trigger the inferred-schema E2E rule, paste the `TTCTL_E2E=1` transcript
or attach a screenshot.
-->

-

## Notes

<!-- Cross-references, follow-ups, anything reviewers should know. -->
