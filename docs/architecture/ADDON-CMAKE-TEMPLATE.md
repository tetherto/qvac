# Addon CMake Template

This document proposes a shared `CMakeLists.txt` template for the QVAC native
inference addons and a strategy for keeping the addons in sync once the
boilerplate is extracted.

Use it when refactoring an addon's build, migrating an addon to the shared
`@qvac/fabric` runtime, or adding a new addon.

> Status: **partially implemented**. The shared module
> (`cmake/qvac-addon/qvac-addon.cmake`) exists and `classification-ggml` is
> migrated to it. The CI drift guard described in "Keeping addons in sync" is
> not built yet, and no other addon is migrated.

## Background

Each addon under `packages/` ships a Bare native module built on the shared
`inference-addon-cpp` interface header via `cmake-bare` + `cmake-vcpkg`. The
addons were developed as independent repos and merged into the monorepo, so
their `CMakeLists.txt` files share a large boilerplate spine but have drifted in
small, mostly accidental ways.

Two forces make consolidation worthwhile now:

1. The boilerplate is copy-pasted ~40–60 lines per file across ~12 files, and
   several fixes (Android 16 KB page size, Apple `compiler-rt` `force_load`, the
   `if(TARGET ggml::…)` backend guard) were applied unevenly — latent bugs, not
   intentional differences.
