# Changelog

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
