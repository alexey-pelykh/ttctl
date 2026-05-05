// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { CodegenConfig } from "@graphql-codegen/cli";

/**
 * GraphQL Codegen configuration.
 *
 * The schema lives in the private `ttctl/research` repo (sibling to this repo
 * in the local workspace) under `research/graphql/schema.graphql`. Codegen runs
 * locally only; the generated artifacts are gitignored. Contributors who do not
 * have access to the research repo can still build (typed GraphQL operations
 * are wrapped in plain string templates that compile without the generated
 * types) but will not get full type-safety until codegen runs.
 *
 * Run: `pnpm codegen`
 */
const config: CodegenConfig = {
  overwrite: true,
  schema: "../research/graphql/schema.graphql",
  documents: ["packages/core/src/**/*.graphql"],
  generates: {
    "packages/core/src/__generated__/graphql.ts": {
      plugins: ["typescript", "typescript-operations"],
      config: {
        useTypeImports: true,
        avoidOptionals: true,
        skipTypename: false,
        enumsAsTypes: true,
      },
    },
  },
};

export default config;
