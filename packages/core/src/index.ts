// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export { AuthSchema, ConfigSchema, ConfigError, discoverConfigPath, loadConfigFile, resolveConfig } from "./config.js";
export type { AuthValue, TtctlConfig } from "./config.js";

export { OnePasswordError, resolveOnePasswordReference } from "./onepassword.js";

export { resolveCredentials, signIn } from "./auth.js";

export { IMPERSONATE_PROFILE, callSurface, impersonatedTransport, stockTransport } from "./transport.js";
export type { TransportRequest, TransportResponse } from "./transport.js";

export { SURFACES_REQUIRING_IMPERSONATION, SURFACE_ENDPOINTS } from "./types.js";
export type { Credentials, GraphQLRequest, ToptalSurface } from "./types.js";
