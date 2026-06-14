// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export {
  AuthCredentialsSchema,
  ConfigError,
  ConfigLoadSchema,
  ConfigWriteSchema,
  discoverConfigPath,
  loadConfigFile,
  OP_REF_PATTERN_HINT,
  OP_REF_PATTERN_SOURCE,
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

export { getAuthStatus, resolveCredentials, signIn, signOut, SignInError } from "./auth/index.js";
export type {
  AuthInvalidReason,
  AuthStatusResult,
  SignInErrorCode,
  SignOutInvalidReason,
  SignOutResult,
  SignOutUnreachableReason,
} from "./auth/index.js";

export { AuthRevokedError, TtctlError } from "./auth/errors.js";

export {
  ACCOUNT_ECHO_MIN_LENGTH,
  CONSENT_ENV_VAR,
  CONSENT_FIELD,
  ConsentRequiredError,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  ensureDestructiveConsent,
} from "./consent.js";
export type { ConsentDomain, ConsentGateOptions, PaymentRoutingCreateContext } from "./consent.js";

export {
  Cf403Error,
  Cf403PersistentError,
  DRY_RUN_REDACTED_AUTHORIZATION,
  IMPERSONATE_PROFILE,
  NativeModuleUnavailableError,
  RedirectError,
  SchedulerBearerExpired,
  buildDryRunPreview,
  buildGraphQLMultipart,
  callSurface,
  impersonatedMultipartTransport,
  impersonatedTransport,
  stockTransport,
} from "./transport/index.js";
export type {
  DryRunPreview,
  MultipartFile,
  MultipartTransportRequest,
  TransportRequest,
  TransportResponse,
} from "./transport/index.js";

export { TransportError, readTransportConfig, resetTransportConfigCache } from "./transport-resilience.js";
export type { TransportConfig } from "./transport-resilience.js";

export { SURFACES_REQUIRING_IMPERSONATION, SURFACE_ENDPOINTS } from "./types.js";
export type { Credentials, GraphQLRequest, ToptalSurface } from "./types.js";

export * as profile from "./services/profile/index.js";
export * as applications from "./services/applications/index.js";
export * as contracts from "./services/contracts/index.js";
export * as engagements from "./services/engagements/index.js";
export * as availability from "./services/availability/index.js";
export * as jobs from "./services/jobs/index.js";
export * as payments from "./services/payments/index.js";
export * as surveys from "./services/surveys/index.js";
export * as timesheet from "./services/timesheet/index.js";
export * as me from "./services/me/index.js";

export { PROFILE_BASIC_FIELDS, PROFILE_SKILL_FIELDS, cliToServer, serverToCli } from "./services/translations.js";

export type { ProfileShowQuery, ProfileShowQueryVariables } from "./__generated__/gateway.js";

export { DateInputError, parseDateInput } from "./lib/date.js";
export type { DateInputErrorCode, ParsedDate } from "./lib/date.js";

export { splitParagraphs } from "./lib/text.js";

export {
  buildWireShapeError,
  buildWireShapeMessage,
  MAX_VALUE_LENGTH,
  projectZodErrorToDiff,
  WIRE_SHAPE_HINT,
} from "./lib/wire-shape.js";
export type { WireShapeDiffEntry, WireShapeErrorPayload } from "./lib/wire-shape.js";

export {
  getDiagnosticLogger,
  logTransportRequest,
  logTransportResponse,
  resetDiagnosticLogger,
  setDiagnosticLogger,
} from "./lib/diagnostic-log.js";
export type { DiagnosticLevel, RequestLogInfo, ResponseLogInfo } from "./lib/diagnostic-log.js";

export { readPackageVersion } from "./lib/package-version.js";

export {
  checkKillSwitch,
  formatKillSwitchMessage,
  KILL_SWITCH_DEFAULT_REFETCH_INTERVAL_MS,
  KILL_SWITCH_DEFAULT_TIMEOUT_MS,
  KILL_SWITCH_MANIFEST_URL,
  KILL_SWITCH_OVERRIDE_ENV_VAR,
  matchesVersion,
} from "./kill-switch.js";
export type {
  CheckKillSwitchOptions,
  FormatKillSwitchMessageOptions,
  KillSwitchEntry,
  KillSwitchManifest,
  KillSwitchResult,
} from "./kill-switch.js";

export {
  BEARER_PATTERN,
  BEARER_PATTERN_SOURCE,
  REDACTED,
  SECRET_BODY_FIELD_NAMES,
  SECRET_HEADER_NAMES,
  containsBearerToken,
  redactBody,
  redactHeaders,
  redactString,
} from "./lib/redact.js";
