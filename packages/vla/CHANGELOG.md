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

- Initial hello-world scaffold for `@qvac/vla`.
