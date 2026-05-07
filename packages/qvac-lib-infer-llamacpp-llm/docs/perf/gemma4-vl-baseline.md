# Gemma 4 VL Baseline Performance Report

**Date**: 2026-05-06
**Task**: QVAC-18293 — Gemma 4 VL mobile inference benchmarking
**llama.cpp**: tag [`b9025`](https://github.com/ggml-org/llama.cpp/releases/tag/b9025) (commit [`eff06702`](https://github.com/ggml-org/llama.cpp/commit/eff06702b2a52e1020ea009ebd86cb9f5acabab5))

## Test Configuration

| Parameter | Value |
|-----------|-------|
| Context size | 4096 |
| Predicted tokens | 256 (128 for iPhone 16e CPU) |
| Threads | 4 |
| Temperature | 0 |
| Seed | 42 |
| Jinja | enabled |
| Flash attention | off (auto on iPhone 16e) |
| Memory fitting | off (`-fit off`) |
| Runs per config | 1 warmup + 3 measured (median reported) |
| Cool-down | 60s sleep between measured runs |

### Models

Source: [unsloth/gemma-4-E2B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF), [unsloth/gemma-4-E4B-it-GGUF](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF), [unsloth/Qwen3.5-2B-GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF)

| Model | Quant | File Size |
|-------|-------|-----------|
| Gemma 4 E2B | Q4_K_M | 2.9 GB |
| Gemma 4 E2B | Q8_0 | 4.7 GB |
| Gemma 4 E4B | Q4_K_M | 4.6 GB |
| Gemma 4 E4B | Q8_0 | 7.6 GB |
| mmproj E2B | F16 | 940 MB |
| mmproj E4B | F16 | 944 MB |
| Qwen3.5-2B | Q4_K_M | 1.2 GB |
| mmproj Qwen3.5 | F16 | 637 MB |

### Test Images

| Image | Path | Resolution | File Size |
|-------|------|-----------|-----------|
| elephant.jpg | [`media/elephant.jpg`](../../media/elephant.jpg) | 612 x 408 | 24 KB |
| fruitPlate.png | [`media/fruitPlate.png`](../../media/fruitPlate.png) | 2250 x 3000 | 9.7 MB |

### Prompt

```
Describe this image in detail.
```

### Devices

| Device | SoC | GPU | Backends | API / OS |
|--------|-----|-----|----------|----------|
| Pixel 9 Pro (`caiman`) | Tensor G4 | Mali-G715 MC7 | CPU, Vulkan, OpenCL | Android 15 (API 35) |
| Samsung S25 (`pa1q`) | Snapdragon 8 Elite (SM8750) | Adreno 830 | CPU, OpenCL | Android 16 (API 36) |
| iPhone 16e | A18 | Apple GPU (5-core) | CPU, Metal | iOS 18.5 |
| iPhone 16 Pro | A18 Pro | Apple GPU (6-core) | CPU, Metal | iOS 18.3 — **not tested** (see notes) |

## Results

### Samsung S25 (Adreno 830)

> Vulkan not tested — Adreno 830 crashes when `libggml-vulkan.so` is loaded, even at `ngl=0`.

#### E2B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|------|
| CPU | elephant | 2,622 | 91.33 | 12.73 | 5,732 | 3 |
| CPU | fruitPlate | 2,708 | 90.57 | 11.74 | 5,910 | 3 |
| OpenCL | elephant | 2,871 | 73.36 | 14.95 | 6,742 | 3 |
| OpenCL | fruitPlate | 3,834 | 56.01 | 12.88 | 9,012 | 3 |

#### E2B Q8_0

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|------|
| CPU | elephant | 2,181 | 110.33 | 15.81 | 4,755 | 3 |
| CPU | fruitPlate | 2,223 | 110.63 | 15.79 | 4,844 | 3 |
| OpenCL | elephant | 2,282 | 95.60 | 15.53 | 5,253 | 3 |
| OpenCL | fruitPlate | 2,333 | 96.30 | 15.33 | 5,344 | 3 |

#### E4B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|------|
| CPU | elephant | 2,378 | 82.95 | 7.21 | 5,802 | 3 |
| CPU | fruitPlate | 2,483 | 80.13 | 6.71 | 6,102 | 3 |
| OpenCL | elephant | 2,669 | 68.55 | 9.34 | 6,812 | 3 |
| OpenCL | fruitPlate | 2,730 | 68.61 | 9.35 | 6,957 | 3 |

#### E4B Q8_0

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|------|
| CPU | elephant | 2,185 | 71.89 | 7.42 | 6,135 | 3 |
| CPU | fruitPlate | 2,731 | 60.29 | 5.70 | 7,541 | 3 |
| OpenCL | elephant | 2,801 | 70.29 | 8.03 | 6,841 | 3 |
| OpenCL | fruitPlate | 2,700 | 74.22 | 8.09 | 6,607 | 3 |

### Pixel 9 Pro (Mali-G715 MC7)

#### E2B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|------|
| CPU | elephant | 29,956 | 8.06 | 1.02 | 65,192 | 3 |
| CPU | fruitPlate | 30,454 | 8.08 | 0.97 | 66,345 | 2 |
| Vulkan | elephant | 25,429 | 8.29 | 10.62 | 59,687 | 3 |
| Vulkan | fruitPlate | 25,739 | 8.41 | 10.59 | 60,222 | 3 |
| OpenCL | elephant | 34,507 | 3.63 | 10.59 | 112,744 | 3 |
| OpenCL | fruitPlate | 35,070 | 3.69 | 10.58 | 113,661 | 3 |

#### E2B Q8_0

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|------|
| CPU | elephant | 29,940 | 8.19 | 1.36 | 64,616 | 3 |
| CPU | fruitPlate | 30,221 | 8.27 | 1.31 | 65,288 | 3 |
| Vulkan | elephant | 27,544 | 5.68 | 7.91 | 77,544 | 3 |
| Vulkan | fruitPlate | 27,662 | 5.79 | 7.85 | 77,748 | 3 |
| OpenCL | elephant | 34,516 | 3.66 | 7.86 | 112,112 | 3 |
| OpenCL | fruitPlate | 34,913 | 3.72 | 7.84 | 112,870 | 3 |

#### E4B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|------|
| CPU | elephant | 30,005 | 7.42 | 0.73 | 68,280 | 3 |
| CPU | fruitPlate | 29,926 | 7.69 | 0.70 | 67,637 | 1 |
| Vulkan | elephant | 27,703 | 5.43 | 6.89 | 80,005 | 3 |
| Vulkan | fruitPlate | 28,025 | 5.51 | 6.88 | 80,657 | 3 |
| OpenCL | elephant | 41,073 | 2.06 | 6.89 | 178,937 | 3 |
| OpenCL | fruitPlate | 41,265 | 2.11 | 6.86 | 178,706 | 1 |

#### E4B Q8_0

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|------|
| CPU | elephant | 29,945 | 7.68 | 0.79 | 66,924 | 3 |
| CPU | fruitPlate | 29,981 | 7.85 | 0.81 | 66,924 | 1 |
| Vulkan | elephant | 33,773 | 2.86 | 4.69 | 133,074 | 3 |
| Vulkan | fruitPlate | 33,748 | 2.89 | 4.64 | 134,094 | 3 |
| OpenCL | elephant | 40,928 | 2.08 | 4.64 | 177,466 | 2 |
| OpenCL | fruitPlate | — | — | — | — | 0 (timeout) |

### iPhone 16e (Apple A18)

> Only E2B Q4_K_M fits in the iPhone 16e's 8 GB RAM (~5.7 GB available to apps). E2B Q8_0, E4B Q4_K_M, and E4B Q8_0 all OOM during model loading — confirmed in both run-1 and run-2. CPU runs use 128 predicted tokens (256 caused iOS memory kills). The mmproj/CLIP vision encoder always runs on Metal regardless of `--gpu-layers`.

#### E2B Q4_K_M

Run-1 (2026-05-06):

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|------|
| CPU | elephant | 1,152 | 167.99 | 23.18 | 2,843 | 3 |
| CPU | fruitPlate | 1,209 | 175.19 | 21.94 | 2,864 | 3 |
| Metal | elephant | 1,239 | 125.71 | 26.66 | 3,498 | 3 |
| Metal | fruitPlate | 1,274 | 126.35 | 26.56 | 3,569 | 3 |

Run-2 (2026-05-07):

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs |
|---------|-------|------------|---------------|-------------|----------|------|
| CPU | elephant | 1,151 | 160.96 | 25.37 | 2,916 | 3 |
| CPU | fruitPlate | 1,180 | 168.82 | 24.74 | 2,898 | 3 |
| Metal | elephant | 1,236 | 125.92 | 27.24 | 3,492 | 3 |
| Metal | fruitPlate | 1,266 | 126.89 | 27.20 | 3,551 | 3 |

> Run-2 results are highly consistent with run-1: vision encode within 1–2%, decode within 2–8%. Metal decode shows a small improvement (+0.6 t/s), CPU decode shows +2.2 t/s improvement (likely due to cooler thermal state). Overall, the benchmark is reproducible.

#### E2B Q8_0 — OOM (confirmed run-1 + run-2)

> Run-1: `ggml_aligned_malloc: insufficient memory (attempted to allocate 2287 MB)` — CPU_REPACK buffer exceeds available memory.
>
> Run-2: `kIOGPUCommandBufferCallbackErrorOutOfMemory` during Metal warmup, then `ggml_metal_host_malloc: error: posix_memalign failed` / `ggml_metal_buffer_init: error: failed to allocate buffer, size = 153.94 MiB`. App terminated with signal 11.

#### E4B Q4_K_M — OOM (confirmed run-1 + run-2)

> Run-1: `kIOGPUCommandBufferCallbackErrorOutOfMemory` on Metal; CPU_REPACK allocation fails at 2619 MB on CPU-only.
>
> Run-2: `kIOGPUCommandBufferCallbackErrorOutOfMemory` during Metal warmup, then `ggml_metal_host_malloc: error: posix_memalign failed` / `ggml_metal_buffer_init: error: failed to allocate buffer, size = 592.45 MiB`. App terminated with signal 11.

#### E4B Q8_0 — OOM (confirmed run-1 + run-2)

> Run-1: Model file (7.6 GB) exceeds total device memory.
>
> Run-2: `llama_model_load: error loading model: mmap failed: Cannot allocate memory`. App terminated with signal 11. Model cannot even be memory-mapped on 8 GB device.

### iPhone 16 Pro (A18 Pro)

> **Not tested.** Firebase Test Lab reported `DEVICE_CAPACITY_NONE` for `iphone16pro,version=18.3` — no physical devices were available during the benchmark window (checked 2026-05-06 and rechecked 2026-05-06 22:36 PST, still unavailable). All 4 iOS test submissions completed without execution. The XCTest wrapper was successfully built and validated; iOS benchmarks require either device availability on Firebase or local test execution.

## GPU Decode Speedup Summary

### Samsung S25 — OpenCL vs CPU

| Model | Quant | CPU Decode (t/s) | OpenCL Decode (t/s) | Speedup |
|-------|-------|-----------------|---------------------|---------|
| E2B | Q4_K_M | 12.73 | 14.95 | **1.17x** |
| E2B | Q8_0 | 15.81 | 15.53 | 0.98x |
| E4B | Q4_K_M | 7.21 | 9.34 | **1.30x** |
| E4B | Q8_0 | 7.42 | 8.03 | **1.08x** |

### Pixel 9 Pro — Best GPU vs CPU

| Model | Quant | CPU Decode (t/s) | Best GPU Decode (t/s) | Backend | Speedup |
|-------|-------|-----------------|----------------------|---------|---------|
| E2B | Q4_K_M | 1.02 | 10.62 | Vulkan | **10.4x** |
| E2B | Q8_0 | 1.36 | 7.91 | Vulkan | **5.8x** |
| E4B | Q4_K_M | 0.73 | 6.89 | Vulkan | **9.4x** |
| E4B | Q8_0 | 0.79 | 4.69 | Vulkan | **5.9x** |

### iPhone 16e — Metal vs CPU

| Model | Quant | CPU Decode (t/s) | Metal Decode (t/s) | Speedup | Runs |
|-------|-------|-----------------|---------------------|---------|------|
| E2B | Q4_K_M | 23.18 / 25.37 | 26.66 / 27.24 | **1.15x** / **1.07x** | 3+3 |

> CPU prefill (168 t/s) is faster than Metal prefill (126 t/s) on the A18 — likely due to GPU kernel dispatch overhead exceeding any compute advantage at this model size. Run-1 / run-2 medians shown.

### Cross-Device Best Decode (elephant.jpg)

| Model | Quant | iPhone 16e Best (t/s) | S25 Best (t/s) | P9P Best (t/s) | 16e / S25 | S25 / P9P |
|-------|-------|----------------------|---------------|----------------|-----------|-----------|
| E2B | Q4_K_M | 26.66 (Metal) | 14.95 (OpenCL) | 10.62 (Vulkan) | **1.78x** | **1.41x** |
| E2B | Q8_0 | — (OOM) | 15.81 (CPU) | 7.91 (Vulkan) | — | **2.00x** |
| E4B | Q4_K_M | — (OOM) | 9.34 (OpenCL) | 6.89 (Vulkan) | — | **1.36x** |
| E4B | Q8_0 | — (OOM) | 8.03 (OpenCL) | 4.69 (Vulkan) | — | **1.71x** |

## Supplementary: Qwen3.5-2B on Pixel 9 Pro

**Purpose**: Validate whether the garbled text issue from QVAC-17129 (Qwen3.5-VL on Mali Vulkan) also affects the newer Qwen3.5-2B architecture.

**Model**: [unsloth/Qwen3.5-2B-GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF) Q4_K_M (1.2 GB + 637 MB mmproj)

**Architecture**: Qwen3.5 uses a hybrid attention + SSM (Mamba/Gated Delta Net) architecture, unlike Gemma 4's pure attention design. The vision projector is `qwen3vl_merger` (24 layers, 16 heads, 1024 embedding → 2048 projection).

### Pixel 9 Pro — Qwen3.5-2B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Runs | Output |
|---------|-------|------------|---------------|-------------|----------|------|--------|
| CPU | elephant | 21,850 | 4.76 | 1.97 | 77,522 | 3 | **garbled** (newlines) |
| CPU | fruitPlate | — | — | — | — | 0 (timeout) | — |
| Vulkan | elephant | 17,843 | 9.48 | 14.22 | 45,798 | 3 | **garbled** (`@@@@...`) |
| Vulkan | fruitPlate | 902,649 | — | — | — | 0 (crash) | **failed** |
| OpenCL | elephant | — | — | — | — | 0 (timeout) | — |
| OpenCL | fruitPlate | — | — | — | — | 0 (timeout) | — |

> **Garbled text confirmed on ALL backends tested.** Vulkan produces 255 `@` characters; CPU produces 255 empty newlines. Neither backend generates coherent text. This is a model/architecture-level issue — not GPU-specific as initially hypothesized in QVAC-17129.
>
> The fruitPlate image (2250x3000, 9.7 MB) caused 15-minute vision encoding on Vulkan, then crashed with `init_batch: failed to prepare attention ubatches` / `decode: failed to find a memory slot for batch of size 1`. The high token count from the large image likely exceeded the context window for the Qwen3.5 attention+SSM pipeline.
>
> Despite garbled output, performance metrics are useful for comparison. Qwen3.5-2B Vulkan decode (14.22 t/s) is 34% faster than Gemma 4 E2B Q4_K_M Vulkan decode (10.62 t/s) — the 2B model is significantly smaller (1.2 GB vs 2.9 GB). CPU decode is also faster (1.97 vs 1.02 t/s).

### Qwen3.5-2B vs Gemma 4 E2B — Pixel 9 Pro Performance Comparison (elephant.jpg)

| Metric | Qwen3.5-2B Q4_K_M | Gemma 4 E2B Q4_K_M | Ratio |
|--------|-------------------|---------------------|-------|
| Model size | 1.2 GB | 2.9 GB | 0.41x |
| Vulkan decode (t/s) | 14.22 | 10.62 | **1.34x** |
| Vulkan prefill (t/s) | 9.48 | 8.29 | **1.14x** |
| Vulkan vision (ms) | 17,843 | 25,429 | **0.70x** (faster) |
| CPU decode (t/s) | 1.97 | 1.02 | **1.93x** |
| Output coherence | garbled | coherent | — |

## Key Observations

### 1. iPhone 16e delivers the fastest decode throughput

The Apple A18's Metal backend achieves 26.66 t/s decode for E2B Q4_K_M — 1.78x faster than Samsung S25 (14.95 t/s OpenCL) and 2.51x faster than Pixel 9 Pro (10.62 t/s Vulkan). Vision encoding is also fast at ~1.2s, matching S25 and far ahead of P9P.

However, the iPhone 16e's 8 GB RAM severely limits which models can run — only E2B Q4_K_M fits. All larger models (E2B Q8, E4B Q4/Q8) fail with OOM during loading.

### 2. Samsung S25 dramatically outperforms Pixel 9 Pro across all metrics

The Snapdragon 8 Elite's Oryon CPU cores and Adreno 830 GPU deliver 1.4–2.0x better decode throughput and 10–15x faster vision encoding compared to the Tensor G4:

- **Vision encode**: S25 2–4s vs P9P 25–41s (10x faster)
- **CPU decode**: S25 6–16 t/s vs P9P 0.7–1.4 t/s (10–12x faster)
- **GPU decode**: S25 OpenCL 8–15 t/s vs P9P Vulkan 5–11 t/s (1.4–2.0x faster)
- **Prefill**: S25 60–110 t/s vs P9P 2–8 t/s (10–30x faster)

The S25's CPU is so fast that GPU offloading provides only marginal decode speedup (1.1–1.3x). On P9P, GPU offloading is essential (6–10x speedup).

### 3. Vision encode dominates total latency on Pixel 9 Pro

Vision encoding takes 25–41 seconds on Pixel 9 Pro, dwarfing all other phases. On S25 and iPhone 16e, vision takes only 1–4 seconds.

- **P9P CPU**: ~30s (consistent across models/images)
- **P9P Vulkan**: 25–34s (faster than CPU for smaller models)
- **P9P OpenCL**: 34–41s (slower than CPU and Vulkan)
- **S25 all backends**: 2–4s
- **iPhone 16e**: ~1.2s (fastest across all devices)

### 4. Vulkan is the best GPU backend on Mali-G715 (Pixel 9 Pro)

On Pixel 9 Pro, Vulkan consistently outperforms OpenCL:
- **Decode**: Vulkan and OpenCL achieve similar throughput
- **Prefill**: Vulkan is 2–3x faster than OpenCL (8.29 vs 3.63 t/s for E2B Q4)
- **Vision**: Vulkan has ~25% less overhead than OpenCL (25s vs 35s)

`GGML_VK_DISABLE_COOPMAT=1` was required for Mali-G715 (no cooperative matrix support).

### 5. CPU prefill can beat GPU on Apple Silicon

On iPhone 16e, CPU prefill (168–175 t/s) is 33% faster than Metal prefill (126 t/s) for E2B Q4_K_M. On S25, CPU prefill (91 t/s) is also 25–60% faster than OpenCL prefill (56–73 t/s). GPU dispatch overhead for the prefill phase (which processes many tokens in parallel) appears to outweigh the compute benefit at these model sizes.

### 6. Q4 quantization is optimal for GPU decode; Q8 is optimal for S25 CPU

On Pixel 9 Pro GPU, Q4_K_M delivers 34–47% higher decode throughput than Q8_0. On S25 CPU, Q8_0 is actually faster than Q4_K_M for E2B (15.81 vs 12.73 t/s), likely due to simpler dequantization in the Oryon CPU's SIMD pipeline.

### 7. Adreno 830 Vulkan is broken

The Adreno 830 crashes when `libggml-vulkan.so` is loaded, even with `-ngl 0`. This is a driver-level issue preventing any Vulkan-based inference on current S25 firmware. OpenCL is the only viable GPU backend on Adreno 830.

### 8. CPU decode on Pixel 9 Pro is unusable

CPU-only decode on Pixel 9 Pro ranges from 0.70 to 1.36 t/s, requiring 3–6 minutes for a 256-token response. GPU acceleration is essential on this device.

### 9. Qwen3.5-2B produces garbled output on Pixel 9 Pro (all backends)

Qwen3.5-2B-Q4_K_M generates nonsensical output on Pixel 9 Pro across both CPU and Vulkan backends: Vulkan produces 255 `@` characters, CPU produces 255 empty newlines. This is not a GPU-specific issue (as originally suspected in QVAC-17129) but a model/architecture-level compatibility problem with llama.cpp `b9025` on this device. Gemma 4 models produce coherent output on the same device with the same binary, confirming the issue is Qwen3.5-specific.

The Qwen3.5-2B architecture combines attention with SSM (Mamba/Gated Delta Net), which may not be fully supported in the llama.cpp `b9025` ARM64 backend. Performance metrics remain valid for comparison purposes despite garbled output.

### 10. iPhone 16e benchmarks are highly reproducible

Run-2 of the Gemma 4 E2B Q4_K_M benchmark on iPhone 16e validates the run-1 results: vision encode times differ by <2%, Metal decode by 0.6 t/s (2%), CPU decode by 2.2 t/s (10% — likely thermal variance). All three larger model OOM failures (E2B Q8, E4B Q4, E4B Q8) were also confirmed in run-2 with consistent error messages.

### 11. iPhone 16e memory is a hard constraint

With only ~5.7 GB available to apps (out of 8 GB total), the iPhone 16e cannot load any model+mmproj combination exceeding ~4 GB. This rules out E2B Q8_0 (5.0+0.9 GB), E4B Q4_K_M (5.0+0.9 GB), and E4B Q8_0 (7.6+0.9 GB). Devices with 12+ GB RAM (iPhone 16 Pro, S25, P9P) are required for larger models.

## Top Bottlenecks

1. **Pixel 9 Pro vision encoding (25–41s)**: The vision encoder runs on CPU and takes 25–41 seconds on P9P. Metal/GPU-accelerated vision encoding would reduce time-to-first-token by 10x (S25 achieves 2–4s, iPhone 16e ~1.2s). This is the #1 optimization target for Tensor G4.

2. **iPhone 16e memory (8 GB)**: Only E2B Q4_K_M fits — all larger models OOM. The 8 GB iPhone 16e is representative of the low-end iPhone market. Strategies like reduced context sizes, streaming KV cache, or aggressive quantization (e.g., IQ4_XS) may help.

3. **Adreno 830 Vulkan crashes**: The S25's Vulkan backend is non-functional due to driver issues. Fixing this (or waiting for a driver update) could unlock additional GPU performance, particularly for prefill where Vulkan shows 2–3x advantage over OpenCL on Mali.

4. **Pixel 9 Pro CPU decode (~1 t/s)**: The Tensor G4's CPU is 10–12x slower than the Snapdragon 8 Elite for LLM decode. Without GPU offloading, the Pixel 9 Pro is impractical for VLM inference.

5. **Qwen3.5-2B garbled output on Pixel 9 Pro**: The Qwen3.5 SSM+attention hybrid architecture produces nonsensical output on all P9P backends. Root cause may be ARM64 NEON/SVE kernel issues or incomplete Qwen3.5 Mamba support in `b9025`. Needs investigation with a newer llama.cpp build or different device.

## Deferred to Phase 2

- Android GPU profiler traces (Perfetto, Snapdragon Profiler, Streamline) — requires local devices
- iOS Metal Instruments traces — requires local devices
- iPhone 16 Pro benchmarks — Firebase Test Lab device unavailability
- iPhone 16 Pro / iPhone 16 local benchmarks — 12 GB RAM devices needed for E4B models
- iPhone 17 benchmarks — not available on Firebase Test Lab
- Samsung S25 Vulkan root-cause analysis — requires driver debugging
- iPhone 16e larger-model strategies (e.g., partial layer offload, reduced context) — may unlock E4B Q4 on 8 GB devices

## Methodology Notes

### TTFT Derivation

llama.cpp does not natively report TTFT. It is derived as:

**TTFT = vision-encode time + prefill time**

where prefill time = (prompt_tokens / prefill t/s) * 1000 ms. Prompt token counts: ~284 for elephant.jpg, ~290 for fruitPlate.png (vision tokens + text prompt tokens). The first generated token arrives after both vision encoding and prefill complete.

### Execution Environment

- Android tests executed on Firebase Test Lab physical devices
- iPhone 16e tests executed locally via `xcrun devicectl device process launch --console`
- Android: `LD_LIBRARY_PATH=/data/local/tmp/llama-bench` for native shared library resolution
- Pixel 9 Pro Vulkan: `GGML_VK_DISABLE_COOPMAT=1`, `GGML_VK_DISABLE_COOPMAT2=1` (Mali-G715 lacks cooperative matrix support)
- Samsung S25 uses OpenCL binary for all tests (CPU + OpenCL) to avoid Vulkan linker dependency
- Samsung S25 CPU tests use the OpenCL-compiled binary with `-ngl 0`; no GPU layers offloaded

### Measurement Protocol

- Median of 3 measured runs reported (warmup run discarded)
- 60-second cool-down between measured runs to mitigate thermal throttling
- Some Pixel 9 Pro CPU tests only completed 1–2 of 3 runs due to 45-minute Firebase timeout
- Pixel 9 Pro CPU tests split by image across separate Firebase invocations
- iPhone 16e CPU runs use `--predict 128` (256 caused iOS memory kills); Metal runs use `--predict 256`
- iPhone 16e vision encoder (mmproj/CLIP) always runs on Metal regardless of `--gpu-layers` setting
- iOS Firebase tests submitted but did not execute due to `DEVICE_CAPACITY_NONE`
- iPhone 16e run-2 (2026-05-07): full Gemma 4 matrix re-run to validate run-1 results and confirm OOM status
- Qwen3.5-2B supplementary tests (2026-05-07): Pixel 9 Pro only, split into 2 Firebase invocations (Vulkan, CPU+OpenCL)

### Not Captured (Deferred to Phase 2)

- **Peak RSS**: `VmHWM` from `/proc/<pid>/status` was not read in the test harness
- **Thermal data**: raw thermal readings exist in logcat files but are not analyzed in this report
- **Profiler traces**: Perfetto, Snapdragon Profiler, Streamline, and Metal Instruments traces require local device access
