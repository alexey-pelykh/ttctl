// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { Command, Option } from "commander";
import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { OUTPUT_FORMATS, emitResult } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { loadAuthTokenOrExit } from "../shared.js";

/**
 * Local alias for the parent `loadAuthTokenOrExit` helper to keep this
 * file's existing call sites (`loadTokenOrExit(commandLabel)`) unchanged.
 * Post-#107 the function reads the token from the in-memory parsed config
 * (`config.auth.token`) — there's no longer a separate token file to
 * resolve.
 */
const loadTokenOrExit = loadAuthTokenOrExit;

/**
 * Resolve the user's profileId for queries that need it (`list`,
 * `autocomplete`, `readiness`). The talent-profile surface keys these
 * operations on `profileId` rather than the auth token, so we fetch it
 * via `profile.basic.show()` once per CLI invocation. The cost is one
 * extra mobile-gateway round-trip — acceptable at v0; future caching
 * tracked separately.
 */
async function resolveProfileId(token: string, commandLabel: string): Promise<string> {
  let payload;
  try {
    payload = await profile.basic.show(token);
  } catch (err) {
    handleSkillsError(err, commandLabel);
  }
  const profileId = payload.viewer?.viewerRole.profileId;
  if (profileId === undefined) {
    process.stderr.write(`${commandLabel} failed (NO_VIEWER): no profile id bound to this session.\n`);
    process.exit(1);
  }
  return profileId;
}

/**
 * Common error router. Centralised so each leaf renders failures with
 * a uniform `<command> failed (<CODE>): <message>` shape — mirroring the
 * existing `basic show` / `basic update` handlers.
 */
