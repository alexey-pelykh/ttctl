// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export {
  AuthCredentialsSchema,
  ConfigError,
  ConfigLoadSchema,
  ConfigWriteSchema,
  discoverConfigPath,
  loadConfigFile,
  resolveConfig,
} from "./config.js";
export type {
  AuthBlock,
  AuthCredentials,
  ConfigErrorCode,
  LiteralAuthCredentials,
  ResolveConfigOptions,
  TtctlConfig,
  TtctlConfigWritable,
} from "./config.js";

export { AuthTokenPersistError, clearAuthToken, persistAuthToken, writeNewConfig } from "./configWriter.js";

export { acquireConfigLock } from "./configLock.js";
export type { ConfigLockHandle } from "./configLock.js";

export { OnePasswordError, resolveOnePasswordReference } from "./onepassword.js";

export { getAuthStatus, resolveCredentials, signIn, SignInError } from "./auth.js";
export type { AuthInvalidReason, AuthStatusResult, SignInErrorCode } from "./auth.js";

export { AuthRevokedError, TtctlError } from "./auth/errors.js";

export {
  Cf403Error,
  Cf403PersistentError,
  DRY_RUN_REDACTED_AUTHORIZATION,
  IMPERSONATE_PROFILE,
  SchedulerBearerExpired,
  buildDryRunPreview,
  buildGraphQLMultipart,
  callSurface,
  impersonatedMultipartTransport,
  impersonatedTransport,
  stockTransport,
} from "./transport.js";
export type {
  DryRunPreview,
  MultipartFile,
  MultipartTransportRequest,
  TransportRequest,
  TransportResponse,
} from "./transport.js";

export { SURFACES_REQUIRING_IMPERSONATION, SURFACE_ENDPOINTS } from "./types.js";
export type { Credentials, GraphQLRequest, ToptalSurface } from "./types.js";

export * as profile from "./services/profile/index.js";
export * as applications from "./services/applications/index.js";
export * as engagements from "./services/engagements/index.js";
export * as availability from "./services/availability/index.js";
export * as jobs from "./services/jobs/index.js";

export { PROFILE_BASIC_FIELDS, PROFILE_SKILL_FIELDS, cliToServer, serverToCli } from "./services/translations.js";

export type { ProfileShowQuery, ProfileShowQueryVariables } from "./__generated__/graphql.js";

export { DateInputError, parseDateInput } from "./lib/date.js";
export type { DateInputErrorCode, ParsedDate } from "./lib/date.js";

export { splitParagraphs } from "./lib/text.js";
