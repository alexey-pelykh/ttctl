// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { DryRunPreview, WireShapeDiffEntry } from "@ttctl/core";

import { formatYaml } from "./output.js";
import type { OutputFormat } from "./output.js";

export type { WireShapeDiffEntry };

/**
 * Cross-CLI envelope ABI (#128) — discriminated-union wire shape for
 * write-success and error responses, plus the top-level list envelope.
 *
 * The envelope locks the public-API contract for the JSON output:
 * pre-`v1.0` (`0.x`) signals "expect breaking changes"; `v1.0` onward,
 * any JSON shape change is a breaking-change release (semver-major).
 *
 * Discriminators:
 *
 * - `ok: true | false` separates success from error.
 * - `operation: string` (e.g., `"profile.skills.add"`) identifies the
 *   verb so consumers can branch without parsing the command path.
 * - For success: `created` / `updated` / `removed` field name selects
 *   the verb (add / update / remove respectively). Mutually exclusive.
 * - For errors: `errors[]` is ALWAYS plural — even single-error cases
 *   ship a 1-element array so consumers don't branch on 1-vs-N shape.
 *
 * Routing (per `emitErrorAndExit`):
 *
 * - `--output=json` errors → STDOUT (machine consumers read structured
 *   payload regardless of exit code).
 * - `--output=yaml` errors → STDOUT (same reasoning).
 * - `--output=pretty` errors → STDERR human-formatted block; STDOUT
 *   stays clean.
 * - Exit code is nonzero on error in all formats; `0` on success.
 *
 * The version string is hard-coded `"1.0"` here. Bumping to `"1.1"`
 * signals an additive (non-breaking) change; bumping to `"2.0"`
 * signals a breaking change — both are forward-evolution levers
 * consumers may discriminate on.
 */
export const ENVELOPE_VERSION = "1.0" as const;

/**
 * One field-level diff entry for the `update` envelope's optional
 * `changes` array. v0.4 ships the type but does NOT thread `changes`
 * through the helpers — populating the `from` value requires a
 * pre-mutation read or a server-returned old-state shape that the core
 * layer does not surface today. The shape is reserved so adding it in
 * a future release is non-breaking (additive).
 *
 * `from` and `to` are kept as `unknown` because the diff is shallow
 * across heterogeneous field types (numbers, strings, booleans, null);
 * narrowing belongs to the consumer.
 */
