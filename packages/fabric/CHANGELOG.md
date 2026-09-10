# Changelog

## [0.13.0] - 2026-09-10

### Changed

- `qvac-fabric` dependency bumped `10297.1.2` -> `10549.0.0` (upstream llama.cpp b10549). Includes a fix that annotates the `ggml_vec_index_*` C API with default visibility, so those symbols stay exportable from this runtime under the library's hidden visibility preset; no API change for this package.

## [0.12.0] - 2026-09-08

### Added

- ggml vector-index API (`ggml_vec_index_*`) in the shared runtime, via the
  `qvac-fabric[vector-index]` feature. `@qvac/embed-llamacpp` is the only
  consumer of this API and was the last blocker to migrating it off its own
  `qvac-fabric` vcpkg build: it requested the feature per-consumer, so a
  fabric-based embed had nowhere to resolve `ggml_vec_index_*` from. The header
  (`ggml-vector-index.h`) ships with the rest of the include tree, and the
  existing `ggml_*` allow-list in `symbols.map` / `exports.txt` / the Windows
  `.def` generator already covers the symbol names, so no export surface had to
  be enumerated by hand.

  The library is whole-archived into `qvac__fabric.bare` on ELF/Mach-O targets.
  This is required rather than incidental: no llama or ggml code calls
  `ggml_vec_index_*`, so a plain link pulls in none of those archive members and
  the version script would filter an empty set. Windows needs no whole-archive
  equivalent — entries in the generated `.def` act as references that pull the
  members in — but the archive must still be on the link line, because unlike
  `ggml-base` it is not a dependency of llama.

  Released as a **minor** for the same reason 0.9.0 was: this widens the
  runtime's exported API surface. Consumers pinned to `^0.10.0` or `^0.11.0` do
  not pick it up automatically and adopt it by widening their range.

## [0.11.0] - 2026-09-08

### Changed

- `qvac-fabric` dependency bumped `10297.1.1` -> `10297.1.2` (mtmd temporal merge is now opt-in per bitmap, so two adjacent equal-size still images are no longer fused into a video chunk and `clip_encode` no longer aborts with an output buffer size mismatch; no API change for this package).

  Released as a **minor**, consistent with `@qvac/embed-llamacpp` 0.39.0 and `@qvac/llm-llamacpp` 0.51.0 in the same release. `@qvac/model-fit`, `@qvac/ocr-ggml`, `@qvac/translation-nmtcpp`, `@qvac/vla-ggml` and `@qvac/classification-ggml` pin `"@qvac/fabric": "^0.10.0"`, which on a `0.x` version resolves `>=0.10.0 <0.11.0`, so they adopt this release deliberately by widening their range rather than automatically.

## [0.10.0] - 2026-08-29

### Changed

- `qvac-fabric` dependency bumped `10297.0.0` -> `10297.1.1` (MTP drafter, pipeline-parallel ACCEL fix, Metal optimisations, Qwen4-Next support and fit host-memory budgeting, plus the Qwen4-Next perf follow-ups and the Vulkan top-k radix-select shader; no API change for this package).

## [0.9.0] - 2026-08-25

### Added

- ROCm/HIP compute backend (`libqvac-ggml-hip.so`, gfx1151 / Strix Halo) in the
  linux-x64 prebuild, via the `qvac-fabric[hip-backend]` feature. It ships as a
  `GGML_BACKEND_DL` module under `prebuilds/linux-x64/qvac__fabric/` alongside
  Vulkan, so every consumer of the shared runtime can select it — previously the
  feature was requested per-consumer by `@qvac/vla-ggml`, which no longer builds
  its own ggml. At **runtime** this is fail-safe: the DL loader skips the module
  on non-AMD hosts and falls back to Vulkan/CPU. At **build time** it is not —
  the `hip` port is deterministic and hard-fails when no ROCm SDK is found,
  because a host-dependent skip would let the vcpkg binary cache conflate a
  no-HIP build with a real HIP build under an identical ABI hash. Building
  `packages/fabric` for linux-x64 therefore requires a ROCm/TheRock install,
  located via `ROCM_PATH` or `/opt/rocm`. Other platforms are unaffected — the
  `hip` dependency is gated on `linux & x64`.

