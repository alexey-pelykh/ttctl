// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export { buildProgram } from "./program.js";
export { exitCodeForTtctlError, formatTtctlErrorMessage, presentTtctlError } from "./errors.js";

// Re-export the typed-error base so the umbrella package's top-level error
// handler can `instanceof`-check without a direct `@ttctl/core` dependency.
// CLI consumers typically catch concrete subclasses instead.
export { TtctlError } from "@ttctl/core";
