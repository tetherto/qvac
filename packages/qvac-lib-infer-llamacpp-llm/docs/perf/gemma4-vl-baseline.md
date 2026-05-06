# Gemma 4 VL Baseline Performance Report

**Date**: 2026-05-06
**Task**: QVAC-18293 — Gemma 4 VL mobile inference benchmarking
**llama.cpp**: commit used in `vlm-benchmark/llama.cpp/`

## Test Configuration

| Parameter | Value |
|-----------|-------|
| Context size | 4096 |
| Predicted tokens | 256 (128 for iPhone 16e CPU) |
| Threads | 4 |
| Temperature | 0 |
| Seed | 42 |
| Jinja | enabled |
| Flash attention | off |
| Runs per config | 1 warmup + 3 measured (median reported) |
| Cool-down | 60s sleep between measured runs |

### Models

| Model | Quant | File Size |
|-------|-------|-----------|
| Gemma 4 E2B | Q4_K_M | 2.9 GB |
| Gemma 4 E2B | Q8_0 | 4.7 GB |
| Gemma 4 E4B | Q4_K_M | 4.6 GB |
| Gemma 4 E4B | Q8_0 | 7.6 GB |
| mmproj E2B | F16 | 940 MB |
| mmproj E4B | F16 | 944 MB |

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

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Runs |
|---------|-------|------------|---------------|-------------|------|
| CPU | elephant | 2,622 | 91.33 | 12.73 | 3 |
| CPU | fruitPlate | 2,708 | 90.57 | 11.74 | 3 |
| OpenCL | elephant | 2,871 | 73.36 | 14.95 | 3 |
| OpenCL | fruitPlate | 3,834 | 56.01 | 12.88 | 3 |

#### E2B Q8_0

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Runs |
|---------|-------|------------|---------------|-------------|------|
| CPU | elephant | 2,181 | 110.33 | 15.81 | 3 |
| CPU | fruitPlate | 2,223 | 110.63 | 15.79 | 3 |
| OpenCL | elephant | 2,282 | 95.60 | 15.53 | 3 |
| OpenCL | fruitPlate | 2,333 | 96.30 | 15.33 | 3 |

#### E4B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Runs |
|---------|-------|------------|---------------|-------------|------|
| CPU | elephant | 2,378 | 82.95 | 7.21 | 3 |
| CPU | fruitPlate | 2,483 | 80.13 | 6.71 | 3 |
| OpenCL | elephant | 2,669 | 68.55 | 9.34 | 3 |
| OpenCL | fruitPlate | 2,730 | 68.61 | 9.35 | 3 |

#### E4B Q8_0

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Runs |
|---------|-------|------------|---------------|-------------|------|
| CPU | elephant | 2,185 | 71.89 | 7.42 | 3 |
| CPU | fruitPlate | 2,731 | 60.29 | 5.70 | 3 |
| OpenCL | elephant | 2,801 | 70.29 | 8.03 | 3 |
| OpenCL | fruitPlate | 2,700 | 74.22 | 8.09 | 3 |

### Pixel 9 Pro (Mali-G715 MC7)

#### E2B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Runs |
|---------|-------|------------|---------------|-------------|------|
| CPU | elephant | 29,956 | 8.06 | 1.02 | 3 |
| CPU | fruitPlate | 30,454 | 8.08 | 0.97 | 2 |
| Vulkan | elephant | 25,429 | 8.29 | 10.62 | 3 |
| Vulkan | fruitPlate | 25,739 | 8.41 | 10.59 | 3 |
| OpenCL | elephant | 34,507 | 3.63 | 10.59 | 3 |
| OpenCL | fruitPlate | 35,070 | 3.69 | 10.58 | 3 |