function handleSkillsError(err: unknown, commandLabel: string): never {
  if (err instanceof TtctlError) presentTtctlError(err);
  if (err instanceof profile.skills.SkillsError) {
    process.stderr.write(`${commandLabel} failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  if (err instanceof profile.basic.ProfileError) {
    process.stderr.write(`${commandLabel} failed (${err.code}): ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${commandLabel} failed: ${message}\n`);
  process.exit(1);
}

// =======================================================================
// Action handlers (one per leaf)
// =======================================================================

async function runSkillsAdd(name: string): Promise<void> {
  const commandLabel = "profile skills add";
  const token = await loadTokenOrExit(commandLabel);
  let result: profile.skills.ProfileSkillSet;
  try {
    result = await profile.skills.add(token, name);
  } catch (err) {
    handleSkillsError(err, commandLabel);
  }
  process.stdout.write(`Added skill ${result.skill.name} (id ${result.id}).\n`);
}

async function runSkillsRm(id: string): Promise<void> {
  const commandLabel = "profile skills remove";
  const token = await loadTokenOrExit(commandLabel);
  try {
    await profile.skills.rm(token, id);
  } catch (err) {
    handleSkillsError(err, commandLabel);
  }
  process.stdout.write(`Removed skill ${id}.\n`);
}

interface SkillsUpdateOptions {
  rating?: profile.skills.ProficiencyRating;
  experience?: string;
  public?: boolean;
  private?: boolean;
}

/**
 * Action handler for `ttctl profile skills update <id> [flags]`. Resolves
 * the multi-flag input into a `SkillUpdate` shape (translating
 * `--public/--private` into a single boolean, parsing `--experience` as
 * a duration) and dispatches to `profile.skills.set()`.
 *
 * Conflicting `--public` and `--private` are caught here; the core layer
 * never sees an inconsistent state.
 */
async function runSkillsUpdate(id: string, options: SkillsUpdateOptions): Promise<void> {
  const commandLabel = "profile skills update";

  if (options.public === true && options.private === true) {
    process.stderr.write(`${commandLabel} failed (VALIDATION_ERROR): --public and --private cannot both be set.\n`);
    process.exit(1);
  }

  const fields: profile.skills.SkillUpdate = {};
  if (options.rating !== undefined) {
    fields.rating = options.rating;
  }
  if (options.experience !== undefined) {
    const months = parseExperience(options.experience);
    if (months === null) {
      process.stderr.write(
        `${commandLabel} failed (VALIDATION_ERROR): --experience must be an integer count of months or a duration like "5y" or "60m".\n`,
      );
      process.exit(1);
    }
    fields.experience = months;
  }
  if (options.public === true) fields.public = true;
  if (options.private === true) fields.public = false;

  const token = await loadTokenOrExit(commandLabel);
  let result: profile.skills.UpdateSkillResult;
  try {
    result = await profile.skills.set(token, id, fields);
  } catch (err) {
    handleSkillsError(err, commandLabel);
  }

  const lines: string[] = [`Updated skill ${id}.`];
  if (result.rating !== null) lines.push(`  rating: ${result.rating}`);
  if (result.experience !== null) lines.push(`  experience: ${result.experience.toString()} months`);
  if (result.public !== null) lines.push(`  visibility: ${result.public ? "public" : "private"}`);
  for (const notice of result.notices) lines.push(`  ${notice}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Parse an `--experience` flag value into an integer count of months.
 * Accepts a bare number ("60" → 60), `Ny` ("5y" → 60), or `Nm` ("60m" →
 * 60). Returns `null` for anything that doesn't match — the caller turns
 * that into a `VALIDATION_ERROR` exit.
 *
 * Pure function — directly unit-testable.
 */
export function parseExperience(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const match = /^(\d+)([ym])$/.exec(trimmed);
  if (match === null) return null;
  const n = Number.parseInt(match[1] ?? "0", 10);
  return match[2] === "y" ? n * 12 : n;
}

async function runSkillsShow(id: string, format: OutputFormat): Promise<void> {
  const commandLabel = "profile skills show";
  const token = await loadTokenOrExit(commandLabel);
  let result: profile.skills.ProfileSkillSet;
  try {
    result = await profile.skills.show(token, id);
  } catch (err) {
    handleSkillsError(err, commandLabel);
  }
  emitResult(result, format, {
    text: formatSkillSetText,
    table: formatSkillSetTable,
  });
}

async function runSkillsList(format: OutputFormat): Promise<void> {
  const commandLabel = "profile skills list";
  const token = await loadTokenOrExit(commandLabel);
  const profileId = await resolveProfileId(token, commandLabel);
  let result: profile.skills.ProfileSkillSet[];
  try {
    result = await profile.skills.list(token, profileId);
  } catch (err) {
    handleSkillsError(err, commandLabel);
  }
  emitResult(result, format, {
    text: formatSkillsListText,
    table: formatSkillsListTable,
    empty: { command: "profile.skills.list" },
  });
}

async function runSkillsAutocomplete(query: string, format: OutputFormat, limit: number): Promise<void> {
  const commandLabel = "profile skills autocomplete";
  const token = await loadTokenOrExit(commandLabel);
  const profileId = await resolveProfileId(token, commandLabel);
  let suggestions: profile.skills.SkillSuggestion[];
  try {
    suggestions = await profile.skills.autocomplete(token, profileId, query, { limit });
  } catch (err) {
    handleSkillsError(err, commandLabel);
  }
  emitResult(suggestions, format, {
    text: (data) =>
      data.length === 0 ? `(no matches for "${query}")` : data.map((s) => `${s.name}\t${s.id}`).join("\n"),
    table: (data) => {
      const table = new Table({ head: ["Name", "Id"], wordWrap: true });
      for (const s of data) table.push([s.name, s.id]);
      return table.toString();
    },
  });
}

async function runSkillsReadiness(format: OutputFormat): Promise<void> {
  const commandLabel = "profile skills readiness";
  const token = await loadTokenOrExit(commandLabel);
  const profileId = await resolveProfileId(token, commandLabel);
  let result: profile.skills.SkillsReadiness;
  try {
    result = await profile.skills.readiness(token, profileId);
  } catch (err) {
    handleSkillsError(err, commandLabel);
  }
  emitResult(result, format, {
    text: (data) =>
      Object.entries(data)
        .map(([k, v]) => `${humanReadiness(k)}: ${v ? "✓" : "✗"}`)
        .join("\n"),
    table: (data) => {
      const table = new Table({ head: ["Criterion", "Satisfied"], wordWrap: true });
      for (const [k, v] of Object.entries(data)) {
        table.push([humanReadiness(k), v ? "true" : "false"]);
      }
      return table.toString();
    },
  });
}

function humanReadiness(key: string): string {
  return key
    .replace(/^is/, "")
    .replace(/Satisfied$/, "")
    .replace(/([A-Z])/g, " $1")
    .trim();
}

// =======================================================================
// Formatters (exported for tests)
// =======================================================================

export function formatSkillSetText(skill: profile.skills.ProfileSkillSet): string {
  const lines: string[] = [skill.skill.name, `  id: ${skill.id}`];
  if (skill.rating !== null) lines.push(`  rating: ${skill.rating}`);
  if (skill.experience !== null) lines.push(`  experience: ${skill.experience.toString()} months`);
  lines.push(`  visibility: ${skill.public ? "public" : "private"}`);
  lines.push(`  connections: ${skill.connectionsCount.toString()}`);
  return lines.join("\n");
}

export function formatSkillSetTable(skill: profile.skills.ProfileSkillSet): string {
  const table = new Table({ head: ["Field", "Value"], wordWrap: true });
  table.push(["name", skill.skill.name]);
  table.push(["id", skill.id]);
  table.push(["rating", skill.rating ?? "(unset)"]);
  table.push(["experience", skill.experience?.toString() ?? "(unset)"]);
  table.push(["visibility", skill.public ? "public" : "private"]);
  table.push(["connections", skill.connectionsCount.toString()]);
  return table.toString();
}

export function formatSkillsListText(skills: profile.skills.ProfileSkillSet[]): string {
  if (skills.length === 0) return "(no skills on profile)";
  return skills
    .map((s) => `${s.skill.name}\t${s.rating ?? "?"}\t${s.public ? "public" : "private"}\t${s.id}`)
    .join("\n");
}

export function formatSkillsListTable(skills: profile.skills.ProfileSkillSet[]): string {
  const table = new Table({ head: ["Name", "Rating", "Experience", "Visibility", "Id"], wordWrap: true });
  for (const s of skills) {
    table.push([
      s.skill.name,
      s.rating ?? "(unset)",
      s.experience?.toString() ?? "(unset)",
      s.public ? "public" : "private",
      s.id,
    ]);
  }
  return table.toString();
}

// =======================================================================
// Builder
// =======================================================================

/**
 * Build the `ttctl profile skills` command tree. Exposes the seven leaves
 * the issue (#73) specifies — `add`, `remove`, `update`, `show`, `list`,
 * `autocomplete`, `readiness` — registered in the canonical name spelling
 * (`remove`) plus the `rm` alias per the project convention introduced
 * by issue #72 (any `remove` verb gets an `rm` alias).
 *
 * No top-level Commander.js alias on the sub-domain itself: the issue
 * doesn't introduce one (#72 declares aliases only for `certifications` /
 * `employment` / `portfolio` / `resume`), and `skills` already reads
 * naturally as a CLI flag.
 */
export function buildProfileSkillsCommand(): Command {
  const skills = new Command("skills").description(
    "Manage the skills section of your profile (add / remove / update / show / list / autocomplete / readiness)",
  );

  skills
    .command("add <name>")
    .description("Add a skill to your profile by its catalog name (e.g., `TypeScript`)")
    .action(async (name: string) => {
      await runSkillsAdd(name);
    });

  skills
    .command("remove <id>")
    .alias("rm")
    .description("Remove a skill from your profile by its skillSet id (NOT the catalog Skill id)")
    .action(async (id: string) => {
      await runSkillsRm(id);
    });

  skills
    .command("update <id>")
    .description("Update one or more fields on an existing skill (rating / experience / public)")
    .option("--rating <value>", "Proficiency level: COMPETENT | STRONG | EXPERT | NOVICE")
    .option(
      "--experience <duration>",
      'Years or months of experience: integer ("60"), "Ny" ("5y" = 60 months), or "Nm" ("60m" = 60 months)',
    )
    .option("--public", "Show the skill on your public profile")
    .option("--private", "Hide the skill from your public profile")
    .action(async (id: string, options: SkillsUpdateOptions) => {
      await runSkillsUpdate(id, options);
    });

  skills
    .command("show <id>")
    .description("Print details of a specific skill on your profile")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runSkillsShow(id, options.output);
    });

  skills
    .command("list")
    .description("List every skill on your profile, with rating / visibility / connection count")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runSkillsList(options.output);
    });

  skills
    .command("autocomplete <query>")
    .description("Search the global skill catalog for matching entries (suitable for autocomplete)")
    .option("--limit <n>", "max number of suggestions to return", "10")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies OutputFormat),
    )
    .action(async (query: string, options: { output: OutputFormat; limit: string }) => {
      const limit = Number.parseInt(options.limit, 10);
      if (Number.isNaN(limit) || limit <= 0) {
        process.stderr.write(
          "profile skills autocomplete failed (VALIDATION_ERROR): --limit must be a positive integer.\n",
        );
        process.exit(1);
      }
      await runSkillsAutocomplete(query, options.output, limit);
    });

  skills
    .command("readiness")
    .description("Print the skill-readiness checklist for your profile")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runSkillsReadiness(options.output);
    });

  return skills;
}
