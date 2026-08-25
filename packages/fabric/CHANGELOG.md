# Changelog

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

- `prebuilds-fabric.yml` sets `include-rocm: true` so the linux-x64 prebuild
  cross-compiles the HIP backend, and `on-pr-fabric.yml`'s `cpp-lint` sets
  `include-rocm-sdk: true` because `ggml-config.cmake` resolves
  `find_dependency(hip/hipblas/rocblas)` at configure time. No AMD GPU is
  required on either runner, but the SDK itself is mandatory on both: without it
  `cpp-lint` fails at configure time resolving the port's `$ENV{ROCM_PATH}` shim
  to an empty prefix (`/lib/cmake/hip/hip-config.cmake`), which a warm vcpkg
  binary cache can disguise as a successful `hip` install.
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
