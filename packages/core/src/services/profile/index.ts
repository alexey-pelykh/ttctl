// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * `profile` services-tree facade. The 11 sub-domains follow the v0 epic
 * cartography (#68): basic, skills, industries, education, certifications,
 * employment, portfolio, visas, resume, external, reviews. Each is exposed
 * as a namespace on this module so consumers write
 * `profile.basic.show(...)`, `profile.skills.add(...)`, etc.
 *
 * Only `basic` carries operations today (`show`, `set`, plus the shared
 * `ProfileError`/`ProfileUpdate`/`UpdateProfileResult` types). The other
 * 10 sub-domains are placeholder modules that land actual operations in
 * the follow-up issues (#73-#76).
 */

export * as basic from "./basic/index.js";
export * as skills from "./skills/index.js";
export * as industries from "./industries/index.js";
export * as education from "./education/index.js";
export * as certifications from "./certifications/index.js";
export * as employment from "./employment/index.js";
export * as portfolio from "./portfolio/index.js";
export * as visas from "./visas/index.js";
export * as resume from "./resume/index.js";
export * as external from "./external/index.js";
export * as reviews from "./reviews/index.js";
export * as specializations from "./specializations/index.js";
