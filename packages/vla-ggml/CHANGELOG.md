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
- Input validation hardened: `model.run()` now rejects mismatched
  `imgWidth` / `imgHeight` (must equal `hparams.visionImageSize`) at both
  the JS and C++ layers, instead of letting the conv2d/reshape mismatch
  trip a `GGML_ASSERT` that hard-aborts the worker. Equivalent guards
  added for `n_images`, `lang_len`, and `state_dim`.
- GGUF load hardened: rejects malformed files with out-of-range hparams,
  mismatched `text_num_layers` / `expert_num_layers`, or any missing
  required tensor, instead of null-dereffing on the first inference.
  Per-tensor mmap-bounds check rejects crafted GGUFs whose tensor
  `(offset, nbytes)` would point outside the mapped region.
- Inference path returns a clean `false` (and surfaces an `Error` event
  to JS) when any ggml graph allocation fails, instead of computing
  against a partially-initialised graph.
- `_hasActiveResponse` clearing migrated to `.finally()` on the response
  promise so a worker abort can't wedge subsequent `run()` calls with
  `JOB_ALREADY_RUNNING`. Mirrors the pattern used by
  `qvac-lib-infer-llamacpp-llm`.
- `smolvla_load_model` split from one 600-line function into a ~125-line
  orchestrator plus 9 file-static helpers; RAII guards for `FILE*` /
  `gguf_context` / fd close out every error branch automatically.
- Bumped `qvac-fabric` to `>=8189.0.2` and
  `qvac-lib-inference-addon-cpp` to `>=1.1.7#1`. The new addon-cpp port
  renamed its include namespace from `qvac-lib-inference-addon-cpp/*` to
  `inference-addon-cpp/*`; lint-cpp moved its config from
  `share/qvac-lint-cpp/` to `share/lint-cpp/`. Source/CMakeLists updated
  to match.

## 0.1.0

- Initial release of `@qvac/vla-ggml`. Ports the SmolVLA vision-language-action
  model to ggml with Vulkan / Metal / OpenCL / CPU backends. Bundles the
  full SigLIP vision encoder, SmolLM2 text tower, action expert, and
  10-step flow-matching ODE in a single Bare addon.
