// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

// Public harness surface — re-exported so `import {...} from "@ttctl/e2e"`
// works without reaching into the package's internal layout. E2E test
// cases live as `*.e2e.test.ts` files under this src/ tree and are gated
// to local runs only via `TTCTL_E2E=1` (see vitest.e2e.config.ts).
export * from "./harness/index.js";
export * from "./wire-snapshots/index.js";
