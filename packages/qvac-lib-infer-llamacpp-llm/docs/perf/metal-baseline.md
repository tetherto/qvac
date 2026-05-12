# Metal GPU Baseline Performance Report

**Date**: 2026-05-07 (updated 2026-05-12 with fiber baseline)
**Task**: QVAC-18293 — VLM inference profiling on Apple Metal GPUs
**llama.cpp**: tag [`b9025`](https://github.com/ggml-org/llama.cpp/releases/tag/b9025) (commit [`eff06702`](https://github.com/ggml-org/llama.cpp/commit/eff06702b2a52e1020ea009ebd86cb9f5acabab5)), fiber fork `tetherto/temp-8189` (build 8412, commit `f686a1324`)

This report consolidates all Metal GPU benchmark results and profiling findings from the QVAC-18293 investigation. It covers two Apple Metal devices — the Mac M4 (performance ceiling) and iPhone 16e A18 (mobile target) — across Gemma 4 and Qwen3.5-2B models. For non-Metal results (Android Vulkan, OpenCL, CPU-only), see [`gemma4-vl-baseline.md`](./gemma4-vl-baseline.md). For full Mac results including CPU, see [`vlm-mac-baseline.md`](./vlm-mac-baseline.md).

## Test Configuration

| Parameter | Value |
|-----------|-------|
| Context size | 4096 |
| Predicted tokens | 256 (Mac Metal), 256 (iPhone Metal), 128 (iPhone CPU) |
| Threads | 4 |
| Temperature | 0 |
| Seed | 42 |
| Jinja | enabled |
| Memory fitting | off (`-fit off`) |
| Runs per config | 1 warmup + 3 measured (median reported) |

### Devices

| Device | SoC | GPU | GPU Cores | Memory | Metal | OS |
|--------|-----|-----|-----------|--------|-------|-----|
| Mac (local) | Apple M4 | Apple M4 GPU | 8 | 16 GB unified | Metal 4 (Apple9) | macOS 26.4.1 |
| iPhone 16e | Apple A18 | Apple A18 GPU | 5 | 8 GB (~5.7 GB usable) | Metal (Apple9) | iOS 18.5 |
| iPhone 16 Pro | Apple A18 Pro | Apple A18 Pro GPU | 6 | — | — | **not tested** |

### Models

| Model | Quant | Model Size | mmproj Size | Total |
|-------|-------|-----------|------------|-------|
| Gemma 4 E2B | Q4_K_M | 2.9 GB | 940 MB | 3.8 GB |
| Gemma 4 E2B | Q8_0 | 4.7 GB | 940 MB | 5.6 GB |
| Gemma 4 E4B | Q4_K_M | 4.6 GB | 944 MB | 5.5 GB |
| Gemma 4 E4B | Q8_0 | 7.6 GB | 944 MB | 8.5 GB |
| Qwen3.5-2B | Q4_K_M | 1.2 GB | 637 MB | 1.8 GB |

### Test Images

| Image | Resolution | File Size | Vision Tokens (Gemma 4) | Vision Tokens (Qwen3.5) |
|-------|-----------|-----------|------------------------|------------------------|
| elephant.jpg | 612 × 408 | 24 KB | 284 | 265 (247 image + 18 text) |
| fruitPlate.png | 2250 × 3000 | 9.7 MB | 290 | 4,015 (ctx overflow) |

---

## Metal Benchmark Results

### Mac M4 — Metal

#### Gemma 4

| Model | Quant | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Total (ms) |
|-------|-------|-------|------------|---------------|-------------|----------|-----------|
| E2B | Q4_K_M | elephant | 630 | 259.61 | 51.28 | 1,724 | 6,512 |
| E2B | Q4_K_M | fruitPlate | 653 | 260.89 | 51.25 | 1,765 | 6,603 |
| E2B | Q8_0 | elephant | 689 | 237.04 | 30.30 | 1,887 | 10,062 |
| E2B | Q8_0 | fruitPlate | 708 | 224.35 | 30.68 | 2,001 | 10,221 |
| E4B | Q4_K_M | elephant | 768 | 135.86 | 23.28 | 2,858 | 13,619 |
| E4B | Q4_K_M | fruitPlate | 840 | 131.40 | 21.91 | 3,048 | 14,482 |
| E4B | Q8_0 | elephant | 827 | 138.36 | 15.26 | 2,880 | 20,040 |
| E4B | Q8_0 | fruitPlate | 884 | 133.09 | 15.12 | 3,063 | 20,367 |

#### Qwen3.5-2B

| Model | Quant | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Total (ms) | Output |
|-------|-------|-------|------------|---------------|-------------|----------|-----------|--------|
| Qwen3.5-2B | Q4_K_M | elephant | 417 | 323.59 | 51.83 | 1,236 | 5,947 | coherent |
| Qwen3.5-2B | Q4_K_M | fruitPlate | — | — | — | — | — | ctx overflow |

### iPhone 16e (A18) — Metal

> Only E2B Q4_K_M fits in 8 GB RAM. E2B Q8_0, E4B Q4_K_M, E4B Q8_0 all OOM. The mmproj/CLIP vision encoder always runs on Metal regardless of `--gpu-layers`.

#### Gemma 4 E2B Q4_K_M

Run-1 (2026-05-06):

| Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) |
|-------|------------|---------------|-------------|----------|
| elephant | 1,239 | 125.71 | 26.66 | 3,498 |
| fruitPlate | 1,274 | 126.35 | 26.56 | 3,569 |

