# @ttctl/core

[![npm](https://img.shields.io/npm/v/%40ttctl%2Fcore?logo=npm)](https://www.npmjs.com/package/@ttctl/core)
[![License](https://img.shields.io/npm/l/%40ttctl%2Fcore)](https://github.com/alexey-pelykh/ttctl/blob/main/LICENSE)

Core library for the [TTCtl](https://github.com/alexey-pelykh/ttctl) toolkit — Toptal Talent platform API client, auth, transport, and service namespaces.

> **Unofficial.** TTCtl is NOT affiliated with, endorsed by, or supported by Toptal LLC. See the [project README](https://github.com/alexey-pelykh/ttctl#readme) for the full use policy and disclaimer.

## Audience

Library consumers who want programmatic access to the surfaces the `ttctl` CLI exposes — including the typed GraphQL clients, the bearer-token auth lifecycle, the Chrome-TLS-impersonating transport for Cloudflare-protected endpoints, and the YAML config loader.

End users should install the [`ttctl`](https://www.npmjs.com/package/ttctl) umbrella package instead — it ships the CLI binary and the MCP server.

## Install

```sh
npm install @ttctl/core
```

Requires **Node.js ≥ 22.19.0**, ESM only.

## API Surface

- **Config** — `resolveConfig`, `loadConfigFile`, `ConfigError`, `ConfigLoadSchema`, `ConfigWriteSchema`, `discoverConfigPath`
- **Config writer** — `writeNewConfig` (bootstrap), `persistAuthToken` / `clearAuthToken` (atomic single-file token lifecycle), `AuthTokenPersistError`, `acquireConfigLock`
- **Auth** — `signIn`, `signOut`, `getAuthStatus`, `resolveCredentials`, `SignInError`, `AuthRevokedError`, `TtctlError`
- **Transport** — `stockTransport` (mobile gateway), `impersonatedTransport` / `impersonatedMultipartTransport` (Chrome-TLS impersonation for Cloudflare-protected surfaces), `callSurface`, `Cf403Error`, `Cf403PersistentError`, `RedirectError` (no-follow redirect policy, issue #268), `SchedulerBearerExpired`, `IMPERSONATE_PROFILE`, `getRedirectLocation`, `buildDryRunPreview`, `buildGraphQLMultipart`
- **Resilience** — `TransportError`, `readTransportConfig`, `resetTransportConfigCache`
- **Service namespaces** — `profile`, `applications`, `contracts`, `engagements`, `availability`, `jobs`, `payments`, `surveys`, `timesheet`
- **1Password** — `resolveOnePasswordReference`, `OnePasswordError`
- **Diagnostics** — `setDiagnosticLogger` / `getDiagnosticLogger` / `resetDiagnosticLogger`, `logTransportRequest`, `logTransportResponse`
- **Redaction** — `redactBody`, `redactHeaders`, `containsBearerToken`, `BEARER_PATTERN`, `BEARER_PATTERN_SOURCE`, `SECRET_BODY_FIELD_NAMES`, `SECRET_HEADER_NAMES`
- **Utilities** — `parseDateInput`, `DateInputError`, `splitParagraphs`

The full export list lives in [`src/index.ts`](https://github.com/alexey-pelykh/ttctl/blob/main/packages/core/src/index.ts).

## Example

```ts
import { resolveConfig, getAuthStatus, profile } from "@ttctl/core";

// Resolve config from --config arg / TTCTL_CONFIG_FILE env / ~/.ttctl.yaml
const { config } = resolveConfig();
const token = config.auth.token ?? "";

const status = await getAuthStatus(token);
if (status.status !== "valid") {
  throw new Error(`Not signed in: ${status.status}`);
}

// Use a service sub-namespace — `profile` splits into `basic`, `skills`,
// `employment`, `education`, … (see `src/services/profile/index.ts`).
const me = await profile.basic.show(token);
console.log(me.viewer?.viewerRole.fullName);
```

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/ttctl/blob/main/LICENSE). Importing `@ttctl/core` into your own code means the combined work is covered by AGPL-3.0; distribution triggers source-disclosure under AGPL § 13 if the combined work is offered as a network service. See the project README's [License](https://github.com/alexey-pelykh/ttctl#license) section for the maintainer's posture.
