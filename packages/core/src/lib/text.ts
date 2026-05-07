// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Split a multi-paragraph string on blank lines into an array of trimmed
 * paragraphs (drops empties). Mirrors the wire shape used by sub-domains
 * whose mutation inputs accept paragraph arrays (e.g. `experienceItems`
 * on `UpdateEmploymentInput` per
 * `research/captures/web/inputs/UpdateEmploymentInput.json`).
 *
 * Pure — no I/O — so it's directly unit-testable.
 *
 * @param text - source string with paragraphs separated by blank lines
 * @returns array of trimmed paragraphs (empty paragraphs dropped)
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
