// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { AuthRevokedError, TtctlError } from "../../../auth/errors.js";
import { impersonatedTransport } from "../../../transport.js";
import type { TransportResponse } from "../../../transport.js";
import { show as showBasic } from "../basic/index.js";
import { isAuthRevokedExtensionCode } from "../shared.js";

/**
 * Visas sub-domain error codes. Cross-cutting auth/Cloudflare failures
 * propagate as `TtctlError` subclasses unchanged.
 */
export type VisasErrorCode =
  | "NO_VIEWER"
  | "GRAPHQL_ERROR"
  | "NETWORK_ERROR"
  | "USER_ERROR"
  | "VALIDATION_ERROR"
  | "UNKNOWN";

export class VisasError extends Error {
  override readonly name = "VisasError";
  constructor(
    public readonly code: VisasErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

interface GraphQLErrorEntry {
  message?: string | null;
  extensions?: { code?: string | null } | null;
}

interface UserError {
  message?: string | null;
  field?: string | null;
}

/**
 * Read-side `TravelVisa` shape. Mirrors the `TravelVisa` fragment in
 * `research/graphql/talent_profile/fragments/TravelVisa.graphql`. The
 * server names the country sub-object — TTCtl flattens it onto the
 * top-level shape for ergonomic access at the CLI layer.
 */
export interface TravelVisa {
  id: string;
  countryId: string;
  countryName: string;
  visaType: string;
  expiryDate: string | null;
}

/**
 * Write-side `TravelVisaInput`. The country reference uses `countryId`
 * (the ID returned by the read-side `country.id`); `visaType` is a free
 * string the server validates against its catalog of known visa types.
 *
 * **[INFERRED]** Wrapper key `travelVisa` (Pattern 1/2 from
 * `research/notes/10-mutation-input-patterns.md`); falsifiable by live
 * capture if the server rejects the wrapper.
 */
export interface TravelVisaInput {
  countryId?: string;
  visaType?: string;
  expiryDate?: string;
}

interface TalentProfileResponse<T> {
  data?: { [key: string]: T | null } | null;
  errors?: GraphQLErrorEntry[] | null;
}

/** Map a server `TravelVisa` node to the typed {@link TravelVisa}. */
function mapTravelVisaNode(node: Record<string, unknown>): TravelVisa {
  const country = (node["country"] ?? {}) as { id?: string; name?: string };
  const id = node["id"];
  return {
    id: typeof id === "string" ? id : "",
    countryId: country.id ?? "",
    countryName: country.name ?? "",
    visaType: (node["visaType"] as string | null | undefined) ?? "",
    expiryDate: (node["expiryDate"] as string | null | undefined) ?? null,
  };
}

async function resolveProfileId(token: string): Promise<string> {
  const profile = await showBasic(token);
  const profileId = profile.viewer?.viewerRole.profileId;
  if (profileId === undefined) {
    throw new VisasError("NO_VIEWER", "Cannot resolve profile id from session response.");
  }
  return profileId;
}

/**
 * Common "200 with errors" shape handler. Returns the unwrapped payload
 * (the value of the single root data field) as `unknown`; callers
 * narrow to their per-operation payload shape at the call site.
 */
function unwrapResponse(res: TransportResponse, operationName: string): unknown {
  if (res.status === 401) {
    throw new AuthRevokedError("Session is invalid or expired.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new VisasError("UNKNOWN", `${operationName} returned HTTP ${res.status.toString()}`);
  }
  const body = res.body as TalentProfileResponse<unknown> | null;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (isAuthRevokedExtensionCode(first?.extensions?.code)) {
      throw new AuthRevokedError("Session is invalid or expired.");
    }
    throw new VisasError("GRAPHQL_ERROR", `${operationName} failed: ${first?.message ?? "GraphQL error"}`);
  }
  if (!body?.data) {
    throw new VisasError("UNKNOWN", `${operationName} response had no \`data\` field`);
  }
  const keys = Object.keys(body.data);
  if (keys.length === 0) {
    throw new VisasError("UNKNOWN", `${operationName} response had empty \`data\``);
  }
  const firstKey = keys[0] as string;
  const payload = body.data[firstKey];
  if (payload === null || payload === undefined) {
    throw new VisasError("UNKNOWN", `${operationName} response had \`null\` payload`);
  }
  return payload;
}

function rejectIfUserErrors(errors: UserError[] | null | undefined, operationName: string): void {
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    const fieldHint = first?.field ? ` (${first.field})` : "";
    throw new VisasError("USER_ERROR", `${operationName} rejected${fieldHint}: ${first?.message ?? "unknown error"}`);
  }
}

async function withTransportErrors<T>(operationName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TtctlError) throw err;
    if (err instanceof VisasError) throw err;
    throw new VisasError("NETWORK_ERROR", `${operationName} request failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                                Operations                                  */
/* -------------------------------------------------------------------------- */

/**
 * Full-document `getTravelVisas` query (talent-profile).
 *
 * The `Profile.travelVisas` field is only defined on the `talent-profile`
 * schema — `mobile-gateway` does not expose it (verified against
 * `research/graphql/talent_profile/operations/getTravelVisas.graphql` and
 * the synthesized SDLs under `research/graphql/`). Sibling mutations
 * (`createTravelVisa`, `updateTravelVisa`, `removeTravelVisa`) already
 * route through `talent-profile` for the same reason; this read aligns
 * with that surface choice.
 */
const GET_TRAVEL_VISAS_QUERY = `query getTravelVisas($profileId: ID!) {
  profile(id: $profileId) {
    id
    travelVisas {
      nodes {
        id
        country {
          id
          name
        }
        visaType
        expiryDate
      }
    }
  }
}`;

/**
 * Fetch the signed-in user's travel-visa records. Empty list returns `[]`,
 * never `null`.
 */
export async function list(token: string): Promise<TravelVisa[]> {
  const profileId = await resolveProfileId(token);
  const res = await withTransportErrors("getTravelVisas", async () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "getTravelVisas",
        query: GET_TRAVEL_VISAS_QUERY,
        variables: { profileId },
      },
    }),
  );
  const profile = unwrapResponse(res, "getTravelVisas") as {
    id: string;
    travelVisas: { nodes: Record<string, unknown>[] };
  };
  return profile.travelVisas.nodes.map(mapTravelVisaNode);
}

const CREATE_TRAVEL_VISA_MUTATION = `mutation createTravelVisa($input: CreateTravelVisaInput!) {
  createTravelVisa(input: $input) {
    profile {
      id
      travelVisas {
        nodes {
          id
          country {
            id
            name
          }
          visaType
          expiryDate
        }
      }
    }
    errors {
      message
      field
    }
  }
}`;

interface CreateTravelVisaInput {
  profileId: string;
  travelVisa: TravelVisaInput;
}

interface TravelVisaMutationPayload {
  profile?: { id: string; travelVisas: { nodes: Record<string, unknown>[] } } | null;
  errors?: UserError[] | null;
}

/**
 * Create a new travel-visa record.
 *
 * Both `countryId` and `visaType` are required by the AC; `expiryDate`
 * is optional. The wire-side error path returns `errors[]` on the
 * mutation payload when the server rejects (e.g. unknown country,
 * malformed date) — those collapse into `USER_ERROR`.
 */
export async function add(token: string, input: TravelVisaInput): Promise<TravelVisa[]> {
  if (!input.countryId || input.countryId.trim() === "") {
    throw new VisasError("VALIDATION_ERROR", "Travel visa requires a non-empty `countryId`.");
  }
  if (!input.visaType || input.visaType.trim() === "") {
    throw new VisasError("VALIDATION_ERROR", "Travel visa requires a non-empty `visaType`.");
  }
  const profileId = await resolveProfileId(token);
  const variables: { input: CreateTravelVisaInput } = {
    input: { profileId, travelVisa: input },
  };
  const res = await withTransportErrors("createTravelVisa", async () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "createTravelVisa",
        query: CREATE_TRAVEL_VISA_MUTATION,
        variables,
      },
    }),
  );
  const payload = unwrapResponse(res, "createTravelVisa") as TravelVisaMutationPayload;
  rejectIfUserErrors(payload.errors, "createTravelVisa");
  if (!payload.profile) {
    throw new VisasError("UNKNOWN", "createTravelVisa succeeded but response had no profile payload.");
  }
  return payload.profile.travelVisas.nodes.map(mapTravelVisaNode);
}

const UPDATE_TRAVEL_VISA_MUTATION = `mutation updateTravelVisa($input: UpdateTravelVisaInput!) {
  updateTravelVisa(input: $input) {
    profile {
      id
      travelVisas {
        nodes {
          id
          country {
            id
            name
          }
          visaType
          expiryDate
        }
      }
    }
    errors {
      message
      field
    }
  }
}`;

interface UpdateTravelVisaInput {
  travelVisaId: string;
  travelVisa: TravelVisaInput;
}

/** Update a travel-visa record by id. */
export async function update(token: string, id: string, changes: TravelVisaInput): Promise<TravelVisa[]> {
  if (Object.keys(changes).length === 0) {
    throw new VisasError("VALIDATION_ERROR", "Travel visa update requires at least one field.");
  }
  const variables: { input: UpdateTravelVisaInput } = {
    input: { travelVisaId: id, travelVisa: changes },
  };
  const res = await withTransportErrors("updateTravelVisa", async () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "updateTravelVisa",
        query: UPDATE_TRAVEL_VISA_MUTATION,
        variables,
      },
    }),
  );
  const payload = unwrapResponse(res, "updateTravelVisa") as TravelVisaMutationPayload;
  rejectIfUserErrors(payload.errors, "updateTravelVisa");
  if (!payload.profile) {
    throw new VisasError("UNKNOWN", "updateTravelVisa succeeded but response had no profile payload.");
  }
  return payload.profile.travelVisas.nodes.map(mapTravelVisaNode);
}

const REMOVE_TRAVEL_VISA_MUTATION = `mutation removeTravelVisa($input: RemoveTravelVisaInput!) {
  removeTravelVisa(input: $input) {
    profile {
      id
      travelVisas {
        nodes {
          id
          country {
            id
            name
          }
          visaType
          expiryDate
        }
      }
    }
    errors {
      message
      field
    }
  }
}`;

/** Remove a travel-visa record by id. */
export async function remove(token: string, id: string): Promise<TravelVisa[]> {
  const variables = { input: { travelVisaId: id } };
  const res = await withTransportErrors("removeTravelVisa", async () =>
    impersonatedTransport({
      surface: "talent-profile",
      authToken: token,
      body: {
        operationName: "removeTravelVisa",
        query: REMOVE_TRAVEL_VISA_MUTATION,
        variables,
      },
    }),
  );
  const payload = unwrapResponse(res, "removeTravelVisa") as TravelVisaMutationPayload;
  rejectIfUserErrors(payload.errors, "removeTravelVisa");
  if (!payload.profile) {
    throw new VisasError("UNKNOWN", "removeTravelVisa succeeded but response had no profile payload.");
  }
  return payload.profile.travelVisas.nodes.map(mapTravelVisaNode);
}