### Changed

- Linux-x64 CI installs the ROCm SDK (`include-rocm` / `include-rocm-sdk`,
  landed in #4132). That is mandatory once this package requests `hip-backend`:
  without it `cpp-lint` fails at configure time resolving the port's
  `$ENV{ROCM_PATH}` shim to an empty prefix (`/lib/cmake/hip/hip-config.cmake`),
  which a warm vcpkg binary cache can disguise as a successful `hip` install.
  No AMD GPU is required on the runner.
- `qvac-registry-vcpkg` baseline `c57eec31` -> `f04e2447`, matching
  `@qvac/vla-ggml`. Required because `qvac-fabric[hip-backend]` depends on `hip`
  with no version constraint, so its version comes from the pinned baseline, and
  the `hip` port does not exist at `c57eec31`. No other version selected by this
  package changes: `qvac-fabric` and `qvac-lint-cpp` are pinned above their
  baseline entries by `version>=`, `opencl` / `vcpkg-cmake` /
  `vcpkg-cmake-config` are identical in both baselines, and `spirv-headers`
  resolves from the separately pinned `microsoft/vcpkg` registry.

## [0.8.0] - 2026-08-24

### Changed

- `qvac-fabric` dependency bumped `10069.2.0` -> `10297.0.0` (b10297 rebase with updated llama.cpp/ggml runtime and vector-index support; no API change for this package).

## [0.7.0] - 2026-08-20

### Changed

- `qvac-fabric` dependency bumped `10069.1.1` -> `10069.2.0` (TurboVec CPU
  support from the fabric runtime; no API change for this package).

## [0.6.0] - 2026-08-18

### Changed

- `qvac-fabric` dependency bumped `10069.1.0` -> `10069.1.1` (Adreno OpenCL MoE
  repack fix; no API change for this package).

## [0.5.0] - 2026-08-17

### Changed

- `qvac-fabric` dependency bumped `10069.0.0` -> `10069.1.0` (VisionPsy Nano
  support and its Flash preprocessing rule; no API change for this package).

## [0.4.0] - 2026-08-10

### Changed

- `qvac-fabric` dependency bumped `9840.1.1` -> `10069.0.0` (b10069 rebase; no
  API change for this package).

### Pull Requests

- [#3621](https://github.com/tetherto/qvac/pull/3621) - Sync all addons with
  fabric v10069.0.0

## [0.3.1] - 2026-07-30

### Changed

- `qvac-fabric` dependency bumped `9840.0.1` -> `9840.1.1`, picking up the
  Vulkan strided `CONCAT` addressing fix with no API change for this package.

## [0.3.0] - 2026-07-28

### Changed

- `qvac-fabric` dependency bumped `9840.0.0` → `9840.0.1` (training weight-repack
  disable, Metal `acc`/`set` threadgroup dispatch fix, and MoE/hybrid training
  loss scaling; no API change for this package).

## [0.1.0] - 2026-05-29

### Added

- Initial release of `@qvac/fabric`: a shared bare addon that hosts the
  `qvac-fabric` runtime (forked `llama.cpp` + `ggml`) as a single prebuilt
  `qvac__fabric@0.bare` shared library, modeled on `@qvac/onnx`.
- Exports the full `llama_* / LLAMA_* / ggml_* / gguf_* / mtmd_*` C API plus the
  `common_*` and `json_schema_to_grammar` C++ symbols (Linux version script
  `symbols.map`, macOS `exports.txt`).
- Ships llama/ggml/common/mtmd headers under `prebuilds/include/` and a
  `find_package(qvac-fabric)` CMake config exposing `qvac-fabric::headers`.
- On **Linux and Android**, stages ggml compute backends as shared libraries under
  `prebuilds/<platform>/qvac__fabric/` for runtime loading via
  `ggml_backend_load_all_from_path()`; on **macOS, Windows, and iOS** the backends
  are static inside the shared `.bare` and self-register on load.
- Consumer integration guide in `INTEGRATION.md`.