Run-2 (2026-05-07):

| Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) |
|-------|------------|---------------|-------------|----------|
| elephant | 1,236 | 125.92 | 27.24 | 3,492 |
| fruitPlate | 1,266 | 126.89 | 27.20 | 3,551 |

> Run-2 validates run-1: vision encode within 1–2%, Metal decode within 2%. Benchmark is highly reproducible.

#### OOM Summary

| Model | Quant | Total Size | Error |
|-------|-------|-----------|-------|
| E2B | Q8_0 | 5.6 GB | `kIOGPUCommandBufferCallbackErrorOutOfMemory` + signal 11 |
| E4B | Q4_K_M | 5.5 GB | `kIOGPUCommandBufferCallbackErrorOutOfMemory` + signal 11 |
| E4B | Q8_0 | 8.5 GB | `mmap failed: Cannot allocate memory` + signal 11 |

> The iPhone 16e's ~5.7 GB app memory limit means only model+mmproj combinations under ~4 GB can run. E2B Q4_K_M (3.8 GB) is the only viable Gemma 4 configuration.

---

## Metal vs CPU (per device)

### Mac M4 — Metal vs CPU Decode

| Model | Quant | CPU (t/s) | Metal (t/s) | Speedup |
|-------|-------|----------|------------|---------|
| E2B | Q4_K_M | 38.74 | 51.28 | **1.32x** |
| E2B | Q8_0 | 25.18 | 30.30 | **1.20x** |
| E4B | Q4_K_M | 17.64 | 23.28 | **1.32x** |
| E4B | Q8_0 | 12.12 | 15.26 | **1.26x** |
| Qwen3.5-2B | Q4_K_M | 32.74 | 51.83 | **1.58x** |

### Mac M4 — Metal vs CPU Prefill

| Model | Quant | CPU (t/s) | Metal (t/s) | Winner |
|-------|-------|----------|------------|--------|
| E2B | Q4_K_M | 424.35 | 259.61 | **CPU (1.63x)** |
| E2B | Q8_0 | 422.74 | 237.04 | **CPU (1.78x)** |
| E4B | Q4_K_M | 353.32 | 135.86 | **CPU (2.60x)** |
| E4B | Q8_0 | 251.04 | 138.36 | **CPU (1.81x)** |
| Qwen3.5-2B | Q4_K_M | 127.36 | 323.59 | **Metal (2.54x)** |

### Mac M4 — Metal vs CPU Vision Pipeline

| Model | Quant | CPU (ms) | Metal (ms) | Speedup |
|-------|-------|---------|-----------|---------|
| E2B | Q4_K_M | 2,113 | 630 | **3.35x** |
| E2B | Q8_0 | 1,941 | 689 | **2.82x** |
| E4B | Q4_K_M | 4,370 | 768 | **5.69x** |
| E4B | Q8_0 | 3,881 | 827 | **4.69x** |
| Qwen3.5-2B | Q4_K_M | 1,922 | 417 | **4.61x** |

### iPhone 16e — Metal vs CPU (E2B Q4_K_M only)

