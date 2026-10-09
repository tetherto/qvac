# Integrating @qvac/fabric into a Consumer Addon

This guide covers the steps needed for a llama.cpp/ggml-based consumer addon to
depend on and use `@qvac/fabric` instead of statically linking the `qvac-fabric`
vcpkg port. It uses [`@qvac/llm-llamacpp`](../llm-llamacpp) and
[`@qvac/embed-llamacpp`](../embed-llamacpp) as concrete reference
implementations.

## Overview

`@qvac/fabric` is distributed as an **npm meta package** plus one **platform
package** per host. Together they ship everything a consumer addon needs to
build against the forked llama.cpp + ggml runtime:

- **C++ headers** (`@qvac/fabric/prebuilds/include/`) — `qvac-fabric.h`,
  `ggml*.h`, `gguf.h` at the include root; `llama.h`, `llama-cpp.h`,
  `common/*.h`, `mtmd/*.h` under `include/llama/`
- **CMake config** (`@qvac/fabric/prebuilds/share/qvac-fabric/`) —
  `find_package(qvac-fabric)` exposes `qvac-fabric::headers` for compile-time
  includes (`include/` and `include/llama/`) and the host helpers
  `qvac_fabric_platform_package()` and `qvac_fabric_module_name()`
- **Prebuilt `.bare` shared library**, `qvac__fabric-<host>.bare` in
  `@qvac/fabric-<host>` — exports the `llama_* / LLAMA_* / ggml_* / gguf_* /
  mtmd_*` C API plus their C++-linkage variants (the qvac-fabric fork adds C++
  extensions such as `llama_model_meta_from_file`), the `common_*` /
  `string_*` / `json_schema_to_grammar` / cpu-params libcommon helpers, and
  `qvac_fabric_load_backends()` / `qvac_fabric_backends_dir()`
- **ggml compute backends** — on **Linux, Android, and Windows**, shipped as
  shared libraries in `@qvac/fabric-<host>/prebuilds/<host>/qvac__fabric-<host>/`

### Platform packages

```
node_modules/@qvac/fabric/binding.js                       module.exports = require('#host-addon')
node_modules/@qvac/fabric/prebuilds/{include,share}/       headers + CMake config
node_modules/@qvac/fabric-<host>/index.js                  module.exports = require.addon()
node_modules/@qvac/fabric-<host>/prebuilds/<host>/         qvac__fabric-<host>.bare
node_modules/@qvac/fabric-<host>/prebuilds/<host>/qvac__fabric-<host>/   ggml backends
```

`#host-addon` maps each supported host to its platform package with a literal
specifier, and every other host to `addon-unavailable.js`. Every iOS flavour
ships in `@qvac/fabric-ios`, as `qvac__fabric-ios.bare`. The module name is the
platform package's name, so cmake-bare's `include_bare_module(... PREBUILD)`
derives the right `DT_NEEDED` from the package it resolves.

The desktop packages are `os`/`cpu` filtered `optionalDependencies` of the meta
package, so npm 7+, pnpm, bun and Yarn Berry install the right one. Yarn v1 and
`--omit=optional` install none. `@qvac/fabric-android-arm64` and
`@qvac/fabric-ios` are cross-built, and no install host selects them, so a mobile
application declares `@qvac/fabric` and the one it targets as direct dependencies
at the same exact version. `qvac verify prebuilds` and the SDK Expo plugin name the
missing pin.

A source build of fabric (`npm run build`) runs `npm run link:platform`, which
creates `packages/fabric/node_modules/@qvac/fabric-<host>` pointing at the fresh
`prebuilds/<host>`. Workspace consumers then resolve the local runtime exactly
as they would an installed one. Never resolve the runtime by path; use the
helpers in Step 3.

### Desktop and mobile

All platforms (desktop and mobile) use the same dynamic linking model: consumer
addons link `qvac-fabric::headers` for compile-time includes and
`DT_NEEDED: qvac__fabric-<host>@0.bare` for the shared runtime via
`include_bare_module`. llama/ggml/common symbols resolve at runtime from the
shared `.bare`, so the runtime is loaded once per process.

On **Linux, Android, and Windows**, ggml compute backends are separate shared
libraries that fabric finds and loads itself (`qvac_fabric_load_backends()`).
On **macOS and iOS** the backends are static inside the runtime and
self-register on load.

Consumer addons do **not** need `qvac-fabric` in their own `vcpkg.json`. The
runtime comes bundled with `@qvac/fabric`.