2. The **fabric migration** (see [PR #3301][pr3301]) changes how the ggml
   runtime is linked. This removes the single largest drift-prone block (the
   per-addon ggml backend collection loop) and replaces it with a smaller,
   uniform "consume a shared prebuilt runtime" block. The template should be
   built around the post-migration form, not the legacy static-ggml form.

[pr3301]: https://github.com/tetherto/qvac/pull/3301

## The fabric migration changes the build shape

Legacy form: statically link ggml from the `qvac-fabric` vcpkg port and copy
every ggml backend into each addon's `prebuilds/`.

New form ([PR #3301][pr3301], `classification-ggml`): consume the `@qvac/fabric`
npm prebuild and dynamically link one shared `.bare` module. The runtime and its
backends ship **once** per process, not once per addon.

Concretely, relative to the legacy `classification-ggml/CMakeLists.txt`:

| Legacy | New |
|---|---|
| `find_package(ggml CONFIG REQUIRED)` | `set(qvac-fabric_DIR …/node_modules/@qvac/fabric/prebuilds/share/qvac-fabric/cmake)` + `find_package(qvac-fabric CONFIG REQUIRED)` + `include_bare_module("@qvac/fabric" qvac_fabric_target PREBUILD)` |
| `foreach(_backend ${GGML_AVAILABLE_BACKENDS}) … INSTALL TARGET ggml::${_backend}` loop feeding `add_bare_module(… EXPORTS ${BACKEND_DL_LIBS})` | **deleted**; `add_bare_module(… EXPORTS)` (no exports) |
| `BACKENDS_SUBDIR = ${bare_target_value}/${module_name}` (per-addon) | `BACKENDS_SUBDIR = ${bare_target_value}/qvac__fabric` (fixed, points at fabric's shared backend dir) |
| `target_link_libraries(${tgt} PRIVATE ggml::ggml ggml::ggml-base)` + conditional `ggml::ggml-cpu` | `target_link_libraries(${tgt} PRIVATE qvac-fabric::headers)` (headers on lib target) **and** `target_link_libraries(${tgt}_module PRIVATE ${qvac_fabric_target}_module)` (dynamic link on module target) |
| `if(GGML_BACKEND_DL)` (read from the ggml vcpkg var) | `if((ANDROID OR UNIX) AND NOT APPLE)` (platform-derived; the ggml var no longer exists) |
| `vcpkg.json` depends on `qvac-fabric` | dependency removed; JS gains `resolveBackendsDir()` |
| test links `ggml::*` | test links `qvac-fabric::headers` + `${qvac_fabric_target}_module`, stages the `.bare` + backends next to the test exe, sets `$ORIGIN`/`@loader_path` rpath, links `bare_delay_load` on win32, and runs limited-ASan with `ASAN_OPTIONS=alloc_dealloc_mismatch=0:detect_leaks=0` |

Net effect on the template: the migration **shrinks** the common surface and
removes most of the drift-prone code, while adding a small, uniform runtime-
consumer block and a non-trivial test-harness staging block.

## Common vs. addon-specific

### Common spine (extract into shared helpers)

Present, in the same order, in essentially every addon:

- `cmake_minimum_required(VERSION 3.25)`.
- Options + vcpkg feature mapping (`BUILD_TESTING` / `ENABLE_COVERAGE` →
  `VCPKG_MANIFEST_FEATURES "tests"`).
- `find_package(cmake-bare …)` + `find_package(cmake-vcpkg …)` from
  `node_modules`.
- `VCPKG_OVERLAY_TRIPLETS` prepend of `../../vcpkg-overlays/triplets`.
- Android STL set before `project()`.
- libc++ on Linux (`-stdlib=libc++`, `-static-libstdc++`).
- lint-cpp sync (`configure_file` of `.clang-format` / `.clang-tidy` /
  `.valgrind.supp` / pre-commit hook).
- C++20 block (`CMAKE_CXX_STANDARD 20`, `EXTENSIONS OFF`, `PIC ON`).
- `WIN32` → `-DNOMINMAX -DWIN32_LEAN_AND_MEAN -DNOGDI`.
- `find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS …)`.
- Linux `-Wl,--exclude-libs,ALL` symbol hygiene.
- `JS_LOGGER` + `BACKENDS_SUBDIR` compile definitions.

New shared blocks introduced by the fabric form (also extract):

- **Runtime discovery**: `set(qvac-fabric_DIR …)` + `find_package(qvac-fabric)`
  + `include_bare_module`.
- **Two-target link split**: `::headers` on the lib target, `_module` on the
  module target.
- **Fixed `BACKENDS_SUBDIR = <host>/qvac__fabric`**.
- **Platform-derived `GGML_BACKEND_DL`**.
- **Test-harness staging**: copy `.bare` + glob fabric backends next to the test
  exe, set rpath, win32 delay-load helper. This is **test-only** — the
  production addon build stages no backends (see note below).

> **The addon never packages ggml backends.** `add_bare_module(… EXPORTS)`
> exports nothing. On desktop the runtime resolves backends from `@qvac/fabric`'s
> own `node_modules` prebuilds (`resolveBackendsDir()` in `src/index.ts`); on
> mobile the app/link bundling co-locates the `.bare` modules and their backends
> (the addon's `__dirname/prebuilds` fallback just points at wherever that
> bundling landed them). The only backend copying in the package is the
> **test** harness staging backends next to the test binary.

### Addon-specific (keep as explicit customization points)

- Module name and `project()` languages.
- Source file list (`target_sources`).
- Extra upstream libs layered on top of fabric (e.g. `llama::llama` /
  `llama::mtmd`, `bergamot-translator`, `sentencepiece`/`protobuf`) and extra
  third-party deps (OpenCV, STB, picojson, nlohmann, concurrentqueue).
- Addon-specific options and vcpkg features (`VK_PROFILING`, `USE_BERGAMOT`,
  `USE_OPENCL`, `ENABLE_VULKAN`, …).
- Mobile static-link fallback where applicable.
- Genuinely exotic per-package logic (nmt's sentencepiece fallback chain,
  parakeet's Android strip + `symbols.map`, etc.) — handled by adding CMake
  after the shared calls, never hidden.

### Accidental drift the template eliminates

| Concern | Consequence if missing | Fix |
|---|---|---|
| `if(TARGET ggml::…)` backend guard | `add_bare_module` `get_target_property()` errors on some feature sets | Removed entirely by fabric form (no backend loop) |
| Android 16 KB page-size link flags | addon fails to load on Pixel 9-class devices | Applied unconditionally in `qvac_addon_finalize` |
| Apple `compiler-rt` `force_load` (Xcode 16 `__isPlatformVersionAtLeast`) | module aborts at first `@available` call | Applied unconditionally in `qvac_addon_finalize` |
| lint-cpp `.valgrind.supp` / pre-commit hook | inconsistent local dev hooks | Opt-in flags on `qvac_addon_project_setup` |

> **The Android page-size and Apple `compiler-rt` fixes are folded into
> `qvac_addon_finalize` unconditionally** to normalize the drift: every migrated
> addon gets them, so none can silently regress. They are platform-guarded
> (`if(ANDROID)` / `if(APPLE)`), so they are no-ops where they don't apply. This
> is a deliberate **behavior change** for addons (like `classification-ggml`)
> that previously lacked them — that's the point. The Apple block resolves the
> exact `libclang_rt.<variant>.a` via `xcrun` and `FATAL_ERROR`s with an
> actionable message if Xcode's SDK is missing, matching the proven
> parakeet/tts implementation. They live in dedicated helpers
> (`qvac_addon_android_page_size` / `qvac_addon_apple_force_load_compiler_rt`)
> that `finalize` calls, so a rare addon that must opt out can call the pieces
> directly instead.

## Proposed shared module

Precedent already exists in-repo: `.clang-format` / `.clang-tidy` are kept in
sync by copying from a single `lint-cpp` source, and triplets are shared via
`../../vcpkg-overlays/triplets`. Extend that model to the build logic.

Location: a committed, versioned module at repo root, resolved the same way
triplets are.

```
cmake/qvac-addon/qvac-addon.cmake
```

Included from an addon via `../../cmake/qvac-addon/qvac-addon.cmake` (consistent
with the existing `../../vcpkg-overlays` relative path assumption).

Function surface (plain functions/macros, so nothing is locked away). The
pre-/post-`project()` helpers are **macros** because they must set directory-scope
state (`VCPKG_MANIFEST_FEATURES`, the vcpkg toolchain, `ANDROID_STL`,
`CMAKE_CXX_STANDARD`, the fabric target var) in the addon's own scope:

- `qvac_addon_preproject()` (macro) — pre-`project()` setup: `BUILD_TESTING` /
  `ENABLE_COVERAGE` options, `tests` vcpkg feature, `cmake-bare`/`cmake-vcpkg`,
  overlay triplets, Android STL, version stamp. Addon-specific options / vcpkg
  features are declared by the addon around this call (still before `project()`).
- `qvac_addon_project_setup([VALGRIND_SUPP] [PRE_COMMIT_HOOK])` (macro) — libc++
  on Linux, lint-cpp `.clang-format`/`.clang-tidy` sync (the `.valgrind.supp`
  file and pre-commit hook are opt-in), C++20 block, WIN32 defs.
- `qvac_addon_use_fabric()` (macro) — fabric discovery (`set(qvac-fabric_DIR …)`
  + `find_package` + `include_bare_module`). Sets `qvac_fabric_target` and
  `BACKENDS_SUBDIR_VALUE` (`<host>/qvac__fabric`) in the caller's scope.
- `qvac_addon_link_fabric(<addon_target> <fabric_target>)` — the two-target link
  split (`qvac-fabric::headers` on the lib, `${fabric_target}_module` on the
  module).
- `qvac_addon_finalize(<addon_target> [SUBDIR <value>])` — everything applied to
  every module: Linux `--exclude-libs,ALL`, `JS_LOGGER`, `BACKENDS_SUBDIR`
  define, platform-derived `GGML_BACKEND_DL`, and (via dedicated helpers it
  calls) the Android 16 KB page-size flags and Apple `compiler-rt` `force_load`.
  The two platform fixes are also exposed as standalone helpers
  (`qvac_addon_android_page_size` / `qvac_addon_apple_force_load_compiler_rt`)
  for the rare addon that needs to opt out of `finalize` and wire them by hand.
- `qvac_addon_stage_fabric_for_test(<test_target> <fabric_target>)` — test-only:
  `GGML_BACKEND_DL`/`GGML_BACKEND_DIR`, copy `qvac__fabric@0.bare` + glob fabric
  backends next to the test binary, set `$ORIGIN`/`@loader_path` rpath, link
  `bare_delay_load` on win32. (ASan and coverage stay in the addon's test file.)

### Target template skeleton

```cmake
cmake_minimum_required(VERSION 3.25)

include(${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/qvac-addon/qvac-addon.cmake)
qvac_addon_preproject()

project(classification-ggml LANGUAGES C CXX)
qvac_addon_project_setup()

find_path(QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS
  "inference-addon-cpp/JsInterface.hpp" REQUIRED)
find_path(STB_INCLUDE_DIRS "stb_image.h" REQUIRED)          # addon-specific

qvac_addon_use_fabric()   # sets qvac_fabric_target + BACKENDS_SUBDIR_VALUE

add_bare_module(classification-ggml EXPORTS)

target_sources(${classification-ggml} PRIVATE ...)          # addon-specific
target_include_directories(${classification-ggml} PRIVATE
  ${QVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS} ${STB_INCLUDE_DIRS}
  ${PROJECT_SOURCE_DIR}/addon/src)

qvac_addon_link_fabric(${classification-ggml} ${qvac_fabric_target})
# addon-specific extra libs, if any:
# target_link_libraries(${classification-ggml} PRIVATE llama::llama ...)

qvac_addon_finalize(${classification-ggml} SUBDIR "${BACKENDS_SUBDIR_VALUE}")

if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
  include(GoogleTest)
  enable_testing()
  add_subdirectory(test/unit)   # calls qvac_addon_stage_fabric_for_test(addon-test ${qvac_fabric_target})
endif()
```

## Keeping addons in sync

1. **Single source of truth + version stamp.** A `QVAC_ADDON_CMAKE_VERSION` in
   the module, echoed via `message(STATUS)` in `qvac_addon_preproject`, so drift
   is visible in build logs.
2. **CI drift guard.** A script (e.g. `scripts/check-addon-cmake.mjs`, run in the
   `on-pr-*` workflows) that asserts every migrated `packages/*/CMakeLists.txt`:
   - includes the shared module and calls `qvac_addon_finalize`, and
   - does **not** re-inline the extracted blocks — fail on sentinels like
     `__isPlatformVersionAtLeast`, `max-page-size=16384`, `--exclude-libs,ALL`,
     or a raw `GGML_AVAILABLE_BACKENDS` loop appearing outside
     `cmake/qvac-addon/`.
   This is the mechanism that actually prevents regression.
3. **Reuse the lint-cpp precedent** for parts already synced (`.clang-format` /
   `.clang-tidy`); the module just wraps the existing `configure_file` calls.
4. **Template file + scaffolder.** A `cmake/qvac-addon/CMakeLists.template.txt`
   (or a `qv-addon-*` skill) so new addons start from the canonical shape.
5. **Optional golden test.** Render the template with a fixture and diff it, so
   intentional template changes are reviewed deliberately.

## Phase 1 scope and sequencing

Phase 1 targets only the addons that build `qvac-fabric` from the vcpkg port
today (the direct consumers migrating to the `@qvac/fabric` npm prebuild). Other
ggml variants (whisper.cpp / parakeet / tts-cpp / stable-diffusion — separate
vcpkg ports) and the ONNX addons (being phased out) are **out of scope**.

Phase 1 packages (vcpkg.json depends on `qvac-fabric`):

- `packages/classification-ggml` — reference, [PR #3301][pr3301].
- `packages/vla-ggml`
- `packages/ocr-ggml`
- `packages/translation-nmtcpp`
- `packages/llm-llamacpp`
- `packages/embed-llamacpp`

> The llama addons (`llm-llamacpp`, `embed-llamacpp`) consume `llama::*` targets
> that also come from the `qvac-fabric` port. Their migration additionally
> depends on `@qvac/fabric` exposing the llama layer with ggml linked
> dynamically — a fabric-packaging question that may gate their order relative
> to the direct-ggml addons.

Sequencing principle: **template adoption == fabric migration**. Do not
templatize the dying static-ggml backend loop and then delete it; build the
shared module around the post-migration form and let each addon's fabric-
migration PR also be its template-adoption PR.

1. Land `classification-ggml` fabric migration ([PR #3301][pr3301]) as the
   reference shape.
2. Add `cmake/qvac-addon/qvac-addon.cmake` and migrate `classification-ggml`.
   `finalize` folds in the Android page-size + Apple `compiler-rt` fixes
   unconditionally — a deliberate behavior change that normalizes the drift, so
   addons that lacked them now get them.
3. Migrate + adopt per addon, starting with the direct-ggml consumers
   (`vla-ggml`, `ocr-ggml`, `translation-nmtcpp`), then the llama addons once
   fabric's llama packaging is ready.

## Open questions

- Whether to ship the module inside the `cmake-bare` / `cmake-vcpkg` npm
  packages later, for consumption outside the monorepo. (Location is decided:
  repo-root `cmake/qvac-addon/`, consistent with `vcpkg-overlays/`.)
- When parakeet / tts migrate, they must **drop their inline** Android
  page-size + Apple `compiler-rt` blocks and rely on `finalize` (avoid
  double-application). Their extra Apple `-Wl,-exported_symbol` flags and
  `symbols.map` version-script stay addon-specific for now.
- Building the CI drift guard (`scripts/check-addon-cmake.mjs`) before the second
  addon migrates, so re-inlined boilerplate can't creep back.
