#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ConfigError, TtctlError, buildProgram, installCrashHandlers, presentTtctlError } from "@ttctl/cli";
import { runMcpStdio } from "@ttctl/mcp";

// Wire `uncaughtException` and `unhandledRejection` handlers BEFORE any other
// executable code (issue #207). The `main().catch()` below covers anything
// that flows through the awaited Promise chain; the global handlers cover
// what escapes — fire-and-forget Promise rejections in tool callbacks,
// throws from `setTimeout` / `setImmediate` / `process.nextTick` callbacks,
// EventEmitter listeners not in `main`'s chain. Both paths redact captured
// Toptal session bearers via `redactString` from `@ttctl/core`.
installCrashHandlers();

/**
 * Umbrella entrypoint: dispatches to MCP-server mode if invoked as
 * `ttctl mcp`, otherwise routes to the Commander CLI program.
 *
 * The MCP branch is kept first so its early dispatch doesn't conflict with
 * commander's argv parsing.
 *
 * MCP `--config <path>` (#113): the umbrella parses the flag from argv
 * after the `mcp` subcommand position and threads it into
 * `runMcpStdio({ configPath })`. The path is captured ONCE inside
 * `buildServer`; subsequent tool invocations read/write the same path
 * regardless of mid-session env-var changes. Startup-time
 * `resolveConfig(NO_CREDS)` propagates as a non-zero exit so the MCP
 * client sees a clean failure rather than a half-initialized server.
 */
async function main(): Promise<void> {
  if (process.argv[2] === "mcp") {
    const configPath = parseConfigFlag(process.argv.slice(3));
    try {
      await runMcpStdio(configPath !== undefined ? { configPath } : {});
    } catch (err) {
      if (err instanceof ConfigError) {
        process.stderr.write(`Error (${err.code}): ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
    return;
  }

  const program = buildProgram();
  await program.parseAsync(process.argv);
}

/**
 * Parse `--config <path>` (and `--config=<path>`) from a flat argv slice.
 * Returns the first match or `undefined`. Unknown flags are ignored —
 * the MCP server has no other entry-flags today, but this keeps the
 * function tolerant for future additions (SSE port, transport selector,
 * …) layered on top by sister tools.
 */
function parseConfigFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--config") {
      return args[i + 1];
    }
    if (arg !== undefined && arg.startsWith("--config=")) {
      return arg.slice("--config=".length);
    }
  }
  return undefined;
}

main().catch((err: unknown) => {
  // Top-level safety net: any TtctlError that escapes a command handler is
  // rendered in the uniform Error/Recovery/Code format (issue #77). Other
  // unexpected errors fall through to the generic single-line stderr.
  if (err instanceof TtctlError) presentTtctlError(err);
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
