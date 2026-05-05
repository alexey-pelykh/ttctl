# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in TTCtl, please report it responsibly
by emailing **oleksii@pelykh.com**. Do not open a public issue.

You should receive a response within 48 hours. Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce or a proof-of-concept.
- The version of TTCtl you tested against.

## Security Model

### Credential Handling

TTCtl authenticates against the Toptal Talent platform using session cookies
obtained via `EmailPasswordSignIn`. The user provides credentials in `.ttctl.yaml`
via one of two forms:

| Form                | Example                                   | Recommended           |
| ------------------- | ----------------------------------------- | --------------------- |
| 1Password reference | `auth: "op://Personal/ttctl"`             | yes                   |
| Literal             | `auth: { email: "...", password: "..." }` | no — dev/testing only |

When the 1Password form is used, TTCtl shells out to `op item get` at runtime to
resolve `username` and `password`. Credentials are not persisted by TTCtl.

After successful sign-in, session cookies are stored at:

| Location                                                               | Permissions | Purpose                   |
| ---------------------------------------------------------------------- | ----------- | ------------------------- |
| `~/.ttctl/session.cookies` (or `$XDG_DATA_HOME/ttctl/session.cookies`) | `0600`      | Mozilla-format cookie jar |

**Threat model assumptions:**

| Assumption                            | Rationale                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| The local machine is trusted          | Cookie jar is plaintext on disk; protected only by file permissions            |
| 1Password CLI is trusted              | When `auth: "op://..."` is configured, TTCtl trusts the `op` binary's response |
| The Toptal Talent platform is trusted | All API calls are made over HTTPS to `*.toptal.com`                            |

The literal `auth: { email, password }` form stores plaintext credentials in
the YAML config and is discouraged. Backups, sync clients, and accidental
commits all expose plaintext config files; the 1Password form removes the
plaintext-on-disk surface entirely.

### MCP Trust Model

TTCtl exposes an MCP server (`ttctl mcp`) that gives MCP clients programmatic
access to your Toptal Talent profile via your saved session.

#### Transport

The MCP server uses **stdio transport**. The MCP client (e.g., Claude Desktop)
spawns `ttctl mcp` as a child process and communicates over stdin/stdout — no
network listener, no authentication token. The trust boundary is
**process-level**: any process that can spawn `ttctl mcp` gets full access to
every registered tool, scoped to your own Toptal Talent profile.

#### Prompt Injection Risk

When the MCP client is an AI agent, the agent processes data from various
sources, some of which may be untrusted (incoming messages, third-party
documents, web content). Adversarial input could contain instructions that
influence the agent to invoke state-changing tools (profile updates, application
state changes). This is a threat vector unique to the MCP interface.

### Recommendations

- Store credentials via 1Password references (`auth: "op://..."`) rather than
  literal `email`/`password` in the YAML.
- Restrict file permissions on `.ttctl.yaml` and `~/.ttctl/session.cookies` to
  the owning user.
- Do not commit `.ttctl.yaml` files to version control. Add them to `.gitignore`.
- Do not grant MCP access to untrusted AI agents. Any MCP client that can spawn
  `ttctl mcp` receives full access to all registered tools.
- Review agent tool calls for state-changing operations when using an AI agent
  as the MCP client.
- Keep TTCtl up to date to benefit from security fixes — particularly the TLS
  impersonation profile, which must track current Chrome stable.

## Supported Versions

Security fixes are applied to the latest release only. There is no long-term
support for older versions.

## Project Use Policy

For the project's use policy and the boundaries of intended use, see the
[README](README.md). TTCtl is a personal-productivity tool intended for use
against the operator's own Toptal Talent profile only.
