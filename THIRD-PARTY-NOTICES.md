# Third-Party Notices

TTCtl itself is licensed under **AGPL-3.0-only** (see [`LICENSE`](LICENSE)).

This file provides attribution for third-party components that TTCtl
**redistributes transitively** but which do not ship their own
consumer-reachable license/notice files. Installing any TTCtl npm package
(`ttctl`, `@ttctl/core`, `@ttctl/cli`, `@ttctl/mcp`) pulls in
[`node-wreq`](https://github.com/StopMakingThatBigFace/node-wreq) and its
platform-specific prebuilt native binary. That binary statically links a Rust
HTTP stack (notably [`wreq`](https://github.com/0x676e67/wreq)) and
[BoringSSL](https://boringssl.googlesource.com/boringssl/). The relevant
licenses (MIT, Apache-2.0) require their notices to be preserved on
redistribution; this file preserves them.

It is a best-effort attribution by the maintainer, not a legal determination.
The per-release [CycloneDX SBOM](https://github.com/alexey-pelykh/ttctl/releases)
(attached to each GitHub Release) is the authoritative machine-readable
inventory of the npm dependency graph.

---

## node-wreq (and `@node-wreq/*` prebuilt binaries) — MIT

- **Package**: `node-wreq` and its optional platform binary subpackages
  `@node-wreq/darwin-arm64`, `@node-wreq/darwin-x64`,
  `@node-wreq/linux-arm64-gnu`, `@node-wreq/linux-x64-gnu`,
  `@node-wreq/linux-x64-musl`, `@node-wreq/win32-x64-msvc`
- **Version**: 2.4.1
- **License**: MIT (declared in each package's `package.json`)
- **Author**: StopMakingThatBigFace
- **Source**: https://github.com/StopMakingThatBigFace/node-wreq

Upstream `node-wreq` ships no `LICENSE` file or explicit copyright line; the
applicable terms are the MIT License (reproduced below), with copyright
attributable to the package's declared author.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Native components statically linked into the `node-wreq` binary

The prebuilt `@node-wreq/*` `.node` binary is compiled from Rust and bundles
the following native components. These are not visible to npm-graph tooling
(they live inside the compiled binary, not in `node_modules`), so they are
enumerated here explicitly.

### wreq — Apache-2.0

- **Component**: `wreq` (the Rust HTTP client backing node-wreq)
- **License**: Apache-2.0 (`license = "Apache-2.0"` in its `Cargo.toml`)
- **Source**: https://github.com/0x676e67/wreq

### BoringSSL — Apache-2.0

- **Component**: BoringSSL (TLS, linked via `wreq`)
- **License**: Apache-2.0 (per the upstream `LICENSE`; the only non-Apache
  portion is Go test-suite code that is not compiled into the distributed
  `libcrypto`/`libssl`, so it does not trigger on binary redistribution)
- **Source**: https://boringssl.googlesource.com/boringssl/

### Rust crate graph (transitive dependencies of `wreq`)

`wreq` pulls a broader graph of Rust crates (async runtime, HTTP/2, TLS glue,
etc.) that are likewise statically linked into the binary. These are
predominantly licensed under **MIT** and/or **Apache-2.0**, with a few under
**BSD** / **ISC** — all permissive, all requiring only notice preservation.
The authoritative per-crate enumeration is the `Cargo.lock` / `Cargo.toml`
manifest set in the [`wreq` repository](https://github.com/0x676e67/wreq); this
notice does not reproduce it crate-by-crate to avoid drift and over-claiming.

---

## Full license texts

- **MIT** — reproduced above; canonical text: https://spdx.org/licenses/MIT.html
- **Apache-2.0** — https://www.apache.org/licenses/LICENSE-2.0 ·
  https://spdx.org/licenses/Apache-2.0.html
