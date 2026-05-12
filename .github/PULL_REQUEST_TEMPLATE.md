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

## Test plan

<!--
Bulleted checklist of how the change was verified locally. For PRs that
trigger the inferred-schema E2E rule, paste the `TTCTL_E2E=1` transcript
or attach a screenshot.
-->

-

## Notes

<!-- Cross-references, follow-ups, anything reviewers should know. -->
