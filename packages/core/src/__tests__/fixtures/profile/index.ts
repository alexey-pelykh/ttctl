// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Profile rendering fixtures — reusable test data for empty / single-item
 * / paragraph-bearing / full / minimal list scenarios. See `README.md`
 * for the full builder API and the rationale behind the
 * `buildParagraphBearingList` shape.
 */

export {
  buildEmptyProfile,
  buildFullProfile,
  buildMinimalProfile,
  buildParagraphBearingList,
  buildSingleItemList,
} from "./builders.js";
export type {
  Certification,
  Education,
  Employment,
  IndustryProfile,
  PortfolioItem,
  ProfileFixture,
  ProfileSkillSet,
  TravelVisa,
} from "./types.js";