#### E2B Q8_0

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Runs |
|---------|-------|------------|---------------|-------------|------|
| CPU | elephant | 29,940 | 8.19 | 1.36 | 3 |
| CPU | fruitPlate | 30,221 | 8.27 | 1.31 | 3 |
| Vulkan | elephant | 27,544 | 5.68 | 7.91 | 3 |
| Vulkan | fruitPlate | 27,662 | 5.79 | 7.85 | 3 |
| OpenCL | elephant | 34,516 | 3.66 | 7.86 | 3 |
| OpenCL | fruitPlate | 34,913 | 3.72 | 7.84 | 3 |

#### E4B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Runs |
|---------|-------|------------|---------------|-------------|------|
| CPU | elephant | 30,005 | 7.42 | 0.73 | 3 |
| CPU | fruitPlate | 29,926 | 7.69 | 0.70 | 1 |
| Vulkan | elephant | 27,703 | 5.43 | 6.89 | 3 |
| Vulkan | fruitPlate | 28,025 | 5.51 | 6.88 | 3 |
| OpenCL | elephant | 41,073 | 2.06 | 6.89 | 3 |
| OpenCL | fruitPlate | 41,265 | 2.11 | 6.86 | 1 |

#### E4B Q8_0

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Runs |
|---------|-------|------------|---------------|-------------|------|
| CPU | elephant | 29,945 | 7.68 | 0.79 | 3 |
| CPU | fruitPlate | 29,981 | 7.85 | 0.81 | 1 |
| Vulkan | elephant | 33,773 | 2.86 | 4.69 | 3 |
| Vulkan | fruitPlate | 33,748 | 2.89 | 4.64 | 3 |
| OpenCL | elephant | 40,928 | 2.08 | 4.64 | 2 |
| OpenCL | fruitPlate | — | — | — | 0 (timeout) |

### iPhone 16e (Apple A18)

> Only E2B Q4_K_M fits in the iPhone 16e's 8 GB RAM (~5.7 GB available to apps). E2B Q8_0, E4B Q4_K_M, and E4B Q8_0 all OOM during model loading. CPU runs use 128 predicted tokens (256 caused iOS memory kills). The mmproj/CLIP vision encoder always runs on Metal regardless of `--gpu-layers`.

#### E2B Q4_K_M

| Backend | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Runs |
|---------|-------|------------|---------------|-------------|------|
| CPU | elephant | 1,152 | 167.99 | 23.18 | 3 |
| CPU | fruitPlate | 1,209 | 175.19 | 21.94 | 3 |
| Metal | elephant | 1,239 | 125.71 | 26.66 | 3 |
| Metal | fruitPlate | 1,274 | 126.35 | 26.56 | 3 |

#### E2B Q8_0 — not tested (OOM)

> `ggml_aligned_malloc: insufficient memory (attempted to allocate 2287 MB)` — the CPU_REPACK buffer alone exceeds available memory.

#### E4B Q4_K_M — not tested (OOM)

> `kIOGPUCommandBufferCallbackErrorOutOfMemory` on Metal; CPU_REPACK allocation fails at 2619 MB on CPU-only.

#### E4B Q8_0 — not tested (OOM)

> Model file (7.6 GB) exceeds total device memory.

### iPhone 16 Pro (A18 Pro)

> **Not tested.** Firebase Test Lab reported `DEVICE_CAPACITY_NONE` for `iphone16pro,version=18.3` — no physical devices were available during the benchmark window. All 4 iOS test submissions completed without execution. The XCTest wrapper was successfully built and validated; iOS benchmarks require either device availability on Firebase or local test execution.

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

| Model | Quant | CPU Decode (t/s) | Metal Decode (t/s) | Speedup |
|-------|-------|-----------------|---------------------|---------|
| E2B | Q4_K_M | 23.18 | 26.66 | **1.15x** |

> CPU prefill (168 t/s) is faster than Metal prefill (126 t/s) on the A18 — likely due to GPU kernel dispatch overhead exceeding any compute advantage at this model size.

### Cross-Device Best Decode (elephant.jpg)

