# Spike: zod-from-graphql plugin selection (Z-0)

| Field              | Value                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Date**           | 2026-05-14                                                                                                                                   |
| **Status**         | Decided                                                                                                                                      |
| **Track**          | T2 (codegen-Zod) of the hybrid runtime-validation scope ([scope brief](../briefs/2026-05-14-scope-runtime-validation-hybrid.md), local-only) |
| **Issue**          | [#277](https://github.com/alexey-pelykh/ttctl/issues/277)                                                                                    |
| **Council source** | `.tmp/council-runtime-validation-20260514/COUNCIL.md` (local-only)                                                                           |
| **Successor**      | Z-2 ([#284](https://github.com/alexey-pelykh/ttctl/issues/284)) — add plugin to `codegen.config.ts` + generate `zod-schemas.ts`              |

## Verdict

**Adopt `graphql-codegen-typescript-validation-schema` ([Code-Hex/graphql-codegen-typescript-validation-schema](https://github.com/Code-Hex/graphql-codegen-typescript-validation-schema)) at v0.19.0**, configured for Zod v4, with `withObjectType: true`, `skipTypename: true`, and an explicit `scalarSchemas` + `scalars` pair for `BigDecimal`, `Date`, `DateTime`, and `Unknown`. Place the output at `packages/core/src/__generated__/zod-schemas.ts` so it inherits the existing ESLint exclusion for `__generated__/`.

Reject the two other named candidates from the council's open-question list — neither is installable.

## Candidate inventory

The issue body and the council record name four candidates. Three of the four either do not exist on npm or are unfit; the upstream codehex plugin is the only viable option.

| Candidate                                    | npm name                                                | Status                                                                                             | Verdict                                                             |
| -------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Codehex upstream**                         | `graphql-codegen-typescript-validation-schema`          | 0.19.0, published 2026-04-25, MIT, actively maintained (49 releases since 2022-01-20)              | **Adopt**                                                           |
| Community ops-scoped variant (council named) | `@graphql-codegen-community/zod-operations-plugin`      | **Does not exist on npm** (`npm view` → 404). Likely a speculative reference in the council brief. | Reject — unreachable                                                |
| Kobiton fork (council named)                 | `@kobiton/graphql-codegen-typescript-validation-schema` | **Does not exist on npm** (404).                                                                   | Reject — unreachable                                                |
| Hand-rolled plugin                           | n/a                                                     | Escape hatch                                                                                       | Reject — not needed; upstream meets all gating criteria with config |

Two adjacent packages surfaced during the candidate sweep:

- **`@anatine/graphql-codegen-zod` 0.4.1** (2024-03-19) — peer-depends `zod ^3.17.3` and `graphql-code-generator ^0.18.2` (a long-deprecated package name). Incompatible with our Zod 4 catalog pin and our graphql-codegen v7 install.
- **`@common-stack/graphql-codegen-zod-schemas` 7.2.1-alpha.49** (2025-11-06) — alpha, niche (oriented to the `common-stack`/Moleculer service-mesh ecosystem). Not a credible alternative to the codehex plugin for a general GraphQL backend.

The abandoned **`graphql-codegen-zod` 1.10.6** (mmahalwy, 2021-11-08, ~4.5 years stale) is out of scope.

## Verification against the issue's gating criteria

The issue body lists seven verification items. Each was checked against the proof-of-life invocation in `.tmp/zod-spike-pol/` (deps installed from npm, codegen run with the project's strict-TS profile mirrored exactly).

| Gating item                                                                        | Result                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generates valid TS that compiles under `verbatimModuleSyntax` + project references | ✓ (with `skipTypename: true`) | `tsc --noEmit` exits 0 against generated file with `tsconfig.base.json` flags mirrored. See § Compilation finding below.                                                                                                                                                                                                                                                                                                                |
| Output respects `noUncheckedIndexedAccess`                                         | ✓                             | The generated `Scalars['Date']['output']` form indexes a literal-typed object whose keys TS proves exist — not arbitrary-key access. `noUncheckedIndexedAccess: true` does not flag it.                                                                                                                                                                                                                                                 |
| Compiles with `tseslint.configs.strictTypeChecked` clean                           | ✓ via existing exclusion      | The output contains `: any` (line `(v: any): v is definedNonNullAny`) and `type definedNonNullAny = {}` — both would flag strictTypeChecked. The project already excludes `**/__generated__/` in `eslint.config.js:14`, so placing the output at `packages/core/src/__generated__/zod-schemas.ts` makes this a no-op.                                                                                                                   |
| Generates schemas for OUTPUT object types (not just INPUT types)                   | ✓ via `withObjectType: true`  | `BillingCycleSchema()`, `BillingCycleConnectionSchema()`, `NodeSchema()` all emit. See § Generated output excerpt below.                                                                                                                                                                                                                                                                                                                |
| Plays nicely with `*_KNOWN_UNTRUSTED_OPS` exclusion list                           | ✓                             | The validation-schema plugin reads the same document set as `typescript`/`typescript-operations`. The existing document-glob negation pattern (`!../research/graphql/.../{op}.graphql`) excludes untrusted ops uniformly. For schema-level types (object types in the SDL), the plugin emits a schema regardless of which operations reference it — that is correct: a `BillingCycle` schema is reusable across any op that selects it. |
| License is AGPL-3.0-only-compatible                                                | ✓                             | MIT. Permitted by `scripts/check-licenses.js`.                                                                                                                                                                                                                                                                                                                                                                                          |
| Bundle-size impact when bundled into `@ttctl/core`                                 | Acceptable                    | Plugin itself is dev-only; runtime cost is the generated `zod-schemas.ts` content + Zod (already a catalog dep at `^4.4.3`). Generated schema size scales linearly with the SDL types we opt in; the council's per-op routing manifest (X-1, #289) bounds this to schema-complete ops only. The plugin's own disk footprint is 1.7 MB in `node_modules/` — comparable to `typescript-operations` and a non-event for devDependency.     |

### Compilation finding (`exactOptionalPropertyTypes` interaction)

The first proof-of-life run with `skipTypename: false` (the project's `SHARED_PLUGIN_CONFIG` default) failed `tsc` with:

> TS2375: Type 'ZodObject<...{ **typename: ZodOptional<ZodLiteral<...>>; ... }...>' is not assignable to type 'ZodObject<Required<{ **typename?: ZodType<...>; ... }>, $strip>' with `exactOptionalPropertyTypes: true`.

The plugin emits `__typename: z.literal('X').optional()` in every schema. `z.optional` infers `T | undefined`; the `Properties<T>` constraint type uses `Required<{...}>` which collapses optional properties — under `exactOptionalPropertyTypes: true`, `T | undefined` is no longer assignable to `T`, breaking the constraint.

**Workaround**: set `skipTypename: true` on the validation-schema generate-entry only. This removes `__typename` from the generated TS type; the Zod schema body still emits the literal (harmlessly — it parses payloads that carry `__typename` and those that don't). The existing `gateway.ts` / `talent-profile.ts` outputs that need `__typename` for discrimination keep `skipTypename: false` as they do today. Two generate-entries; two configs.

### Generated output excerpt (proof-of-life)

The full output is 87 lines for the BillingCycle slice. The schema-emission portion:

```ts
export function BillingCycleSchema(): z.ZodObject<Properties<BillingCycle>> {
  return z.object({
    __typename: z.literal("BillingCycle").optional(),
    endDate: z.string(),
    hours: z.string(),
    id: z.string(),
    minimumCommitment: z.unknown().nullish(),
    startDate: z.string(),
    timesheetOverdue: z.boolean(),
    timesheetSubmissionDeadlineDatetime: z.string(),
    timesheetSubmissionOpenDatetime: z.string(),
    timesheetSubmitted: z.boolean(),
  });
}

export function BillingCycleConnectionSchema(): z.ZodObject<Properties<BillingCycleConnection>> {
  return z.object({
    __typename: z.literal("BillingCycleConnection").optional(),
    ids: z.array(z.string().nullable()),
    nodes: z.array(z.lazy(() => BillingCycleSchema().nullable())),
  });
}
```

Observations:

- Output types are emitted as `function ...Schema(): z.ZodObject<...>` (not constants), which sidesteps recursion via `z.lazy()`. Slightly less ergonomic but correct.
- The `Properties<T>` helper (`Required<{ [K in keyof T]: z.ZodType<T[K]> }>`) is the structural-correctness gate: if a TS field is added without a matching Zod entry, the file fails to compile. This is the property the council was after — drift between the type and the validator is a compile error, not a runtime surprise.
- `minimumCommitment: Unknown` (a placeholder scalar in the synthesized SDL) maps cleanly: TS `Maybe<unknown>` ↔ Zod `z.unknown().nullish()`. Aligned with how Z-1 (#279) will handle the `BigDecimal` scalar.

## Configuration shape for Z-2

A draft of the new generate-entry to add in `codegen.config.ts` alongside the existing `gateway.ts` and `talent-profile.ts` entries:

```ts
"packages/core/src/__generated__/zod-schemas.ts": {
  schema: "../research/graphql/gateway/schema.graphql",
  documents: [
    // Same document set + exclusions as the gateway entry — keeps the
    // KNOWN_UNTRUSTED_OPS trust boundary uniform.
    "../research/graphql/gateway/operations/mobile/*.graphql",
    "../research/graphql/gateway/operations/portal/*.graphql",
    ...GATEWAY_PORTAL_COLLISIONS.map((name) => `!../research/graphql/gateway/operations/portal/${name}.graphql`),
    ...GATEWAY_MOBILE_KNOWN_UNTRUSTED_OPS.map(
      (name) => `!../research/graphql/gateway/operations/mobile/${name}.graphql`,
    ),
    ...GATEWAY_PORTAL_KNOWN_UNTRUSTED_OPS.map(
      (name) => `!../research/graphql/gateway/operations/portal/${name}.graphql`,
    ),
  ],
  documentTransforms: [dedupeFragments],
  plugins: [
    { add: { content: ZOD_SCHEMAS_HEADER } },
    "typescript",
    "typescript-validation-schema",
  ],
  config: {
    // typescript plugin: align scalar TS types with the Zod schemas
    scalars: {
      BigDecimal: "string",
      Date: "string",
      DateTime: "string",
      Unknown: "unknown",
    },
    useTypeImports: true,
    avoidOptionals: true,
    enumsAsTypes: true,
    // validation-schema plugin specifics
    skipTypename: true, // required under exactOptionalPropertyTypes — see § Compilation finding
    schema: "zod",
    withObjectType: true,
    scalarSchemas: {
      BigDecimal: "z.string()",
      Date: "z.string()",
      DateTime: "z.string()",
      Unknown: "z.unknown()",
    },
    defaultScalarTypeSchema: "z.unknown()",
  },
},
```

Notes for Z-2:

- The `scalars` field on the typescript plugin and `scalarSchemas` on the validation plugin must agree pairwise. Mapping `BigDecimal → string` here aligns with Z-1 (#279), which is the canonical decision for the scalar.
- `withOperationType: true` is an option for emitting schemas tied to specific operation result selection sets (e.g. `BillingCyclesQuerySchema`). The council's hybrid model targets _type-level_ validation at the callGateway boundary, not selection-set-shaped validation; we therefore opt out of `withOperationType` for the first iteration and revisit if Z-4 (#288) finds it useful.
- A second generate-entry mirrors the same shape for `talent-profile/schema.graphql`, producing `packages/core/src/__generated__/talent-profile-zod-schemas.ts`. Both entries are independent.

## What this verdict is not

- **Not an integration**. Z-2 (#284) does the actual wiring: adding the plugin to `pnpm-workspace.yaml` catalog, extending `codegen.config.ts`, regenerating, committing the output, and validating CI. This spike's working tree under `.tmp/zod-spike-pol/` is throwaway — no plugin is added to the project's lockfile or workspace.
- **Not a defense of Zod over alternatives**. The council selected Zod; this spike only chose between Zod plugins.
- **Not a per-op routing decision**. Which ops are validated via codegen-Zod vs wire-snapshots (Track 1) lives in X-1 (#289). This spike only validates that the codegen path is viable.

## Follow-up declaration

Z-2 ([#284](https://github.com/alexey-pelykh/ttctl/issues/284)) is unblocked by this verdict and inherits:

1. The plugin selection (`graphql-codegen-typescript-validation-schema` v0.19.0).
2. The config shape above (with the `skipTypename: true` requirement called out).
3. The output path convention (`packages/core/src/__generated__/zod-schemas.ts`).
4. The KNOWN_UNTRUSTED_OPS document-glob inheritance.
5. The expectation that scalar TS-type config (`scalars`) and Zod schema config (`scalarSchemas`) are maintained as a pair.

Z-1 ([#279](https://github.com/alexey-pelykh/ttctl/issues/279)) — `BigDecimal` scalar mapping to `string` — is a prerequisite for the first integration to be honest about the wire shape; this spike confirmed the mapping is the right call but does not implement it.
