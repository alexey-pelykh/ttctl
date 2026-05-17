// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the running package's version by reading the sibling
 * `package.json` of the calling module. Pass `import.meta.url` from the
 * caller; the helper walks from `<dir>/../package.json` (the canonical
 * `dist/<file>.js` → `package.json` layout used by every workspace
 * package in this repo).
 *
 * Falls back to `0.0.0` if the file cannot be read or parsed —
 * defensive against partial installs / chmod weirdness, never throws.
 * `0.0.0` matches the unstamped placeholder used in source today
 * (e.g., `packages/cli/src/program.ts:107`, `packages/mcp/src/server.ts`),
 * so the fallback never surfaces a discontinuity to consumers.
 *
 * Used by the kill-switch wire-up sites (#312) to supply the running
 * version to `checkKillSwitch`, and is available for any future
 * version-aware feature.
 */
export function readPackageVersion(metaUrl: string): string {
  try {
    const dir = dirname(fileURLToPath(metaUrl));
    const candidate = join(dir, "..", "package.json");
    const raw = readFileSync(candidate, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to the placeholder default.
  }
  return "0.0.0";
}
