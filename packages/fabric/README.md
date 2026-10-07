# @qvac/fabric

Shared bare addon that hosts the **qvac-fabric** runtime (Tether's fork of
`llama.cpp` + `ggml`) as a single prebuilt shared library. Consumer addons
(`@qvac/llm-llamacpp`, `@qvac/embed-llamacpp`, …) declare `@qvac/fabric` as an
npm dependency and dynamically link against it, so the multi-hundred-megabyte
llama/ggml runtime is **built once** and **loaded once per process** instead of
being statically embedded into every addon.

`binding.js` is one line, `module.exports = require('#host-addon')`. The
`#host-addon` import resolves to the platform package for the current host,
with literal specifiers only, so `bare-pack` and `bare-link` see the whole
graph. See [INTEGRATION.md](./INTEGRATION.md) for the consumer guide.

## What it ships

- **Prebuilt `.bare` shared library** — `qvac__fabric-<host>.bare` (SONAME
  `qvac__fabric-<host>@0.bare`), in the `@qvac/fabric-<host>` platform package.
  It contains `libllama`, `libcommon`, `libmtmd`, and `libggml-base`, and
  exports the full `llama_* / LLAMA_* / ggml_* / gguf_* / mtmd_*` C API, the
  `common_*` and `json_schema_to_grammar` C++ symbols, and the
  `qvac_fabric_*` backend-discovery API declared in `qvac-fabric.h`.
- **C++ headers** (`prebuilds/include/`) — `qvac-fabric.h`, `ggml*.h`, `gguf.h`
  at the root and `llama.h`, `llama-cpp.h`, `common/*.h`, `mtmd/*.h` under
  `include/llama/`.
- **CMake config** (`prebuilds/share/qvac-fabric/`) — `find_package(qvac-fabric)`
  exposes `qvac-fabric::headers` and the host helpers
  `qvac_fabric_platform_package()` / `qvac_fabric_module_name()`.
- **ggml compute backends** — on **Linux, Android, and Windows**, separate shared
  libraries ship under `prebuilds/<host>/qvac__fabric-<host>/` of the platform
  package and are loaded at runtime by `qvac_fabric_load_backends()`. On
  **macOS and iOS** the backends are linked statically inside the `.bare` and
  self-register on load. On **linux-x64** this includes the ROCm/HIP backend
  (`libqvac-ggml-hip.so`, gfx1151) alongside Vulkan; the DL loader skips it on
  non-AMD hosts. Linux packages also include an RPC backend with RDMA
  auto-negotiation and TCP fallback.

## Platform packages

`@qvac/fabric` is a meta package that ships the one-line `binding.js`, headers
and CMake config. Each host's runtime and backends live in a version-locked
platform package, an ordinary addon whose `index.js` is
`module.exports = require.addon()`:

| Host | Package | Module |
| --- | --- | --- |
| linux-x64 (glibc) | `@qvac/fabric-linux-x64` | `qvac__fabric-linux-x64` |
| linux-arm64 (glibc) | `@qvac/fabric-linux-arm64` | `qvac__fabric-linux-arm64` |
| darwin-arm64 | `@qvac/fabric-darwin-arm64` | `qvac__fabric-darwin-arm64` |
| darwin-x64 | `@qvac/fabric-darwin-x64` | `qvac__fabric-darwin-x64` |
| win32-x64 | `@qvac/fabric-win32-x64` | `qvac__fabric-win32-x64` |
| android-arm64 | `@qvac/fabric-android-arm64` | `qvac__fabric-android-arm64` |
| ios (device + simulators) | `@qvac/fabric-ios` | `qvac__fabric-ios` |

Desktop packages are `os`/`cpu`-filtered `optionalDependencies`, so installers
pick the right one; do not depend on them directly. Supported installers are
npm 7+, pnpm, bun, and Yarn Berry. Yarn v1 and `--omit=optional` installs skip
the platform package, and `require('@qvac/fabric')` (or `bare-pack`) then fails
naming `#host-addon`. A host without a platform package resolves to
`addon-unavailable.js`, which throws.

Mobile targets are cross-built, so no install host ever matches their `os`.
Mobile applications must declare `@qvac/fabric` and the target's platform
package as direct dependencies at the same exact version, one that satisfies
the `@qvac/fabric` range their addons declare. The meta package lists them as
optional peers.

Source builds (`npm run build`) finish with `npm run link:platform`, which
creates `node_modules/@qvac/fabric-<host>` inside this package with its
`prebuilds/<host>` linked to the fresh build, so `#host-addon` and the CMake
template resolve the local runtime without a publish.