| Metric | CPU (run-2) | Metal (run-2) | Winner |
|--------|-----------|-------------|--------|
| Decode (t/s) | 25.37 | 27.24 | **Metal (1.07x)** |
| Prefill (t/s) | 160.96 | 125.92 | **CPU (1.28x)** |
| Vision (ms) | 1,151 | 1,236 | **CPU (1.07x)** |
| TTFT (ms) | 2,916 | 3,492 | **CPU (1.20x faster)** |

> On iPhone 16e, CPU wins on prefill and TTFT; Metal wins only on decode. The vision encoder (mmproj) runs on Metal regardless of backend setting, so "CPU" vision time still uses Metal for CLIP encoding.

---

## Cross-Device Metal Comparison

### Decode Throughput (elephant.jpg, Metal)

| Model | Quant | Mac M4 (t/s) | iPhone 16e (t/s) | Mac / iPhone |
|-------|-------|-------------|-----------------|-------------|
| E2B | Q4_K_M | 51.28 | 27.24 | **1.88x** |
| E2B | Q8_0 | 30.30 | — (OOM) | — |
| E4B | Q4_K_M | 23.28 | — (OOM) | — |
| E4B | Q8_0 | 15.26 | — (OOM) | — |
| Qwen3.5-2B | Q4_K_M | 51.83 | — | — |

### Prefill Throughput (elephant.jpg, Metal)

| Model | Quant | Mac M4 (t/s) | iPhone 16e (t/s) | Mac / iPhone |
|-------|-------|-------------|-----------------|-------------|
| E2B | Q4_K_M | 259.61 | 125.92 | **2.06x** |

### Vision Pipeline (elephant.jpg, Metal)

| Model | Quant | Mac M4 (ms) | iPhone 16e (ms) | Mac speedup |
|-------|-------|------------|----------------|-------------|
| E2B | Q4_K_M | 630 | 1,236 | **1.96x** |

### TTFT (elephant.jpg, Metal)

| Model | Quant | Mac M4 (ms) | iPhone 16e (ms) | Mac speedup |
|-------|-------|------------|----------------|-------------|
| E2B | Q4_K_M | 1,724 | 3,492 | **2.03x** |
| E2B | Q8_0 | 1,887 | — (OOM) | — |
| E4B | Q4_K_M | 2,858 | — (OOM) | — |
| E4B | Q8_0 | 2,880 | — (OOM) | — |
| Qwen3.5-2B | Q4_K_M | 1,236 | — | — |

### Metal vs All Platforms (elephant.jpg, best backend per device)

| Model | Quant | Mac Metal | iPhone 16e Metal | S25 Best | P9P Best | Mac/S25 | Mac/P9P |
|-------|-------|----------|-----------------|---------|---------|---------|---------|
| E2B | Q4_K_M | 51.28 t/s | 27.24 t/s | 14.95 (OCL) | 10.62 (VK) | **3.43x** | **4.83x** |
| E2B | Q8_0 | 30.30 t/s | — (OOM) | 15.81 (CPU) | 7.91 (VK) | **1.92x** | **3.83x** |
| E4B | Q4_K_M | 23.28 t/s | — (OOM) | 9.34 (OCL) | 6.89 (VK) | **2.49x** | **3.38x** |
| E4B | Q8_0 | 15.26 t/s | — (OOM) | 8.03 (OCL) | 4.69 (VK) | **1.90x** | **3.25x** |
| Qwen3.5-2B | Q4_K_M | 51.83 t/s | — | — | 14.22 (VK) | — | **3.64x** |

---

## Profiling: Metal System Trace

### Trace Inventory

| Trace | Device | Model | Predict | Size | Method |
|-------|--------|-------|---------|------|--------|
| `mac-m4-gemma4-e2b-q4km.trace` | Mac M4 | Gemma 4 E2B Q4_K_M | 256 | 597 MB | `xcrun xctrace record --launch` (automated) |
| `mac-m4-qwen3.5-2b-q4km.trace` | Mac M4 | Qwen3.5-2B Q4_K_M | 256 | 480 MB | `xcrun xctrace record --launch` (automated) |
| `iPhone16e-gemma4-e2b-q4km.trace` | iPhone 16e | Gemma 4 E2B Q4_K_M | 128 | 371 MB | Xcode Instruments GUI (manual) |
| `iPhone16e-qwen3.5-2b-q4km.trace` | iPhone 16e | Qwen3.5-2B Q4_K_M | 128 | 101 MB | Xcode Instruments GUI (manual) |

