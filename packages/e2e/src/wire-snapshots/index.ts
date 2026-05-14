// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Public surface of the wire-snapshots subsystem (Track 1 — wire-shape
 * drift detection). WS-1 ships the capture utility and snapshot file
 * format. WS-2 will add the assert+diff helper. WS-3 will apply the
 * pair to the timesheet domain. See council outcome and scope brief at:
 *
 *   - `.tmp/council-runtime-validation-20260514/COUNCIL.md`
 *   - `docs/briefs/2026-05-14-scope-runtime-validation-hybrid.md`
 */

export { captureWireShape, createWireSnapshot } from "./captureWireShape.js";
export type {
  CreateWireSnapshotParams,
  WireShape,
  WireSnapshot,
  WireSnapshotSurface,
  WireSnapshotTransport,
} from "./captureWireShape.js";
