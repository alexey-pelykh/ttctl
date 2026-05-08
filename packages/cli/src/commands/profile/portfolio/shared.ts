// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Shared helpers for `ttctl profile portfolio` leaves. Re-exports
 * `loadAuthTokenOrExit` from `../shared.ts` (post-#107 unification — the
 * separate token file is gone; auth-token resolution is centralised on
 * the in-memory `config.auth.token`).
 */

export { loadAuthTokenOrExit } from "../shared.js";
