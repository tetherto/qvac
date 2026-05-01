# Changelog

## 0.2.0

- `VlaModel.run()` now returns `{ actions, stats }` instead of a raw
  `Float32Array`. The `stats` object carries per-stage wall-clock timings
  (`vision_ms`, `smollm2_compute_ms`, `smollm2_total_ms`, `ode_ms`,
  `total_ms`) captured during inference.
- Integration test: added tolerance-based assertion against a committed
  PyTorch reference output (`test/integration/assets/pt_actions_libero_fixed.json`)
  and wired the shared performance reporter
  (`scripts/test-utils/performance-reporter.js`, `addonType: 'vla'`).

## 0.1.0

- Initial release of `@qvac/vla`. Ports the SmolVLA vision-language-action
  model to ggml with Vulkan / Metal / OpenCL / CPU backends. Bundles the
  full SigLIP vision encoder, SmolLM2 text tower, action expert, and
  10-step flow-matching ODE in a single Bare addon.
