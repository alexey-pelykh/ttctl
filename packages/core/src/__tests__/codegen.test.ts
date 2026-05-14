// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { describe, expect, it } from "vitest";

import type { AvailabilityDataFragment, ViewerQuery, ViewerQueryVariables } from "../__generated__/gateway.js";

/**
 * Smoke test: verifies that `pnpm codegen` produces TypeScript types that are
 * importable from `@ttctl/core` source and structurally correct end-to-end.
 *
 * The fixtures below construct values that satisfy `ViewerQuery` and
 * `AvailabilityDataFragment` without any `as` cast or `as any`. Custom-mapped
 * scalars — `BigDecimal`, `Date`, `DateTime`, `Time` (per captured wire
 * shapes) and `JSON` (per ecosystem convention) — carry concrete TS mappings
 * declared in `codegen.config.ts`; this fragment exercises
 * `Scalars['Unknown']`-typed fields (`disablingReason`, `comment`,
 * `rejectReason`, `futureAvailableHours`, `returnInDate`) — the schema-side
 * `Unknown` placeholder for positions that have not yet been pinned by a
 * live capture — which still surface as `unknown` and accept `null` via
 * `Maybe<>`.
 */
describe("graphql-codegen smoke", () => {
  it("emits a typed `ViewerQuery` operation type with no variables", () => {
    const _variables: ViewerQueryVariables = {};
    expect(_variables).toEqual({});

    const sample: ViewerQuery = {
      viewer: {
        __typename: "Viewer",
        id: "viewer-1",
        preliminarySearchSetting: {
          __typename: "PreliminarySearchSetting",
          enabled: false,
          disablingReason: null,
          comment: null,
        },
        viewerRole: {
          __typename: "ViewerRole",
          allocatedHours: 40,
          hiredHours: 30,
          lastAllocatedHoursChangeRequest: null,
        },
      },
    };

    expect(sample.viewer?.id).toBe("viewer-1");
    expect(sample.viewer?.preliminarySearchSetting.enabled).toBe(false);
    expect(sample.viewer?.viewerRole.allocatedHours).toBe(40);
    expect(sample.viewer?.viewerRole.hiredHours).toBe(30);
    expect(sample.viewer?.viewerRole.lastAllocatedHoursChangeRequest).toBeNull();
  });

  it("emits a typed `AvailabilityData` fragment shape that aligns with `ViewerQuery.viewer`", () => {
    const fragment: AvailabilityDataFragment = {
      __typename: "Viewer",
      id: "viewer-1",
      preliminarySearchSetting: {
        __typename: "PreliminarySearchSetting",
        enabled: true,
        disablingReason: null,
        comment: null,
      },
      viewerRole: {
        __typename: "ViewerRole",
        allocatedHours: 40,
        hiredHours: 30,
        lastAllocatedHoursChangeRequest: {
          __typename: "AllocatedHoursChangeRequest",
          id: "ahcr-1",
          allocatedHours: 35,
          rejectReason: null,
          comment: "",
          futureAvailableHours: null,
          returnInDate: null,
          useReturnAvailability: false,
          reviewedManually: true,
          statusV2: {
            __typename: "AllocatedHoursChangeRequestStatus",
            value: "PENDING",
          },
        },
      },
    };

    expect(fragment.id).toBe("viewer-1");
    expect(fragment.viewerRole.lastAllocatedHoursChangeRequest?.statusV2.value).toBe("PENDING");
  });
});
