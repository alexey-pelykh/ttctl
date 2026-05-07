// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Public API of the `@ttctl/e2e` harness.
 *
 * Test authors import from `@ttctl/e2e` (which re-exports this module).
 * The harness is the contract between the package's E2E test cases (#21
 * and follow-ups) and the live Toptal Talent platform — it owns:
 *
 *   - Live-account safety (isolated jar, run-level lockfile, redaction).
 *   - Session lifecycle (`withFreshSession`).
 *   - Programmatic invocation (`getCliClient`, `getMcpClient`).
 *
 * Internals (`lockfile`, `paths`, etc.) are not exported — keep the
 * surface area small. If a test author needs a path the harness uses,
 * route the request through this module rather than reaching into private
 * paths.
 */

export { printPreflightBanner } from "./banner.js";
export { getCliClient } from "./cli-client.js";
export type { CliClient, CliClientOptions, CliInvocationOptions, CliInvocationResult } from "./cli-client.js";
export { LockfileError, acquireLock, isPidAlive, releaseLock } from "./lockfile.js";
export type { LockState } from "./lockfile.js";
export { getMcpClient } from "./mcp-client.js";
export type { McpClient, McpClientOptions } from "./mcp-client.js";
export {
  cliConfigPath,
  findRepoRoot,
  resolveIsolatedAuthTokenPath,
  resolveLockfilePath,
  resolveSandboxConfigPath,
  resolveSandboxDir,
  writeSandboxConfig,
} from "./paths.js";
export { formatRedacted, redact } from "./redaction.js";
export { withFreshSession } from "./session.js";
export type {
  FreshSessionContext,
  FreshSessionHandle,
  SessionRegistration,
  WithFreshSessionOptions,
} from "./session.js";