All traces stored in `vlm-benchmark/results/traces/`. Open in Instruments: `open <path>.trace`

> Mac profiling is fully automated via `xcrun xctrace record --launch` (spawns process under Instruments, stops on exit). iPhone profiling requires manual Instruments GUI interaction because `xctrace --launch` cannot target arbitrary app sandbox processes on iOS.

### Metal GPU Configuration Comparison

| Property | Mac M4 | iPhone 16e A18 |
|----------|--------|----------------|
| GPU family | MTLGPUFamilyApple9, Metal4 | MTLGPUFamilyApple9 |
| GPU cores | 8 | 5 |
| Unified memory | 16 GB | 8 GB |
| recommendedMaxWorkingSetSize | 12,713 MB | ~5,727 MB |
| BFloat16 | yes | yes |
| Tensor cores | no (pre-M5) | no (pre-A19) |
| Residency sets | yes | yes |
| Shared buffers | yes | yes |
| Fusion | yes | yes |
| Concurrency | yes | yes |
| Graph optimize | yes | yes |

### Metal Memory Allocation (Mac M4)

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

### Phase Breakdown — Mac M4 (elephant.jpg, Metal, `--predict 256`)

| Phase | Gemma 4 E2B Q4_K_M | Qwen3.5-2B Q4_K_M | Notes |
|-------|--------------------|--------------------|-------|
| Model load | 280 ms | 191 ms | mmap + Metal buffer allocation |
| Vision encode (CLIP) | 611 ms | 415 ms | SigLIP / Qwen3VL encoder |
| Image decode (projection) | 19 ms | 2 ms | gemma4a cross-attn vs qwen3vl_merger |
| Prefill | 1,094 ms (284 tok, 260 t/s) | 807 ms (265 tok, 329 t/s) | LLM prompt eval |
| Decode | 4,973 ms (255 tok, 51.3 t/s) | 4,920 ms (255 tok, 51.8 t/s) | Token generation |
| **Total** | **6,512 ms** | **5,947 ms** | |

### Phase Breakdown — iPhone 16e (elephant.jpg, Metal, `--predict 128`)

| Phase | Gemma 4 E2B Q4_K_M | Qwen3.5-2B Q4_K_M | Notes |
|-------|--------------------|--------------------|-------|
| Vision encode (CLIP) | 1,272 ms | 829 ms | SigLIP / Qwen3VL encoder |
| Image decode (projection) | 36 ms | 183 ms | gemma4a cross-attn vs qwen3vl_merger |
| Prefill | 2,330 ms (284 tok, 122 t/s) | 1,983 ms (265 tok, 134 t/s) | LLM prompt eval |
| Decode | 5,478 ms (127 tok, 23.2 t/s) | 5,220 ms (127 tok, 24.3 t/s) | Token generation |
| **Total** | **9,885 ms** | **8,086 ms** | |

### Phase Speedup — Mac M4 vs iPhone 16e (Gemma 4 E2B Q4_K_M)

| Phase | Mac M4 | iPhone 16e | Mac speedup |
|-------|--------|-----------|-------------|
| Vision encode | 611 ms | 1,272 ms | **2.08x** |
| Image decode | 19 ms | 36 ms | **1.89x** |
| Prefill throughput | 260 t/s | 122 t/s | **2.13x** |
| Decode throughput | 51.3 t/s | 23.2 t/s | **2.21x** |

> The Mac M4 is consistently ~2x faster across all phases. The 8 vs 5 GPU core difference (1.6x) accounts for part of this; the rest comes from higher memory bandwidth and clock speeds. Note: iPhone used `--predict 128` (256 caused OOM).

---

## Addon vs CLI Overhead (Mac M4)

**Date**: 2026-05-11
**Addon**: llm-llamacpp v0.20.0 (wt-main branch, Bare runtime)
**CLI**: llama-mtmd-cli b9025 baseline

Measures the overhead introduced by running inference through the qvac addon (JS binding + Bare runtime) vs the raw CLI binary. Same models, image, prompt, and inference parameters. Mean of 3 measured runs (1 warmup discarded).

### Qwen3.5-2B Q4_K_M (elephant.jpg, Metal)

