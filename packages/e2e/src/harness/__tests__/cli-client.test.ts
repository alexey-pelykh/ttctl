// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getCliClient } from "../cli-client.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ttctl-e2e-cli-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("getCliClient — construction", () => {
  it("throws a clear error when the CLI entry point is missing", () => {
    const stub = join(workDir, "missing.js");
    expect(() =>
      getCliClient({
        jarPath: join(workDir, "session.cookies"),
        cliEntryPoint: stub,
        repoRoot: workDir,
      }),
    ).toThrow(/CLI entry point not found.*pnpm build/);
  });

  it("exposes the resolved cliEntryPoint on the client object", async () => {
    const stub = join(workDir, "stub.js");
    await writeFile(stub, "process.exit(0);\n");
    const client = getCliClient({
      jarPath: join(workDir, "session.cookies"),
      cliEntryPoint: stub,
      repoRoot: workDir,
    });
    expect(client.cliEntryPoint).toBe(stub);
  });
});

describe("getCliClient — run", () => {
  it("captures stdout, stderr, and exit code from a successful invocation", async () => {
    const stub = join(workDir, "echo.js");
    await writeFile(
      stub,
      ["process.stdout.write('hello-out\\n');", "process.stderr.write('hello-err\\n');", "process.exit(0);", ""].join(
        "\n",
      ),
    );
    const client = getCliClient({ jarPath: "/dev/null", cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run([]);
    expect(result.stdout).toBe("hello-out\n");
    expect(result.stderr).toBe("hello-err\n");
    expect(result.exitCode).toBe(0);
  });

  it("forwards non-zero exit codes (does not throw)", async () => {
    const stub = join(workDir, "fail.js");
    await writeFile(stub, "process.exit(7);\n");
    const client = getCliClient({ jarPath: "/dev/null", cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run([]);
    expect(result.exitCode).toBe(7);
  });

  it("sets TTCTL_COOKIE_JAR_PATH in the spawned env to the configured jarPath", async () => {
    const stub = join(workDir, "env-dump.js");
    // Print the env var, exit 0
    await writeFile(stub, 'process.stdout.write(process.env.TTCTL_COOKIE_JAR_PATH || "");\n');
    const jarPath = join(workDir, "isolated.cookies");
    const client = getCliClient({ jarPath, cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run([]);
    expect(result.stdout).toBe(jarPath);
  });

  it("rejects attempts to override TTCTL_COOKIE_JAR_PATH via run() env (isolation guard)", async () => {
    const stub = join(workDir, "noop.js");
    await writeFile(stub, "process.exit(0);\n");
    const jarPath = join(workDir, "isolated.cookies");
    const client = getCliClient({ jarPath, cliEntryPoint: stub, repoRoot: workDir });
    await expect(client.run([], { env: { TTCTL_COOKIE_JAR_PATH: "/etc/passwd" } })).rejects.toThrow(
      /refusing to override TTCTL_COOKIE_JAR_PATH/,
    );
  });

  it("merges per-invocation env overlay with the harness defaults", async () => {
    const stub = join(workDir, "env-other.js");
    await writeFile(stub, 'process.stdout.write(process.env.MY_TEST_VAR || "missing");\n');
    const client = getCliClient({
      jarPath: "/dev/null",
      cliEntryPoint: stub,
      repoRoot: workDir,
    });
    const result = await client.run([], { env: { MY_TEST_VAR: "overlay-value" } });
    expect(result.stdout).toBe("overlay-value");
  });

  it("supports stdin input", async () => {
    const stub = join(workDir, "stdin-echo.js");
    await writeFile(
      stub,
      [
        "let buf = '';",
        "process.stdin.on('data', (c) => { buf += c.toString('utf8'); });",
        "process.stdin.on('end', () => { process.stdout.write(buf); process.exit(0); });",
        "",
      ].join("\n"),
    );
    const client = getCliClient({ jarPath: "/dev/null", cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run([], { input: "stdin payload" });
    expect(result.stdout).toBe("stdin payload");
  });

  it("forwards positional args to the spawned CLI", async () => {
    const stub = join(workDir, "argv.js");
    await writeFile(stub, "process.stdout.write(process.argv.slice(2).join(' '));\n");
    const client = getCliClient({ jarPath: "/dev/null", cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run(["a", "b", "c"]);
    expect(result.stdout).toBe("a b c");
  });

  it("times out a hung subprocess and rejects the promise", async () => {
    const stub = join(workDir, "hang.js");
    await writeFile(stub, "setTimeout(() => process.exit(0), 30_000);\n");
    const client = getCliClient({ jarPath: "/dev/null", cliEntryPoint: stub, repoRoot: workDir });
    await expect(client.run([], { timeoutMs: 200 })).rejects.toThrow(/timed out after 200ms/);
  });
});