---

## Step 1 — npm dependency

Add `@qvac/fabric` and its platform packages to the consumer's `package.json`:

```json
{
  "dependencies": {
    "@qvac/fabric": "^0.21.0"
  },
  "optionalDependencies": {
    "@qvac/fabric-linux-x64": "^0.21.0",
    "@qvac/fabric-linux-arm64": "^0.21.0",
    "@qvac/fabric-darwin-arm64": "^0.21.0",
    "@qvac/fabric-darwin-x64": "^0.21.0",
    "@qvac/fabric-win32-x64": "^0.21.0"
  },
  "peerDependencies": {
    "@qvac/fabric-android-arm64": "^0.21.0",
    "@qvac/fabric-ios": "^0.21.0"
  },
  "peerDependenciesMeta": {
    "@qvac/fabric-android-arm64": { "optional": true },
    "@qvac/fabric-ios": { "optional": true }
  },
  "devDependencies": {
    "@qvac/fabric-android-arm64": "0.21.0",
    "@qvac/fabric-ios": "0.21.0",
    "cmake-bare": "^1.9.0",
    "cmake-vcpkg": "^1.1.0"
  }
}
```

The consumer's `.bare` has a `DT_NEEDED` on the platform package's module, and
bare-link only rewrites a `DT_NEEDED` it can match to one of the package's own
dependencies. Hence each kind of declaration:

- **`optionalDependencies` (desktop).** The install host's `os`/`cpu` filters
  pick the one that applies.
- **Optional `peerDependencies` (mobile).** No install host selects a mobile
  package, and a hard dependency would download both mobile runtimes (about
  150 MB) with every install. The application installs the one it ships,
  pinned to the exact `@qvac/fabric` version. The SDK's
  `installMissingPrebuilds` does that for you.
- **Exact-pinned `devDependencies` (mobile).** These are what an addon that
  cross-builds Android or iOS prebuilds links against. Bump them together with
  the `@qvac/fabric` range. When one is missing, configure fails and names the
  package to add.

