# Changelog

## [0.17.0] - 2026-09-23

### Changed

- `qvac-fabric` dependency bumped `10549.1.0` -> `10549.3.0`:
  - Fixed MTP pending-state position persistence.
  - Added managed RPC server lifecycle APIs with safe socket shutdown and
    network-resource cleanup.
  - Reduced distributed RPC model loading time with weight-only caching,
    direct I/O, parallel reads, and bounded upload queues.
  - Fixed fit cleanup and parameter reporting while preserving caller
    settings.
  - Fixed Windows dynamic backend module loading and restricted DLL search
    paths.
  - Added CUDA CUTLASS block-scaled prefill and decode optimizations for FP4
    weights.

### Removed

- The CMake package config no longer publishes `QVAC_FABRIC_ABI_VERSION` or
  `QVAC_FABRIC_OWNS_CXX_RUNTIME`. Both described the platform they were
  configured for, and the config is not per-platform: it installs to
  `share/qvac-fabric/cmake`, which every prebuild leg writes, and the artifact
  merge keeps one copy in the published package. So the pair described whichever
  leg finished last — `ON` from either Linux leg, `OFF` from Android, empty from
  darwin, iOS or win32 — and a consumer had no way to tell a value meant for it
  from one that was not. `0.16.0` shipped `ON` by that ordering rather than by
  construction, and `0.16.1` still published them.

  Consumers asserting the pin read the node, and whether this build exports a
  runtime to pin to at all, out of the `.bare` for their own triplet instead;
  `__cxa_throw` is either defined there under a version node or it is not. The
  in-tree addon template moved to that before this removal, so nothing in the
  repository reads either variable. `QVAC_FABRIC_ABI_VERSION` remains as a build
  variable, stamped onto the version node so the name and the script cannot
  drift.

## [0.16.1] - 2026-09-17

### Fixed

- The Android build exports an anonymous ELF version node again, as it did
  through 0.15.0. 0.16.0 named the node for every ELF target, which left every
  consumer unable to load on Android: the addon fails its `dlopen` and `bare`
  reports `ADDON_NOT_FOUND: Cannot find addon '.'` from the addon's
  `binding.js`, before any model work. Desktop was unaffected.

  The name exists so a consumer records a `DT_VERNEED` that the host's
  `libstdc++` cannot satisfy, which is what keeps it from answering for the C++
  ABI this module exports. Only the Linux link that embeds libc++ exports that
  ABI — Android links `libc++_shared.so` and the ASan build links
  `libc++.so.1` — so on Android the `DT_VERNEED` guarded an export set that
  does not exist and only cost the load. The name now follows the same
  condition as the ABI block it protects, and `symbols.map` ships the node
  anonymous. The export surface and its `local: *;` narrowing are unchanged on
  every platform.

  Not a gap in bionic's symbol versioning, which has been there since API 23.
  It resolves a version need through the `DT_SONAME` of the dependency that
  declares it, and on device an addon's fabric dependency is not a file at all:
  the APK stages it under another name, and the dependency resolves only
  because `bare` has already loaded it. Either bionic finds no dependency
  matching the `verneed` and fails the `dlopen`, or it finds no such version
  there and demotes the requirement to unversioned definitions, which every
  export carries a version for under a named node. Both end in a failed
  `dlopen`, and `bare` discards the `dlerror` that would distinguish them, so
  what is established is narrower: the node's name is the only ELF difference
  between a consumer that loads and one that does not.

  Consumers must be rebuilt to pick this up: an Android binary built against
  0.16.0 carries versioned imports of `QVAC_FABRIC_ABI_1` and keeps failing to
  load. Linux binaries built against 0.16.0 are unaffected and keep working,
  since the node and its name are unchanged there.

## [0.16.0] - 2026-09-16

### Changed

