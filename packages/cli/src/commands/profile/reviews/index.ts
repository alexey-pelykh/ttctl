// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, Option } from "commander";

import { OUTPUT_FORMATS } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { runProfileReviewsApproveItem } from "./approve-item.js";
import { runProfileReviewsApproveSection } from "./approve-section.js";
import { runProfileReviewsList } from "./list.js";
import { runProfileReviewsSubmitForReview } from "./submit-for-review.js";

/**
 * Build the `ttctl profile reviews` command tree. See
 * `core/services/profile/reviews/index.ts` for the per-leaf rationale and
 * spec/API divergences (notably: the `<id>` shorthand from the issue spec
 * is replaced by named flags because the API requires three fields per
 * approval).
 *
 * Four leaves:
 *   - list                  — pending section reviews
 *   - approve-item          — approve one pending item
 *   - approve-section       — approve all pending items in a section
 *   - submit-for-review     — submit profile for platform re-review
 *
 * Approval is destructive (final per platform semantics). When `--dry-run`
 * (#52) ships, this sub-tree should opt in.
 */
export function buildProfileReviewsCommand(): Command {
  const reviews = new Command("reviews").description(
    "View and approve pending section/item reviews; submit profile for platform re-review",
  );

  reviews
    .command("list")
    .description("List pending section reviews (and their items)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileReviewsList(options.output);
    });

  reviews
    .command("approve-item")
    .description(
      "Approve a single pending item within a section review. " +
        "Run `profile reviews list` first to obtain the three required IDs.",
    )
    .requiredOption("--review-id <id>", "section-review ID (from `profile reviews list`)")
    .requiredOption("--item-id <id>", "underlying item ID (from `profile reviews list`)")
    .requiredOption("--kind <kind>", "ItemReviewKind enum value (e.g. EDUCATION, EMPLOYMENT)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { reviewId: string; itemId: string; kind: string; output: OutputFormat }) => {
      await runProfileReviewsApproveItem(options);
    });

  reviews
    .command("approve-section")
    .description("Approve all pending items in a section review")
    .requiredOption("--review-id <id>", "section-review ID (from `profile reviews list`)")
    .requiredOption("--section <section>", "ReviewSection enum value (e.g. EDUCATION)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { reviewId: string; section: string; output: OutputFormat }) => {
      await runProfileReviewsApproveSection(options);
    });

  reviews
    .command("submit-for-review")
    .description("Submit the profile for platform-side re-review (used after edits)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileReviewsSubmitForReview(options);
    });

  return reviews;
}
