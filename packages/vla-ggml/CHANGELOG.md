# Changelog

## Unreleased

## 0.2.0

- feat: π₀.₅ support behind GGUF `general.architecture=pi05`. The addon
  now loads and runs the Physical Intelligence π₀.₅ model alongside
  existing SmolVLA — no behaviour change for SmolVLA callers. The
  polymorphic `IVlaModel` interface (already introduced under the
  hood) dispatches based on the GGUF architecture key; legacy v0.1.0
  weights without the key keep loading as SmolVLA.
- `VlaModel.run()` accepts up to 3 camera images (vs SmolVLA's 2);
  `getVlaHparams()` reports `numCameras: 3` and `stateInputMode:
  'discrete'` for π₀.₅. The discrete-state path tokenises robot state
  into digit tokens inside the language prompt — the caller passes an
  empty (or any) `state` Float32Array, which π₀.₅ ignores.
- `runtimeStats()` adds architecture-neutral `prefill_compute_ms` /
  `prefill_total_ms` keys alongside the legacy `smollm2_*` aliases
  (kept for back-compat with existing JS consumers).
- Phase-3 verification: every sub-graph (SigLIP per-block, full
  SigLIP tower, PaliGemma embedder, Gemma-1 VLM block + full prefill,
  time-cond + adaRMSNorm split, expert block with joint attention,
  full expert pass, Euler step, full 10-step ODE loop, end-to-end
  prefill + ODE) is parity-tested against a PyTorch reference dump.
  All gates pass at cos > 0.9999.
- C++ + JS integration tests drive a real `pi05_base.gguf` through
  the production `Pi05Model::infer` / `VlaModel.run()` paths and
  assert the returned action chunk vs PyTorch's `ode.actions_final`
  (cos = 0.9999, rel-max < 5 % on CPU).
- First-cut limitations (intentional, called out in `pi05.cpp` and
  tracked as follow-ups): CPU backend only — the GPU sweep across
  Vulkan / Metal / OpenCL is a 0.2.x; only leading-contiguous valid
  prompt prefixes are accepted (proper additive attention mask
  pending); `gguf_init_from_file` malloc path instead of mmap fast
  path (mobile-targeted follow-up).
- New python tooling shipped under `packages/vla-ggml/scripts/`:
  `dump_pi05_activations.py` (the parity oracle that produced the
  fixture used by every milestone test) and `convert_pi05_to_gguf.py`
  (LeRobot/openpi checkpoint → GGUF, ~6.7 GB output for `pi05_base`).
- New JS integration test `test/integration/pi05.test.js` mirrors the
  shape of `addon.test.js` (exports surface, validator error paths,
  img-shape mismatch, end-to-end inference parity).

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
