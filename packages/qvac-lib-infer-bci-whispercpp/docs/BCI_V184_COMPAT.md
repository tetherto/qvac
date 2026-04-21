# BCI whisper.cpp v1.8.4 Compatibility

## Goal

Get the BCI addon working on whisper.cpp v1.8.4.1 (from `tetherto/qvac-ext-lib-whisper.cpp`) instead of the current v1.7.6 (from `ggml-org/whisper.cpp`).

## Status: FIXED

| Version | Source | WER | Status |
|---------|--------|-----|--------|
| v1.7.6 (`a8d002cf`) | `ggml-org/whisper.cpp` + 4 overlay patches | **10.4%** | Working |
| v1.8.4.1 (unpatched) | `tetherto/qvac-ext-lib-whisper.cpp` + BCI patches | **91.9%** | Broken (garbage output) |
| v1.8.4.1 (patched) | `tetherto/qvac-ext-lib-whisper.cpp` + BCI patches + `0005` fix | **10.4%** | Working (identical to v1.7.6) |

## Root Cause

The issue was **not** in the ggml submodule. It was a **graph placement bug** introduced when the BCI windowed attention patch was ported from v1.7.6 to v1.8.4.

In v1.7.6, `whisper_encode_internal` built a single monolithic computation graph for the entire encoder. The BCI windowed attention patch added:
1. A `window_mask` tensor created in the graph builder
2. Mask data population via `ggml_graph_get_tensor(gf, "window_mask")` after graph allocation, before graph computation

In v1.8.4, the encoder was refactored into **three separate computation graphs**:
1. `whisper_build_graph_conv` — convolution layers
2. `whisper_build_graph_encoder` — self-attention encoder layers
3. `whisper_build_graph_cross` — cross-attention KV pre-computation

The BCI patch correctly placed the `window_mask` tensor creation in `whisper_build_graph_encoder` (step 2), but the mask **data population** code was placed in the **cross-attention section** (step 3) of `whisper_encode_internal`. Since the cross graph doesn't contain a `window_mask` tensor, `ggml_graph_get_tensor(gf, "window_mask")` returned `nullptr`, and the mask was never initialized. The encoder ran with an uninitialized attention mask, producing garbage output.

## Fix

Patch `0005-fix-bci-window-mask-encoder-graph.patch` moves the `window_mask` data population from the cross-attention section to the encoder section of `whisper_encode_internal`, between `ggml_backend_sched_alloc_graph` and `ggml_graph_compute_helper`.

## What Was Ruled Out (previously investigated)

1. **Flash attention default change** — v1.8.4 sets `flash_attn = true` by default (was `false` in v1.7.6). The BCI patch already bypasses flash attention when `window_mask` is active.

2. **`ggml_mul_mat_pad` removal** — v1.7.6 had a Metal-specific matrix multiplication padding optimization. Restoring this to v1.8.4 does not fix the quality issue.

3. **Decoder prompt handling changes** — v1.8.4 refactored `prompt_past` into `prompt_past0`/`prompt_past1` for the `carry_initial_prompt` feature. BCI transcriptions are single-segment and the first-segment codepath is functionally equivalent.

4. **KQ mask padding removal** — v1.8.4 removed `GGML_KQ_MASK_PAD` from the decoder attention mask.

5. **ggml submodule changes** — 1,190 commits changed the ggml library between v1.7.6 and v1.8.4.1, but this was not the cause.

## Fork PR

[tetherto/qvac-ext-lib-whisper.cpp#10](https://github.com/tetherto/qvac-ext-lib-whisper.cpp/pull/10) — BCI patches (conv1 kernel + windowed attention + flash attn bypass) on v1.8.4.1 base. Needs the `0005` fix patch applied.

## Files

- BCI model: `models/ggml-bci-windowed.bin`
- Embedder weights: `models/bci-embedder.bin`
- Conversion script: `scripts/convert-model.py`
- Overlay portfile: `vcpkg-overlays/whisper-cpp/portfile.cmake` (points to `tetherto/qvac-ext-lib-whisper.cpp` at the merged master commit `2b1e04f20bad9a72321e72df8d6a8c14aae98adc`)
- Test: `test/integration/addon.test.js`