- On Linux every export now carries the named ELF version node
  `QVAC_FABRIC_ABI_1` instead of an anonymous one. That is what actually makes a
  consumer import the C++ runtime from this module.

  0.15.0 exported the runtime, but nothing reached it. The `bare` executable
  links GNU `libstdc++.so.6`, so a second complete C++ runtime sits in the
  process' **global** lookup scope, which the dynamic linker searches before a
  `dlopen`'d module's own `DT_NEEDED` chain. A consumer linked with
  `-nostdlib++` therefore took `__cxa_throw`, `__gxx_personality_v0` and the
  `std::` typeinfo objects from libstdc++, and only the libc++-only names from
  here. `std::exception_ptr` split down that seam — `std::current_exception`
  binding to libstdc++ and `std::rethrow_exception` to this module's libc++,
  which re-raises the exception stamped `CLNGC++`, where GNU's personality
  routine may only match `catch (...)`. Every native error out of a consumer's
  load path still reached JS as `INTERNAL_ERROR` / `"Unknown error"` on Linux,
  which is the symptom 0.15.0 set out to fix.

  A named node makes the linker record a `DT_VERNEED` in every consumer that
  libstdc++ cannot satisfy, since it does not define that version. The node
  covers the whole export surface rather than only the C++ ABI: an anonymous
  version node cannot coexist with a named one, and the spliced ABI block has to
  stay inside the same `global:` list to keep its precedence over `local: *;`.
  It pins this module's own internal references too, which were being interposed
  the same way.

  The CMake package config now publishes `QVAC_FABRIC_ABI_VERSION` and
  `QVAC_FABRIC_OWNS_CXX_RUNTIME`, so a consumer's build can assert it pinned the
  runtime instead of trusting its link line, and can tell a deliberately shared
  libc++ (Android, the ASan build) from a fabric too old to pin at all.

  **Consumers must be rebuilt against this release.** This is a **minor** for
  that reason rather than for surface growth: a mixed pairing is *worse* than
  the old one and fails silently. Pinning this module's internal references
  removes the accident that both sides previously resolved the runtime from
  libstdc++ and so agreed on one, while a consumer that is not rebuilt keeps
  using libstdc++ — measured, a direct throw from here that used to be catchable
  by type stops matching. It still loads, because an unversioned reference binds
  to a default-versioned definition. On `0.x` a caret range locks the minor, so
  `^0.15.0` is what keeps already-published consumers away from it; a patch
  would reach them and degrade them. The in-tree consumers hold `^0.15.0` until
  this release is on npm and then move together, the same ordering the 0.15.0
  floor followed: their CI installs each package standalone, so a range naming
  an unpublished version fails to resolve. Until they move,
  `linkWorkspacePackages` no longer links the workspace copy into them, since
  `0.16.0` does not satisfy `^0.15.0`.

  The node name is part of the Linux ABI: renaming it is a rebuild of every
  consumer. Android is the other ELF target sharing `symbols.map` and exports
  the same set, now version-stamped, but its consumers share `libc++_shared.so`
  instead of importing the runtime from here, so they are unaffected; Darwin,
  iOS and Windows use no version script and are untouched. Rationale,
  alternatives and measurements:
  `arch/qips/linux-fabric-libcxx-ownership.md`.

## [0.15.0] - 2026-09-15

### Changed

