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

export { getAuthStatus, resolveCredentials, signIn, signOut, SignInError } from "./auth.js";
export type {
  AuthInvalidReason,
  AuthStatusResult,
  SignInErrorCode,
  SignOutInvalidReason,
  SignOutResult,
  SignOutUnreachableReason,
} from "./auth.js";

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
export * as payments from "./services/payments/index.js";
export * as timesheet from "./services/timesheet/index.js";

export { PROFILE_BASIC_FIELDS, PROFILE_SKILL_FIELDS, cliToServer, serverToCli } from "./services/translations.js";

export type { ProfileShowQuery, ProfileShowQueryVariables } from "./__generated__/gateway.js";

export { DateInputError, parseDateInput } from "./lib/date.js";
export type { DateInputErrorCode, ParsedDate } from "./lib/date.js";

export { splitParagraphs } from "./lib/text.js";

export {
  getDiagnosticLogger,
  logTransportRequest,
  logTransportResponse,
  resetDiagnosticLogger,
  setDiagnosticLogger,
} from "./lib/diagnostic-log.js";
export type { DiagnosticLevel, RequestLogInfo, ResponseLogInfo } from "./lib/diagnostic-log.js";

export {
  BEARER_PATTERN,
  BEARER_PATTERN_SOURCE,
  REDACTED,
  SECRET_BODY_FIELD_NAMES,
  SECRET_HEADER_NAMES,
  containsBearerToken,
  redactBody,
  redactHeaders,
} from "./lib/redact.js";
