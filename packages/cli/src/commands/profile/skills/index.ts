// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import Table from "cli-table3";
import { Command, Option } from "commander";
import { TtctlError, profile } from "@ttctl/core";

import { presentTtctlError } from "../../../errors.js";
import { getCliDryRun, markMutation } from "../../../lib/dry-run.js";
import {
  emitAddSuccess,
  emitDryRunSuccess,
  emitErrorAndExit,
  emitRemoveSuccess,
  emitUpdateSuccess,
  wrapListEnvelope,
} from "../../../lib/envelopes.js";
import type { EnvelopeError } from "../../../lib/envelopes.js";
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
async function resolveProfileId(token: string, commandLabel: string, format: OutputFormat): Promise<string> {
  let payload;
  try {
    payload = await profile.basic.show(token);
  } catch (err) {
    handleSkillsError(err, commandLabel, format);
  }
  const profileId = payload.viewer?.viewerRole.profileId;
  if (profileId === undefined) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [{ code: "NO_VIEWER", message: "No profile id bound to this session." }],
      prettySummary: `${commandLabel} failed (NO_VIEWER): no profile id bound to this session.`,
    });
  }
  return profileId;
}

/**
 * Translate the command label (`profile skills add`) into the canonical
 * envelope `operation` value (`profile.skills.add`) used as a stable
 * machine-readable discriminator across all envelopes for this
 * sub-domain.
 */
function operationFor(commandLabel: string): string {
  return commandLabel.replace(/ /g, ".");
}

/**
 * Common error router. Routes every typed-hierarchy domain error
 * through the envelope ABI (#128) — `--output=json` / `--output=yaml`
 * land on STDOUT; `--output=pretty` lands on STDERR with a one-line
 * summary plus the multi-line block. Exit code is `1` for domain
 * errors and follows `exitCodeForTtctlError` for `TtctlError`
 * subclasses (`Cf403*` map to `2`).
 */