export interface EnvelopeChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * One entry in the error envelope's plural `errors[]` array. `code` is
 * a stable machine-readable token (`VALIDATION_ERROR`, `NO_VIEWER`,
 * `CF_403_PERSISTENT`, …). `message` is human-readable. `field`,
 * `hint`, `documentationUrl` are optional — `documentationUrl` is
 * reserved for v1.0+ when the error doc URLs exist; v0.4 omits.
 *
 * `diff?` is the additive slot reserved for `WIRE_SHAPE_ERROR` (Z-3 /
 * #286): each entry is a `WireShapeDiffEntry` per
 * `docs/wire-validation-error-format.md`. Populated only when `code`
 * is `"WIRE_SHAPE_ERROR"`; absent for every other code. Adding this
 * optional field is non-breaking under `ENVELOPE_VERSION = "1.0"`
 * (additive — sibling slot to `documentationUrl?`). The single-valued
 * `field?` slot keeps its meaning for non-wire-shape errors; the two
 * are mutually-exclusive in practice but the wire shape doesn't
 * enforce it.
 */
export interface EnvelopeError {
  code: string;
  field?: string;
  message: string;
  hint?: string;
  documentationUrl?: string;
  diff?: WireShapeDiffEntry[];
}

/**
 * Offset-style pagination metadata block for the top-level list
 * envelope. Activated by #138 (the wiring issue for the reservation
 * #128 introduced).
 *
 * Shape decision (#138 user decision 2026-05-12): the CLI's
 * `--page` / `--per-page` flags are 1-indexed offset-style; the wire
 * across Toptal surfaces is heterogeneous (page-based
 * `eligibleJobs(page, pageSize)`, offset wrapped
 * `gigs(pagination: {limit, offset})`, cursor
 * `payments(pagination: {limit, after})`), but the user-facing
 * envelope normalises to offset-style metadata for predictable
 * scripting.
 *
 * All fields are optional so commands whose wire ops report only a
 * subset (e.g., a cursor-style backend that doesn't expose
 * `totalCount`) can populate the fields they have without padding the
 * rest. A list response with `pageInfo` omitted entirely signals "no
 * pagination metadata available" (e.g., a wire op that returns all
 * entities in one go).
 *
 * Pre-#138 the reservation was cursor-style (`{hasNextPage?,
 * endCursor?}`) — never populated in v0.4. The reshape is
 * forward-evolution under `ENVELOPE_VERSION = "1.0"` (pre-1.0 the
 * envelope explicitly signals "expect breaking changes").
 */
export interface EnvelopePageInfo {
  /** 1-indexed page number the server returned. */
  currentPage?: number;
  /** Items per page the server actually applied. May differ from the
   * client request when the server enforces a cap. */
  perPage?: number;
  /** Total pages, derived from `totalCount / perPage` (rounded up).
   * Omitted when the server doesn't expose `totalCount`. */
  totalPages?: number;
  /** True when at least one more page is available after the current
   * page; false when the current page is the last (or the only) one. */
  hasNextPage?: boolean;
}

/**
 * Discriminated success envelope for `add`. The `created` field carries
 * the full payload of the new entity (or the post-mutation list, for
 * sub-domains where the core API returns the full list — visas /
 * portfolio in v0.4 — until per-domain narrowing lands in a follow-up).
 */
export interface SuccessEnvelopeAdd<T> {
  ok: true;
  version: typeof ENVELOPE_VERSION;
  operation: string;
  created: T;
  notice?: string;
}

/**
 * Discriminated success envelope for `update`. `changes?` is reserved
 * (v0.4 omits — see `EnvelopeChange` doc).
 */
export interface SuccessEnvelopeUpdate<T> {
  ok: true;
  version: typeof ENVELOPE_VERSION;
  operation: string;
  updated: T;
  changes?: EnvelopeChange[];
  notice?: string;
}

/**
 * Discriminated success envelope for `remove`. `removed.id` is the
 * server-issued identifier of the now-deleted entity; the helper
 * derives it from the caller's input so the envelope shape is stable
 * regardless of whether the core API returns void, an id, or a
 * post-mutation list.
 */
export interface SuccessEnvelopeRemove {
  ok: true;
  version: typeof ENVELOPE_VERSION;
  operation: string;
  removed: { id: string };
  notice?: string;
}

/**
 * Error envelope. Always `ok: false`; `errors[]` is ALWAYS plural even
 * for single-error cases.
 */
export interface ErrorEnvelope {
  ok: false;
  version: typeof ENVELOPE_VERSION;
  operation: string;
  errors: EnvelopeError[];
}

/**
 * Top-level list envelope for `list` verbs. The `items` field carries
 * the array; `pageInfo?` carries offset-style pagination metadata when
 * the underlying wire op supplied any (activated in #138). Commands
 * whose wire op has no pagination args still emit `{version, items}`
 * with no `pageInfo` field.
 */
export interface ListEnvelope<T> {
  version: typeof ENVELOPE_VERSION;
  items: T[];
  pageInfo?: EnvelopePageInfo;
}

/**
 * Wrap an array as the v0.4+ list envelope (`{version, items,
 * pageInfo?}`). The `version` field is required (locked at `"1.0"`)
 * so wire consumers can branch on the envelope shape uniformly across
 * success / error / list payloads.
 *
 * When `pageInfo` is supplied (by a paginated command's action
 * handler after threading `--page` / `--per-page` through to the
 * service layer), it's included verbatim. When omitted (by a list
 * command whose wire op has no pagination args, OR when the user
 * passes no flags and the server returns no metadata), the envelope
 * surfaces `{version, items}` only.
 *
 * The empty-state wrapper from #122 (`isEmptyCollection` in
 * `lib/empty-state-cta.ts`) detects both raw `[]` AND `{items: []}` —
 * wrapping list output through this helper keeps the empty-state
 * behavior unchanged on json/yaml.
 *
 * Pure — no I/O.
 */
export function wrapListEnvelope<T>(items: T[], pageInfo?: EnvelopePageInfo): ListEnvelope<T> {
  const env: ListEnvelope<T> = { version: ENVELOPE_VERSION, items };
  if (pageInfo !== undefined) env.pageInfo = pageInfo;
  return env;
}

/**
 * Pretty success-line marker. The visible glyph is a heavy check
 * (`✓`); kept in a constant so tests can assert on it without
 * duplicating Unicode escapes across snapshots.
 */
export const PRETTY_SUCCESS_PREFIX = "✓";

/**
 * Indent every line of `text` by two spaces. Used for the indented
 * entity preview that follows the one-line `prettySummary` in success
 * envelopes' pretty rendering.
 *
 * Pure — directly unit-testable.
 */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/**
 * Stringify the JSON success-add envelope (single-line, no extra
 * whitespace — matches `formatResult` json branch). Exposed for tests.
 */
export function formatAddJson<T>(envelope: SuccessEnvelopeAdd<T>): string {
  return JSON.stringify(envelope);
}

/**
 * Stringify the YAML success-add envelope as block-style YAML via
 * `formatYaml`. Exposed for tests.
 */
export function formatAddYaml<T>(envelope: SuccessEnvelopeAdd<T>): string {
  return formatYaml(envelope);
}

/**
 * Stringify the JSON success-update envelope. Exposed for tests.
 */
export function formatUpdateJson<T>(envelope: SuccessEnvelopeUpdate<T>): string {
  return JSON.stringify(envelope);
}

/**
 * Stringify the YAML success-update envelope. Exposed for tests.
 */
export function formatUpdateYaml<T>(envelope: SuccessEnvelopeUpdate<T>): string {
  return formatYaml(envelope);
}

/**
 * Stringify the JSON success-remove envelope. Exposed for tests.
 */
export function formatRemoveJson(envelope: SuccessEnvelopeRemove): string {
  return JSON.stringify(envelope);
}

/**
 * Stringify the YAML success-remove envelope. Exposed for tests.
 */
export function formatRemoveYaml(envelope: SuccessEnvelopeRemove): string {
  return formatYaml(envelope);
}

/**
 * Stringify the JSON error envelope. Exposed for tests.
 */
export function formatErrorJson(envelope: ErrorEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Stringify the YAML error envelope. Exposed for tests.
 */
export function formatErrorYaml(envelope: ErrorEnvelope): string {
  return formatYaml(envelope);
}

/**
 * Build the pretty-format rendering of a success-add envelope:
 *
 *     ✓ Added: <prettySummary>
 *       <prettyEntity-line-1>
 *       <prettyEntity-line-2>
 *       …
 *
 * `prettyEntity` is OPTIONAL — when omitted the output is just the
 * single-line summary. `notice` (when present) appears on its own
 * trailing line, also indented.
 *
 * Pure — directly unit-testable.
 */
export function formatAddPretty<T>(args: {
  prettySummary: string;
  prettyEntity?: ((entity: T) => string) | undefined;
  entity: T;
  notice?: string | undefined;
}): string {
  const lines: string[] = [`${PRETTY_SUCCESS_PREFIX} Added: ${args.prettySummary}`];
  if (args.prettyEntity !== undefined) {
    lines.push(indent(args.prettyEntity(args.entity)));
  }
  if (args.notice !== undefined) {
    lines.push(indent(`notice: ${args.notice}`));
  }
  return lines.join("\n");
}

/**
 * Build the pretty-format rendering of a success-update envelope.
 * Mirror of `formatAddPretty` with an "Updated:" header. v0.4 does NOT
 * render the `changes` diff (the deep comparison is out of scope per
 * #128 caller context); the field is reserved on the JSON/YAML wire
 * shape only.
 */
export function formatUpdatePretty<T>(args: {
  prettySummary: string;
  prettyEntity?: ((entity: T) => string) | undefined;
  entity: T;
  notice?: string | undefined;
}): string {
  const lines: string[] = [`${PRETTY_SUCCESS_PREFIX} Updated: ${args.prettySummary}`];
  if (args.prettyEntity !== undefined) {
    lines.push(indent(args.prettyEntity(args.entity)));
  }
  if (args.notice !== undefined) {
    lines.push(indent(`notice: ${args.notice}`));
  }
  return lines.join("\n");
}

/**
 * Build the pretty-format rendering of a success-remove envelope:
 *
 *     ✓ Removed: <prettySummary or id>
 *
 * The summary defaults to the bare id when no `prettySummary` is
 * supplied; callers that have the entity name handy (post-fetch) can
 * pass a richer line like `"sk_abc123 (TypeScript)"`.
 */
export function formatRemovePretty(args: {
  id: string;
  prettySummary?: string | undefined;
  notice?: string | undefined;
}): string {
  const summary = args.prettySummary ?? args.id;
  const lines: string[] = [`${PRETTY_SUCCESS_PREFIX} Removed: ${summary}`];
  if (args.notice !== undefined) {
    lines.push(indent(`notice: ${args.notice}`));
  }
  return lines.join("\n");
}

/**
 * Maximum number of diff entries rendered in the pretty form of a
 * `WIRE_SHAPE_ERROR` (per `docs/wire-validation-error-format.md`
 * § `-o pretty`). The JSON / YAML wire shapes carry the full list;
 * only the human-readable rendering caps to keep terminal output
 * scannable. When the diff exceeds the cap, a `… and <K> more` line
 * tells the operator where to look for the full data.
 */
export const WIRE_SHAPE_DIFF_PRETTY_CAP = 10;

/**
 * Render a single {@link WireShapeDiffEntry} as the one-line form used
 * inside the `Diff (schema vs wire):` block (per
 * `docs/wire-validation-error-format.md` § `-o pretty`). Examples:
 *
 *     ~ records[0].duration: expected number, got string ("480")
 *     - records[1].notes: expected string, got undefined
 *     + records[0].surprise: unexpected wire field (unknown)
 *
 * The `value?` slot is rendered inline parenthesised with surrounding
 * double quotes for string values — matching the spec's `("480")`
 * formatting. Non-string values are rendered verbatim (already
 * stringified upstream by `renderValue` in `wire-shape.ts`).
 */
function formatWireShapeDiffEntry(entry: WireShapeDiffEntry): string {
  if (entry.op === "+") {
    return `+ ${entry.path}: unexpected wire field (${entry.actual})`;
  }
  if (entry.op === "-") {
    return `- ${entry.path}: expected ${entry.expected}, got ${entry.actual}`;
  }
  // op === "~"
  if (entry.value === undefined) {
    return `~ ${entry.path}: expected ${entry.expected}, got ${entry.actual}`;
  }
  return `~ ${entry.path}: expected ${entry.expected}, got ${entry.actual} ("${entry.value}")`;
}

/**
 * Build the pretty-format rendering of an error envelope. Each error
 * surfaces as its own block; `field` and `hint` annotate the message
 * when present.
 *
 *     Error: <message-1>
 *       (Code: <code-1>)
 *       (Field: <field-1>)
 *       Diff (schema vs wire):
 *         <op> <path>: expected <expected>, got <actual> [("<value>")]
 *         …
 *       Hint: <hint-1>
 *
 *     Error: <message-2>
 *       …
 *
 * The format is symmetric with `formatTtctlErrorMessage` from
 * `errors.ts` (used for the typed-hierarchy `TtctlError` block) — same
 * `Error: …` prefix, same parenthesised metadata. The recovery line
 * from `TtctlError` does not have a generic equivalent here; callers
 * convert to `hint` if a recovery sentence is available.
 *
 * `WIRE_SHAPE_ERROR` (Z-3 / #286) carries a `diff` field — when
 * present, the pretty form renders a `Diff (schema vs wire):` block
 * before the `Hint:` footer per
 * `docs/wire-validation-error-format.md` § `-o pretty`. Capped at
 * {@link WIRE_SHAPE_DIFF_PRETTY_CAP} entries; overflow renders a
 * `… and <K> more …` line pointing at `-o json` for the full diff.
 */
export function formatErrorPretty(envelope: ErrorEnvelope): string {
  const blocks = envelope.errors.map((err) => {
    const lines: string[] = [`Error: ${err.message}`];
    lines.push(`  (Code: ${err.code})`);
    if (err.field !== undefined) {
      lines.push(`  (Field: ${err.field})`);
    }
    if (err.diff !== undefined && err.diff.length > 0) {
      lines.push(`  Diff (schema vs wire):`);
      const head = err.diff.slice(0, WIRE_SHAPE_DIFF_PRETTY_CAP);
      for (const entry of head) {
        lines.push(`    ${formatWireShapeDiffEntry(entry)}`);
      }
      const overflow = err.diff.length - head.length;
      if (overflow > 0) {
        lines.push(`    … and ${overflow.toString()} more (see -o json for the full diff).`);
      }
    }
    if (err.hint !== undefined) {
      lines.push(`  Hint: ${err.hint}`);
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/**
 * One-line stderr summary for the pretty error path. The AC requires
 * a "one-line stderr summary" alongside the multi-line block — when
 * stdout is structured (json/yaml) the summary is omitted because the
 * structured payload IS the summary.
 *
 * Defaults to `Error: <first-error.message>` when the caller does not
 * pass an explicit summary. Useful when piping the multi-line block
 * elsewhere but still wanting a glance-readable single line on the
 * terminal.
 */
export function defaultPrettyErrorSummary(envelope: ErrorEnvelope): string {
  const first = envelope.errors[0];
  if (first === undefined) {
    return "Error: (no error details supplied)";
  }
  return `Error: ${first.message}`;
}

/**
 * Build the success-add envelope object (pure — no I/O). Shape:
 * `{ok: true, version: "1.0", operation, created, notice?}`. Exposed
 * separately from `emitAddSuccess` so callers (and tests) can inspect
 * the structured shape without going through stdout.
 */
export function buildAddEnvelope<T>(args: {
  operation: string;
  created: T;
  notice?: string | undefined;
}): SuccessEnvelopeAdd<T> {
  const env: SuccessEnvelopeAdd<T> = {
    ok: true,
    version: ENVELOPE_VERSION,
    operation: args.operation,
    created: args.created,
  };
  if (args.notice !== undefined) env.notice = args.notice;
  return env;
}

/**
 * Build the success-update envelope object (pure — no I/O). Shape:
 * `{ok: true, version: "1.0", operation, updated, changes?, notice?}`.
 *
 * `changes` is reserved (see `EnvelopeChange` doc). Callers do not
 * thread it through in v0.4; the parameter is preserved for future
 * extension without an API churn.
 */
export function buildUpdateEnvelope<T>(args: {
  operation: string;
  updated: T;
  changes?: EnvelopeChange[] | undefined;
  notice?: string | undefined;
}): SuccessEnvelopeUpdate<T> {
  const env: SuccessEnvelopeUpdate<T> = {
    ok: true,
    version: ENVELOPE_VERSION,
    operation: args.operation,
    updated: args.updated,
  };
  if (args.changes !== undefined) env.changes = args.changes;
  if (args.notice !== undefined) env.notice = args.notice;
  return env;
}

/**
 * Build the success-remove envelope object (pure — no I/O). Shape:
 * `{ok: true, version: "1.0", operation, removed: {id}, notice?}`.
 */
export function buildRemoveEnvelope(args: {
  operation: string;
  id: string;
  notice?: string | undefined;
}): SuccessEnvelopeRemove {
  const env: SuccessEnvelopeRemove = {
    ok: true,
    version: ENVELOPE_VERSION,
    operation: args.operation,
    removed: { id: args.id },
  };
  if (args.notice !== undefined) env.notice = args.notice;
  return env;
}

/**
 * Build the error envelope object (pure — no I/O). Shape:
 * `{ok: false, version: "1.0", operation, errors[]}`. `errors` is
 * normalised to a plural array even for single-error inputs so the
 * wire shape is stable.
 */
export function buildErrorEnvelope(args: { operation: string; errors: EnvelopeError[] }): ErrorEnvelope {
  return {
    ok: false,
    version: ENVELOPE_VERSION,
    operation: args.operation,
    errors: args.errors,
  };
}

/**
 * Side-effecting emitter for the `add` success envelope. Writes the
 * per-format payload to stdout with a trailing newline; never throws.
 *
 * - `json` → single-line JSON envelope on stdout
 * - `yaml` → block-style YAML envelope on stdout
 * - `pretty` → `✓ Added: <summary>` + indented `prettyEntity?` on stdout
 *
 * The success path always exits 0 (the helper does not call
 * `process.exit` — leaves it to the caller / Node's natural exit).
 */
export function emitAddSuccess<T>(args: {
  operation: string;
  format: OutputFormat;
  created: T;
  prettySummary: string;
  prettyEntity?: ((entity: T) => string) | undefined;
  notice?: string | undefined;
}): void {
  const envelope = buildAddEnvelope({
    operation: args.operation,
    created: args.created,
    notice: args.notice,
  });
  const payload = renderSuccessAdd(envelope, args.format, {
    prettySummary: args.prettySummary,
    prettyEntity: args.prettyEntity,
  });
  process.stdout.write(`${payload}\n`);
}

function renderSuccessAdd<T>(
  envelope: SuccessEnvelopeAdd<T>,
  format: OutputFormat,
  prettyArgs: { prettySummary: string; prettyEntity?: ((entity: T) => string) | undefined },
): string {
  if (format === "json") return formatAddJson(envelope);
  if (format === "yaml") return formatAddYaml(envelope);
  return formatAddPretty({
    prettySummary: prettyArgs.prettySummary,
    prettyEntity: prettyArgs.prettyEntity,
    entity: envelope.created,
    notice: envelope.notice,
  });
}

/**
 * Side-effecting emitter for the `update` success envelope. Mirror of
 * `emitAddSuccess` for the update verb.
 */
export function emitUpdateSuccess<T>(args: {
  operation: string;
  format: OutputFormat;
  updated: T;
  prettySummary: string;
  prettyEntity?: ((entity: T) => string) | undefined;
  changes?: EnvelopeChange[] | undefined;
  notice?: string | undefined;
}): void {
  const envelope = buildUpdateEnvelope({
    operation: args.operation,
    updated: args.updated,
    changes: args.changes,
    notice: args.notice,
  });
  const payload = renderSuccessUpdate(envelope, args.format, {
    prettySummary: args.prettySummary,
    prettyEntity: args.prettyEntity,
  });
  process.stdout.write(`${payload}\n`);
}

function renderSuccessUpdate<T>(
  envelope: SuccessEnvelopeUpdate<T>,
  format: OutputFormat,
  prettyArgs: { prettySummary: string; prettyEntity?: ((entity: T) => string) | undefined },
): string {
  if (format === "json") return formatUpdateJson(envelope);
  if (format === "yaml") return formatUpdateYaml(envelope);
  return formatUpdatePretty({
    prettySummary: prettyArgs.prettySummary,
    prettyEntity: prettyArgs.prettyEntity,
    entity: envelope.updated,
    notice: envelope.notice,
  });
}

/**
 * Side-effecting emitter for the `remove` success envelope. The id is
 * the server-issued identifier of the now-deleted entity (the caller
 * already knows it from the input or from the API response).
 */
export function emitRemoveSuccess(args: {
  operation: string;
  format: OutputFormat;
  id: string;
  prettySummary?: string | undefined;
  notice?: string | undefined;
}): void {
  const envelope = buildRemoveEnvelope({
    operation: args.operation,
    id: args.id,
    notice: args.notice,
  });
  const payload = renderSuccessRemove(envelope, args.format, args.prettySummary);
  process.stdout.write(`${payload}\n`);
}

function renderSuccessRemove(
  envelope: SuccessEnvelopeRemove,
  format: OutputFormat,
  prettySummary: string | undefined,
): string {
  if (format === "json") return formatRemoveJson(envelope);
  if (format === "yaml") return formatRemoveYaml(envelope);
  return formatRemovePretty({
    id: envelope.removed.id,
    prettySummary,
    notice: envelope.notice,
  });
}

/**
 * Discriminated success envelope for `--dry-run` (issue #52). Mirrors
 * the wire shape of {@link SuccessEnvelopeUpdate} (`ok: true, version,
 * operation, …`) plus a `dryRun: true` discriminator and a `preview`
 * field carrying the structured "would-have-sent" payload from the
 * core layer's {@link DryRunPreview}.
 *
 * Why a separate envelope variant rather than reusing
 * `SuccessEnvelopeUpdate`: dry-run is fundamentally a "no-op confirmed"
 * outcome — there is NO updated entity, only a preview of the request
 * that WOULD have updated one. Reusing the update envelope would force
 * `updated: ...` to carry a fake/empty value that downstream consumers
 * could mistake for a real result. The `dryRun: true` discriminator
 * makes the no-effect semantics legible at the JSON layer.
 *
 * Wire shape: `{ ok, version, operation, dryRun: true, preview: { … } }`
 * where the `preview` body matches the AC (#52 § Output format under
 * --dry-run): `{ operation, variables, transport, surface, headers }`
 * with secrets redacted.
 */
export interface SuccessEnvelopeDryRun {
  ok: true;
  version: typeof ENVELOPE_VERSION;
  operation: string;
  dryRun: true;
  preview: DryRunPreview;
  notice?: string;
}

/**
 * Build the dry-run success envelope object (pure — no I/O). Shape:
 * `{ok: true, version: "1.0", operation, dryRun: true, preview, notice?}`.
 *
 * Exposed separately from {@link emitDryRunSuccess} so callers (and
 * tests) can inspect the structured shape without going through stdout.
 */
export function buildDryRunEnvelope(args: {
  operation: string;
  preview: DryRunPreview;
  notice?: string | undefined;
}): SuccessEnvelopeDryRun {
  const env: SuccessEnvelopeDryRun = {
    ok: true,
    version: ENVELOPE_VERSION,
    operation: args.operation,
    dryRun: true,
    preview: args.preview,
  };
  if (args.notice !== undefined) env.notice = args.notice;
  return env;
}

/**
 * Stringify the JSON dry-run envelope (single-line, no extra whitespace
 * — matches `formatResult` json branch). Exposed for tests.
 */
export function formatDryRunJson(envelope: SuccessEnvelopeDryRun): string {
  return JSON.stringify(envelope);
}

/**
 * Stringify the YAML dry-run envelope as block-style YAML via
 * `formatYaml`. Exposed for tests.
 */
export function formatDryRunYaml(envelope: SuccessEnvelopeDryRun): string {
  return formatYaml(envelope);
}

/**
 * Build the pretty-format rendering of a dry-run envelope:
 *
 *     ✓ Dry run: would call `<operationName>` (no changes sent)
 *       surface:    <surface> (<transport>)
 *       endpoint:   <endpoint>
 *       variables:
 *         <pretty-printed-JSON, 2-space indented>
 *       headers:
 *         authorization: Token token=<redacted>
 *         <other-header>: <value>
 *         …
 *
 * Pure — directly unit-testable. The output is human-friendly: the
 * variables block uses `JSON.stringify(_, null, 2)` to give a readable
 * multi-line shape, while headers list one-per-line so the redacted
 * `authorization` is obvious at a glance.
 */
export function formatDryRunPretty(envelope: SuccessEnvelopeDryRun): string {
  const { preview } = envelope;
  const lines: string[] = [
    `${PRETTY_SUCCESS_PREFIX} Dry run: would call \`${preview.operationName}\` (no changes sent)`,
    indent(`surface:    ${preview.surface} (${preview.transport})`),
    indent(`endpoint:   ${preview.endpoint}`),
    indent(`variables:`),
  ];
  const variablesJson = JSON.stringify(preview.variables, null, 2);
  for (const line of variablesJson.split("\n")) {
    // 4-space indent (2 base + 2 nest) so the JSON body is visibly
    // grouped under the `variables:` header.
    lines.push(`    ${line}`);
  }
  lines.push(indent("headers:"));
  // Sort headers for stable pretty rendering — JSON.stringify preserves
  // insertion order, but sort here so the human view doesn't depend on
  // the order COMMON_HEADERS keys were defined in. The `authorization`
  // line surfaces under "a" naturally; redaction is visible without
  // prejudice across sort orders.
  for (const key of Object.keys(preview.headers).sort()) {
    lines.push(`    ${key}: ${preview.headers[key] ?? ""}`);
  }
  if (envelope.notice !== undefined) {
    lines.push(indent(`notice: ${envelope.notice}`));
  }
  return lines.join("\n");
}

/**
 * Side-effecting emitter for the dry-run success envelope. Mirrors
 * {@link emitUpdateSuccess} for the dry-run variant — writes the
 * per-format payload to stdout with a trailing newline; never throws.
 *
 * - `json` → single-line JSON envelope on stdout
 * - `yaml` → block-style YAML envelope on stdout
 * - `pretty` → multi-line `✓ Dry run: …` block on stdout
 *
 * The success path always exits 0 (helper does not call `process.exit`
 * — leaves it to the caller / Node's natural exit). This matches the
 * AC: a well-formed dry-run preview exits 0 regardless of whether the
 * apply-path WOULD have errored at the server level.
 */
export function emitDryRunSuccess(args: {
  operation: string;
  format: OutputFormat;
  preview: DryRunPreview;
  notice?: string | undefined;
}): void {
  const envelope = buildDryRunEnvelope({
    operation: args.operation,
    preview: args.preview,
    notice: args.notice,
  });
  const payload = renderDryRun(envelope, args.format);
  process.stdout.write(`${payload}\n`);
}

function renderDryRun(envelope: SuccessEnvelopeDryRun, format: OutputFormat): string {
  if (format === "json") return formatDryRunJson(envelope);
  if (format === "yaml") return formatDryRunYaml(envelope);
  return formatDryRunPretty(envelope);
}

/**
 * Side-effecting error emitter. Routes per format and exits the
 * process — never returns.
 *
 * Routing:
 *
 * - `json` / `yaml`: the structured envelope is written to STDOUT (so
 *   `jq`/`yq` consumers see structured payload regardless of exit
 *   code). The exit code is nonzero (default `1`).
 * - `pretty`: a one-line stderr summary is written FIRST, then the
 *   multi-line human block (also on stderr). STDOUT stays clean.
 *
 * Exit code defaults to `1`; callers can pass a different value (e.g.
 * `2` for transport-level Cloudflare blocks, mirroring
 * `exitCodeForTtctlError`).
 */
export function emitErrorAndExit(args: {
  operation: string;
  format: OutputFormat;
  errors: EnvelopeError[];
  prettySummary?: string | undefined;
  exitCode?: number;
}): never {
  const envelope = buildErrorEnvelope({
    operation: args.operation,
    errors: args.errors,
  });
  const code = args.exitCode ?? 1;
  if (args.format === "json") {
    process.stdout.write(`${formatErrorJson(envelope)}\n`);
  } else if (args.format === "yaml") {
    process.stdout.write(`${formatErrorYaml(envelope)}\n`);
  } else {
    const summary = args.prettySummary ?? defaultPrettyErrorSummary(envelope);
    process.stderr.write(`${summary}\n`);
    process.stderr.write(`${formatErrorPretty(envelope)}\n`);
  }
  process.exit(code);
}
