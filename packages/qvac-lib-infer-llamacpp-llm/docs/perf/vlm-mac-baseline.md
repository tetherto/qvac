# VLM Mac Baseline Performance Report

**Date**: 2026-05-07
**Task**: QVAC-18293 — VLM inference benchmarking on local Mac (Apple Silicon)
**llama.cpp**: tag [`b9025`](https://github.com/ggml-org/llama.cpp/releases/tag/b9025) (commit [`eff06702`](https://github.com/ggml-org/llama.cpp/commit/eff06702b2a52e1020ea009ebd86cb9f5acabab5))

## Purpose

Establish a Mac Apple Silicon performance ceiling for VLM inference across the full model matrix (Gemma 4 + Qwen3.5-2B). Mac results serve as the upper-bound reference for mobile GPU optimization — compare these numbers against the mobile results in [`gemma4-vl-baseline.md`](./gemma4-vl-baseline.md) to quantify the mobile performance gap.

## Test Configuration

| Parameter | Value |
|-----------|-------|
| Context size | 4096 |
| Predicted tokens | 256 |
| Threads | 4 |
| Temperature | 0 |
| Seed | 42 |
| Jinja | enabled |
| Flash attention | off (auto) |
| Memory fitting | off (`-fit off`) |
| Runs per config | 1 warmup + 3 measured (median reported) |
| Cool-down | none (active cooling) |

### Device

| Property | Value |
|----------|-------|
| Chip | Apple M4 |
| GPU cores | 8 |
| Unified memory | 16 GB |
| macOS | 26.4.1 (Build 25E253) |
| Architecture | arm64 |
| Metal | Metal 4 (MTLGPUFamilyApple9) |
| BLAS | Accelerate framework |

### Models

Source: [unsloth/gemma-4-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF), [unsloth/gemma-4-E4B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF), [unsloth/Qwen3.5-2B-GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF)

| Model | Quant | File Size | mmproj |
|-------|-------|-----------|--------|
| Gemma 4 E2B | Q4_K_M | 2.9 GB | 940 MB (F16) |
| Gemma 4 E2B | Q8_0 | 4.7 GB | 940 MB (F16) |
| Gemma 4 E4B | Q4_K_M | 4.6 GB | 944 MB (F16) |
| Gemma 4 E4B | Q8_0 | 7.6 GB | 944 MB (F16) |
| Qwen3.5-2B | Q4_K_M | 1.2 GB | 637 MB (F16) |

### Test Images

| Image | Resolution | File Size |
|-------|-----------|-----------|
| elephant.jpg | 612 × 408 | 24 KB |
| fruitPlate.png | 2250 × 3000 | 9.7 MB |

### Prompt

```
Describe this image in detail.
```

## Results

### Gemma 4 E2B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Total (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|-----------|------|
| CPU | elephant | 2,113 | 424.35 | 38.74 | 2,782 | 9,196 | 3 |
| CPU | fruitPlate | 2,273 | 425.46 | 38.16 | 2,954 | 9,528 | 3 |
| Metal | elephant | 630 | 259.61 | 51.28 | 1,724 | 6,512 | 3 |
| Metal | fruitPlate | 653 | 260.89 | 51.25 | 1,765 | 6,603 | 3 |

### Gemma 4 E2B Q8_0

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Total (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|-----------|------|
| CPU | elephant | 1,941 | 422.74 | 25.18 | 2,613 | 12,677 | 3 |
| CPU | fruitPlate | 2,032 | 418.56 | 24.90 | 2,725 | 13,040 | 3 |
| Metal | elephant | 689 | 237.04 | 30.30 | 1,887 | 10,062 | 3 |
| Metal | fruitPlate | 708 | 224.35 | 30.68 | 2,001 | 10,221 | 3 |

### Gemma 4 E4B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Total (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|-----------|------|
| CPU | elephant | 4,370 | 353.32 | 17.64 | 5,174 | 19,803 | 3 |
| CPU | fruitPlate | 4,148 | 334.48 | 17.20 | 5,015 | 20,139 | 3 |
| Metal | elephant | 768 | 135.86 | 23.28 | 2,858 | 13,619 | 3 |
| Metal | fruitPlate | 840 | 131.40 | 21.91 | 3,048 | 14,482 | 3 |

### Gemma 4 E4B Q8_0

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Total (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|-----------|------|
| CPU | elephant | 3,881 | 251.04 | 12.12 | 5,012 | 26,824 | 3 |
| CPU | fruitPlate | 4,259 | 210.85 | 11.92 | 5,634 | 28,654 | 3 |
| Metal | elephant | 827 | 138.36 | 15.26 | 2,880 | 20,040 | 3 |
| Metal | fruitPlate | 884 | 133.09 | 15.12 | 3,063 | 20,367 | 3 |

### Qwen3.5-2B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Total (ms) | Runs | Output |
|---------|-------|------------|---------------|-------------|----------|-----------|------|--------|
| CPU | elephant | 1,922 | 127.36 | 32.74 | 4,003 | 10,144 | 3 | coherent |
| CPU | fruitPlate | — | — | — | — | — | 0 | **ctx overflow** |
| Metal | elephant | 417 | 323.59 | 51.83 | 1,236 | 5,947 | 3 | coherent |
| Metal | fruitPlate | — | — | — | — | — | 0 | **ctx overflow** |

> **Qwen3.5-2B + fruitPlate context overflow**: The 2250×3000 image produces 4,015 vision tokens (2 batches: 2,048 + 1,967). With the 4,096 context window, only ~80 tokens remain after vision encoding, far below the 256 predict target. The model begins generating but fails during decode with `init_batch: failed to prepare attention ubatches` / `failed to find a memory slot for batch of size 1`. This is an architecture limitation — Qwen3.5's `qwen3vl_merger` produces ~16× more tokens for fruitPlate (4,015) than for elephant (247).

## Metal vs CPU Decode Speedup

| Model | Quant | CPU Decode (t/s) | Metal Decode (t/s) | Speedup |
|-------|-------|-----------------|---------------------|---------|
| E2B | Q4_K_M | 38.74 | 51.28 | **1.32x** |
| E2B | Q8_0 | 25.18 | 30.30 | **1.20x** |
| E4B | Q4_K_M | 17.64 | 23.28 | **1.32x** |
| E4B | Q8_0 | 12.12 | 15.26 | **1.26x** |
| Qwen3.5-2B | Q4_K_M | 32.74 | 51.83 | **1.58x** |

## CPU Prefill vs Metal Prefill

| Model | Quant | CPU Prefill (t/s) | Metal Prefill (t/s) | Winner |
|-------|-------|------------------|---------------------|--------|
| E2B | Q4_K_M | 424.35 | 259.61 | **CPU (1.63x)** |
| E2B | Q8_0 | 422.74 | 237.04 | **CPU (1.78x)** |
| E4B | Q4_K_M | 353.32 | 135.86 | **CPU (2.60x)** |
| E4B | Q8_0 | 251.04 | 138.36 | **CPU (1.81x)** |
| Qwen3.5-2B | Q4_K_M | 127.36 | 323.59 | **Metal (2.54x)** |

## Vision Pipeline Speedup (Metal vs CPU)

| Model | Quant | CPU Vision (ms) | Metal Vision (ms) | Speedup |
|-------|-------|----------------|--------------------|---------| 
| E2B | Q4_K_M | 2,113 | 630 | **3.35x** |
| E2B | Q8_0 | 1,941 | 689 | **2.82x** |
| E4B | Q4_K_M | 4,370 | 768 | **5.69x** |
| E4B | Q8_0 | 3,881 | 827 | **4.69x** |
| Qwen3.5-2B | Q4_K_M | 1,922 | 417 | **4.61x** |

> Vision pipeline = image slice encoding + image batch decoding. CPU vision time includes large image decode overhead (1,300–3,800 ms) that is negligible on Metal (~2–90 ms).

## Cross-Platform Comparison (elephant.jpg, best backend per device)

| Model | Quant | Mac Metal (t/s) | iPhone 16e Metal (t/s) | S25 Best (t/s) | P9P Best (t/s) | Mac/16e | Mac/S25 | Mac/P9P |
|-------|-------|----------------|----------------------|---------------|----------------|---------|---------|---------|
| E2B | Q4_K_M | 51.28 | 27.24 | 14.95 (OpenCL) | 10.62 (Vulkan) | **1.88x** | **3.43x** | **4.83x** |
| E2B | Q8_0 | 30.30 | — (OOM) | 15.81 (CPU) | 7.91 (Vulkan) | — | **1.92x** | **3.83x** |
| E4B | Q4_K_M | 23.28 | — (OOM) | 9.34 (OpenCL) | 6.89 (Vulkan) | — | **2.49x** | **3.38x** |
| E4B | Q8_0 | 15.26 | — (OOM) | 8.03 (OpenCL) | 4.69 (Vulkan) | — | **1.90x** | **3.25x** |
| Qwen3.5-2B | Q4_K_M | 51.83 | — | — | 14.22 (Vulkan) | — | — | **3.64x** |

> Mobile results from [`gemma4-vl-baseline.md`](./gemma4-vl-baseline.md). iPhone 16e uses run-2 median. Qwen3.5-2B was not benchmarked on S25 or iPhone 16e in the main benchmark matrix; P9P produced garbled output. Mac and iPhone 16e both produce coherent Qwen3.5 output.

## TTFT Comparison (elephant.jpg)

| Model | Quant | Mac Metal (ms) | iPhone 16e Metal (ms) | S25 Best (ms) | P9P Best (ms) |
|-------|-------|---------------|---------------------|--------------|--------------|
| E2B | Q4_K_M | 1,724 | 3,492 | 5,732 (CPU) | 59,687 (Vulkan) |
| E2B | Q8_0 | 1,887 | — (OOM) | 4,755 (CPU) | 64,616 (CPU) |
| E4B | Q4_K_M | 2,858 | — (OOM) | 5,802 (CPU) | 68,280 (CPU) |
| E4B | Q8_0 | 2,880 | — (OOM) | 6,135 (CPU) | 66,924 (CPU) |
| Qwen3.5-2B | Q4_K_M | 1,236 | — | — | 45,798 (Vulkan) |

> Mac Metal TTFT is 2.0–2.1x faster than iPhone 16e, 2.1–3.3x faster than S25, and 23–37x faster than P9P.

## Key Observations

### 1. CPU prefill is faster than Metal for Gemma 4 on M4

The M4's CPU with Accelerate (BLAS) outperforms Metal for prefill across all Gemma 4 configurations — 1.6–2.6x faster. This is consistent with the iPhone 16e finding where CPU prefill also beats Metal (168 vs 126 t/s). The Accelerate framework's optimized matrix multiply routines outperform Metal compute shader dispatch overhead for the prefill phase, which processes many tokens in a single batch.

The exception is Qwen3.5-2B, where Metal prefill is 2.54x faster than CPU (324 vs 127 t/s). This may reflect differences in how the Qwen3.5 SSM+attention hybrid pipeline maps to Accelerate vs Metal.

### 2. Metal is always faster for decode

Metal consistently outperforms CPU for token generation (1.2–1.6x), with the advantage increasing for smaller models (Qwen3.5-2B Q4_K_M: 1.58x) and decreasing for larger Q8_0 quantizations (E2B Q8: 1.20x). Decode is fundamentally memory-bandwidth-bound (sequential single-token operations), and Metal has better bandwidth utilization than CPU-side BLAS.

### 3. Vision pipeline is dominated by image decode on CPU

On the CPU backend, image batch decoding takes 1,300–3,800 ms (the cross-attention/projection from vision to LLM embedding space), while on Metal it takes only 2–91 ms. Vision encoding (CLIP/SigLIP forward pass) is similar across backends (~600 ms). This means CPU vision time is 3–6x slower than Metal, driven entirely by the projection stage.

### 4. E4B Q8_0 fits comfortably on 16 GB Mac

The largest model (E4B Q8_0 at 7.6 GB + 944 MB mmproj = 8.5 GB) runs without issues on the 16 GB M4 Mac, unlike the 8 GB iPhone 16e where it cannot even be memory-mapped. Mac load times for E4B Q8_0 are high (~8–12s) due to the large memory allocation, but inference is stable.

### 5. Mac Metal is 1.9–4.8x faster than mobile GPUs for decode

Compared to the best mobile GPU result per device: Mac is 1.88x faster than iPhone 16e, 1.9–3.4x faster than S25, and 3.2–4.8x faster than P9P. The gap is larger for Q4_K_M (where the M4's larger GPU can better exploit parallelism) and smaller for Q8_0 (where memory bandwidth becomes the bottleneck on all platforms).

### 6. Qwen3.5-2B produces coherent output on Mac Metal

Qwen3.5-2B generates correct, detailed image descriptions on the M4 Mac — consistent with iPhone 16e but contradicting the garbled output seen on Pixel 9 Pro. This further narrows the garbled text issue to the ARM64 Android / Tensor G4 runtime rather than the model architecture. The SSM (Gated Delta Net) + attention hybrid works correctly on Apple Silicon (both macOS and iOS).

### 7. Qwen3.5-2B + large images overflows context

fruitPlate.png (2250×3000) generates 4,015 vision tokens via the `qwen3vl_merger` projector, nearly filling the entire 4,096 context. This is not a Mac-specific issue — the same overflow occurs on iPhone 16e and P9P. Gemma 4's projector produces only 284–290 tokens for the same images, demonstrating fundamentally different token-efficiency between the two vision architectures.

### 8. Q4_K_M vs Q8_0 decode tradeoff

| | E2B Q4 | E2B Q8 | Ratio | E4B Q4 | E4B Q8 | Ratio |
|--|--------|--------|-------|--------|--------|-------|
| Metal decode (t/s) | 51.28 | 30.30 | 1.69x | 23.28 | 15.26 | 1.53x |
| CPU decode (t/s) | 38.74 | 25.18 | 1.54x | 17.64 | 12.12 | 1.46x |

Q4_K_M is 1.5–1.7x faster than Q8_0 for decode on both backends. The speedup is slightly higher on Metal, suggesting GPU memory bandwidth is more saturated at Q8_0 sizes.

## Profiling: Metal System Trace (Mac M4)

**Date**: 2026-05-07
**Tool**: Xcode Instruments 26.0 — Metal System Trace (via `xcrun xctrace record --launch`)
**Device**: Mac (Apple M4, 8 GPU cores, 16 GB unified memory)
**Parameters**: `--ctx-size 4096 --predict 256 --gpu-layers 99 --threads 4 --temp 0 --seed 42 --jinja -fit off`
**Image**: elephant.jpg (612 × 408)

Unlike iPhone profiling (which requires manual Instruments GUI interaction), Mac profiling is fully automated via `xcrun xctrace record --launch`, which spawns the target process under Instruments and stops recording when the process exits.

### Trace Files

| Trace | Model | Size | Path |
|-------|-------|------|------|
| `mac-m4-gemma4-e2b-q4km.trace` | Gemma 4 E2B Q4_K_M | 597 MB | `vlm-benchmark/results/traces/` |
| `mac-m4-qwen3.5-2b-q4km.trace` | Qwen3.5-2B Q4_K_M | 480 MB | `vlm-benchmark/results/traces/` |

> Open in Instruments for GPU timeline, shader execution, and memory allocation analysis: `open <path>.trace`

### Metal GPU Configuration

| Property | Value |
|----------|-------|
| GPU | Apple M4 (MTL0) |
| GPU family | MTLGPUFamilyApple9 (1009), MTLGPUFamilyMetal4 (5002) |
| Unified memory | true |
| BFloat16 | true |
| Tensor cores | false (pre-M5) |
| Residency sets | true |
| Shared buffers | true |
| Fusion | true |
| Concurrency | true |
| Graph optimize | true |
| recommendedMaxWorkingSetSize | 12,713 MB |
| Free GPU memory at load | 12,123 MiB |

### Metal Memory Allocation

| Component | Gemma 4 E2B Q4_K_M | Qwen3.5-2B Q4_K_M |
|-----------|--------------------|--------------------|
| MTL0 model buffer | 2,948 MiB | 1,211 MiB |
| CPU mapped model buffer | 1,756 MiB | 398 MiB |
| MTL0 KV cache | 36 MiB (24 + 12) | 48 MiB |
| RS (recurrent state) buffer | — | 19 MiB |
| MTL0 compute buffer (LLM) | 519 MiB | 489 MiB |
| CPU compute buffer (LLM) | 34 MiB | 16 MiB |
| CLIP compute buffer (vision) | 101 MiB | 223 MiB |
| mmproj compute buffer (audio) | 154 MiB | — |
| **Total GPU resident (est.)** | **~3,758 MiB** | **~1,990 MiB** |
| Graph nodes (LLM) | 1,500 | 1,377 |
| Graph splits (LLM) | 2 | 2 |
| CLIP graph nodes | 940 | 736 |
| Layers offloaded | 36/36 | 25/25 |

> Gemma 4 uses ~3.8 GB of GPU memory (well within the 12.7 GB recommended limit). Qwen3.5-2B uses ~2.0 GB — about half. Both models fully offload all layers to GPU. Qwen3.5-2B has an additional 19 MiB recurrent state (RS) buffer for its SSM (Mamba/Gated Delta Net) layers, which Gemma 4 does not need.

### Mac vs iPhone 16e Metal — GPU Comparison

| Property | Mac M4 | iPhone 16e A18 |
|----------|--------|----------------|
| GPU family | Apple9, Metal4 | Apple9 |
| GPU cores | 8 | 5 |
| Unified memory | 16 GB | 8 GB (~5.7 GB usable) |
| recommendedMaxWorkingSetSize | 12,713 MB | ~5,727 MB |
| BFloat16 | yes | yes |
| Tensor cores | no (pre-M5) | no (pre-A19) |

### Profiling Phase Breakdown (elephant.jpg, Metal)

| Phase | Gemma 4 E2B Q4_K_M | Qwen3.5-2B Q4_K_M | Notes |
|-------|--------------------|--------------------|-------|
| Model load | 280 ms | 191 ms | mmap + Metal buffer allocation |
| Vision encode (CLIP) | 611 ms | 415 ms | SigLIP / Qwen3VL encoder on Metal |
| Image decode (projection) | 19 ms | 2 ms | gemma4a cross-attn vs qwen3vl_merger |
| Prefill | 1,094 ms (284 tok, 260 t/s) | 807 ms (265 tok, 329 t/s) | LLM prompt processing |
| Decode | 4,973 ms (255 tok, 51.3 t/s) | 4,920 ms (255 tok, 51.8 t/s) | Autoregressive token generation |
| **Total** | **6,512 ms** | **5,947 ms** | End-to-end |

### Profiling Observations

1. **Decode throughput is identical between models** (~51.5 t/s). Despite different architectures (pure attention vs hybrid attention+SSM) and model sizes (2.9 GB vs 1.2 GB), the Metal decode bottleneck is the same — memory bandwidth for single-token KV lookups. The M4's memory bandwidth (~120 GB/s) saturates equally for both model sizes at this quantization level.

2. **Vision encode is 32% faster on Qwen3.5** (415 ms vs 611 ms). The Qwen3.5 CLIP encoder is smaller (637 MB mmproj, 736 graph nodes) than Gemma 4's SigLIP encoder (940 MB mmproj, 940 graph nodes), with fewer layers and parameters.

3. **Qwen3.5 image projection is near-instant** (2 ms vs 19 ms). The `qwen3vl_merger` projects vision tokens more efficiently than Gemma 4's `gemma4a` cross-attention projector on Mac Metal. This is the opposite of the iPhone 16e finding (183 ms vs 36 ms with `--predict 128`), suggesting the Mac's larger GPU handles the merger's parallel operations much better.

4. **Prefill is 27% faster on Qwen3.5** (329 t/s vs 260 t/s) despite similar token counts (265 vs 284). The 25-layer Qwen3.5 model (1.2 GB) has less computation per layer than the 34-layer Gemma 4 E2B (2.9 GB), and the SSM layers may be more parallelizable on Metal.

5. **GPU memory headroom is substantial**. Gemma 4 E2B uses ~3.8 GB of 12.7 GB available (30%), Qwen3.5-2B uses ~2.0 GB (16%). E4B Q8_0 (the largest model at ~8.5 GB total) would consume ~67% — still within limits. This contrasts with iPhone 16e where E2B Q4_K_M alone consumes ~65% of available GPU memory.

6. **Graph splits = 2 for both models** indicates that llama.cpp splits the compute graph between GPU and CPU for both models. The CPU handles a small portion (34 MiB / 16 MiB compute buffers vs 519 MiB / 489 MiB on GPU), likely embedding lookups and final output projection.

7. **Qwen3.5 has a recurrent state (RS) buffer** (19 MiB) for its SSM layers — a unique memory allocation not present in Gemma 4. This RS buffer stores Mamba/Gated Delta Net internal state and grows with sequence length. On memory-constrained devices, this additional allocation could contribute to OOM.

## Methodology Notes

### TTFT Derivation

TTFT = vision pipeline time + (prompt tokens / prefill t/s × 1000) ms

Vision pipeline time = image slice encoding + image batch decoding. Prompt token counts: 284 for elephant.jpg (Gemma 4), 290 for fruitPlate.png (Gemma 4), 265 for elephant.jpg (Qwen3.5-2B).

### Vision (ms) Column

Vision (ms) = image slice encoding time + image batch decoding time. The encoding phase runs the CLIP/SigLIP vision encoder; the decoding phase projects vision embeddings into the LLM embedding space via cross-attention (Gemma 4 `gemma4a`) or merger (Qwen3.5 `qwen3vl_merger`).

### Build Configuration

```
cmake .. -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON
```

Native arm64 build with Metal and Accelerate (BLAS) backends. Metal shaders embedded via `GGML_METAL_EMBED_LIBRARY=ON` (default). No cross-compilation.

### Measurement Protocol

- Median of 3 measured runs reported (warmup run discarded)
- No cool-down between runs (Mac has active cooling — thermal throttling is not a concern)
- Qwen3.5-2B fruitPlate tests attempted but failed on both CPU and Metal (context overflow)
- Raw logs saved to `vlm-benchmark/results/raw/mac/`
- Metal profiling traces captured via `xcrun xctrace record --template "Metal System Trace" --launch` (automated — no manual GUI interaction)
- Trace files saved to `vlm-benchmark/results/traces/` (mac-m4-gemma4-e2b-q4km.trace, mac-m4-qwen3.5-2b-q4km.trace)
- Metal GPU configuration and memory allocation data extracted from benchmark logs (llama.cpp Metal init output)