| Metric | CLI | Addon | Delta | Delta % |
|--------|-----|-------|-------|---------|
| **Total/Wall (ms)** | 5,748 | 7,726 | +1,978 | **+34.4%** |
| **Decode (t/s)** | 53.7 | 37.7 | −16.0 | **−29.8%** |
| **Prefill (t/s)** | 333.0 | 306.4 | −26.6 | **−8.0%** |
| Prompt tokens | 265 | 276 | +11 | +4.2% |
| Generated tokens | 255 | 256 | +1 | +0.4% |
| Model load (ms) | 192 | 614 | +422 | +220% |
| TTFT (ms) | — | 901 | — | — |

### Gemma 4 E2B Q4_K_M (elephant.jpg, Metal)

| Metric | CLI | Addon | Delta | Delta % |
|--------|-----|-------|-------|---------|
| **Total/Wall (ms)** | 6,370 | 7,484 | +1,114 | **+17.5%** |
| **Decode (t/s)** | 52.1 | 42.1 | −10.0 | **−19.2%** |
| **Prefill (t/s)** | 261.6 | 258.9 | −2.7 | **−1.0%** |
| Prompt tokens | 284 | 290 | +6 | +2.1% |
| Generated tokens | 255 | 256 | +1 | +0.4% |
| Model load (ms) | 310 | 786 | +476 | +154% |
| TTFT (ms) | — | 1,120 | — | — |

### Known Differences

| Parameter | CLI | Addon |
|-----------|-----|-------|
| Template | `--jinja` | addon template handler |
| Image scaling | `-fit off` | addon default |
| Threads | `--threads 4` | llama.cpp default (all cores) |
| Runtime | native binary | Bare runtime + JS binding |
| Stats granularity | vision_ms, img_decode_ms, prefill_ms, decode_ms | TTFT, TPS, ppTPS only |

### Addon Trace Inventory

| Trace | Model | Size | Notes |
|-------|-------|------|-------|
| `addon-mac-2026-05-11T1943/addon-qwen35-2b.trace` | Qwen3.5-2B Q4_K_M | 478 MB | bare process exited 139 (segfault at cleanup); trace data valid |
| `addon-mac-2026-05-11T1943/addon-gemma4-e2b.trace` | Gemma 4 E2B Q4_K_M | 121 MB | clean exit |

Source data: `vlm-benchmark/results/parsed/addon-mac-2026-05-11T1943.json`, full comparison at `vlm-benchmark/results/diffs/addon-vs-cli-mac-2026-05-11T1943.md`

---

## Key Findings

### 1. Metal decode throughput scales with GPU core count

Mac M4 (8 cores) achieves 51.3 t/s vs iPhone 16e (5 cores) at 27.2 t/s for E2B Q4_K_M — a 1.88x speedup from 1.6x more GPU cores. The super-linear scaling suggests the M4 also benefits from higher memory bandwidth and thermal headroom.

### 2. CPU prefill beats Metal prefill on Apple Silicon (Gemma 4)

On both Mac and iPhone, CPU with Accelerate (BLAS) outperforms Metal for the prefill phase (batch token processing):
- Mac: CPU 424 t/s vs Metal 260 t/s (1.63x CPU advantage)
- iPhone: CPU 161 t/s vs Metal 126 t/s (1.28x CPU advantage)

The Accelerate framework's optimized GEMM routines outperform Metal compute shader dispatch overhead for large batch operations. The exception is Qwen3.5-2B on Mac, where Metal prefill is 2.54x faster — the SSM layers may have poor Accelerate mapping.

### 3. Metal always wins for decode (memory-bandwidth-bound)

Metal decode is 1.07–1.58x faster than CPU across all configurations. Decode is sequential single-token generation, fundamentally limited by memory bandwidth for KV cache reads. Metal's GPU memory subsystem provides better bandwidth utilization than CPU-side access.

### 4. Vision pipeline is 2–6x faster on Metal

Metal accelerates the vision pipeline (CLIP encoding + image projection) by 2.8–5.7x on Mac and ~2x on iPhone. The speedup is driven by the image projection stage — on CPU it takes 1,300–3,800 ms, on Metal only 2–91 ms.

### 5. iPhone 16e memory is the primary Metal constraint

The 8 GB iPhone 16e's ~5.7 GB app limit means only E2B Q4_K_M (3.8 GB total) fits. All larger models OOM during Metal buffer allocation with `kIOGPUCommandBufferCallbackErrorOutOfMemory`. Even E2B Q4_K_M requires `--predict 128` (256 triggers OOM during decode phase KV cache growth). The Mac M4's 12.7 GB working set comfortably fits all models including E4B Q8_0 (8.5 GB).

