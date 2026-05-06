// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

import type { ProfileShowQuery, UpdateProfileResult } from "@ttctl/core";
import { describe, expect, it } from "vitest";

import { buildProfileCommand, formatProfile, formatUpdateResult } from "../commands/profile.js";

const PROFILE: ProfileShowQuery = {
  viewer: {
    __typename: "Viewer",
    id: "v1",
    viewerRole: {
      __typename: "ViewerRole",
      email: "ada@example.com",
      firstName: "Ada",
      fullName: "Ada Lovelace",
      phoneNumber: "+1 555 0001",
      allocatedHours: 40,
      hiredHours: 30,
      photo: { __typename: "Photo", large: "https://cdn/large.jpg", small: "https://cdn/small.jpg" },
      profile: {
        __typename: "Profile",
        id: "p1",
        fullName: "Ada Lovelace",
        city: "London",
        photo: { __typename: "ProfilePhotoType", large: "https://cdn/p-large.jpg" },
        skillSets: {
          __typename: "ProfileSkillSetConnection",
          nodes: [
            {
              __typename: "ProfileSkillSet",
              id: "s1",
              experience: 12,
              rating: "EXPERT",
              public: true,
              skill: { __typename: "Skill", id: "sk1", name: "Analytical Engine" },
            },
            {
              __typename: "ProfileSkillSet",
              id: "s2",
              experience: 5,
              rating: "PROFICIENT",
              public: true,
              skill: { __typename: "Skill", id: "sk2", name: "Difference Engine" },
            },
            {
              __typename: "ProfileSkillSet",
              id: "s3",
              experience: 3,
              rating: "BEGINNER",
              public: false,
              skill: { __typename: "Skill", id: "sk3", name: "Mechanical Computing" },
            },
          ],
        },
      },
    },
  },
};

const PROFILE_NO_VIEWER: ProfileShowQuery = { viewer: null };