- On Linux the module now exports the Itanium C++ ABI and the libc++ surface
  built into it — `__cxa_*`, `__dynamic_cast`, `_Unwind_*`,
  `__gxx_personality_v0`, the typeinfo / vtable objects (`_ZT*`), `operator new`
  / `operator delete`, and the standard library's out-of-line members and
  template instantiations (`_ZNSt*`, `_ZSt*` and friends) — so it is the one C++
  runtime for every in-process consumer that `DT_NEEDED`s
  `qvac__fabric@0.bare`. It still embeds libc++ statically, so the prebuild
  stays self-contained: no host `libc++.so.1`, no new `DT_NEEDED`.

  libc++ is now whole-archived instead of arriving via `-static-libstdc++`.
  That is required rather than tidy, and for the same reason ggml is
  whole-archived: `-static-libstdc++` pulls in only the archive members llama,
  ggml and common happen to reference, and a version script filters symbols
  that are already present rather than pulling members in. Exporting an
  incomplete runtime would leave consumers unable to resolve the rest of it.

  Consumers previously statically linked a second libc++ of their own. Two
  copies in one process means two copies of every `std::` typeinfo, and RTTI
  matches typeinfo by *address*, so an exception thrown by libcommon in here
  matched no `catch (const std::exception&)` in the addon. Argument-validation
  errors unwound past the addon's handler and surfaced to JS as
  `INTERNAL_ERROR` / `"Unknown error"` instead of llama's message — on Linux
  only, since macOS and Windows already share one runtime with their consumers.

  Only the Linux module is affected. Android keeps `ANDROID_STL=c++_shared`, so
  it already shares one runtime with its consumers through `libc++_shared.so`
  and exports exactly what it did before; Darwin, iOS and Windows are untouched.

  This is a **minor** for the same reason 0.9.0 and 0.12.0 were: it widens the
  exported surface. It also makes the Linux runtime and its consumers a
  lockstep pair — an addon linked with `-nostdlib++`
  (`qvac_addon_import_fabric_cxx_runtime`) requires a fabric from this release
  or later, and must not be mixed with an older one. Rationale and the
  alternatives considered: `arch/qips/linux-fabric-libcxx-ownership.md`
  ([#4468](https://github.com/tetherto/qvac/pull/4468)).

## [0.14.0] - 2026-09-15

### Changed

- `qvac-fabric` dependency bumped `10549.0.0#1` -> `10549.1.0`. No API change for this package; the runtime it carries changes as follows since `v10549.0.0`:
  - Fixed an out-of-bounds tensor write in the MoE copy path. The used-expert scan ran unbounded, so a ubatch whose `ids` tensor had zero rows read past its own bitset and aborted on `GGML_ASSERT(offset <= nbytes ...)`. Reached with the persistent MoE expert cache — on by default under `--fit` — at `-c 65536` and above ([#260](https://github.com/tetherto/qvac-fabric-llm.cpp/pull/260)).
  - Fixed uninitialized ggml views after oversized MoE cache banks and context tensors ([#263](https://github.com/tetherto/qvac-fabric-llm.cpp/pull/263)).
  - `mtmd` callers can now skip the projector's audio encoder, loading a combined projector vision-only ([#261](https://github.com/tetherto/qvac-fabric-llm.cpp/pull/261)).
  - Native MTP shares compute buffers and synchronizes draft catch-up before the target runs, now also on Vulkan and Metal and preserved across scheduler rebuilds ([#253](https://github.com/tetherto/qvac-fabric-llm.cpp/pull/253)).
  - qwen4exp correctness backports: `seq_cp`, block position keying, mtmd input, a CUDA abort, KV-unified NaN collapse, and indexer-cache `ext.x`/`ext.y` restore on state reload. Tensor parallelism is enabled and `-sm tensor` is now declared unsupported for the arch rather than skipped from the test ([#255](https://github.com/tetherto/qvac-fabric-llm.cpp/pull/255)).

## [0.13.1] - 2026-09-14

### Changed

- `qvac-fabric` dependency bumped `10549.0.0` -> `10549.0.0#1` (`LLAMA_OPENSSL=OFF`, so native prebuilds do not link OpenSSL; no API change for this package).
- Android builds no longer link `libvulkan.so` into `qvac__fabric.bare`. The port is built with `GGML_BACKEND_DL`, so the Vulkan backend is a separate dlopen'd module and the carrier module references no Vulkan symbol; the direct link only added a `DT_NEEDED` the loader had to satisfy before the module could load, and made the Vulkan SDK a hard configure-time requirement for Android builds. Vulkan acceleration is unaffected — it still arrives via the staged backend module.

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
