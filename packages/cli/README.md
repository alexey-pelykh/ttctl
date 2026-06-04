# @ttctl/cli

[![npm](https://img.shields.io/npm/v/%40ttctl%2Fcli?logo=npm)](https://www.npmjs.com/package/@ttctl/cli)
[![License](https://img.shields.io/npm/l/%40ttctl%2Fcli)](https://github.com/alexey-pelykh/ttctl/blob/main/LICENSE)

[Commander](https://github.com/tj/commander.js)-based CLI program for the [TTCtl](https://github.com/alexey-pelykh/ttctl) toolkit. Powers the `ttctl` binary shipped by the umbrella package.

> **Unofficial.** TTCtl is NOT affiliated with, endorsed by, or supported by Toptal LLC. See the [project README](https://github.com/alexey-pelykh/ttctl#readme) for the full use policy and disclaimer.

## Audience

End users should install the [`ttctl`](https://www.npmjs.com/package/ttctl) umbrella package — it ships the `ttctl` binary plus the MCP server.

This package is published separately for **embedders** who want to mount the Commander program inside another CLI tree, or run it standalone in a controlled context (test harness, custom wrapper).

## Install

```sh
npm install @ttctl/cli
```

Requires **Node.js ≥ 22.19.0**, ESM only.

## API Surface

- `buildProgram()` — returns a `commander` [`Command`](https://github.com/tj/commander.js) with every sub-command registered: `profile`, `applications`, `engagements`, `availability`, `jobs`, `timesheet`, `contracts`, `payments`, `auth`. Honors the global flags `--config`, `--output`, `--json`, `--yaml`, `--dry-run`, `--verbose`, `--debug` (run `ttctl --help` for details; see the project README's [Configuration](https://github.com/alexey-pelykh/ttctl#configuration) section for `--config` precedence).
- `presentTtctlError`, `exitCodeForTtctlError`, `formatTtctlErrorMessage` — typed-error rendering for embedders that want CLI-shaped exit codes and stderr messages.
- Re-exports `TtctlError`, `ConfigError`, `ConfigErrorCode` from `@ttctl/core` so embedders can `instanceof`-check error types without taking a direct `@ttctl/core` dependency.

## Example

Minimal embedder:

```ts
import { buildProgram, presentTtctlError, TtctlError } from "@ttctl/cli";

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof TtctlError) {
      // Writes the formatted block to stderr and calls process.exit
      // with the right code (1 for auth, 2 for Cf403). Never returns.
      presentTtctlError(err);
    }
    throw err;
  }
}

await main();
```

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/ttctl/blob/main/LICENSE). Importing `@ttctl/cli` into your own code means the combined work is covered by AGPL-3.0; using the unmodified `ttctl` binary as a tool does not. See the project README's [License](https://github.com/alexey-pelykh/ttctl#license) section.
