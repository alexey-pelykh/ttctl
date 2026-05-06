// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getMcpClient } from "../mcp-client.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ttctl-e2e-mcp-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("getMcpClient — construction", () => {
  it("throws when the CLI entry point is missing (same guard as getCliClient)", () => {
    expect(() =>
      getMcpClient({
        jarPath: join(workDir, "session.cookies"),
        cliEntryPoint: join(workDir, "missing.js"),
        repoRoot: workDir,
      }),
    ).toThrow(/CLI entry point not found.*pnpm build/);
  });

  it("rejects TTCTL_COOKIE_JAR_PATH overrides via env (isolation guard)", async () => {
    const stub = join(workDir, "noop.js");
    await writeFile(stub, "process.exit(0);\n");
    expect(() =>
      getMcpClient({
        jarPath: join(workDir, "session.cookies"),
        cliEntryPoint: stub,
        repoRoot: workDir,
        env: { TTCTL_COOKIE_JAR_PATH: "/etc/passwd" },
      }),
    ).toThrow(/refusing to override TTCTL_COOKIE_JAR_PATH/);
  });
});

describe("getMcpClient — lifecycle", () => {
  it("spawns the MCP server and exposes the live process object", async () => {
    const stub = join(workDir, "long.js");
    // Block on stdin until the parent closes it (close() sends SIGTERM)
    await writeFile(stub, "process.stdin.on('end', () => process.exit(0)); process.stdin.resume();\n");
    const client = getMcpClient({
      jarPath: "/dev/null",
      cliEntryPoint: stub,
      repoRoot: workDir,
    });
    expect(client.process).toBeDefined();
    expect(client.process.pid).toBeGreaterThan(0);
    expect(client.cliEntryPoint).toBe(stub);

    await client.close(2_000);
    expect(client.process.exitCode !== null || client.process.signalCode !== null).toBe(true);
  });

  it("getStderr returns accumulated stderr", async () => {
    const stub = join(workDir, "stderr-then-exit.js");
    await writeFile(
      stub,
      [
        "process.stderr.write('boot diagnostic\\n');",
        // Keep alive for a moment so test has time to drain stderr buffer
        "setTimeout(() => process.exit(0), 100);",
        "",
      ].join("\n"),
    );
    const client = getMcpClient({ jarPath: "/dev/null", cliEntryPoint: stub, repoRoot: workDir });
    await new Promise<void>((resolveWait) => client.process.on("close", () => resolveWait()));
    expect(client.getStderr()).toContain("boot diagnostic");
  });

  it("close() is idempotent on an already-exited process", async () => {
    const stub = join(workDir, "exit.js");
    await writeFile(stub, "process.exit(0);\n");
    const client = getMcpClient({ jarPath: "/dev/null", cliEntryPoint: stub, repoRoot: workDir });
    await new Promise<void>((resolveWait) => client.process.on("close", () => resolveWait()));
    await expect(client.close(500)).resolves.toBeUndefined();
  });

  it("close() returns immediately when the child was killed by signal (no hang)", async () => {
    // POSIX-only failure mode: a signal-killed child has exitCode=null but
    // signalCode set (e.g. "SIGTERM"). A check that only reads exitCode
    // would proceed past the early-return, register `once("close")` after
    // the close event already fired, and hang until closeTimeoutMs (then
    // SIGKILL on a dead PID, then hang forever). The Promise.race wrapper
    // makes a regression fail in ~1s instead of waiting for vitest's
    // testTimeout. On Windows, exitCode is set after kill() and the early
    // return triggers regardless — the test still passes.
    const stub = join(workDir, "block.js");
    await writeFile(stub, "process.stdin.resume();\n");
    const client = getMcpClient({ jarPath: "/dev/null", cliEntryPoint: stub, repoRoot: workDir });

    client.process.kill("SIGTERM");
    await new Promise<void>((resolveWait) => client.process.on("close", () => resolveWait()));

    await expect(
      Promise.race([
        client.close(200),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("close hung")), 1_000)),
      ]),
    ).resolves.toBeUndefined();
  });
});
