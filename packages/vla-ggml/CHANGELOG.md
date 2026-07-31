# Changelog

## [0.16.2] - 2026-07-31

This release fixes three regressions introduced by the 0.16.0 TypeScript migration. ESM named imports work again, a `null` config no longer breaks `load()`, and `run()` input validation is consistent for a missing `hparams`. There are no intentional API changes - the named-export surface matches 0.15.x again.

### Fixed

- ESM named imports such as `import { VlaModel } from '@qvac/vla-ggml'` failed at
  link time on both Node.js and Bare with `SyntaxError: Named export 'VlaModel'
  not found`. The generated `index.js` attached its exported members through a
  namespace-merge helper that `cjs-module-lexer` cannot see, so the CommonJS to
  ESM interop discovered no named exports. The six public members (`VlaModel`,
  `preprocessImage`, `padState`, `DEFAULT_IMAGE_SIZE`, `QvacErrorAddonVla`,
  `ERR_CODES`) are now also assigned as top-level `module.exports.X = ...`
  statements, which the lexer detects. Default imports and `require()` are
  unchanged. A runtime integration test now guards this, because the type-level
  consumer tests cannot detect lexer visibility problems.
- `load()` failed with a `TypeError` reported as `FAILED_TO_LOAD_WEIGHTS` when
  the model was constructed with `config: null`, instead of falling back to the
  default configuration: the destructuring default only applies to `undefined`,
  so the null value survived into the load path. The same failure also left the
  registered native-logger callback attached, which keeps the Bare event loop
  alive. The config is now normalized to `{}` at construction, restoring the
  pre-0.16.0 behaviour.
- Internal `run()` input validation now treats a missing `hparams` the same way
  as a `null` one, like every other guard in that function. The patch-mode check
  tested against `null` only, so a missing value would have thrown a raw
  `TypeError` instead of falling back to pixel-mode validation. This is a
  consistency fix rather than a user-visible bug: the validated value is always
  either `null` or a loaded hparams object, so the raw throw was not reachable
  through the public API.

### Pull Requests

- [#3519](https://github.com/tetherto/qvac/pull/3519) - QVAC-22177 fix: restore ESM named exports + config null-safety in vla wrapper

## [0.16.1] - 2026-07-30

### Changed

- `qvac-fabric` dependency bumped `9840.0.1` -> `9840.1.1`, picking up the
  Vulkan strided `CONCAT` addressing fix with no API change for this package.

## [0.16.0] - 2026-07-29

### Changed

- Migrated the runtime wrapper and type declarations to TypeScript. Sources now live under `src/` and the published root JavaScript entrypoints (`index.js`, `addon.js`, `lib/error.js`) and `.d.ts` declarations are generated from them and committed. Public API, CommonJS export shape, and inference output are unchanged.

## [0.15.0] - 2026-07-28

### Changed

- `qvac-fabric` dependency bumped `9840.0.0` → `9840.0.1` (training weight-repack
  disable, Metal `acc`/`set` threadgroup dispatch fix, and MoE/hybrid training
  loss scaling; no API change for this package).

## [0.14.0] - 2026-07-20

### Added

- GR00T N1.7-3B LIBERO support as the third VLA architecture behind the `IVlaModel` interface, alongside SmolVLA and pi05. Qwen3-VL backbone with a VL-fusion and AlternateVLDiT action head driven by a Euler flow-matching loop, dispatched by GGUF `general.architecture`. Ships the GGUF converter and quantizer scripts, PyTorch-parity C++ tests, and cpp, desktop and mobile CI coverage. GPU offload is wired across all inference phases.

## [0.13.0] - 2026-07-20

### Changed

- `qvac-fabric` dependency bumped `9341.1.6` → `9840.0.0` (llama.cpp b9840 rebase; no API change for this package).

### Pull Requests

- [#3036](https://github.com/tetherto/qvac/pull/3036) - QVAC-22385 rebase qvac-fabric to b9840 (9840.0.0)

## [0.12.0] - 2026-07-14

### Fixed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.4` (JsLogger concurrent-env ownership hardening fix, QVAC-21544 follow-up).

## [0.11.2] - 2026-07-08

### Changed

- `qvac-fabric` dependency bumped `9341.1.5` → `9341.1.6` (clip flash-attention AUTO fallback on non-coopmat GPUs + bounded ggml-opencl driver submissions — fixes Android vision-encoder crashes on very large encodes; no API change for this package).

## [0.11.1] - 2026-07-08

### Fixed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.3` (JsLogger teardown / re-`setLogger` crash fix, QVAC-21544, tetherto/qvac#2932).

## [0.11.0] - 2026-07-07

### Changed

- `qvac-fabric` dependency bumped `9341.1.4` → `9341.1.5` (Mali/Vulkan GPU projector optimizations — vendor-aware flash-attention gate, Valhall warptile tuning, layernorm fusion — plus OpenCL bidirectional-encoder attention and Adreno vision-encoder fixes; no API change for this package).

## [0.10.0] - 2026-07-06

### Changed

- `qvac-fabric` dependency bumped `9341.1.3` → `9341.1.4` (Qwen3-VL grid selection rewrite + CPU CLIP vision-encoder weight repacking for i8mm/AVX2 GEMM; no API change for this package).

## [0.9.0] - 2026-07-06

### Changed

- `qvac-fabric` dependency bumped `9341.1.0` → `9341.1.3` (Gemma-4 E2B vision-encoder Arm Mali/Vulkan attention speedup + encoder token-count fix; no API change for this package).

### Pull Requests

- [#3067](https://github.com/tetherto/qvac/pull/3067) - QVAC-21361 feat[api]: bump qvac-fabric to 9341.1.3 across consumers

## [0.8.2] - 2026-07-03

### Changed

- pi0.5 HIP warm-path inference optimized ~479 → 384 ms (**-18%**) on Strix Halo / gfx1151, accuracy-neutral (cos = 0.9994 vs PyTorch). Combines graph reuse across ODE steps, batched vision, flash-attention at the three attention sites (SigLIP, VLM prefill, expert block), batched AdaLN, a llama.cpp-style unified F16 KV cache, and a fused GeGLU + adaRMSNorm path. No public API change.

### Added

- Load-time validation on pi0.5 checkpoints: rejects non-MQA expert KV configs (`expert_n_kv_heads != 1` — the unified KV cache assumes a single K/V head so the VLM prefix is contiguous at offset 0) and validates adaRMSNorm modulation width (`3 × expert_hidden`), failing fast at load instead of silently corrupting the KV layout or reading out of bounds.

## Pull Requests

- [#2971](https://github.com/tetherto/qvac/pull/2971) - QVAC-21319 perf[vla]: pi05 HIP warm-path optimization (479->384ms, accuracy-neutral)

## [0.8.1] - 2026-07-01

### Changed

- Bumped the `qvac-lib-inference-addon-cpp` vcpkg dependency to `1.2.2` (self-pin fix for safe `Worklet.terminate()` on Android).

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
