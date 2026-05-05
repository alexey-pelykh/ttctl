#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { buildProgram } from "@ttctl/cli";
import { runMcpStdio } from "@ttctl/mcp";

/**
 * Umbrella entrypoint: dispatches to MCP-server mode if invoked as
 * `ttctl mcp`, otherwise routes to the Commander CLI program.
 *
 * The MCP branch is kept first so its early dispatch doesn't conflict with
 * commander's argv parsing.
 */
async function main(): Promise<void> {
  if (process.argv[2] === "mcp") {
    await runMcpStdio();
    return;
  }

  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
