# ttctl

[![npm](https://img.shields.io/npm/v/ttctl?logo=npm)](https://www.npmjs.com/package/ttctl)
[![License](https://img.shields.io/npm/l/ttctl)](https://github.com/alexey-pelykh/ttctl/blob/main/LICENSE)

Unofficial CLI and MCP server for [Toptal Talent](https://talent.toptal.com) — your own profile, your own session, your own data.

> **Unofficial.** TTCtl is NOT affiliated with, endorsed by, or supported by Toptal LLC. See the [project README](https://github.com/alexey-pelykh/ttctl#readme) for the full use policy and disclaimer.

## Install

```sh
npm install -g ttctl
```

Or run directly with npx:

```sh
npx ttctl --help
```

Requires **Node.js ≥ 22.19.0**.

## What's in this package

`ttctl` is the **umbrella binary**. It bundles two sibling packages so end users get one install:

- [`@ttctl/cli`](https://www.npmjs.com/package/@ttctl/cli) — the Commander program (`ttctl profile show`, `ttctl timesheet list`, `ttctl auth signin`, …)
- [`@ttctl/mcp`](https://www.npmjs.com/package/@ttctl/mcp) — the MCP server (`ttctl mcp` on stdio)

If you only need part of TTCtl in another program, install the sibling package directly. For interactive use, this umbrella is the package you want.

## Quick Start

```sh
# 1. Bootstrap config interactively (Form A: 1Password reference, recommended)
ttctl auth init

# 2. Sign in — captures the bearer back into ~/.ttctl.yaml
ttctl auth signin

# 3. Verify
ttctl auth status

# 4. View your profile
ttctl profile show
```

## MCP

```sh
# Start the MCP server on stdio (typically spawned by your MCP client)
ttctl mcp
```

For Claude Desktop / Claude Code / Cursor configuration snippets, the full sub-command reference, configuration shapes (Forms A–D, sync-root exclusions, debug instrumentation), and the disclaimer / fair-use posture, see the [**project README**](https://github.com/alexey-pelykh/ttctl#readme).

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/ttctl/blob/main/LICENSE). Using the `ttctl` binary as a tool does not impose AGPL obligations on your own code; importing the constituent libraries (`@ttctl/cli` / `@ttctl/mcp` / `@ttctl/core`) does. See the project README's [License](https://github.com/alexey-pelykh/ttctl#license) section.
