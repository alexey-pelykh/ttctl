// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { persistAuthToken } from "@ttctl/core";

/**
 * Worker module forked by `configLock-cross-process.test.ts`. Two of these
 * run as concurrent OS-level processes and both call `persistAuthToken` on
 * the same config file — the cross-process advisory lock (Item 1 of the
 * #107 follow-up batch) must serialize them with no corruption and no
 * data-loss.
 *
 * Communication contract:
 *
 *   - Args (positional): `<configPath>`, `<token>`, `[delayMs]`.
 *   - Optional `delayMs` lets the test stage the second worker's start so
 *     contention is observable; default is 0.
 *   - Output: a single JSON line on stdout encoding `{ ok, token, error?,
 *     code? }`. Exit code 0 on success, 1 on failure.
 *
 * Stderr is left to the underlying ttctl machinery (e.g., world-writable
 * mode warnings — none expected in this test). The harness asserts on
 * exit code + stdout JSON, so any incidental stderr noise does not break
 * the contract.
 */

interface WorkerSuccess {
  ok: true;
  token: string;
}

interface WorkerFailure {
  ok: false;
  token: string;
  error: string;
  code?: string;
  name?: string;
}

type WorkerResult = WorkerSuccess | WorkerFailure;

function emit(result: WorkerResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const [, , configPath, token, delayArg] = process.argv;

if (configPath === undefined || token === undefined) {
  emit({
    ok: false,
    token: token ?? "",
    error: "configLock-worker: missing args (expected: configPath, token, [delayMs])",
  });
  process.exit(1);
}

const delayMs = delayArg !== undefined ? Number.parseInt(delayArg, 10) : 0;

async function main(): Promise<void> {
  if (delayMs > 0) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  try {
    await persistAuthToken(configPath as string, token as string);
    emit({ ok: true, token: token as string });
    process.exit(0);
  } catch (err) {
    const e = err as Error & { code?: string };
    emit({
      ok: false,
      token: token as string,
      error: e.message,
      ...(e.code !== undefined ? { code: e.code } : {}),
      name: e.name,
    });
    process.exit(1);
  }
}

void main();
