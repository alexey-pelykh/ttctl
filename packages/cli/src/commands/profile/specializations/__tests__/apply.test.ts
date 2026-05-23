// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @ttctl/core so the `instanceof` checks in apply.ts and the
// shared error router resolve against THESE constructors (vi.mock
// replaces the imports). Tracks the real shape from
// `packages/core/src/services/profile/specializations/index.ts` plus
// the cross-cutting `TtctlError` / `ConsentRequiredError` from
// `packages/core/src/consent.ts`.
vi.mock("@ttctl/core", () => {
  class ProfileError extends Error {
    override readonly name = "ProfileError";
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  class TtctlError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly recovery: string,
    ) {
      super(message);
    }
  }
  class ConsentRequiredError extends TtctlError {
    override readonly name = "ConsentRequiredError";
    constructor(opName: string, domain: string, message: string) {
      super(message, "CONSENT_REQUIRED", `Pass --consent-${domain} or set TTCTL_ALLOW_INFERRED_DESTRUCTIVE=1.`);
      this.opName = opName;
      this.domain = domain;
    }
    readonly opName: string;
    readonly domain: string;
  }
  const apply = vi.fn();
  return {
    TtctlError,
    profile: {
      specializations: {
        ProfileError,
        apply,
      },
    },
    // Cross-cutting consent error — exported from core's root.
    ConsentRequiredError,
  };
});

vi.mock("../../../../lib/config-context.js", () => ({
  resolveConfigForCli: vi.fn(() => ({
    config: { auth: { token: "tok-test-123" } },
    path: "/fake/.ttctl.yaml",
  })),
}));

vi.mock("../../../../lib/dry-run.js", () => ({
  getCliDryRun: vi.fn(() => false),
}));

import { profile } from "@ttctl/core";

import { getCliDryRun } from "../../../../lib/dry-run.js";
import { runProfileSpecializationsApply } from "../apply.js";

const mockedApply = vi.mocked(profile.specializations.apply);
const mockedGetCliDryRun = vi.mocked(getCliDryRun);

const SPEC_ID = "spec-marketplace-uuid";

const APPLIED_FIXTURE = {
  kind: "applied" as const,
  result: {
    specializationId: SPEC_ID,
    notice: "Application submitted.",
  },
};

const DRY_RUN_PREVIEW_FIXTURE = {
  kind: "preview" as const,
  preview: {
    operationName: "ApplyForSpecialization",
    transport: "stock" as const,
    surface: "mobile-gateway" as const,
    endpoint: "https://www.toptal.com/gateway/graphql/talent/graphql",
    headers: { authorization: "Token token=<redacted>" },
    variables: { specializationId: SPEC_ID },
  },
};

