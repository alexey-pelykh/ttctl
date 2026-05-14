// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export { buildProgram } from "./program.js";
export { exitCodeForTtctlError, formatTtctlErrorMessage, presentTtctlError } from "./errors.js";
export { formatCrashLog, installCrashHandlers } from "./crash-handlers.js";
export type { CrashKind } from "./crash-handlers.js";

// Re-export the typed-error base so the umbrella package's top-level error
// handler can `instanceof`-check without a direct `@ttctl/core` dependency.
// CLI consumers typically catch concrete subclasses instead.
export { TtctlError } from "@ttctl/core";

// Also re-export ConfigError so the umbrella's MCP branch can render the
// startup-time `NO_CREDS` failure (#113 fail-fast contract) in the same
// uniform `Error (CODE): message` form the CLI surface uses, without
// pulling `@ttctl/core` as a direct dependency on the umbrella.
export { ConfigError } from "@ttctl/core";
export type { ConfigErrorCode } from "@ttctl/core";