function handleSkillsError(err: unknown, commandLabel: string, format: OutputFormat): never {
  if (err instanceof TtctlError) {
    // The TtctlError pretty rendering keeps its dedicated 3-block
    // shape (Recovery, Code) on `pretty`; on `json`/`yaml` we route
    // through the envelope so machine consumers still see the stable
    // wire shape.
    if (format === "pretty") presentTtctlError(err);
    const errors: EnvelopeError[] = [{ code: err.code, message: err.message, hint: err.recovery }];
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors,
      exitCode: err.code === "CF_403_CLEARANCE" || err.code === "CF_403_PERSISTENT" ? 2 : 1,
    });
  }
  if (err instanceof profile.skills.SkillsError) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${commandLabel} failed (${err.code}): ${err.message}`,
    });
  }
  if (err instanceof profile.basic.ProfileError) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [{ code: err.code, message: err.message }],
      prettySummary: `${commandLabel} failed (${err.code}): ${err.message}`,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  emitErrorAndExit({
    operation: operationFor(commandLabel),
    format,
    errors: [{ code: "INTERNAL_ERROR", message }],
    prettySummary: `${commandLabel} failed: ${message}`,
  });
}

// =======================================================================
// Action handlers (one per leaf)
// =======================================================================

interface SkillsAddOptions {
  rating?: profile.skills.ProficiencyRating;
  experience?: string;
  public?: boolean;
  private?: boolean;
  skillId?: string;
  output: OutputFormat;
}

async function runSkillsAdd(name: string, options: SkillsAddOptions): Promise<void> {
  const commandLabel = "profile skills add";
  const format = options.output;

  if (options.public === true && options.private === true) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "--public and --private cannot both be set.",
        },
      ],
      prettySummary: `${commandLabel} failed (VALIDATION_ERROR): --public and --private cannot both be set.`,
    });
  }

  const fields: profile.skills.AddSkillFields = { name };
  if (options.rating !== undefined) fields.rating = options.rating;
  if (options.experience !== undefined) {
    const experience = parseExperience(options.experience);
    if (experience === null) {
      emitErrorAndExit({
        operation: operationFor(commandLabel),
        format,
        errors: [
          {
            code: "VALIDATION_ERROR",
            field: "experience",
            message: '--experience must be an integer count of months or a duration like "5y" or "60m".',
          },
        ],
        prettySummary: `${commandLabel} failed (VALIDATION_ERROR): --experience must be an integer count of months or a duration like "5y" or "60m".`,
      });
    }
    fields.experience = experience;
  }
  if (options.public === true) fields.public = true;
  if (options.private === true) fields.public = false;
  if (options.skillId !== undefined) fields.skillId = options.skillId;

  const token = await loadTokenOrExit(commandLabel, format);
  const dryRun = getCliDryRun();

  let outcome: profile.skills.AddSkillOutcome;
  try {
    outcome = await profile.skills.add(token, fields, { dryRun });
  } catch (err) {
    handleSkillsError(err, commandLabel, format);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: operationFor(commandLabel),
      format,
      preview: outcome.preview,
    });
    return;
  }

  const { result } = outcome;
  emitAddSuccess({
    operation: operationFor(commandLabel),
    format,
    created: result,
    prettySummary: `${result.skill.name} (id ${result.id})`,
    prettyEntity: formatSkillSetText,
  });
}

async function runSkillsRm(id: string, format: OutputFormat): Promise<void> {
  const commandLabel = "profile skills remove";
  const token = await loadTokenOrExit(commandLabel, format);
  try {
    await profile.skills.rm(token, id);
  } catch (err) {
    handleSkillsError(err, commandLabel, format);
  }
  emitRemoveSuccess({
    operation: operationFor(commandLabel),
    format,
    id,
  });
}

interface SkillsAddConnectionOptions {
  skillSetId?: string;
  connectionType?: profile.skills.SkillConnectionType;
  connectionId?: string;
  consentProfileCapability?: boolean;
  output: OutputFormat;
}

/**
 * Action handler for `ttctl profile skills add-connection`. Links an
 * existing `ProfileSkillSet` to a single employment / education /
 * certification / portfolio row via `addProfileSkillSetConnection`. Wire
 * input is the captured 2-field `{ skillSetId, connectionId }`; the
 * `--connection-type` flag is a client-side UX guard cross-checked
 * against the connectionId Relay prefix.
 *
 * **Consent gate** (ADR-009 (ttctl) — `profile-capability` domain): the
 * caller MUST pass `--consent-profile-capability` (or set
 * `TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1` for non-interactive contexts).
 * Absence raises `ConsentRequiredError("CONSENT_REQUIRED")` at the
 * service layer.
 */
async function runSkillsAddConnection(options: SkillsAddConnectionOptions): Promise<void> {
  const commandLabel = "profile skills add-connection";
  const format = options.output;

  // Defense-in-depth alongside commander's `.requiredOption` /
  // `.makeOptionMandatory` — catches whitespace-only values that pass
  // commander's presence check, and narrows each option via
  // `emitErrorAndExit`'s `never` return type for the downstream call.
  const skillSetId = options.skillSetId?.trim();
  if (skillSetId === undefined || skillSetId.length === 0) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [{ code: "VALIDATION_ERROR", message: "Missing required flag: --skill-set-id." }],
      prettySummary: `${commandLabel} failed (VALIDATION_ERROR): missing --skill-set-id.`,
    });
  }
  const connectionType = options.connectionType;
  if (connectionType === undefined) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [{ code: "VALIDATION_ERROR", message: "Missing required flag: --connection-type." }],
      prettySummary: `${commandLabel} failed (VALIDATION_ERROR): missing --connection-type.`,
    });
  }
  const connectionId = options.connectionId?.trim();
  if (connectionId === undefined || connectionId.length === 0) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [{ code: "VALIDATION_ERROR", message: "Missing required flag: --connection-id." }],
      prettySummary: `${commandLabel} failed (VALIDATION_ERROR): missing --connection-id.`,
    });
  }

  if (!profile.skills.SKILL_CONNECTION_TYPES.includes(connectionType)) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [
        {
          code: "VALIDATION_ERROR",
          field: "connectionType",
          message: `--connection-type must be one of: ${profile.skills.SKILL_CONNECTION_TYPES.join(", ")}.`,
        },
      ],
      prettySummary: `${commandLabel} failed (VALIDATION_ERROR): --connection-type must be one of: ${profile.skills.SKILL_CONNECTION_TYPES.join(", ")}.`,
    });
  }

  const token = await loadTokenOrExit(commandLabel, format);
  const dryRun = getCliDryRun();

  // Static type only allows `true` literal; the runtime gate at the
  // service entry covers the `false` case (operator omits the flag).
  const consent = {
    profileCapabilityConsentIssued: options.consentProfileCapability ?? false,
  } as unknown as profile.skills.AddSkillConnectionConsent;

  let outcome: profile.skills.AddSkillConnectionOutcome;
  try {
    outcome = await profile.skills.addConnection(token, { skillSetId, connectionType, connectionId }, consent, {
      dryRun,
    });
  } catch (err) {
    handleSkillsError(err, commandLabel, format);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: operationFor(commandLabel),
      format,
      preview: outcome.preview,
    });
    return;
  }

  const { result } = outcome;
  emitUpdateSuccess({
    operation: operationFor(commandLabel),
    format,
    updated: result,
    prettySummary: `Linked skillSet ${result.skillSetId} to ${connectionType} ${connectionId} (${result.connectionsCount.toString()} connection${result.connectionsCount === 1 ? "" : "s"} total).`,
    notice: result.notice ?? undefined,
  });
}

interface SkillsRemoveConnectionOptions {
  skillSetId?: string;
  connectionId?: string;
  consentProfileCapability?: boolean;
  output: OutputFormat;
}

async function runSkillsRemoveConnection(options: SkillsRemoveConnectionOptions): Promise<void> {
  const commandLabel = "profile skills remove-connection";
  const format = options.output;

  const skillSetId = options.skillSetId?.trim();
  if (skillSetId === undefined || skillSetId.length === 0) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [{ code: "VALIDATION_ERROR", message: "Missing required flag: --skill-set-id." }],
      prettySummary: `${commandLabel} failed (VALIDATION_ERROR): missing --skill-set-id.`,
    });
  }
  const connectionId = options.connectionId?.trim();
  if (connectionId === undefined || connectionId.length === 0) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [{ code: "VALIDATION_ERROR", message: "Missing required flag: --connection-id." }],
      prettySummary: `${commandLabel} failed (VALIDATION_ERROR): missing --connection-id.`,
    });
  }

  const token = await loadTokenOrExit(commandLabel, format);
  const dryRun = getCliDryRun();

  const consent = {
    profileCapabilityConsentIssued: options.consentProfileCapability ?? false,
  } as unknown as profile.skills.RemoveSkillConnectionConsent;

  let outcome: profile.skills.RemoveSkillConnectionOutcome;
  try {
    outcome = await profile.skills.removeConnection(token, { skillSetId, connectionId }, consent, { dryRun });
  } catch (err) {
    handleSkillsError(err, commandLabel, format);
  }

  if (outcome.kind === "preview") {
    emitDryRunSuccess({
      operation: operationFor(commandLabel),
      format,
      preview: outcome.preview,
    });
    return;
  }

  const { result } = outcome;
  emitUpdateSuccess({
    operation: operationFor(commandLabel),
    format,
    updated: result,
    prettySummary: `Unlinked connection ${connectionId} from skillSet ${result.skillSetId} (${result.connectionsCount.toString()} connection${result.connectionsCount === 1 ? "" : "s"} remaining).`,
    notice: result.notice ?? undefined,
  });
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
async function runSkillsUpdate(id: string, options: SkillsUpdateOptions, format: OutputFormat): Promise<void> {
  const commandLabel = "profile skills update";

  if (options.public === true && options.private === true) {
    emitErrorAndExit({
      operation: operationFor(commandLabel),
      format,
      errors: [
        {
          code: "VALIDATION_ERROR",
          message: "--public and --private cannot both be set.",
        },
      ],
      prettySummary: `${commandLabel} failed (VALIDATION_ERROR): --public and --private cannot both be set.`,
    });
  }

  const fields: profile.skills.SkillUpdate = {};
  if (options.rating !== undefined) {
    fields.rating = options.rating;
  }
  if (options.experience !== undefined) {
    const months = parseExperience(options.experience);
    if (months === null) {
      emitErrorAndExit({
        operation: operationFor(commandLabel),
        format,
        errors: [
          {
            code: "VALIDATION_ERROR",
            field: "experience",
            message: '--experience must be an integer count of months or a duration like "5y" or "60m".',
          },
        ],
        prettySummary: `${commandLabel} failed (VALIDATION_ERROR): --experience must be an integer count of months or a duration like "5y" or "60m".`,
      });
    }
    fields.experience = months;
  }
  if (options.public === true) fields.public = true;
  if (options.private === true) fields.public = false;

  const token = await loadTokenOrExit(commandLabel, format);
  let result: profile.skills.UpdateSkillResult;
  try {
    result = await profile.skills.set(token, id, fields);
  } catch (err) {
    handleSkillsError(err, commandLabel, format);
  }

  // First server-supplied notice (when present) threads into the
  // envelope's optional `notice` field; subsequent notices are
  // concatenated for v0.4 (the field is `string`, not `string[]` —
  // narrowing to a list is reserved for a future shape evolution).
  const notice = result.notices.length > 0 ? result.notices.join("; ") : undefined;
  emitUpdateSuccess({
    operation: operationFor(commandLabel),
    format,
    updated: result,
    prettySummary: `skill ${id}`,
    prettyEntity: formatSkillUpdateResult,
    notice,
  });
}

/**
 * Pretty entity preview for the `update` envelope's body. Shows only
 * the fields that the user actually changed (non-null in the
 * `UpdateSkillResult`); preserves parity with the prior raw stdout
 * line-by-line rendering.
 */
function formatSkillUpdateResult(result: profile.skills.UpdateSkillResult): string {
  const lines: string[] = [];
  if (result.rating !== null) lines.push(`rating: ${result.rating}`);
  if (result.experience !== null) lines.push(`experience: ${result.experience.toString()} months`);
  if (result.public !== null) lines.push(`visibility: ${result.public ? "public" : "private"}`);
  return lines.join("\n");
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
  const token = await loadTokenOrExit(commandLabel, format);
  let result: profile.skills.ProfileSkillSet;
  try {
    result = await profile.skills.show(token, id);
  } catch (err) {
    handleSkillsError(err, commandLabel, format);
  }
  emitResult(result, format, {
    pretty: formatSkillSetText,
    table: formatSkillSetTable,
  });
}

async function runSkillsList(format: OutputFormat): Promise<void> {
  const commandLabel = "profile skills list";
  const token = await loadTokenOrExit(commandLabel, format);
  const profileId = await resolveProfileId(token, commandLabel, format);
  let result: profile.skills.ProfileSkillSet[];
  try {
    result = await profile.skills.list(token, profileId);
  } catch (err) {
    handleSkillsError(err, commandLabel, format);
  }
  emitResult(wrapListEnvelope(result), format, {
    pretty: (data) => formatSkillsListText(data.items),
    table: (data) => formatSkillsListTable(data.items),
    empty: { command: "profile.skills.list" },
  });
}

async function runSkillsAutocomplete(query: string, format: OutputFormat, limit: number): Promise<void> {
  const commandLabel = "profile skills autocomplete";
  const token = await loadTokenOrExit(commandLabel, format);
  const profileId = await resolveProfileId(token, commandLabel, format);
  let suggestions: profile.skills.SkillSuggestion[];
  try {
    suggestions = await profile.skills.autocomplete(token, profileId, query, { limit });
  } catch (err) {
    handleSkillsError(err, commandLabel, format);
  }
  emitResult(wrapListEnvelope(suggestions), format, {
    pretty: (data) =>
      data.items.length === 0 ? `(no matches for "${query}")` : data.items.map((s) => `${s.name}\t${s.id}`).join("\n"),
    table: (data) => {
      const table = new Table({ head: ["Name", "Id"], wordWrap: true });
      for (const s of data.items) table.push([s.name, s.id]);
      return table.toString();
    },
  });
}

async function runSkillsReadiness(format: OutputFormat): Promise<void> {
  const commandLabel = "profile skills readiness";
  const token = await loadTokenOrExit(commandLabel, format);
  const profileId = await resolveProfileId(token, commandLabel, format);
  let result: profile.skills.SkillsReadiness;
  try {
    result = await profile.skills.readiness(token, profileId);
  } catch (err) {
    handleSkillsError(err, commandLabel, format);
  }
  emitResult(result, format, {
    pretty: (data) =>
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

  markMutation(
    skills
      .command("add <name>")
      .description(
        "Add a skill to your profile. By default `name` auto-resolves against the catalog: a single exact match (case-insensitive) binds to that catalog Skill; ≥2 exact duplicates surface a `--skill-id` disambiguation error; no exact match falls back to creating a custom (non-catalog) skill. Pass `--skill-id` to override resolution. Defaults applied when omitted: rating=COMPETENT, experience=1, --private.",
      )
      .option("--rating <value>", "Proficiency level (one of: COMPETENT, STRONG, EXPERT). Defaults to COMPETENT.")
      .option(
        "--experience <duration>",
        'Experience: integer ("60"), "Ny" ("5y" = 60 months), or "Nm" ("60m" = 60 months). Defaults to 1.',
      )
      .option("--public", "Show the skill on your public profile (defaults to private)")
      .option("--private", "Hide the skill from your public profile (default)")
      .option(
        "--skill-id <id>",
        "Catalog Skill id (e.g., V1-Skill-NNN) to bind explicitly, bypassing name-based auto-resolution",
      )
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (name: string, options: SkillsAddOptions) => {
        await runSkillsAdd(name, options);
      }),
  );

  skills
    .command("remove <id>")
    .alias("rm")
    .description("Remove a skill from your profile by its skillSet id (NOT the catalog Skill id)")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: { output: OutputFormat }) => {
      await runSkillsRm(id, options.output);
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
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (id: string, options: SkillsUpdateOptions & { output: OutputFormat }) => {
      await runSkillsUpdate(id, options, options.output);
    });

  skills
    .command("show <id>")
    .description("Print details of a specific skill on your profile")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
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
        .default("pretty" satisfies OutputFormat),
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
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (query: string, options: { output: OutputFormat; limit: string }) => {
      const limit = Number.parseInt(options.limit, 10);
      if (Number.isNaN(limit) || limit <= 0) {
        emitErrorAndExit({
          operation: "profile.skills.autocomplete",
          format: options.output,
          errors: [
            {
              code: "VALIDATION_ERROR",
              field: "limit",
              message: "--limit must be a positive integer.",
            },
          ],
          prettySummary: "profile skills autocomplete failed (VALIDATION_ERROR): --limit must be a positive integer.",
        });
      }
      await runSkillsAutocomplete(query, options.output, limit);
    });

  skills
    .command("readiness")
    .description("Print the skill-readiness checklist for your profile")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("pretty" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runSkillsReadiness(options.output);
    });

  markMutation(
    skills
      .command("add-connection")
      .description(
        "Link an existing ProfileSkillSet to one of your employment, education, certification, or portfolio rows. Requires --consent-profile-capability per ADR-009 (ttctl). Use `profile skills list` and `profile {employment,education,certifications,portfolio} list` to discover the ids.",
      )
      .requiredOption(
        "--skill-set-id <id>",
        "ProfileSkillSet id (V1-ProfileSkillSet-NNN) — get via `profile skills list`",
      )
      .addOption(
        new Option(
          "--connection-type <type>",
          "Target row class (one of: EMPLOYMENT, EDUCATION, PORTFOLIO_ITEM, CERTIFICATION)",
        )
          .choices([...profile.skills.SKILL_CONNECTION_TYPES])
          .makeOptionMandatory(),
      )
      .requiredOption(
        "--connection-id <id>",
        "Target row id — V1-Employment-NNN / V1-Education-NNN / V1-Certification-NNN / V1-PortfolioItem-NNN",
      )
      .option(
        "--consent-profile-capability",
        "REQUIRED — acknowledge that this writes a recruiter-visible skill→entity link to your public profile (ADR-009 (ttctl) profile-capability domain)",
      )
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (options: SkillsAddConnectionOptions) => {
        await runSkillsAddConnection(options);
      }),
  );

  markMutation(
    skills
      .command("remove-connection")
      .description(
        "Unlink a single connection from a ProfileSkillSet — per-edge sibling of `add-connection` (#463). Wire input is CAPTURED (`research/captures/web/inputs/RemoveProfileSkillSetConnectionInput.json`); no --connection-type flag — the server discriminates the target from the Relay id. Requires --consent-profile-capability per ADR-009 (ttctl). Discover the connection id via `profile skills show <skillSetId>`.",
      )
      .requiredOption(
        "--skill-set-id <id>",
        "ProfileSkillSet id (V1-ProfileSkillSet-NNN) — get via `profile skills list`",
      )
      .requiredOption(
        "--connection-id <id>",
        "Connection node id currently linked to the skill-set — V1-Employment-NNN / V1-Education-NNN / V1-Certification-NNN / V1-PortfolioItem-NNN. Get via `profile skills show <skillSetId>`.",
      )
      .option(
        "--consent-profile-capability",
        "REQUIRED — acknowledge that this removes a recruiter-visible skill→entity link from your public profile (ADR-009 (ttctl) profile-capability domain)",
      )
      .addOption(
        new Option("-o, --output <format>", "output format")
          .choices(OUTPUT_FORMATS)
          .default("pretty" satisfies OutputFormat),
      )
      .action(async (options: SkillsRemoveConnectionOptions) => {
        await runSkillsRemoveConnection(options);
      }),
  );

  return skills;
}
