// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { ProfileError } from "../basic/index.js";
import { callTalentProfile, ensureNoTopLevelErrors } from "../shared.js";
import type { GraphQLErrorEntry } from "../shared.js";

/**
 * A `Country` catalog entry. Same `{ id, code, name }` shape as the
 * `Employment.primaryGeography` read fragment (the resolver returns a
 * `Country`), so an id sourced here drops into the `primaryGeographyId`
 * write path (#586). `id` is a Relay id (`V1-Country-<n>`); `code` is the
 * ISO code. `code`/`name` are nullable because the SDL types
 * `countries: Unknown`.
 */
export interface Country {
  id: string;
  code: string | null;
  name: string | null;
}

// Hand-authored: `getCountries` is in `TALENT_PROFILE_KNOWN_UNTRUSTED_OPS`
// (SDL types `countries: Unknown`), so there is no generated type and
// wire-shape stability is the T1 snapshot's job. No `geographiesAutocomplete`
// exists — the catalog is a full list, not a search.
const GET_COUNTRIES_QUERY = `query getCountries {
  countries {
    id
    code
    name
  }
}`;

interface CountriesResponse {
  data?: { countries?: unknown } | null;
  errors?: GraphQLErrorEntry[] | null;
}

// Defensive projection of the `Unknown`-typed wire row (mirrors
// `projectCurationRefs` in industries): rows without a usable `id` are
// dropped; non-string `code`/`name` collapse to null.
function projectCountry(raw: unknown): Country | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as { id?: unknown; code?: unknown; name?: unknown };
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  return {
    id: row.id,
    code: typeof row.code === "string" ? row.code : null,
    name: typeof row.name === "string" ? row.name : null,
  };
}

/**
 * List the Toptal Country/geography catalog (id-discovery for the
 * `primaryGeographyId` write field, #586).
 *
 * A non-array `data.countries` throws `GRAPHQL_ERROR` rather than
 * defaulting to `[]` — the no-silent-empty contract from `industries.list`
 * (a wire-shape mismatch must be loud). An empty array is a valid result.
 */
export async function list(token: string): Promise<Country[]> {
  const res = await callTalentProfile(token, "getCountries", GET_COUNTRIES_QUERY, {}, "countries list");
  const body = res.body as CountriesResponse | null;
  ensureNoTopLevelErrors(body, "countries list");
  const countries = body?.data?.countries;
  if (!Array.isArray(countries)) {
    throw new ProfileError(
      "GRAPHQL_ERROR",
      `countries list returned non-array \`data.countries\` (wire shape mismatch).`,
    );
  }
  return countries.map(projectCountry).filter((c): c is Country => c !== null);
}