### 6. Qwen3.5-2B works correctly on Metal (Mac + iPhone), garbled on Android

Qwen3.5-2B generates coherent output on both Mac Metal and iPhone 16e Metal, but produces garbled text on Pixel 9 Pro across all backends (CPU, Vulkan, OpenCL). The SSM (Gated Delta Net) + attention hybrid architecture is correctly supported by llama.cpp's Metal backend on Apple Silicon. The garbled output is specific to the ARM64 Android / Tensor G4 runtime.

### 7. Image projection behaves differently across devices

| Device | Gemma 4 projection (ms) | Qwen3.5 projection (ms) | Faster |
|--------|------------------------|------------------------|--------|
| Mac M4 | 19 | 2 | Qwen3.5 (9.5x) |
| iPhone 16e | 36 | 183 | Gemma 4 (5.1x) |

The `qwen3vl_merger` projector is near-instant on Mac (2 ms) but slow on iPhone (183 ms), while Gemma 4's `gemma4a` cross-attention projector scales more linearly. This suggests the merger architecture requires GPU parallelism that the iPhone's 5-core GPU cannot fully exploit.

### 8. Qwen3.5-2B and Gemma 4 E2B Q4_K_M hit the same decode ceiling

On Mac Metal, both models decode at ~51.5 t/s despite different architectures and sizes (1.2 GB vs 2.9 GB). This indicates the M4's memory bandwidth (~120 GB/s) is the shared bottleneck — both models' per-token KV read patterns saturate the same bus.

### 9. Q4_K_M is optimal for Metal decode performance

Q4_K_M delivers 1.5–1.7x higher decode throughput than Q8_0 across all Gemma 4 configurations on Metal. The halved memory per parameter means more tokens per memory bandwidth cycle. Quality tradeoff is minimal for VLM tasks at these model sizes.

### 10. Addon introduces 19–30% decode throughput overhead vs CLI

> **Update (2026-05-12)**: Finding #11 reveals the fiber fork itself introduces a 19–29% decode regression vs upstream b9025. Since the addon benchmarks used the fiber-based addon (not upstream b9025), the overhead attributed here to JS binding may be partially or entirely caused by the fiber fork regression. Isolating true addon overhead requires re-benchmarking the addon against an upstream b9025 build.

Running through the llm-llamacpp addon (Bare runtime + JS binding) drops decode TPS by 30% for Qwen3.5-2B (53.7 → 37.7 t/s) and 19% for Gemma 4 E2B (52.1 → 42.1 t/s). This is the dominant source of the +17–34% wall-time overhead. Likely contributors:

- **Per-token JS callback overhead**: Each generated token fires an `onUpdate` callback across the Bare C++→JS boundary. At ~40 tok/s, that's 40 cross-boundary calls/sec accumulating over 256 tokens.
- **Process orchestration**: The addon manages model lifecycle, session state, and the event loop — overhead the CLI doesn't have.
- **Model load**: 2–3x slower (614ms vs 192ms for Qwen, 786ms vs 310ms for Gemma4) due to addon initialization, Bare binding setup, and config validation — one-time cost that doesn't affect steady-state throughput.

Prefill throughput is nearly unaffected for Gemma 4 (−1.0%) and moderately slower for Qwen3.5 (−8.0%), likely due to 11 extra prompt tokens from different template processing.

### 11. Fiber fork (tetherto/temp-8189) introduces 19–29% decode regression vs upstream b9025

**Date**: 2026-05-12
**Branch**: `test/QVAC-18293-fiber-baseline` from `tetherto/temp-8189`
**Build**: 8412 (f686a1324), cmake flags identical to b9025 baseline

| Model | Metric | b9025 | Fiber | Delta |
|-------|--------|-------|-------|-------|
| Qwen3.5-2B Q4_K_M | Vision (ms) | 402 | 434 | +8.0% |
| | Prefill (t/s) | 333.0 | 298.7 | −10.3% |
| | Decode (t/s) | 53.7 | 38.2 | −28.8% |
| | Total (ms) | 5,748 | 7,774 | +35.3% |
| Gemma 4 E2B Q4_K_M | Vision (ms) | 604 | 636 | +5.3% |
| | Prefill (t/s) | 261.6 | 255.4 | −2.4% |
| | Decode (t/s) | 52.1 | 42.0 | −19.3% |
| | Total (ms) | 6,369 | 7,649 | +20.1% |