### Backend discovery

The runtime finds its own backends; consumers pass no path. The lookup order
of `qvac_fabric_backends_dir()` is:

1. `$QVAC_FABRIC_BACKENDS_DIR`, when set;
2. `<runtime dir>/qvac__fabric-<host>/`, when it exists (installed and
   `bare-pack`ed layouts);
3. `<runtime dir>` itself (`bare-link`ed layouts, where backends sit next to
   the runtime, including inside an APK).

`qvac_fabric_load_backends()` loads that directory once per process.
`require('@qvac/fabric')` exposes the same two calls as `backendsDir()` and
`loadBackends()`.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Consumer addons (.bare)                                   │
│  @qvac/llm-llamacpp   @qvac/embed-llamacpp   …             │
│  link qvac-fabric::headers + DT_NEEDED qvac__fabric-<host> │
└───────────────────────────┬────────────────────────────────┘
                            │ (ELF SONAME dedup → one load)
┌───────────────────────────▼────────────────────────────────┐
│  qvac__fabric-<host>@0.bare  (@qvac/fabric-<host>)          │
│  libllama · libcommon · libmtmd · libggml-base              │
│  + ggml backend modules (.so/.dll; static on Apple)         │
│  exports llama_* / LLAMA_* / ggml_* / gguf_* / mtmd_* /     │
│          common_* / json_schema_to_grammar                  │
└───────────────────────────┬────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────┐
│  qvac-fabric vcpkg port (forked llama.cpp + ggml)           │
└──────────────────────────────────────────────────────────┘
```

**Key design points:**

- **Single runtime load** — Every consumer addon's `.bare` has
  `DT_NEEDED: qvac__fabric-<host>@0.bare`. The dynamic linker deduplicates by SONAME,
  so the llama/ggml runtime is loaded exactly once per process, no matter how
  many fabric-based addons are present.
- **Minimal JS API** — `@qvac/fabric` is a carrier module. Consumers `require()`
  it to register the `.bare` with the bare runtime before resolving their own
  addon (see INTEGRATION.md Step 5). Besides `backendsDir()` and
  `loadBackends()`, all inference happens through the consumer's own C++ code
  against the shipped headers.
- **One C++ runtime (Linux)** — the module embeds libc++ and exports the Itanium
  C++ ABI under the ELF version node `QVAC_FABRIC_ABI_1`. Consumer addons link
  with `-nostdlib++` and record a `DT_VERNEED` on that node, which is what keeps
  their `__cxa_*` / typeinfo references from binding to the GNU `libstdc++.so.6`
  that the `bare` executable brings into the process' global lookup scope. The
  node name is part of the ABI: renaming it requires rebuilding every consumer.
  See `symbols.map` and `arch/qips/linux-fabric-libcxx-ownership.md`.
- **Backends** — ggml compute backends are self-contained: each links its own
  ggml statically and imports no `ggml_*` from the module that `dlopen`s it.

## Build

```bash
npm install
npm run build   # bare-make generate/build/install, then npm run link:platform
```

Linux builds require the libibverbs development package (`libibverbs-dev` on
Debian/Ubuntu). On **linux-x64** a ROCm/TheRock SDK is also required, discovered
via `ROCM_PATH` or `/opt/rocm`. The `hip` port is deterministic — it hard-fails
rather than installing empty, so that the vcpkg binary cache cannot conflate a
no-HIP build with a real one under the same ABI hash. The `hip` dependency is
gated on `linux & x64`.

Linux hosts that use the RPC backend must provide `libibverbs.so.1`
(`libibverbs1` on Debian/Ubuntu). RDMA use also requires the provider package
for the host's hardware. The library is required even when the connection
falls back to TCP because the dynamic loader resolves it before loading the RPC
backend. Other Fabric backends remain available when the RPC backend cannot be
loaded.

## Supported platforms

| Platform | Triplet | Backends |
|----------|---------|----------|
| Linux | `x64-linux`, `arm64-linux` | shared `.so` under `prebuilds/<host>/qvac__fabric-<host>/` (RPC with RDMA auto-negotiation; x64 also ships ROCm/HIP) |
| macOS | `arm64-osx` | static (CPU, Metal) inside `.bare` |
| Windows | (default MSVC) | dynamic `.dll` under `prebuilds/<host>/qvac__fabric-<host>/` |
| Android | `arm64-android` | shared `.so` under `prebuilds/<host>/qvac__fabric-<host>/` |
| iOS | `arm64-ios` | static inside `.bare` |