describe("formatProfile (text)", () => {
  it("renders a multi-line summary with name, email, city, availability, and public skills", () => {
    const out = formatProfile(PROFILE, "text");
    const lines = out.split("\n");

    expect(lines[0]).toBe("Ada Lovelace");
    expect(lines).toContain("  ada@example.com");
    expect(lines).toContain("  London");
    expect(lines).toContain("  Availability: 30/40h (hired/allocated)");
    expect(lines.find((l) => l.includes("Skills:"))).toBe("  Skills: Analytical Engine, Difference Engine");
  });

  it("does NOT include private (public=false) skills in the text summary", () => {
    const out = formatProfile(PROFILE, "text");
    expect(out).not.toContain("Mechanical Computing");
  });

  it("trims every line to at most 80 columns (AC: readable on an 80-column terminal)", () => {
    const out = formatProfile(PROFILE, "text");
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("truncates over-wide lines with an ellipsis", () => {
    const longSkill = "x".repeat(200);
    const wide: ProfileShowQuery = structuredClone(PROFILE);
    if (wide.viewer !== null) {
      wide.viewer.viewerRole.profile.skillSets.nodes = [
        {
          __typename: "ProfileSkillSet",
          id: "s1",
          experience: 1,
          rating: "EXPERT",
          public: true,
          skill: { __typename: "Skill", id: "sk1", name: longSkill },
        },
      ];
    }

    const out = formatProfile(wide, "text");
    const skillLine = out.split("\n").find((l) => l.includes("Skills:"));
    expect(skillLine).toBeDefined();
    expect(skillLine?.length).toBeLessThanOrEqual(80);
    expect(skillLine?.endsWith("…")).toBe(true);
  });

  it("omits the city line when the profile has no city set (empty string)", () => {
    const noCity: ProfileShowQuery = structuredClone(PROFILE);
    if (noCity.viewer !== null) noCity.viewer.viewerRole.profile.city = "";

    const out = formatProfile(noCity, "text");
    expect(out).not.toContain("  London");
    expect(out).not.toMatch(/^\s+\s*$/m);
  });

  it("omits the skills line when there are no public skills", () => {
    const noSkills: ProfileShowQuery = structuredClone(PROFILE);
    if (noSkills.viewer !== null) {
      noSkills.viewer.viewerRole.profile.skillSets.nodes = [];
    }

    const out = formatProfile(noSkills, "text");
    expect(out).not.toContain("Skills:");
  });

  it("falls back to a placeholder line when the viewer is null", () => {
    const out = formatProfile(PROFILE_NO_VIEWER, "text");
    expect(out).toContain("(no viewer bound to this session)");
  });
});

describe("formatProfile (json)", () => {
  it("returns the raw typed payload as pretty-printed JSON (AC: -o json returns raw)", () => {
    const out = formatProfile(PROFILE, "json");
    const parsed: unknown = JSON.parse(out);
    expect(parsed).toEqual(PROFILE);
  });

  it("does not apply human-readable formatting to the json branch", () => {
    const out = formatProfile(PROFILE, "json");
    expect(out).not.toContain("Availability:");
    expect(out).not.toContain("Skills:");
  });

  it("emits valid JSON when the viewer is null", () => {
    const out = formatProfile(PROFILE_NO_VIEWER, "json");
    expect(JSON.parse(out)).toEqual({ viewer: null });
  });
});

describe("formatProfile (table)", () => {
  it("emits one `key\\tvalue` row per field, suitable for shell pipes", () => {
    const out = formatProfile(PROFILE, "table");
    const rows = out.split("\n").map((r) => r.split("\t"));
    const map = new Map(rows.map(([k, v]) => [k, v]));

    expect(map.get("name")).toBe("Ada Lovelace");
    expect(map.get("email")).toBe("ada@example.com");
    expect(map.get("city")).toBe("London");
    expect(map.get("allocated_hours")).toBe("40");
    expect(map.get("hired_hours")).toBe("30");
    expect(map.get("availability")).toBe("30/40h");
    expect(map.get("skills")).toBe("Analytical Engine,Difference Engine");
  });

  it("falls back to a single `name\\t(no viewer)` row when the viewer is null", () => {
    const out = formatProfile(PROFILE_NO_VIEWER, "table");
    expect(out).toBe("name\t(no viewer)");
  });

  it("uses `(unset)` placeholder for empty city in table mode", () => {
    const noCity: ProfileShowQuery = structuredClone(PROFILE);
    if (noCity.viewer !== null) noCity.viewer.viewerRole.profile.city = "";

    const out = formatProfile(noCity, "table");
    const rows = out.split("\n").map((r) => r.split("\t"));
    const map = new Map(rows.map(([k, v]) => [k, v]));
    expect(map.get("city")).toBe("(unset)");
  });
});

describe("buildProfileCommand", () => {
  it("registers a `show` subcommand with -o, --output option", () => {
    const cmd = buildProfileCommand();
    const show = cmd.commands.find((c) => c.name() === "show");

    expect(show).toBeDefined();
    expect(show?.description()).toMatch(/profile/i);
    const outputOption = show?.options.find((o) => o.long === "--output");
    expect(outputOption).toBeDefined();
    expect(outputOption?.short).toBe("-o");
  });

  it("limits --output choices to text|json|table and defaults to text", () => {
    const cmd = buildProfileCommand();
    const show = cmd.commands.find((c) => c.name() === "show");
    const outputOption = show?.options.find((o) => o.long === "--output");

    expect(outputOption?.argChoices).toEqual(["text", "json", "table"]);
    expect(outputOption?.defaultValue).toBe("text");
  });

  it("rejects unknown output formats", () => {
    const cmd = buildProfileCommand();
    cmd.exitOverride();
    expect(() => {
      cmd.parse(["show", "-o", "yaml"], { from: "user" });
    }).toThrow();
  });

  it("registers an `update` subcommand alongside `show`", () => {
    const cmd = buildProfileCommand();
    const update = cmd.commands.find((c) => c.name() === "update");
    expect(update).toBeDefined();
    expect(update?.description()).toMatch(/update/i);
  });

  it("registers --bio, --headline, and -o on `update`", () => {
    const cmd = buildProfileCommand();
    const update = cmd.commands.find((c) => c.name() === "update");

    const bioOption = update?.options.find((o) => o.long === "--bio");
    const headlineOption = update?.options.find((o) => o.long === "--headline");
    const outputOption = update?.options.find((o) => o.long === "--output");

    expect(bioOption).toBeDefined();
    expect(headlineOption).toBeDefined();
    expect(outputOption).toBeDefined();
    expect(outputOption?.argChoices).toEqual(["text", "json", "table"]);
  });

  it("parses --bio and --headline values from argv into the action options", () => {
    const cmd = buildProfileCommand();
    cmd.exitOverride();

    let captured: { bio?: string; headline?: string; output?: string } = {};
    const update = cmd.commands.find((c) => c.name() === "update");
    update?.action(async (opts: { bio?: string; headline?: string; output: string }) => {
      captured = opts;
      return Promise.resolve();
    });

    cmd.parse(["update", "--bio", "test bio", "--headline", "test headline"], { from: "user" });

    expect(captured.bio).toBe("test bio");
    expect(captured.headline).toBe("test headline");
  });
});

const UPDATED: UpdateProfileResult = {
  profile: {
    id: "p1",
    about: "a brand new bio",
    quote: "shorter, sharper, smarter",
  },
  notice: null,
};

describe("formatUpdateResult (text)", () => {
  it("leads with a `Profile updated.` confirmation line", () => {
    const out = formatUpdateResult(UPDATED, "text");
    expect(out.split("\n")[0]).toBe("Profile updated.");
  });

  it("echoes back the new bio and headline using the user-facing flag names", () => {
    const out = formatUpdateResult(UPDATED, "text");
    expect(out).toContain("bio: a brand new bio");
    expect(out).toContain("headline: shorter, sharper, smarter");
  });

  it("omits unchanged-side lines when the server does not return them", () => {
    const partial: UpdateProfileResult = {
      profile: { id: "p1", about: "only bio", quote: null },
      notice: null,
    };
    const out = formatUpdateResult(partial, "text");
    expect(out).toContain("bio: only bio");
    expect(out).not.toContain("headline:");
  });

  it("trims every line to 80 columns (long-bio truncation must end with ellipsis)", () => {
    const longBio = "x".repeat(200);
    const wide: UpdateProfileResult = {
      profile: { id: "p1", about: longBio, quote: null },
      notice: null,
    };
    const out = formatUpdateResult(wide, "text");
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    const bioLine = out.split("\n").find((l) => l.includes("bio:"));
    expect(bioLine?.endsWith("…")).toBe(true);
  });

  it("includes the server-returned notice on its own indented line when present", () => {
    const withNotice: UpdateProfileResult = {
      profile: { id: "p1", about: "x", quote: null },
      notice: "Profile review may be required for some changes",
    };
    const out = formatUpdateResult(withNotice, "text");
    expect(out).toContain("Profile review may be required");
  });
});

describe("formatUpdateResult (json)", () => {
  it("returns the raw typed payload as pretty-printed JSON", () => {
    const out = formatUpdateResult(UPDATED, "json");
    const parsed: unknown = JSON.parse(out);
    expect(parsed).toEqual(UPDATED);
  });

  it("does not apply human-readable formatting to the json branch", () => {
    const out = formatUpdateResult(UPDATED, "json");
    expect(out).not.toContain("Profile updated.");
  });
});

describe("formatUpdateResult (table)", () => {
  it("emits a `status\\tupdated` row plus one row per echoed field", () => {
    const out = formatUpdateResult(UPDATED, "table");
    const rows = out.split("\n").map((r) => r.split("\t"));
    const map = new Map(rows.map(([k, v]) => [k, v]));

    expect(map.get("status")).toBe("updated");
    expect(map.get("bio")).toBe("a brand new bio");
    expect(map.get("headline")).toBe("shorter, sharper, smarter");
  });

  it("uses an empty string for a null `quote` (table mode is shell-pipe friendly)", () => {
    const partial: UpdateProfileResult = {
      profile: { id: "p1", about: "only bio", quote: null },
      notice: null,
    };
    const out = formatUpdateResult(partial, "table");
    const rows = out.split("\n").map((r) => r.split("\t"));
    const map = new Map(rows.map(([k, v]) => [k, v]));
    expect(map.get("headline")).toBe("");
  });

  it("includes a `notice` row when the server returns one", () => {
    const withNotice: UpdateProfileResult = {
      profile: { id: "p1", about: "x", quote: null },
      notice: "Profile review may be required",
    };
    const out = formatUpdateResult(withNotice, "table");
    const rows = out.split("\n").map((r) => r.split("\t"));
    const map = new Map(rows.map(([k, v]) => [k, v]));
    expect(map.get("notice")).toBe("Profile review may be required");
  });
});
