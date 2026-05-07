// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export { AuthSchema, ConfigSchema, ConfigError, discoverConfigPath, loadConfigFile, resolveConfig } from "./config.js";
export type { AuthValue, TtctlConfig } from "./config.js";

export { OnePasswordError, resolveOnePasswordReference } from "./onepassword.js";

export { getAuthStatus, resolveCredentials, signIn, SignInError } from "./auth.js";
export type { AuthInvalidReason, AuthStatusResult, SignInErrorCode } from "./auth.js";

export { AuthRevokedError, TtctlError } from "./auth/errors.js";

export { deleteAuthToken, loadAuthToken, resolveAuthTokenPath, saveAuthToken } from "./authToken.js";
export type { ResolveAuthTokenPathOptions } from "./authToken.js";

export {
  Cf403Error,
  Cf403PersistentError,
  IMPERSONATE_PROFILE,
  SchedulerBearerExpired,
  callSurface,
  impersonatedTransport,
  stockTransport,
} from "./transport.js";
export type { TransportRequest, TransportResponse } from "./transport.js";

export { SURFACES_REQUIRING_IMPERSONATION, SURFACE_ENDPOINTS } from "./types.js";
export type { Credentials, GraphQLRequest, ToptalSurface } from "./types.js";

export * as profile from "./services/profile/index.js";

export { PROFILE_BASIC_FIELDS, PROFILE_SKILL_FIELDS, cliToServer, serverToCli } from "./services/translations.js";

export type { ProfileShowQuery, ProfileShowQueryVariables } from "./__generated__/graphql.js";
