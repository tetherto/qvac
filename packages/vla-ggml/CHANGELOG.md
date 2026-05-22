# Changelog

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
- GGUF load rejects malformed files with out-of-range hparams,
  mismatched `text_num_layers` / `expert_num_layers`, missing required
  tensors, or per-tensor `(offset, nbytes)` pointing outside the mmap
  region.
- Integration test includes a tolerance-based assertion against a
  committed PyTorch reference output and wires the shared performance
  reporter (`addonType: 'vla'`).
