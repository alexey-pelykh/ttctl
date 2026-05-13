// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

export { buildServer, runMcpStdio } from "./server.js";
export type { BuildServerOptions } from "./server.js";
export { ttctlErrorToToolResponse, ttctlErrorToToolResponseOrNull } from "./errors.js";
export type { ToolErrorResponse } from "./errors.js";

export {
  emitMcpAuthResolve,
  emitMcpDebug,
  extractTransportStatus,
  extractTransportSurface,
  getMcpDiagnosticLogger,
  isTransportError,
  redactToolArgs,
  resetMcpDiagnosticLogger,
  setMcpDiagnosticLogger,
  wrapToolHandler,
} from "./diagnostic.js";
export type {
  McpAuthResolveRecord,
  McpDebugRecord,
  McpDiagnosticLogger,
  McpToolInvokeEndRecord,
  McpToolInvokeStartRecord,
  McpToolInvokeStatus,
  McpTransportErrorRecord,
} from "./diagnostic.js";
