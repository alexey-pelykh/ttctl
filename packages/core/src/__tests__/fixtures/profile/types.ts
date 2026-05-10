// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { Certification } from "../../../services/profile/certifications/index.js";
import type { Education } from "../../../services/profile/education/index.js";
import type { Employment } from "../../../services/profile/employment/index.js";
import type { IndustryProfile } from "../../../services/profile/industries/index.js";
import type { PortfolioItem } from "../../../services/profile/portfolio/index.js";
import type { ProfileSkillSet } from "../../../services/profile/skills/index.js";
import type { TravelVisa } from "../../../services/profile/visas/index.js";

/**
 * Fixture-only aggregate bundling every per-domain list a CLI/MCP rendering
 * test might want to drive against in one shape. Production code does not
 * have an aggregate `Profile` — each sub-domain (`profile.skills`,
 * `profile.portfolio`, …) returns its own list — so this aggregate exists
 * solely so test code can write
 *
 * ```ts
 * const fx = buildEmptyProfile();
 * expect(fx.skills).toEqual([]);
 * expect(fx.portfolio).toEqual([]);
 * ```
 *
 * Each member is the production entity type verbatim (re-exported from the
 * sub-domain modules — no type duplication, no hand-rolled mock shapes).
 *
 * Note: the issue body referenced a `reviews` list with paragraph-bearing
 * body text, but the production `reviews` domain (`profile.reviews`) is the
 * admin section-review queue (`SectionReview`) with no prose body. The
 * paragraph-bearing fixture therefore populates `portfolio` items with
 * realistic multi-sentence `description` + `accomplishment` content (the
 * actual paragraph-bearing fields in production). See the `README.md`
 * sibling for the rationale.
 */
export interface ProfileFixture {
  skills: ProfileSkillSet[];
  portfolio: PortfolioItem[];
  employment: Employment[];
  education: Education[];
  certifications: Certification[];
  industries: IndustryProfile[];
  visas: TravelVisa[];
}

/**
 * Re-exports of the per-domain entity types so consumers can pull
 * everything they need from one fixture-module path:
 *
 * ```ts
 * import type { ProfileFixture, ProfileSkillSet } from "../fixtures/profile";
 * ```
 *
 * The re-exports point at the production types — there is no
 * fixture-private variant.
 */
export type { Certification, Education, Employment, IndustryProfile, PortfolioItem, ProfileSkillSet, TravelVisa };
