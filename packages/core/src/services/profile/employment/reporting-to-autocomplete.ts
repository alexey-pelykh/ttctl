// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ProfileError } from "../basic/index.js";
import { callTalentProfile, ensureNoTopLevelErrors, extractProfileId } from "../shared.js";
import type { GraphQLErrorEntry } from "../shared.js";

/**
 * One suggestion returned by the `reportingToAutocomplete` catalog
 * lookup — the canonical id of a known reporting-line target plus its
 * display name. Used to populate `Employment.reportingTo` with a
 * server-vetted value rather than a freeform string.
 */
export interface ReportingToSuggestion {
  id: string;
  name: string;
}

const REPORTING_TO_AUTOCOMPLETE_QUERY = `query GET_REPORTING_TO_AUTOCOMPLETE($name: String!, $limit: Int!, $profileId: ID!) {
  profile(id: $profileId) {
    id
    reportingToAutocomplete(name: $name, limit: $limit) {
      id
      name
    }
  }
}`;

interface AutocompleteResponse {
  data?: {
    profile?: {
      id?: unknown;
      reportingToAutocomplete?: ReportingToSuggestion | ReportingToSuggestion[] | null;
    } | null;
  } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/**
 * Search Toptal's reporting-to name catalog. Returns `{id, name}`
 * suggestions suitable for setting `Employment.reportingTo` to a
 * server-vetted value.
 *
 * The minimum-length gate (`prefix.trim().length >= 2`) runs BEFORE
 * the wire call — mirrors the web client's 2-char debounce against a
 * server-paginated name index.
 *
 * `options.profileId` lets callers pass an already-resolved profile id
 * and skip the `extractProfileId` viewer-chain round-trip.
 */
export async function reportingToAutocomplete(
  token: string,
  prefix: string,
  options: { limit?: number; profileId?: string } = {},
): Promise<ReportingToSuggestion[]> {
  const trimmed = prefix.trim();
  if (trimmed.length < 2) {
    throw new ProfileError("VALIDATION_ERROR", "reporting-to-autocomplete requires a prefix of at least 2 characters.");
  }
  const profileId = options.profileId ?? (await extractProfileId(token));
  const limit = options.limit ?? 10;
  const res = await callTalentProfile(
    token,
    "GET_REPORTING_TO_AUTOCOMPLETE",
    REPORTING_TO_AUTOCOMPLETE_QUERY,
    { name: trimmed, limit, profileId },
    "reporting-to-autocomplete",
  );
  const body = res.body as AutocompleteResponse | null;
  ensureNoTopLevelErrors(body, "reporting-to-autocomplete");
  const raw = body?.data?.profile?.reportingToAutocomplete;
  if (raw === null || raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}