Key observations:

- **Decode is the dominant regression**: Qwen3.5 loses 28.8% decode TPS, Gemma4 loses 19.3%. Prefill and vision are less affected.
- **Qwen3.5 fiber decode (38.2 t/s) matches addon decode (37.7 t/s)**: The addon overhead measured in Finding #10 may partially reflect fiber fork regression rather than JS binding overhead alone. Addon benchmarks used the fiber-based addon, not upstream b9025.
- **Gemma4 Flash Attention auto-disabled on fiber**: The fiber build logs show `layer 4 is assigned to device MTL0 but the Flash Attention tensor is assigned to device CPU`, causing FA to be disabled. The b9025 build did not have this issue. This may account for part of the Gemma4 decode regression.
- **Qwen3.5 FA enabled but still regressed 28.8%**: FA was auto-enabled for Qwen3.5 on both builds, so the Qwen3.5 regression is in the fiber fork's code changes, not FA-related.
- **Run 3 outlier**: Qwen3.5 run 3 showed 18.36 t/s decode (thermal throttling suspected), excluded by median selection. Runs 1-2 were consistent (38.28/38.23 t/s).

Raw results: `vlm-benchmark/results/parsed/mac-fiber-2026-05-12T1006.json`
Binary archive: `vlm-benchmark/llama.cpp/binaries/b9025/` and `vlm-benchmark/llama.cpp/binaries/fiber-temp8189/`

---

## Methodology Notes

### TTFT Derivation

TTFT = vision pipeline time + (prompt tokens / prefill t/s × 1000) ms

Vision pipeline = image slice encoding + image batch decoding. The first generated token arrives after both vision processing and LLM prefill complete.

### Vision (ms) Column

Vision (ms) = image slice encoding + image batch decoding. Encoding runs the CLIP/SigLIP vision encoder; decoding projects vision embeddings into the LLM embedding space via cross-attention (Gemma 4 `gemma4a`) or merger (Qwen3.5 `qwen3vl_merger`).

### Build Configuration

- **Mac**: Native arm64, `cmake .. -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON`, Metal shaders embedded
- **iPhone**: Cross-compiled arm64 iOS via CMake + Xcode, `GGML_METAL=ON`, statically linked, code-signed for device deployment

### Execution Environment

- Mac CLI: Direct execution of `build-mac/bin/llama-mtmd-cli` (native binary)
- Mac addon: `bare test/integration/vlm-bench.js` in `wt-main/packages/llm-llamacpp/` (llm-llamacpp v0.20.0, Bare runtime)
- iPhone 16e: `xcrun devicectl device process launch --console` targeting app sandbox

### Measurement Protocol

- Median of 3 measured runs (warmup discarded)
- Mac: no cool-down (active cooling)
- iPhone: 60s cool-down between runs
- iPhone CPU runs use `--predict 128` (256 causes OOM); Metal runs use `--predict 256` on Mac, `--predict 128` on iPhone (256 triggers signal 9 during decode)
- iPhone vision encoder (mmproj/CLIP) runs on Metal regardless of `--gpu-layers` setting
- iPhone run-2 validates run-1 (vision ±2%, decode ±2%)
- Addon: mean of 3 measured runs (1 warmup discarded), wall-clock via `Date.now()` delta
- Raw logs: `vlm-benchmark/results/raw/mac/` (Mac CLI), `vlm-benchmark/results/raw/addon-mac-2026-05-11T1942/` (Mac addon), `vlm-benchmark/results/ios-local/` (iPhone)
- Profiling traces: `vlm-benchmark/results/traces/` (4 CLI traces, ~1.55 GB total) + `vlm-benchmark/results/traces/addon-mac-2026-05-11T1943/` (2 addon traces, ~599 MB total)
- Fiber results: `vlm-benchmark/results/parsed/mac-fiber-2026-05-12T1006.json`
- Pre-compiled binary archive: `vlm-benchmark/llama.cpp/binaries/b9025/` (upstream) and `vlm-benchmark/llama.cpp/binaries/fiber-temp8189/` (tetherto fork). Run with `DYLD_LIBRARY_PATH=<dir> <dir>/llama-mtmd-cli`
