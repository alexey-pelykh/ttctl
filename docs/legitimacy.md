<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Oleksii PELYKH
-->

# Project Legitimacy

This page collects, in one place, TTCtl's posture on the questions that
come up when someone unfamiliar with the project lands on it: what it is,
why the Toptal name appears here, whether using it conflicts with
Toptal's Terms of Service, and what the maintainer considers in-scope
versus out-of-scope. The goal is plain disclosure rather than legal
argumentation; the operational use policy lives in the
[README](../README.md#%EF%B8%8F-unofficial--personal-use-only) and
[SECURITY.md](../SECURITY.md).

## 1. What TTCtl is

TTCtl is a personal-productivity CLI and MCP server that lets a Toptal
talent interact with **their own** Toptal Talent profile data using the
session they already have as a logged-in user. It reads and updates one
person's profile — the same data that user can see when they open
`talent.toptal.com` in a browser. It is not a multi-tenant service, not
a hosted product, and not connected to anyone's profile other than the
operator's own.

## 2. Trademark use is nominative fair use

The word "Toptal" appears in this project's name (TTCtl), description,
and documentation. That use is **nominative fair use** under established
trademark doctrine, which permits using a mark to identify the trademark
owner's product where (a) the product cannot be readily identified
without using the mark, (b) only as much of the mark is used as
reasonably necessary, and (c) nothing suggests sponsorship or
endorsement. TTCtl uses the word "Toptal" only to identify which
platform the operator's session belongs to. It does not display Toptal's
logo, color palette, or branded design assets, and it states its
independence on every surface that mentions Toptal (README, SECURITY.md,
package metadata, source-file headers). Architectural decisions about
how the session is authenticated (ADR-002 / ADR-005, private
`ttctl/research` repo) and how mutations are gated for safety (ADR-003)
record that TTCtl consumes Toptal's interface from the outside rather
than embedding or redistributing any Toptal property.

## 3. No Terms-of-Service violation

TTCtl is designed to stay inside the envelope of what an individual
Toptal talent does manually through the official web and mobile
interfaces:

- The operator authenticates with **their own** credentials. No
  third-party impersonation, no shared account, no harvested session.
- The session interacts with **the operator's own** profile data. No
  scraping of other talents, recruiters, or clients.
- Surfaces that would enable mass automation — bulk-application
  submission, engagement-signal manipulation, recruiter enumeration,
  parallelism on rate-limited endpoints — are deliberately not
  exposed. PDR-004 (surface-safety boundary, private `ttctl/research`
  repo) records which surfaces are in-scope and which are off-limits,
  and architectural friction in the codebase (sequential rate limits,
  single-credential design, no batch parallelism on automation-prone
  endpoints) enforces that boundary at the code layer rather than
  relying on policy alone.

In short: anything TTCtl does, a single Toptal talent could do by hand
in their own browser. The tool reduces keystrokes, not Toptal's rate
limits.

## 4. Not a competing service

TTCtl is licensed under [AGPL-3.0-only](../LICENSE). The license choice
is recorded in ADR-003 (private `ttctl/research` repo) as part of the
project's safety posture: the strong copyleft term makes it impractical
for anyone to take TTCtl and operate it as a hosted multi-tenant
service without releasing their modifications under the same license. The project is structured for
single-user fair use, not as the seed of a commercial platform that
would compete with Toptal. There is no SaaS offering, no managed-service
tier, and no plan to operate TTCtl on behalf of other users.

## 5. Why this exists — the fair-use tradition

Building independent tooling on top of a service interface the user
already has lawful access to is a long-standing software-engineering
tradition. Browser extensions, third-party email clients, RSS readers,
and personal automation tools have all been built on platforms that did
not publish first-class APIs. The tradition is reinforced by advocacy
on adversarial interoperability and on the limits of the Computer Fraud
and Abuse Act for users acting on their own accounts — see the
Electronic Frontier Foundation on
[adversarial interoperability](https://www.eff.org/deeplinks/2019/06/adversarial-interoperability)
and the [Computer Fraud and Abuse Act](https://www.eff.org/issues/cfaa).
TTCtl sits in that tradition: one person, building their own tooling,
against their own account, using the same interface the platform
already serves them.

## 6. What we won't do

The README disclaimer is not a marketing slogan; it is a
contribution-acceptance policy. Pull requests that move TTCtl toward
behavior outside its envelope will not be accepted:

- **No mass-automation features.** Anything that bulks up application
  submission, recruiter outreach, or engagement-signal manipulation
  will be declined regardless of how cleanly it is implemented.
- **No third-party impersonation.** Anything that would let one
  operator act against another talent's account, or that would let a
  service operate against multiple talents in aggregate, is out of
  scope.
- **No recruiter or client scraping.** TTCtl reads data the operator's
  session can already see; bulk enumeration of other parties is not in
  scope.
- **No removal of architectural friction.** The sequential rate limits,
  the single-credential design, and the absence of batch parallelism on
  automation-prone endpoints are intentional and load-bearing.

These constraints are enforced through code-review judgment and project
conventions rather than runtime checks; the project's small footprint
makes that maintainable.

## 7. Contact

If you believe TTCtl is being used in a way that violates this posture —
whether you are the platform vendor, a security researcher, or a fellow
user — please use the channel described in
[SECURITY.md § Reporting a Vulnerability](../SECURITY.md#reporting-a-vulnerability).
Reports are read directly by the maintainer; pseudonymous reports are
welcome.