After `npm install`, the headers and CMake config are under
`node_modules/@qvac/fabric/prebuilds/`, and the host's prebuilt `.bare` and ggml
backends are in its platform package (see
[Platform packages](#platform-packages)).

---

## Step 2 — vcpkg manifest (`vcpkg.json`)

Remove the `qvac-fabric` dependency (and the `vk-profiling` feature that pulled
its `force-profiler` feature — that now lives in `@qvac/fabric`). Keep only the
addon's own dependencies:

```json
{
  "dependencies": [
    { "name": "opencl", "platform": "android" },
    "picojson",
    "nlohmann-json",
    { "name": "qvac-lib-inference-addon-cpp", "version>=": "1.2.0" },
    { "name": "qvac-lint-cpp", "version>=": "1.4.4#3" }
  ],
  "features": {
    "tests": { "description": "Build tests", "dependencies": ["gtest"] }
  }
}
```

Do **not** add `qvac-fabric`.

---

## Step 3 — CMakeLists.txt

### Find @qvac/fabric

Addons on the shared template (`cmake/qvac-addon`, see
`docs/architecture/ADDON-CMAKE-TEMPLATE.md`) call `qvac_addon_use_fabric()`, which
does all of the below and sets `qvac_fabric_target`.

```cmake
# Provides llama/ggml/common headers + the host helpers.
set(qvac-fabric_DIR "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/@qvac/fabric/prebuilds/share/qvac-fabric/cmake")
find_package(qvac-fabric CONFIG REQUIRED)

# The runtime is the host's platform package, resolved from fabric's real path
# because it is fabric's dependency, not this addon's.
bare_target(host)
qvac_addon_fabric_layout("${host}" "${CMAKE_CURRENT_SOURCE_DIR}"
  fabric_specifier fabric_working_dir fabric_prebuilds)
include_bare_module("${fabric_specifier}" qvac_fabric_target PREBUILD
  WORKING_DIRECTORY "${fabric_working_dir}")
```

Do not call `include_bare_module("@qvac/fabric" ... PREBUILD)` directly: it is a
meta package with no `prebuilds/<host>`.

Remove the old `find_package(llama)` / `find_package(ggml)` /
`find_package(OpenSSL)` calls and the `GGML_AVAILABLE_BACKENDS` staging loop.

### Linking

```cmake
add_bare_module(my-consumer-addon EXPORTS)

# ... target_sources(...) / target_include_directories(...) ...

# Compile against llama/ggml/common headers...
target_link_libraries(${my-consumer-addon} PRIVATE qvac-fabric::headers)
# ...and dynamically link the shared runtime (DT_NEEDED qvac__fabric-<host>@0.bare).
target_link_libraries(${my-consumer-addon}_module PRIVATE ${qvac_fabric_target}_module)
```

Do not copy the runtime or its backends into the consumer's `prebuilds/`. Bare
resolves the `DT_NEEDED` to the `.bare` that `require('@qvac/fabric')` already
registered, and `bare-pack` / `bare-link` carry the platform package as an
ordinary dependency.

### How it works at runtime

1. `require('@qvac/fabric')` resolves `#host-addon` to `@qvac/fabric-<host>`,
   whose `require.addon()` loads `qvac__fabric-<host>.bare`.
2. The consumer addon `.bare` has `DT_NEEDED: qvac__fabric-<host>@0.bare`, which
   resolves to that already-loaded module (SONAME match).
3. `llama_* / ggml_* / common_*` symbols resolve from the single loaded
   instance. On macOS and iOS the static ggml backends inside the runtime
   self-register; on Linux, Android, and Windows the consumer calls
   `qvac_fabric_load_backends()`.
4. All fabric-based addons share one llama/ggml runtime in memory.

### CMake targets

| Target | Description |
|--------|-------------|
| `qvac-fabric::headers` | Compile-time headers (`include/` + `include/llama/`) |

### Symbol visibility

Consumer addons do **not** need to export the llama/ggml symbol
surface — those symbols resolve at runtime from the shared `qvac__fabric-<host>@0.bare`.
A standard consumer map exports only `bare_*` / `napi_*`:

```
{
  global:
    bare_*;
    napi_*;
  local:
    *;
};
```

The large `llama_* / ggml_* / common_*` export surface lives in `@qvac/fabric`'s
own `symbols.map` / `exports.txt`, not in the consumer.

---

## Step 4 — JS-side: pre-loading @qvac/fabric

Consumer addons that dynamically link against the fabric runtime **must**
pre-load it in `binding.js` before calling `require.addon()`, so the bare runtime
has registered the `.bare` module before resolution (required for Windows
delay-load):

```js
// Pre-load @qvac/fabric so its shared .bare module (the llama.cpp + ggml
// runtime) is registered with the bare runtime before our addon resolves its
// DT_NEEDED dependency qvac__fabric-<host>@0.bare (shipped by @qvac/fabric-<host>).
require('@qvac/fabric')

module.exports = require.addon()
```

Every `require()` and `require.addon()` specifier must be a string literal:
`bare-pack` and `bare-link` only follow what the module lexer can see.

### Locating the ggml backends

Nothing to do in JS. Fabric locates its backends natively, relative to its own
runtime, in installed, `bare-pack`ed and `bare-link`ed layouts alike (see the
README's *Backend discovery*). Do not compute a backends directory in JS and do
not default one: a user-supplied `backendsDir`, if the addon accepts one, is
passed through untouched and loaded as given.

For diagnostics, `require('@qvac/fabric').backendsDir()` returns the directory
fabric loads from.

---

## Step 5 — C++ usage

Includes are unchanged from a direct `find_package(llama)` build, because
`qvac-fabric::headers` exposes the same include roots:

```cpp
#include <llama.h>
#include <llama-cpp.h>
#include <ggml.h>
#include <ggml-backend.h>
#include <common/common.h>
#include <common/chat.h>
#include <common/json-schema-to-grammar.h>
```

`json_schema_to_grammar()` (from `libcommon`) takes a `nlohmann::ordered_json`,
so consumers that call it still need `nlohmann-json` in their own `vcpkg.json`
and `find_package(nlohmann_json CONFIG REQUIRED)` — only the full nlohmann
headers are required, not the runtime symbols.

Load the backends through fabric:

```cpp
#include <qvac-fabric.h>

if (!backendsDir.empty()) {
  ggml_backend_load_all_from_path(backendsDir.c_str()); // caller's override, as given
} else {
  qvac_fabric_load_backends(); // once per process; safe to call from every addon
}
```

On **Linux, Android, and Windows** this loads fabric's backend shared
libraries; on **macOS and iOS** the static backends inside the runtime
self-register and the call only reports them. The `BACKENDS_SUBDIR` define is
gone.

---

## Step 6 — Build

```bash
npm install        # Resolves @qvac/fabric + devDependencies (cmake-bare, cmake-vcpkg)
npm run build      # bare-make generate && bare-make build && bare-make install
```

Verify the result:

```bash
readelf -d prebuilds/<host>/<addon>.bare | grep NEEDED   # → NEEDED qvac__fabric-<host>@0.bare
bare-pack --host <host> --linked index.js > /dev/null   # bundles without errors
```

---

## Checklist

| # | Step | What to verify |
|---|------|----------------|
| 1 | `package.json` | `@qvac/fabric` `^0.21.0` in `dependencies`; the desktop platform packages in `optionalDependencies` and the mobile ones as optional `peerDependencies`; `cmake-bare` + `cmake-vcpkg` in `devDependencies`, plus exact-pinned `@qvac/fabric-android-arm64` / `@qvac/fabric-ios` when building mobile prebuilds |
| 2 | `vcpkg.json` | `qvac-fabric` is **not** listed; `vk-profiling` feature removed; addon-specific deps remain |
| 3 | `CMakeLists.txt` | `qvac_addon_use_fabric()`, or `find_package(qvac-fabric ...)` + `qvac_addon_fabric_layout()`; `qvac-fabric::headers`; no runtime or backend install |
| 4 | `binding.js` | `require('@qvac/fabric')` **before** `require.addon()`, literal specifiers only; no backends path in JS |
| 5 | Backends | native code calls `qvac_fabric_load_backends()` unless the caller passed `backendsDir` |
| 6 | Build | `npm run build` succeeds; `readelf -d` shows `NEEDED qvac__fabric-<host>@0.bare`; consumer `.bare` is small (no embedded ggml/llama); `bare-pack` succeeds |

---

## Fabric-stack PRs (parallel `qvac-fabric` development)

When developing `qvac-fabric` on a test branch in `qvac-fabric-llm.cpp`, open a qvac PR
that includes:

1. A vcpkg overlay port at `vcpkg-overlays/ports/qvac-fabric/` pointing at that branch
   or SHA, plus the `vcpkg-configuration.json` edit that registers that directory as an
   overlay for each package meant to build against it. The port on its own changes no
   build; registering it is what swaps the registry version for the branch under test.
2. Updates to `packages/fabric` (and any direct vcpkg consumers that need coordinated
   bumps).
3. Optional consumer addon changes that call new fabric APIs.

CI runs automatically on PR open/sync:

- **Direct vcpkg consumers** — every package whose `vcpkg.json` still lists the
  `qvac-fabric` port — pick up the overlay at compile time when the PR updates
  that package's `vcpkg-configuration.json` (covered by the existing
  `packages/<pkg>/**` path filters).
- **`packages/fabric`** builds `@qvac/fabric` prebuilds and publishes a
  `fabric-prebuilds` artifact.
- **npm-runtime consumers** (see `.github/fabric-consumers.json`) overlay that
  artifact into `node_modules/@qvac/fabric` before `bare-make generate`, and the
  `overlay-local-fabric` action then links the overlaid host builds as
  `node_modules/@qvac/fabric/node_modules/@qvac/fabric-<suffix>`
  (`slice-platform-packages.mjs --link-local`, as `npm run link:platform` does).
  `#host-addon` and `qvac_addon_fabric_layout()` both resolve from fabric's real
  path, so headers, link and runtime all match the unreleased engine instead of
  the released platform package npm installed. No dev npm publish is required.

Author checklist:

| Step | Action |
|------|--------|
| Overlay | Keep `vcpkg-overlays/ports/qvac-fabric/portfile.cmake` REF in sync with the `qvac-fabric-llm.cpp` branch under test |
| Lockstep | Run `verify-qvac-fabric-lockstep` — every `packages/*/vcpkg.json` that still lists `qvac-fabric` must satisfy `version>=` |
| Combined PR | When changing consumer code *and* fabric APIs, ensure both `on-pr-fabric` and the consumer `on-pr-*` workflow run. The `vcpkg-configuration.json` edit is the trigger — it sits under the consumer's own `packages/<pkg>/**` path filter, whereas a change confined to `vcpkg-overlays/` starts nothing |
| Manifest | When a package migrates to `@qvac/fabric`, add it to `npm_runtime` in `.github/fabric-consumers.json` — that list drives the consumer smoke matrix |

See `docs/architecture/qips/fabric-stack-ci.md` for the full CI design.