class ExitInvoked extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code.toString()})`);
  }
}

function captureExit(): { exit: { code: number } | null } {
  const captured = { exit: null as { code: number } | null };
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.exit = { code: code ?? 0 };
    throw new ExitInvoked(code ?? 0);
  }) as never);
  return captured;
}

function captureStreams(): { stdout: string[]; stderr: string[] } {
  const captured = { stdout: [] as string[], stderr: [] as string[] };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    captured.stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return captured;
}

beforeEach(() => {
  mockedApply.mockReset();
  mockedGetCliDryRun.mockReset();
  mockedApply.mockResolvedValue(APPLIED_FIXTURE);
  mockedGetCliDryRun.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- Happy path: consent + apply succeeds ----------

describe("runProfileSpecializationsApply: happy path with --consent-profile-capability (#467)", () => {
  it("forwards token, specializationId, consent literal, and dryRun=false to profile.specializations.apply()", async () => {
    captureExit();
    captureStreams();
    await runProfileSpecializationsApply(SPEC_ID, { consentProfileCapability: true, output: "json" });

    expect(mockedApply).toHaveBeenCalledTimes(1);
    const [token, specId, consent, options] = mockedApply.mock.calls[0] ?? [];
    expect(token).toBe("tok-test-123");
    expect(specId).toBe(SPEC_ID);
    expect(consent).toEqual({ profileCapabilityConsentIssued: true });
    expect(options).toEqual({ dryRun: false });
  });

  it("emits the applied envelope on stdout (json) with the echoed specializationId + notice", async () => {
    captureExit();
    const streams = captureStreams();
    await runProfileSpecializationsApply(SPEC_ID, { consentProfileCapability: true, output: "json" });

    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      operation: string;
      updated: { specializationId: string; notice: string | null };
      notice?: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.operation).toBe("profile.specializations.apply");
    expect(parsed.updated.specializationId).toBe(SPEC_ID);
    expect(parsed.updated.notice).toBe("Application submitted.");
  });

  it("pretty output names the specialization that was applied to", async () => {
    captureExit();
    const streams = captureStreams();
    await runProfileSpecializationsApply(SPEC_ID, { consentProfileCapability: true, output: "pretty" });

    const stdout = streams.stdout.join("");
    expect(stdout).toContain(SPEC_ID);
    expect(stdout.toLowerCase()).toContain("applied");
  });
});

// ---------- Missing --consent-profile-capability: refuse, no wire call ----------

describe("runProfileSpecializationsApply: consent gate (#467 / ADR-009 profile-capability)", () => {
  it("forwards profileCapabilityConsentIssued=false (defense-in-depth) — service layer surfaces ConsentRequiredError", async () => {
    captureExit();
    captureStreams();

    // Service rejects with ConsentRequiredError when consent is false
    // — mirror that here so the CLI handler renders the error envelope.
    const { ConsentRequiredError } = (await import("@ttctl/core")) as unknown as {
      ConsentRequiredError: new (op: string, domain: string, message: string) => Error;
    };
    mockedApply.mockRejectedValueOnce(
      new ConsentRequiredError("ApplyForSpecialization", "profile-capability", "consent required"),
    );

    await expect(
      runProfileSpecializationsApply(SPEC_ID, {
        output: "json",
        // consentProfileCapability intentionally omitted
      }),
    ).rejects.toBeInstanceOf(ExitInvoked);

    // CLI threaded the omitted flag as `false` so the service can
    // reject deterministically.
    expect(mockedApply).toHaveBeenCalledTimes(1);
    const [, , consent] = mockedApply.mock.calls[0] ?? [];
    expect((consent as { profileCapabilityConsentIssued: boolean }).profileCapabilityConsentIssued).toBe(false);
  });

  it("renders CONSENT_REQUIRED envelope on stdout with the recovery hint", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    const { ConsentRequiredError } = (await import("@ttctl/core")) as unknown as {
      ConsentRequiredError: new (op: string, domain: string, message: string) => Error;
    };
    mockedApply.mockRejectedValueOnce(
      new ConsentRequiredError(
        "ApplyForSpecialization",
        "profile-capability",
        "ApplyForSpecialization requires explicit consent.",
      ),
    );

    await expect(runProfileSpecializationsApply(SPEC_ID, { output: "json" })).rejects.toBeInstanceOf(ExitInvoked);

    expect(exit.exit?.code).toBe(1);
    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      operation: string;
      errors: { code: string; message: string; hint?: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.operation).toBe("profile.specializations.apply");
    expect(parsed.errors[0]?.code).toBe("CONSENT_REQUIRED");
    expect(parsed.errors[0]?.hint?.toLowerCase()).toContain("consent");
  });
});

// ---------- --dry-run: preview without wire call ----------

describe("runProfileSpecializationsApply: --dry-run preview (#467 / #52)", () => {
  it("forwards dryRun=true to profile.specializations.apply() when global flag is set", async () => {
    captureExit();
    captureStreams();
    mockedGetCliDryRun.mockReturnValue(true);
    mockedApply.mockResolvedValue(DRY_RUN_PREVIEW_FIXTURE);

    await runProfileSpecializationsApply(SPEC_ID, { consentProfileCapability: true, output: "json" });

    expect(mockedApply).toHaveBeenCalledTimes(1);
    const [, , , options] = mockedApply.mock.calls[0] ?? [];
    expect((options as { dryRun: boolean }).dryRun).toBe(true);
  });

  it("emits the dryRun envelope on stdout with operationName + variables + redacted bearer", async () => {
    captureExit();
    const streams = captureStreams();
    mockedGetCliDryRun.mockReturnValue(true);
    mockedApply.mockResolvedValue(DRY_RUN_PREVIEW_FIXTURE);

    await runProfileSpecializationsApply(SPEC_ID, { consentProfileCapability: true, output: "json" });

    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      dryRun: boolean;
      operation: string;
      preview: {
        operationName: string;
        surface: string;
        variables: { specializationId: string };
        headers: { authorization: string };
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.operation).toBe("profile.specializations.apply");
    expect(parsed.preview.operationName).toBe("ApplyForSpecialization");
    expect(parsed.preview.surface).toBe("mobile-gateway");
    expect(parsed.preview.variables.specializationId).toBe(SPEC_ID);
    expect(parsed.preview.headers.authorization).toBe("Token token=<redacted>");
  });
});

// ---------- Service-layer error surfaces ----------

describe("runProfileSpecializationsApply: service-layer error mapping (#467)", () => {
  it("renders USER_ERROR envelope when the wire rejects (e.g. already-applied track)", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    mockedApply.mockRejectedValueOnce(
      new profile.specializations.ProfileError(
        "USER_ERROR",
        "ApplyForSpecialization rejected (already_applied): Already a member of this specialization.",
      ),
    );

    await expect(
      runProfileSpecializationsApply(SPEC_ID, { consentProfileCapability: true, output: "json" }),
    ).rejects.toBeInstanceOf(ExitInvoked);
    expect(exit.exit?.code).toBe(1);

    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as { ok: boolean; errors: { code: string; message: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.code).toBe("USER_ERROR");
    expect(parsed.errors[0]?.message).toContain("already_applied");
  });

  it("renders VALIDATION_ERROR envelope on empty specializationId (defense-in-depth at the service)", async () => {
    const exit = captureExit();
    const streams = captureStreams();
    mockedApply.mockRejectedValueOnce(
      new profile.specializations.ProfileError(
        "VALIDATION_ERROR",
        "ApplyForSpecialization requires a non-empty specializationId.",
      ),
    );

    await expect(
      runProfileSpecializationsApply("", { consentProfileCapability: true, output: "json" }),
    ).rejects.toBeInstanceOf(ExitInvoked);
    expect(exit.exit?.code).toBe(1);

    const stdout = streams.stdout.join("");
    const parsed = JSON.parse(stdout) as { ok: boolean; errors: { code: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]?.code).toBe("VALIDATION_ERROR");
  });
});
