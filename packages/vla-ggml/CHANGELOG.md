# Changelog

## [0.8.0] - 2026-06-30

### Added

- ROCm/HIP GPU backend for AMD GPUs on Linux (Strix Halo / gfx1151), built as a `GGML_BACKEND_DL` module (`libqvac-ggml-hip.so`) alongside Vulkan. `BackendSelection` prefers the ROCm device at runtime with Vulkan/CPU fallback; an unloadable HIP module or non-AMD target is skipped by the DL loader. Opt-in via the `qvac-fabric[hip-backend]` feature (linux-x64 only) — other consumers are unaffected and gain no ROCm dependency.

### Changed

- `default-registry` baseline raised to consume the published `qvac-fabric` `hip-backend` feature and the new `hip` port directly from the registry ([qvac-registry-vcpkg #206](https://github.com/tetherto/qvac-registry-vcpkg/pull/206)); no in-tree overlay ports.

## Pull Requests

- [#2781](https://github.com/tetherto/qvac/pull/2781) - QVAC-19291 feat[api]: vla-ggml ROCm/HIP backend (gfx1151, Strix Halo)

## [0.7.0] - 2026-06-24

### Changed

- `qvac-fabric` dependency bumped `9341.0.0` → `9341.1.0` (Qwen3.5-VL multi-tile batching; no API change for this package).

## Pull Requests

- [#2840](https://github.com/tetherto/qvac/pull/2840) - QVAC-19119 feat[api]: bump qvac-fabric to 9341.1.0 (vla-ggml)

## [0.6.1] - 2026-06-22

### Changed

- Windows prebuilds now link the static Visual C++ runtime (`/MT`) instead of
  importing `vcruntime140.dll`, `msvcp140.dll`, or UCRT DLLs from the MSVC
  redistributable. Shared monorepo `vcpkg-overlays/triplets/{x64,arm64}-windows.cmake`
  build dependencies with a static CRT; addon CMake no longer links `msvcrt.lib`,
  which had forced the dynamic runtime. Per-package vcpkg overlays were
  consolidated into the shared `vcpkg-overlays/` tree. No public API change.

## Pull Requests

- [#2722](https://github.com/tetherto/qvac/pull/2722) - QVAC-21100: Switch to static C/C++ windows runtimes

## [0.6.0] - 2026-06-22

### Changed

- Updated the `qvac-fabric` vcpkg dependency to registry version `9341.0.0`, which enables `GGML_BACKEND_DL` dynamic backend loading on desktop Linux: the Vulkan GPU backend and runtime-dispatched CPU micro-architecture variants now load as standalone modules from `prebuilds`. No public API change.

## Pull Requests

- [#2733](https://github.com/tetherto/qvac/pull/2733) - QVAC-20827 feat[api]: GGML_BACKEND_DL desktop backends (Vulkan) across fabric consumers

## [0.5.0] - 2026-06-18

### Changed

- Updated the `qvac-fabric` vcpkg dependency to registry version `8828.1.2` (adds the OpenCL DocTR ops — `CONV_2D_DW`, `POOL_2D`, `HARDSWISH`, `HARDSIGMOID` — for the Adreno OpenCL backend; no behavioral change for this package).

## Pull Requests

- [#2617](https://github.com/tetherto/qvac/pull/2617) - feat[api]: DocTR Adreno OpenCL — direct regular conv (~0.72s on S25) + qvac-fabric 8828.1.2

## [0.4.0] - 2026-06-12

### Changed

- Updated the `qvac-fabric` vcpkg dependency to registry version `8828.1.1` (adds the direct Metal `CONV_2D_DW` depthwise-convolution kernel).

## Pull Requests

- [#2536](https://github.com/tetherto/qvac/pull/2536) - feat[api]: DocTR depthwise convs via direct Metal CONV_2D_DW kernel

## [0.3.2] - 2026-06-06

- Pinned to the Fabric revision used by the M-RoPE/iM-RoPE sliding-context work.

## Pull Requests

- [#2438](https://github.com/tetherto/qvac/pull/2438) - feat[notask]: add M-RoPE sliding context support

## [0.3.1] - 2026-06-02

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.1`.

## [0.3.0]

- feat: π₀.₅ support behind GGUF `general.architecture=pi05`. The addon
  now loads and runs the Physical Intelligence π₀.₅ model alongside
  existing SmolVLA — no behaviour change for SmolVLA callers. The
  polymorphic `IVlaModel` interface dispatches based on the GGUF
  architecture key; legacy v0.1.0 weights without the key keep loading
  as SmolVLA.
- `VlaModel.run()` accepts up to 3 camera images (vs SmolVLA's 2);
  `getVlaHparams()` reports `numCameras: 3` and `stateInputMode:
  'discrete'` for π₀.₅. The discrete-state path tokenises robot state
  into digit tokens inside the language prompt — the caller passes an
  empty (or any) `state` Float32Array, which π₀.₅ ignores.
- `runtimeStats()` adds architecture-neutral `prefill_compute_ms` /
  `prefill_total_ms` keys alongside the legacy `smollm2_*` aliases
  (kept for back-compat with existing JS consumers).
- Every sub-graph (SigLIP per-block, full SigLIP tower, PaliGemma
  embedder, Gemma-1 VLM block + full prefill, time-cond + adaRMSNorm
  split, expert block with joint attention, full expert pass, Euler
  step, full 10-step ODE loop, end-to-end prefill + ODE) is
  parity-tested against a PyTorch reference. All gates pass at
  cos > 0.999.
- C++ + JS integration tests drive a real `pi05_base.gguf` through
  the production `Pi05Model::infer` / `VlaModel.run()` paths and
  assert the returned action chunk vs PyTorch reference actions
  (cos > 0.999, rel-max < 5 % on CPU).
- `convert_pi05_to_gguf.py` converts LeRobot/openpi checkpoints to
  GGUF with quantization variants (q_aggressive, all-q8, all-q4).
- New JS integration test `test/integration/pi05.test.js` mirrors the
  shape of `addon.test.js` (exports surface, validator error paths,
  img-shape mismatch, end-to-end inference parity).

## [0.2.1] - 2026-05-26

- Updated the `qvac-fabric` vcpkg dependency to registry version `8828.0.2`.

## [0.2.0] - 2026-05-23

- Updated the `qvac-fabric` vcpkg dependency to registry version `8828.0.1`.
- Relaxed the `cmake-bare` dev dependency range to accept compatible patch releases.

## [0.1.0]

- Initial release of `@qvac/vla-ggml`. Ports the SmolVLA vision-language-action
  model to ggml with Vulkan / Metal / OpenCL / CPU backends. Bundles the
  full SigLIP vision encoder, SmolLM2 text tower, action expert, and
  10-step flow-matching ODE in a single Bare addon.
- `VlaModel.run()` returns `{ actions, stats }` where `stats` carries
  per-stage wall-clock timings (`vision_ms`, `smollm2_compute_ms`,
  `smollm2_total_ms`, `ode_ms`, `total_ms`).
- Input validation: `model.run()` rejects mismatched `imgWidth` /
  `imgHeight` (must equal `hparams.visionImageSize`), `n_images`,
  `lang_len`, and `state_dim` at both the JS and C++ layers.
