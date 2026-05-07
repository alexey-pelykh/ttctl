// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        cliEntryPoint: stub,
        repoRoot: workDir,
      }),
    ).toThrow(/CLI entry point not found.*pnpm build/);
  });

  it("exposes the resolved cliEntryPoint on the client object", async () => {
    const stub = join(workDir, "stub.js");
    await writeFile(stub, "process.exit(0);\n");
    const client = getCliClient({
      cliEntryPoint: stub,
      repoRoot: workDir,
    });
    expect(client.cliEntryPoint).toBe(stub);
  });

  it("exposes the resolved cwd on the client object (defaults to repoRoot)", async () => {
    const stub = join(workDir, "stub.js");
    await writeFile(stub, "process.exit(0);\n");
    const client = getCliClient({
      cliEntryPoint: stub,
      repoRoot: workDir,
    });
    expect(client.cwd).toBe(workDir);
  });

  it("uses the provided cwd when set (sandbox isolation entry point)", async () => {
    const sandbox = join(workDir, "sandbox");
    await mkdir(sandbox);
    const stub = join(workDir, "stub.js");
    await writeFile(stub, "process.exit(0);\n");
    const client = getCliClient({
      cwd: sandbox,
      cliEntryPoint: stub,
      repoRoot: workDir,
    });
    expect(client.cwd).toBe(sandbox);
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
    const client = getCliClient({ cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run([]);
    expect(result.stdout).toBe("hello-out\n");
    expect(result.stderr).toBe("hello-err\n");
    expect(result.exitCode).toBe(0);
  });

  it("forwards non-zero exit codes (does not throw)", async () => {
    const stub = join(workDir, "fail.js");
    await writeFile(stub, "process.exit(7);\n");
    const client = getCliClient({ cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run([]);
    expect(result.exitCode).toBe(7);
  });

  it("spawns the subprocess in the configured cwd (isolation entry point)", async () => {
    // Test the *contract* — a relative path inside the subprocess resolves
    // against the configured cwd — rather than asserting the literal cwd
    // string. Cross-platform `process.cwd()` normalization differs in ways
    // that make string comparison brittle:
    //   - macOS:    /tmp/X is symlinked to /private/tmp/X; child sees long form
    //   - Windows:  os.tmpdir() may return 8.3 short form (RUNNER~1) on CI,
    //               while fs.realpath returns long form (runneradmin)
    // Writing a marker file at "./marker.txt" inside the child and asserting
    // the harness can read it back at <sandbox>/marker.txt proves the cwd
    // contract directly without coupling to either canonicalization quirk.
    const sandbox = join(workDir, "sandbox");
    await mkdir(sandbox);
    const stub = join(workDir, "marker.js");
    await writeFile(stub, "require('fs').writeFileSync('./marker.txt', 'present');\n");
    const client = getCliClient({ cwd: sandbox, cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run([]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(sandbox, "marker.txt"))).toBe(true);
    expect(await readFile(join(sandbox, "marker.txt"), "utf8")).toBe("present");
  });

  it("inherits process.env into the spawned subprocess when configPath is unset", async () => {
    // Construction-only mode (no `configPath`): the harness adds no env
    // of its own. Verify that an arbitrary parent env var lands in the
    // child verbatim.
    const stub = join(workDir, "env-passthrough.js");
    await writeFile(stub, 'process.stdout.write(process.env.PATH || "<unset>");\n');
    const client = getCliClient({ cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run([]);
    expect(result.stdout).toBe(process.env["PATH"] ?? "<unset>");
  });

  it("injects TTCTL_CONFIG_FILE into the spawned subprocess when configPath is set (#94)", async () => {
    const stub = join(workDir, "config-passthrough.js");
    await writeFile(stub, 'process.stdout.write(process.env.TTCTL_CONFIG_FILE || "<unset>");\n');
    const sandboxConfig = join(workDir, "sandbox", ".ttctl.yaml");
    const client = getCliClient({
      configPath: sandboxConfig,
      cliEntryPoint: stub,
      repoRoot: workDir,
    });
    const result = await client.run([]);
    expect(result.stdout).toBe(sandboxConfig);
  });

  it("override-injects TTCTL_CONFIG_FILE even when the parent process has it set", async () => {
    const stub = join(workDir, "config-override.js");
    await writeFile(stub, 'process.stdout.write(process.env.TTCTL_CONFIG_FILE || "<unset>");\n');
    const sandboxConfig = join(workDir, "sandbox", ".ttctl.yaml");
    const original = process.env["TTCTL_CONFIG_FILE"];
    process.env["TTCTL_CONFIG_FILE"] = "/some/parent/config.yaml";
    try {
      const client = getCliClient({
        configPath: sandboxConfig,
        cliEntryPoint: stub,
        repoRoot: workDir,
      });
      const result = await client.run([]);
      expect(result.stdout).toBe(sandboxConfig);
    } finally {
      if (original === undefined) delete process.env["TTCTL_CONFIG_FILE"];
      else process.env["TTCTL_CONFIG_FILE"] = original;
    }
  });

  it("per-invocation env overlay can drop the harness-injected TTCTL_CONFIG_FILE (negative-case escape hatch)", async () => {
    // Per-invocation env wins over the harness's injection — tests can
    // exercise the `no config injected` path by passing
    // `env: { TTCTL_CONFIG_FILE: undefined }`.
    const stub = join(workDir, "config-cleared.js");
    await writeFile(stub, 'process.stdout.write(process.env.TTCTL_CONFIG_FILE || "<unset>");\n');
    const sandboxConfig = join(workDir, "sandbox", ".ttctl.yaml");
    const original = process.env["TTCTL_CONFIG_FILE"];
    delete process.env["TTCTL_CONFIG_FILE"];
    try {
      const client = getCliClient({
        configPath: sandboxConfig,
        cliEntryPoint: stub,
        repoRoot: workDir,
      });
      const result = await client.run([], { env: { TTCTL_CONFIG_FILE: undefined } });
      expect(result.stdout).toBe("<unset>");
    } finally {
      if (original !== undefined) process.env["TTCTL_CONFIG_FILE"] = original;
    }
  });

  it("merges per-invocation env overlay onto process.env", async () => {
    const stub = join(workDir, "env-other.js");
    await writeFile(stub, 'process.stdout.write(process.env.MY_TEST_VAR || "missing");\n');
    const client = getCliClient({
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
    const client = getCliClient({ cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run([], { input: "stdin payload" });
    expect(result.stdout).toBe("stdin payload");
  });

  it("forwards positional args to the spawned CLI", async () => {
    const stub = join(workDir, "argv.js");
    await writeFile(stub, "process.stdout.write(process.argv.slice(2).join(' '));\n");
    const client = getCliClient({ cliEntryPoint: stub, repoRoot: workDir });
    const result = await client.run(["a", "b", "c"]);
    expect(result.stdout).toBe("a b c");
  });

  it("times out a hung subprocess and rejects the promise", async () => {
    const stub = join(workDir, "hang.js");
    await writeFile(stub, "setTimeout(() => process.exit(0), 30_000);\n");
    const client = getCliClient({ cliEntryPoint: stub, repoRoot: workDir });
    await expect(client.run([], { timeoutMs: 200 })).rejects.toThrow(/timed out after 200ms/);
  });
});