| Model | Quant | iPhone 16e Best (t/s) | S25 Best (t/s) | P9P Best (t/s) | 16e / S25 | S25 / P9P |
|-------|-------|----------------------|---------------|----------------|-----------|-----------|
| E2B | Q4_K_M | 26.66 (Metal) | 14.95 (OpenCL) | 10.62 (Vulkan) | **1.78x** | **1.41x** |
| E2B | Q8_0 | — (OOM) | 15.81 (CPU) | 7.91 (Vulkan) | — | **2.00x** |
| E4B | Q4_K_M | — (OOM) | 9.34 (OpenCL) | 6.89 (Vulkan) | — | **1.36x** |
| E4B | Q8_0 | — (OOM) | 8.03 (OpenCL) | 4.69 (Vulkan) | — | **1.71x** |

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

### 9. iPhone 16e memory is a hard constraint

With only ~5.7 GB available to apps (out of 8 GB total), the iPhone 16e cannot load any model+mmproj combination exceeding ~4 GB. This rules out E2B Q8_0 (5.0+0.9 GB), E4B Q4_K_M (5.0+0.9 GB), and E4B Q8_0 (7.6+0.9 GB). Devices with 12+ GB RAM (iPhone 16 Pro, S25, P9P) are required for larger models.

## Top Bottlenecks

1. **Pixel 9 Pro vision encoding (25–41s)**: The vision encoder runs on CPU and takes 25–41 seconds on P9P. Metal/GPU-accelerated vision encoding would reduce time-to-first-token by 10x (S25 achieves 2–4s, iPhone 16e ~1.2s). This is the #1 optimization target for Tensor G4.

2. **iPhone 16e memory (8 GB)**: Only E2B Q4_K_M fits — all larger models OOM. The 8 GB iPhone 16e is representative of the low-end iPhone market. Strategies like reduced context sizes, streaming KV cache, or aggressive quantization (e.g., IQ4_XS) may help.

3. **Adreno 830 Vulkan crashes**: The S25's Vulkan backend is non-functional due to driver issues. Fixing this (or waiting for a driver update) could unlock additional GPU performance, particularly for prefill where Vulkan shows 2–3x advantage over OpenCL on Mali.

4. **Pixel 9 Pro CPU decode (~1 t/s)**: The Tensor G4's CPU is 10–12x slower than the Snapdragon 8 Elite for LLM decode. Without GPU offloading, the Pixel 9 Pro is impractical for VLM inference.

## Deferred to Phase 2

- Android GPU profiler traces (Perfetto, Snapdragon Profiler, Streamline) — requires local devices
- iOS Metal Instruments traces — requires local devices
- iPhone 16 Pro benchmarks — Firebase Test Lab device unavailability
- iPhone 16 Pro / iPhone 16 local benchmarks — 12 GB RAM devices needed for E4B models
- iPhone 17 benchmarks — not available on Firebase Test Lab
- Samsung S25 Vulkan root-cause analysis — requires driver debugging
- iPhone 16e larger-model strategies (e.g., partial layer offload, reduced context) — may unlock E4B Q4 on 8 GB devices

## Methodology Notes

- Android tests executed on Firebase Test Lab physical devices
- iPhone 16e tests executed locally via `xcrun devicectl device process launch --console`
- Median of 3 measured runs reported (warmup run discarded)
- 60-second cool-down between measured runs to mitigate thermal throttling
- Some Pixel 9 Pro CPU tests only completed 1–2 of 3 runs due to 45-minute Firebase timeout
- Pixel 9 Pro CPU tests split by image across separate Firebase invocations
- Samsung S25 uses OpenCL binary for all tests (CPU + OpenCL) to avoid Vulkan linker dependency
- Samsung S25 CPU tests use the OpenCL-compiled binary with `-ngl 0`; no GPU layers offloaded
- iPhone 16e CPU runs use `--predict 128` (256 caused iOS memory kills); Metal runs use `--predict 256`
- iPhone 16e vision encoder (mmproj/CLIP) always runs on Metal regardless of `--gpu-layers` setting
- iOS Firebase tests submitted but did not execute due to `DEVICE_CAPACITY_NONE`
