# Profile rendering fixtures

Reusable in-memory fixtures for unit-testing CLI / MCP formatters and
`@ttctl/core` services that render profile-domain lists. Pure
TypeScript — no I/O, no network, no codegen dependency. Every builder
returns a fresh object on each call so test mutation in one suite cannot
leak into another.

## Aggregate type

`ProfileFixture` bundles every per-domain entity list under one shape:

```ts
interface ProfileFixture {
  skills: ProfileSkillSet[];
  portfolio: PortfolioItem[];
  employment: Employment[];
  education: Education[];
  certifications: Certification[];
  industries: IndustryProfile[];
  visas: TravelVisa[];
}
```

The aggregate exists only so test code can write `fx.skills`, `fx.portfolio`
etc. ergonomically — production code does not have a `Profile` aggregate
(each sub-domain returns its own list). Each member is the production
entity type verbatim, re-exported from this module so test files can pull
both fixtures and types from one path.

## Builder API

### `buildEmptyProfile()`

Every per-domain list resolves to `[]`. Drives the empty-state rendering
tests across the formatter suite (`(no skills)`, the empty-state wrapper
from issue #122, etc.).

### `buildSingleItemList(name, overrides?)`

Populates exactly one item in the named list, with every other list
empty. The item is shallow-merged from the canonical seed for `name`
with the caller-supplied `overrides`. Drives single-row rendering tests
where table format must not look ridiculous for a 1-row collection.

`name` is one of `'skills' | 'portfolio' | 'employment' | 'education' |
'certifications' | 'industries' | 'visas'`. `overrides` is a `Partial<T>`
where `T` is the element type for `name` — TypeScript narrows it
automatically.

### `buildParagraphBearingList()`

Populates `portfolio` with three items, each carrying a multi-sentence
`description` (200-400 chars) plus an `accomplishment` line. Drives
paragraph-bearing list rendering tests where table truncation must not
destroy prose content (per parent epic #121).

**Naming note**: the source issue (#125) referenced a `reviews` list, but
the production `reviews` domain (`profile.reviews`) is the admin
section-review queue (`SectionReview`) with no prose body. The
paragraph-bearing entities in production are `PortfolioItem.description`,
`PortfolioItem.accomplishment`, and `Employment.experienceItems`. This
builder uses `portfolio` because it is the canonical paragraph-per-row
shape for list-format rendering.

### `buildFullProfile()`

Maximally-populated fixture — every list carries every sample item with
every optional field set to a realistic, non-null value. Drives the
"complete profile" rendering tests where formatters must show every
column populated (no `(unset)` placeholders).

### `buildMinimalProfile()`

Every list carries one entity with only the production type's required
(non-nullable) fields populated; every nullable / optional field is set
to `null`. Drives `(unset)` rendering tests where formatters must
collapse missing optional fields cleanly.

## Usage

```ts
import { buildEmptyProfile, buildSingleItemList } from "../fixtures/profile";

// Empty-state rendering test
const empty = buildEmptyProfile();
expect(formatPortfolioText(empty.portfolio)).toBe("(no portfolio items)");

// Single-row table test with field override
const oneSkill = buildSingleItemList("skills", { rating: "COMPETENT" });
expect(oneSkill.skills).toHaveLength(1);
expect(oneSkill.skills[0]?.rating).toBe("COMPETENT");
```

## Customizing shape-fixed builders

`buildSingleItemList` accepts inline `overrides` because that's where
field-level customization makes the most sense. The other builders are
shape-fixed (their entire purpose is the shape, e.g., "every list
empty"). To customize them, either:

1. **Mutate the returned fixture** — every builder returns a fresh
   object on every call, so post-call mutation is safe:

   ```ts
   const fx = buildFullProfile();
   fx.portfolio[0]!.title = "Custom title";
   ```

2. **Compose from the named seeds** — `data.ts` exports every sample
   entity (`SKILL_TYPESCRIPT`, `PORTFOLIO_DISTRIBUTED_LEDGER`, …) so
   tests can assemble bespoke fixtures:

   ```ts
   import { SKILL_TYPESCRIPT } from "../fixtures/profile/data";
   import { buildEmptyProfile } from "../fixtures/profile";

   const fx = buildEmptyProfile();
   fx.skills = [{ ...SKILL_TYPESCRIPT, rating: "COMPETENT" }];
   ```

## Conventions

- **No PII** — every URL points at the IANA-reserved `example.com`
  test domain; every company / institution name is a fictitious
  placeholder (`Acme Financial`, `Mercury Health`, `Test Institution`).
  The fixture entities don't carry email or person-name fields directly.
- **Deterministic dates** — every date is a fixed ISO 8601 string or
  integer year/month. No `new Date()`. Snapshot diffs stay clean across
  CI hosts.
- **Predictable IDs** — `<entity>_test_<NNN>` (e.g., `sk_test_001`,
  `port_test_002`). Snapshot diffs read cleanly.
- **Realistic shape** — senior-developer persona (TypeScript / PostgreSQL
  / Kubernetes stack, fintech / healthtech industries) so column-width
  rendering exercises real-world string lengths instead of toy data.
