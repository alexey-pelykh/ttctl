// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { Command, Option } from "commander";

import { OUTPUT_FORMATS } from "../../../lib/output.js";
import type { OutputFormat } from "../../../lib/output.js";
import { runProfileResumeCancelUpload } from "./cancel-upload.js";
import { runProfileResumeUpload } from "./upload.js";

/**
 * Build the `ttctl profile resume` command tree.
 *
 * The canonical sub-domain name is `resume`; the CLI registers `cv` as a
 * Commander.js alias (Commonwealth English). Per project policy (#72),
 * aliases are CLI-only — MCP tool names use ONLY the canonical name
 * (e.g. `ttctl_profile_resume_upload`).
 *
 * Operations: `upload <file>`, `cancel-upload`. The cancel command is a
 * one-shot to clear in-flight upload state on the server (e.g., when a
 * partial upload from another client is stuck).
 */
export function buildProfileResumeCommand(): Command {
  const resume = new Command("resume").alias("cv").description("View and update the resume section of your profile");

  resume
    .command("upload")
    .description("Upload a resume file (PDF or DOCX)")
    .argument("<file>", "path to the resume file")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies OutputFormat),
    )
    .action(async (file: string, options: { output: OutputFormat }) => {
      await runProfileResumeUpload(file, options.output);
    });

  resume
    .command("cancel-upload")
    .description("Cancel any in-flight resume upload, clearing half-uploaded server state")
    .addOption(
      new Option("-o, --output <format>", "output format")
        .choices(OUTPUT_FORMATS)
        .default("text" satisfies OutputFormat),
    )
    .action(async (options: { output: OutputFormat }) => {
      await runProfileResumeCancelUpload(options.output);
    });

  return resume;
}
