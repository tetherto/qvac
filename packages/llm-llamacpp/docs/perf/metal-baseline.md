# VLM Metal Baseline Performance Report

**Date**: 2026-05-13 (Mac M4, iPhone 16e Phase 1), 2026-05-18 (iPhone 16e full matrix, iPhone 16 Pro)

This report consolidates VLM inference benchmark and profiling results on Apple Metal devices (Mac M4, iPhone 16e, iPhone 16 Pro).

Android mobile GPU results (Samsung S25 Adreno 830, Pixel 9 Pro Mali-G715) are in [Appendix G](#appendix-g-android-gpu-results). Full Android analysis will continue under a separate ticket and dedicated report document.

### llama.cpp Branches Tested

| Branch | Commit | Description |
|--------|--------|-------------|
| `b9025` (upstream) | [`eff06702`](https://github.com/ggml-org/llama.cpp/commit/eff06702b2a52e1020ea009ebd86cb9f5acabab5) | Baseline reference — upstream tag |
| `feat/QVAC-18297-u1-deepstack-prealloc` (U1) | `3cd776c5c` | Targets Qwen3.5 iPhone 16e projection anomaly (183 ms -> 11 ms) |
| `tetherto/temp-8189` (Fiber) | `f686a1324` (build 8412) | Production fork — fiber-based concurrency |
| `feat/QVAC-18297-fiber-updates` (Fiber + RC1-RC4) | progressive | Fiber regression fixes: fused GDN, FA dk512 |

---

## 1. Methodology

### 1.1 Devices

| Device | SoC | GPU | GPU Cores | Memory | Best Backend | OS | Status |
|--------|-----|-----|-----------|--------|-------------|-----|--------|
| Mac (local) | Apple M4 | Apple M4 GPU | 8 | 16 GB unified | Metal | macOS 26.4.1 | **Tested** |
| iPhone 16e | Apple A18 | Apple A18 GPU | 5 | 8 GB (~5.7 GB usable) | Metal | iOS 18.5 | **Tested** |
| iPhone 16 Pro | Apple A18 Pro | Apple A18 Pro GPU | 6 | 8 GB (~5.3 GB Metal working set) | Metal | iOS 18.3.2 | **Tested** (Firebase `DEVICE_CAPACITY_LOW`, 2026-05-18) |
| iPhone 17 | Apple A19 Pro | — | — | — | — | — | **TODO**: not in Firebase catalog (2026-05-18) |

Android devices: see [Appendix G](#appendix-g-android-gpu-results).

### 1.2 Models

| Model | Quant | Model Size | mmproj Size | Total |
|-------|-------|-----------|------------|-------|
| Gemma4-E2B | Q4_K_M | 2.9 GB | 940 MB | 3.8 GB |
| Gemma4-E2B | Q8_0 | 4.7 GB | 940 MB | 5.6 GB |
| Gemma4-E4B | Q4_K_M | 4.6 GB | 944 MB | 5.5 GB |
| Gemma4-E4B | Q8_0 | 7.6 GB | 944 MB | 8.5 GB |
| Qwen3.5-2B | Q4_K_M | 1.2 GB | 637 MB | 1.8 GB |
| Qwen3.5-2B | Q8_0 | 1.9 GB | 637 MB | 2.5 GB |
| Qwen3.5-4B | Q4_K_M | 2.6 GB | 641 MB | 3.2 GB |
| Qwen3.5-4B | Q8_0 | 4.2 GB | 641 MB | 4.8 GB |

### 1.3 Test Images

| Image | Resolution | File Size | Vision Tokens (Gemma 4) | Vision Tokens (Qwen3.5) |
|-------|-----------|-----------|------------------------|------------------------|
| elephant.jpg | 612 x 408 | 24 KB | 284 | 265 (247 image + 18 text) |
| fruitPlate.png | 2250 x 3000 | 9.7 MB | 290 | 4,015 (ctx overflow) |

### 1.4 Inference Parameters

| Parameter | Value |
|-----------|-------|
| Context size | 4096 |
| Predicted tokens | 256 (Mac Metal, iPhone 16e/16 Pro 2026-05-18), 128 (iPhone 16e Phase 1 only — 256 triggers OOM via CLI) |
| Threads | 4 |
| Temperature | 0 |
| Seed | 42 |
| Jinja | enabled |
| Flash attention | off (auto) |
| Memory fitting | off (`-fit off`) |
| Runs per config | 1 warmup + 3 measured (median reported) |
| Cool-down | none (Mac, active cooling), 60s (mobile devices) |

### 1.5 Build Configuration

| Platform | Build |
|----------|-------|
| Mac | Native arm64: `cmake .. -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON` |
| iPhone | Cross-compiled arm64 iOS via CMake + Xcode, `GGML_METAL=ON`, statically linked |

Android build configs: see [Appendix G](#appendix-g-android-gpu-results).

### 1.6 Measurement Protocol

- Median of 3 measured runs reported (warmup run discarded)
- Mac: no cool-down (active cooling); mobile: 60s cool-down between runs
- iPhone 16e CPU/Metal: `--predict 128` (256 triggers OOM/signal 9)
- iPhone 16e vision encoder (mmproj/CLIP) runs on Metal regardless of `--gpu-layers` setting

**TTFT derivation**: TTFT = vision pipeline time + (prompt tokens / prefill t/s x 1000) ms. The first generated token arrives after both vision processing and LLM prefill complete.

**Vision (ms)**: image slice encoding (CLIP/SigLIP forward pass) + image batch decoding (cross-attention projection for Gemma 4 `gemma4a`, merger for Qwen3.5 `qwen3vl_merger`).

---

## 2. Primary Results Matrix

All results use elephant.jpg (612 x 408). Peak RSS captured via `/usr/bin/time -l` on Mac M4 (2026-05-13 run). iPhone 16e/16 Pro RSS captured via in-process `mach_task_basic_info` (2026-05-18 runs). Android Peak RSS remains TODO.

### Mac M4

> Fiber = `tetherto/temp-8189` (build 8412). Full 8-model × 2-backend matrix tested for both b9025 and Fiber (2026-05-13). See [Appendix D](#appendix-d-branch-comparison--b9025-vs-u1-vs-fiber) for detailed branch comparison. Coherence validated: all configs produce correct image descriptions.
>
> **Date**: 2026-05-13 (run group T1856)
> **Raw logs**: `vlm-benchmark/results/raw/b9025-mac-2026-05-13T1856/` and `vlm-benchmark/results/raw/fiber-mac-2026-05-13T1856/`
> **Parsed**: `vlm-benchmark/results/parsed/b9025-mac-2026-05-13T1856.json` and `vlm-benchmark/results/parsed/fiber-mac-2026-05-13T1856.json`
> **Metal traces**: `vlm-benchmark/results/traces/` (multiple dates; see [Appendix F](#appendix-f-metal-profiling--gpu-analysis))
> **Peak RSS**: via `/usr/bin/time -l` (`peak_mem_mb` field in parsed JSON)

| Branch | Backend | Model | Quant | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Total (ms) | Peak RSS (MB) |
|--------|---------|-------|-------|------------|---------------|-------------|----------|-----------|----------|
| b9025 | Metal | Gemma4-E2B | Q4_K_M | 632 | 260.33 | 50.73 | 1,723 | 6,602 | 1,266 |
| Fiber | Metal | Gemma4-E2B | Q4_K_M | 804 | 177.33 | 31.45 | 2,406 | 10,130 | 1,249 |
| b9025 | Metal | Gemma4-E2B | Q8_0 | 704 | 231.93 | 30.88 | 1,929 | 10,008 | 1,272 |
| Fiber | Metal | Gemma4-E2B | Q8_0 | 785 | 184.94 | 21.79 | 2,321 | 13,646 | 1,250 |
| b9025 | Metal | Gemma4-E4B | Q4_K_M | 772 | 132.16 | 22.82 | 2,921 | 13,891 | 1,353 |
| Fiber | Metal | Gemma4-E4B | Q4_K_M | 877 | 109.69 | 16.78 | 3,466 | 18,303 | 1,331 |
| b9025 | Metal | Gemma4-E4B | Q8_0 | 836 | 133.36 | 14.34 | 2,966 | 21,101 | 1,355 |
| Fiber | Metal | Gemma4-E4B | Q8_0 | 807 | 141.72 | 12.66 | 2,811 | 23,329 | 1,335 |
| b9025 | Metal | Qwen3.5-2B | Q4_K_M | 537 | 218.68 | 39.79 | 1,749 | 7,810 | 933 |
| Fiber | Metal | Qwen3.5-2B | Q4_K_M | 470 | 253.23 | 32.56 | 1,516 | 9,181 | 946 |
| b9025 | Metal | Qwen3.5-2B | Q8_0 | 531 | 228.06 | 30.37 | 1,693 | 9,844 | 933 |
| Fiber | Metal | Qwen3.5-2B | Q8_0 | 484 | 249.70 | 25.28 | 1,545 | 11,446 | 946 |
| b9025 | Metal | Qwen3.5-4B | Q4_K_M | 543 | 125.80 | 17.60 | 2,650 | 16,801 | 1,051 |
| Fiber | Metal | Qwen3.5-4B | Q4_K_M | 571 | 125.22 | 15.46 | 2,687 | 19,006 | 1,071 |
| b9025 | Metal | Qwen3.5-4B | Q8_0 | 510 | 133.69 | 14.08 | 2,492 | 20,362 | 1,052 |
| Fiber | Metal | Qwen3.5-4B | Q8_0 | 633 | 111.00 | 13.15 | 3,020 | 22,246 | 1,072 |
| b9025 | CPU | Gemma4-E2B | Q4_K_M | 2,128 | 419.64 | 38.68 | 2,805 | 9,233 | 2,589 |
| Fiber | CPU | Gemma4-E2B | Q4_K_M | 2,256 | 415.57 | 38.08 | 2,939 | 9,462 | 2,562 |
| b9025 | CPU | Gemma4-E2B | Q8_0 | 1,929 | 419.04 | 25.23 | 2,607 | 12,622 | 3,607 |
| Fiber | CPU | Gemma4-E2B | Q8_0 | 2,538 | 364.83 | 21.09 | 3,316 | 15,229 | 3,575 |
| b9025 | CPU | Gemma4-E4B | Q4_K_M | 4,196 | 338.53 | 17.22 | 5,035 | 20,156 | 4,123 |
| Fiber | CPU | Gemma4-E4B | Q4_K_M | 5,736 | 329.61 | 14.83 | 6,598 | 23,830 | 4,091 |
| b9025 | CPU | Gemma4-E4B | Q8_0 | 3,857 | 234.57 | 12.15 | 5,068 | 26,818 | 6,185 |
| Fiber | CPU | Gemma4-E4B | Q8_0 | 4,311 | 260.51 | 11.45 | 5,401 | 28,489 | 6,152 |
| b9025 | CPU | Qwen3.5-2B | Q4_K_M | 1,974 | 124.12 | 33.32 | 4,109 | 10,067 | 2,173 |
| Fiber | CPU | Qwen3.5-2B | Q4_K_M | 2,134 | 111.75 | 33.99 | 4,505 | 10,184 | 2,176 |
| b9025 | CPU | Qwen3.5-2B | Q8_0 | 1,434 | 170.01 | 28.72 | 2,993 | 10,677 | 2,871 |
| Fiber | CPU | Qwen3.5-2B | Q8_0 | 1,686 | 139.67 | 28.00 | 3,583 | 11,224 | 2,873 |
| b9025 | CPU | Qwen3.5-4B | Q4_K_M | 4,610 | 53.46 | 15.96 | 9,567 | 21,219 | 3,698 |
| Fiber | CPU | Qwen3.5-4B | Q4_K_M | 5,108 | 46.98 | 16.45 | 10,749 | 21,438 | 3,712 |
| b9025 | CPU | Qwen3.5-4B | Q8_0 | 3,698 | 66.21 | 12.80 | 7,700 | 24,300 | 5,361 |
| Fiber | CPU | Qwen3.5-4B | Q8_0 | 4,031 | 58.37 | 13.25 | 8,571 | 24,063 | 5,374 |

### iPhone 16e (A18) — Local Device, Full Matrix

> Metal-only (`ngl=99`). In-process inference via static-linked llama.cpp.
> Median of 3 measured runs, 1 warmup, 60s cool-down, 5 min between models,
> 10 min between sessions. Local device via `xcodebuild test-without-building`.
> Models > ~3.8 GB total Jetsam-killed (same as Firebase 16 Pro).
>
> **Date**: 2026-05-18 (run group T1659)
> **Raw logs**: `vlm-benchmark/results/raw/ios-local-{fiber,b9025}-{model}-2026-05-18T1659/xcodebuild.log`
> **RSS**: via in-process `mach_task_basic_info` (run=2 values; includes XCTest host overhead ~50-100 MB)

**Fiber** (`tetherto/temp-8189`, `f686a1324`):

| Model | Quant | Image | Vision (ms) | img_decode (ms) | Prefill (t/s) | Decode (t/s) | RSS (MB) |
|-------|-------|-------|------------|----------------|---------------|-------------|----------|
| Gemma4-E2B | Q4_K_M | elephant | 1,200 | 1,122 | 206.8 | 17.01 | 1,284 |
| Gemma4-E2B | Q4_K_M | fruitPlate | 1,225 | 1,126 | 207.8 | 16.95 | 1,306 |
| Qwen3.5-2B | Q4_K_M | elephant | 783 | 820 | 133.8 | 8.22 | 1,328 |
| Qwen3.5-2B | Q8_0 | elephant | 785 | 779 | 137.4 | 7.23 | 1,474 |
| Qwen3.5-4B | Q4_K_M | elephant | 787 | 2,133 | 69.2 | 3.98 | 1,422 |

**b9025** (upstream tag `eff06702b`):

| Model | Quant | Image | Vision (ms) | img_decode (ms) | Prefill (t/s) | Decode (t/s) | RSS (MB) |
|-------|-------|-------|------------|----------------|---------------|-------------|----------|
| Gemma4-E2B | Q4_K_M | elephant | 1,285 | 38 | 122.7 | 27.26 | 1,071 |
| Gemma4-E2B | Q4_K_M | fruitPlate | 1,317 | 40 | 123.4 | 27.29 | 1,096 |
| Qwen3.5-2B | Q4_K_M | elephant | 927 | 9 | 150.0 | 27.69 | 1,575 |
| Qwen3.5-2B | Q8_0 | elephant | 924 | 9 | 154.3 | 21.86 | 1,305 |
| Qwen3.5-4B | Q4_K_M | elephant | 1,058 | 10 | 82.7 | 12.28 | 956 |

**Fiber vs b9025 — iPhone 16e regression:**

| Model | Quant | Fiber decode (t/s) | b9025 decode (t/s) | Delta | Fiber img_decode (ms) | b9025 img_decode (ms) |
|-------|-------|-------------------|-------------------|-------|----------------------|----------------------|
| Gemma4-E2B | Q4_K_M | 17.0 | 27.3 | **-37.7%** | 1,122 | 38 |
| Qwen3.5-2B | Q4_K_M | 8.2 | 27.7 | **-70.4%** | 820 | 9 |
| Qwen3.5-2B | Q8_0 | 7.2 | 21.9 | **-67.1%** | 779 | 9 |
| Qwen3.5-4B | Q4_K_M | 4.0 | 12.3 | **-67.5%** | 2,133 | 10 |

**Critical finding**: Fiber fork has a catastrophic Metal regression on iPhone 16e
(5-core A18), far worse than on Mac M4 (-7 to -38%) or iPhone 16 Pro (-3%).
The regression is most severe for Qwen3.5 models (-67 to -70%) where the
`img_decode` step takes 80-210x longer on fiber vs b9025 (820-2,133 ms vs 9-38 ms).
The img_decode regression dominates Gemma4 too (1,122 ms vs 38 ms, 30x slower)
but Gemma4's decode throughput is less affected (-38% vs -70%) because Gemma4
spends proportionally less time in the projection path.

This strongly suggests the fiber fork's Metal image projection kernel is
missing an optimization that b9025 has — possibly the same deepstack/GDN
Metal kernel gap documented in `QVAC-18297-fiber-b9025-gap.md`.

### iPhone 16 Pro (A18 Pro) — Firebase Test Lab

> Metal-only (`ngl=99`). In-process inference via static-linked llama.cpp
> (posix_spawn not available on iOS sandbox). Median of 3 measured runs,
> 1 warmup, 60s cool-down. Models > ~3.8 GB total (model+mmproj) Jetsam-killed
> due to in-process memory overhead. Sequential sessions: fiber first, then b9025.
> Qwen3.5 fruitPlate skipped (context overflow).
>
> **Date**: 2026-05-18 (fiber session T1505, b9025 session T1545)
> **RSS**: via in-process `mach_task_basic_info` (run=2 values). Firebase RSS values
> (75-135 MB) are significantly lower than local iPhone 16e (956-1575 MB) — Firebase
> `mach_task_basic_info` may not account for Metal GPU buffer allocations mapped
> outside the process address space.

**Fiber** (`tetherto/temp-8189`, `f686a1324`):

| Model | Quant | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Total (ms) | RSS (MB) |
|-------|-------|-------|------------|---------------|-------------|-----------|----------|
| Gemma4-E2B | Q4_K_M | elephant | 883 | 174.4 | 30.9 | 10,467 | 96 |
| Gemma4-E2B | Q4_K_M | fruitPlate | 898 | 175.2 | 30.4 | 10,635 | 75 |
| Gemma4-E2B | Q8_0 | — | — | — | — | Jetsam (5.6 GB) | — |
| Gemma4-E4B | Q4_K_M | — | — | — | — | Jetsam (5.5 GB) | — |
| Gemma4-E4B | Q8_0 | — | — | — | — | Jetsam (8.5 GB) | — |
| Qwen3.5-2B | Q4_K_M | elephant | 555 | 231.1 | 31.4 | 10,467 | 135 |
| Qwen3.5-2B | Q8_0 | elephant | 570 | 237.2 | 22.6 | 14,152 | 78 |
| Qwen3.5-4B | Q4_K_M | elephant | 638 | 124.3 | 14.4 | 21,906 | 97 |
| Qwen3.5-4B | Q8_0 | — | — | — | — | Jetsam (4.8 GB) | — |

**b9025** (upstream tag `eff06702b`):

| Model | Quant | Image | Vision (ms) | Prefill (t/s) | Decode (t/s) | Total (ms) | RSS (MB) |
|-------|-------|-------|------------|---------------|-------------|-----------|----------|
| Gemma4-E2B | Q4_K_M | elephant | 879 | 176.2 | 30.0 | 10,815 | 96 |
| Gemma4-E2B | Q4_K_M | fruitPlate | 896 | 179.5 | 30.0 | 10,787 | 96 |
| Qwen3.5-2B | Q4_K_M | elephant | 591 | 222.2 | 31.0 | 10,705 | 128 |
| Qwen3.5-2B | Q8_0 | elephant | 549 | 241.5 | 23.2 | 13,633 | 114 |
| Qwen3.5-4B | Q4_K_M | elephant | 647 | 124.4 | 14.6 | 21,549 | 107 |

**Fiber vs b9025 — Anchor variant (Gemma4-E2B-Q4 Metal elephant):**

| Metric | Fiber | b9025 | Delta |
|--------|-------|-------|-------|
| Vision (ms) | 883 | 879 | -0.5% |
| Prefill (t/s) | 174.4 | 176.2 | +1.0% |
| Decode (t/s) | 30.9 | 30.0 | -2.9% |

Anchor delta within 3% — no significant thermal drift between sessions.

**Fiber vs b9025 — All models:**

| Model | Quant | Fiber decode (t/s) | b9025 decode (t/s) | Delta |
|-------|-------|--------------------|--------------------| ------|
| Gemma4-E2B | Q4_K_M | 30.9 | 30.0 | -2.9% |
| Qwen3.5-2B | Q4_K_M | 31.4 | 31.0 | -1.3% |
| Qwen3.5-2B | Q8_0 | 22.6 | 23.2 | +2.7% |
| Qwen3.5-4B | Q4_K_M | 14.4 | 14.6 | +1.4% |

All deltas within ±3% — fiber and b9025 are equivalent on iPhone 16 Pro Metal
for these models. The decode ceiling is ~31 t/s (2B Q4) / ~23 t/s (2B Q8) /
~15 t/s (4B Q4), consistent with the A18 Pro's ~60 GB/s memory bandwidth.

**Caveat — Firebase Test Lab thermal and external factors:** These results are
directionally reliable for establishing per-model baselines but not precise
enough to detect <5% branch deltas. Firebase does not expose device thermal
state, does not guarantee the same physical device across sessions, and shares
devices with other users between invocations. The anchor variant shows -2.9%
(borderline on the 3% noise threshold), which could reflect thermal carryover,
different device hardware, or background process interference. For precise
branch-to-branch comparison (<5% deltas), local device testing with
`powermetrics` thermal monitoring is required.

**Cross-platform comparison (Gemma4-E2B Q4_K_M Metal elephant, b9025):**

| Device | Vision (ms) | Prefill (t/s) | Decode (t/s) | Peak RSS (MB) | RSS method |
|--------|------------|---------------|-------------|--------------|------------|
| Mac M4 (16 GB, 8 cores) | 632 | 260.3 | 50.7 | 1,266 | `/usr/bin/time -l` |
| iPhone 16 Pro (8 GB, 6 cores) | 879 | 176.2 | 30.0 | 96 | `mach_task_basic_info` [^2] |
| iPhone 16e (8 GB, 5 cores) | 1,285 | 122.7 | 27.3 | 1,071 | `mach_task_basic_info` |

[^2]: Firebase RSS values are not comparable to local measurements — see iPhone 16 Pro notes above.

iPhone 16 Pro sits between Mac M4 and iPhone 16e as expected — 6 GPU cores vs
5 (16e) and 8 (M4), ~60 GB/s vs ~50 GB/s vs ~120 GB/s bandwidth.

---

## 3. Top-3 Bottlenecks per Platform

Ranked by % of wall-clock time for Gemma4-E2B Q4_K_M on elephant.jpg. Percentages derived from benchmark timing data.

> **TODO**: Apple profiler evidence screenshots (Xcode Instruments Metal System Trace) not included. Detailed shader/memory analysis of captured traces pending.

### Mac M4 Metal (Total: 6,602 ms)

| Rank | Phase | Time | % of Wall | Notes |
|------|-------|------|-----------|-------|
| 1 | Decode | 5,027 ms | **76.1%** | Memory-bandwidth-bound at ~50.7 t/s |
| 2 | Prefill | 1,091 ms | **16.5%** | CPU Accelerate BLAS actually faster (420 t/s vs 260 t/s) |
| 3 | Vision encode | 632 ms | **9.6%** | SigLIP CLIP encoder on Metal |

### iPhone 16e Metal (Total: 9,885 ms)

| Rank | Phase | Time | % of Wall | Notes |
|------|-------|------|-----------|-------|
| 1 | Decode | 5,478 ms | **55.4%** | 5-core GPU, 23.2 t/s (1.88x slower than Mac M4) |
| 2 | Prefill | 2,330 ms | **23.6%** | CPU prefill is 1.28x faster (161 vs 126 t/s) |
| 3 | Vision encode | 1,272 ms | **12.9%** | 2.08x slower than Mac due to fewer GPU cores |

Android bottleneck analysis: see [Appendix G, Section G.7](#g7-top-3-bottlenecks-android).

---

## 4. Key Findings

### Metal Performance

1. **Metal decode throughput scales with GPU core count.** Mac M4 (8 cores) achieves 51.3 t/s vs iPhone 16e (5 cores) at 27.2 t/s for Gemma4-E2B Q4_K_M — 1.88x speedup from 1.6x more cores. Super-linear scaling from higher memory bandwidth and thermal headroom.

2. **CPU prefill beats Metal prefill on Apple Silicon (Gemma 4).** Accelerate BLAS outperforms Metal dispatch for batch token processing: Mac 1.6-2.6x, iPhone 1.28x. Exception: Qwen3.5 where Metal prefill is 1.3-2.4x faster (SSM/GDN layers have poor Accelerate mapping).

3. **Metal always wins for decode.** 1.06-1.33x faster than CPU across all configs. Decode is memory-bandwidth-bound; Metal has better bandwidth utilization.

4. **Vision pipeline is 2-8x faster on Metal.** Driven by image projection: CPU 1,400-4,600 ms, Metal 510-836 ms. Qwen3.5-4B shows the largest gap (8.5x) due to heavy merger computation.

5. **Q4_K_M is optimal for Metal decode.** 1.5-1.7x higher decode throughput than Q8_0 across all Gemma4 configs.

### Memory & Compatibility

6. **iPhone 16e memory is the primary Metal constraint.** Only Gemma4-E2B Q4_K_M (3.8 GB) fits in ~5.7 GB app limit. All larger models OOM.

7. **Qwen3.5-2B works correctly on Metal (Mac + iPhone).** SSM (Gated Delta Net) architecture is correctly supported by Metal. Garbled output observed on Pixel 9 Pro — see [Appendix G](#appendix-g-android-gpu-results).

8. **Image projection behaves differently across devices.** `qwen3vl_merger` is 2 ms on Mac but 183 ms on iPhone 16e (5x slower than Gemma 4's `gemma4a`). Suggests merger requires GPU parallelism that 5-core GPU cannot exploit.

9. **Qwen3.5-4B and Gemma4-E4B converge at ~14-23 t/s on Metal.** Larger models are more uniformly memory-bandwidth-bound. Smaller models (E2B/2B) show more architectural variation: Gemma4-E2B at 50.7 t/s vs Qwen3.5-2B at 39.8 t/s.

### Branch Comparison

10. **Addon introduces 19-30% decode overhead vs CLI**, but this may be partially or entirely due to fiber fork regression (see #11).

11. **Fiber fork introduces 7-38% Metal decode regression vs upstream b9025.** Confirmed across 4 independent sessions with verified binary provenance. Regression is worst on smaller Gemma4 models (E2B Q4_K_M: -38%, E2B Q8_0: -29%) and lessens on larger models (E4B Q8_0: -12%, Qwen3.5-4B Q8_0: -7%). CPU decode regression is smaller (0-16%) and within tolerance for some configs.

12. **U1 deepstack prealloc is identical to b9025 on Mac M4** — all metrics within +/-1%. U1 targets iPhone 16e projection, which is already fast on Mac.

13. **Fiber regression fixes recovered most Gemma4 gap** (-2.8% remaining) **but Qwen3.5 retains a 14% gap.** RC1 (fused GDN) gave +18.8% for Qwen3.5; RC3 (FA dk512) gave +17.7% for Gemma4.

Android-specific findings: see [Appendix G, Section G.8](#g8-android-key-findings).

---

## 5. TODO / Missing Items

Items not yet delivered:

| # | Item | Status | Reason |
|---|------|--------|--------|
| 1 | **Peak RSS (MB) — Mac M4** | **Done** | Captured via `/usr/bin/time -l` (2026-05-13 run). See [Section 2](#2-primary-results-matrix) and [Appendix D.1c](#d1c-peak-rss-comparison-mb) |
| 1b | **Peak RSS (MB) — iPhone 16e** | **Partial** | In-process `mach_task_basic_info` RSS captured (2026-05-18 local matrix). Note: measures XCTest host process RSS, not standalone binary — includes test framework overhead (~50-100 MB). See [iPhone 16e full matrix](#iphone-16e-a18--local-device-full-matrix-added-2026-05-18) |
| 2 | **iPhone 16 Pro** | **Done** | Firebase Test Lab `DEVICE_CAPACITY_LOW` (2026-05-18). Fiber + b9025, Metal-only, 4 models with data, 4 Jetsam. See [Section 2, iPhone 16 Pro](#iphone-16-pro-a18-pro--firebase-test-lab-added-2026-05-18) |
| 3 | **iPhone 17** | Not tested | Firebase Test Lab: not in device catalog (2026-05-18) |
| 4 | **Apple profiler evidence screenshots** | Not included | Metal System Traces captured but detailed shader/memory analysis pending |
| 5 | **iPhone 16e Qwen3.5-2B** | **Done** | Full 3-run matrix collected (2026-05-18 local). Fiber: 8.22 t/s, b9025: 27.69 t/s. See [iPhone 16e full matrix](#iphone-16e-a18--local-device-full-matrix-added-2026-05-18) |
| 6 | **Raw traces** | Not uploaded | 6 trace files (~2.1 GB total) — stored locally |
| 7 | **Executive summary comment** | Not posted | Pending report PR merge |
| 8 | **Report PR reviewed and merged** | Pending | PR #1923 opened on `feat/QVAC-18293-profile-gemma4-vl-mobile-gpus` |

Android TODO items: see [Appendix G, Section G.9](#g9-android-todo-items).

---

## Appendices

### Appendix A: iPhone 16e OOM Detail

The iPhone 16e's ~5.7 GB app memory limit means only model+mmproj combinations under ~4 GB can run. Gemma4-E2B Q4_K_M (3.8 GB) is the only viable Gemma4 configuration.

| Model | Quant | Total Size | Error |
|-------|-------|-----------|-------|
| Gemma4-E2B | Q8_0 | 5.6 GB | `kIOGPUCommandBufferCallbackErrorOutOfMemory` + signal 11 |
| Gemma4-E4B | Q4_K_M | 5.5 GB | `kIOGPUCommandBufferCallbackErrorOutOfMemory` + signal 11 |
| Gemma4-E4B | Q8_0 | 8.5 GB | `mmap failed: Cannot allocate memory` + signal 11 |

OOM confirmed across both run-1 (2026-05-06) and run-2 (2026-05-07) with consistent error messages.

---

### Appendix B: GPU vs CPU Speedup Comparisons

#### B.1 Mac M4 — Metal vs CPU Decode

| Model | Quant | CPU (t/s) | Metal (t/s) | Speedup |
|-------|-------|----------|------------|---------|
| Gemma4-E2B | Q4_K_M | 38.68 | 50.73 | **1.31x** |
| Gemma4-E2B | Q8_0 | 25.23 | 30.88 | **1.22x** |
| Gemma4-E4B | Q4_K_M | 17.22 | 22.82 | **1.33x** |
| Gemma4-E4B | Q8_0 | 12.15 | 14.34 | **1.18x** |
| Qwen3.5-2B | Q4_K_M | 33.32 | 39.79 | **1.19x** |
| Qwen3.5-2B | Q8_0 | 28.72 | 30.37 | **1.06x** |
| Qwen3.5-4B | Q4_K_M | 15.96 | 17.60 | **1.10x** |
| Qwen3.5-4B | Q8_0 | 12.80 | 14.08 | **1.10x** |

#### B.1b Mac M4 — Metal vs CPU Prefill

| Model | Quant | CPU (t/s) | Metal (t/s) | Winner |
|-------|-------|----------|------------|--------|
| Gemma4-E2B | Q4_K_M | 419.64 | 260.33 | **CPU (1.61x)** |
| Gemma4-E2B | Q8_0 | 419.04 | 231.93 | **CPU (1.81x)** |
| Gemma4-E4B | Q4_K_M | 338.53 | 132.16 | **CPU (2.56x)** |
| Gemma4-E4B | Q8_0 | 234.57 | 133.36 | **CPU (1.76x)** |
| Qwen3.5-2B | Q4_K_M | 124.12 | 218.68 | **Metal (1.76x)** |
| Qwen3.5-2B | Q8_0 | 170.01 | 228.06 | **Metal (1.34x)** |
| Qwen3.5-4B | Q4_K_M | 53.46 | 125.80 | **Metal (2.35x)** |
| Qwen3.5-4B | Q8_0 | 66.21 | 133.69 | **Metal (2.02x)** |

#### B.1c Mac M4 — Metal vs CPU Vision Pipeline

| Model | Quant | CPU (ms) | Metal (ms) | Speedup |
|-------|-------|---------|-----------|---------|
| Gemma4-E2B | Q4_K_M | 2,128 | 632 | **3.37x** |
| Gemma4-E2B | Q8_0 | 1,929 | 704 | **2.74x** |
| Gemma4-E4B | Q4_K_M | 4,196 | 772 | **5.44x** |
| Gemma4-E4B | Q8_0 | 3,857 | 836 | **4.61x** |
| Qwen3.5-2B | Q4_K_M | 1,974 | 537 | **3.68x** |
| Qwen3.5-2B | Q8_0 | 1,434 | 531 | **2.70x** |
| Qwen3.5-4B | Q4_K_M | 4,610 | 543 | **8.49x** |
| Qwen3.5-4B | Q8_0 | 3,698 | 510 | **7.25x** |

#### B.2 iPhone 16e — Metal vs CPU (Gemma4-E2B Q4_K_M only)

| Metric | CPU (run-2) | Metal (run-2) | Winner |
|--------|-----------|-------------|--------|
| Decode (t/s) | 25.37 | 27.24 | **Metal (1.07x)** |
| Prefill (t/s) | 160.96 | 125.92 | **CPU (1.28x)** |
| Vision (ms) | 1,151 | 1,236 | **CPU (1.07x)** |
| TTFT (ms) | 2,916 | 3,492 | **CPU (1.20x faster)** |

> On iPhone 16e, CPU wins on prefill and TTFT; Metal wins only on decode. The vision encoder (mmproj) runs on Metal regardless of backend setting.

Android GPU vs CPU comparisons: see [Appendix G, Section G.5](#g5-android-gpu-vs-cpu-speedup).

---

### Appendix C: Cross-Device Comparison

#### C.1 Cross-Device Metal — Mac M4 vs iPhone 16e

##### Decode Throughput (elephant.jpg, Metal)

| Model | Quant | Mac M4 (t/s) | iPhone 16e (t/s) | Mac / iPhone |
|-------|-------|-------------|-----------------|-------------|
| Gemma4-E2B | Q4_K_M | 50.73 | 27.24 | **1.86x** |
| Gemma4-E2B | Q8_0 | 30.88 | — (OOM) | — |
| Gemma4-E4B | Q4_K_M | 22.82 | — (OOM) | — |
| Gemma4-E4B | Q8_0 | 14.34 | — (OOM) | — |
| Qwen3.5-2B | Q4_K_M | 39.79 | — | — |
| Qwen3.5-2B | Q8_0 | 30.37 | — | — |
| Qwen3.5-4B | Q4_K_M | 17.60 | — | — |
| Qwen3.5-4B | Q8_0 | 14.08 | — | — |

##### TTFT (elephant.jpg, Metal)

| Model | Quant | Mac M4 (ms) | iPhone 16e (ms) | Mac speedup |
|-------|-------|------------|----------------|-------------|
| Gemma4-E2B | Q4_K_M | 1,723 | 3,492 | **2.03x** |
| Gemma4-E2B | Q8_0 | 1,929 | — (OOM) | — |
| Gemma4-E4B | Q4_K_M | 2,921 | — (OOM) | — |
| Gemma4-E4B | Q8_0 | 2,966 | — (OOM) | — |
| Qwen3.5-2B | Q4_K_M | 1,749 | — | — |
| Qwen3.5-2B | Q8_0 | 1,693 | — | — |
| Qwen3.5-4B | Q4_K_M | 2,650 | — | — |
| Qwen3.5-4B | Q8_0 | 2,492 | — | — |

> Mac Metal TTFT is 2.0x faster than iPhone 16e.

Cross-platform comparisons including Android devices: see [Appendix G, Section G.6](#g6-cross-platform-comparison-all-devices).

---

### Appendix D: Branch Comparison — b9025 vs U1 vs Fiber

All branch comparisons use Mac M4 Metal, elephant.jpg, identical test matrix.

#### D.1 Fiber vs b9025 Baseline

**Date**: 2026-05-13 (full matrix), 2026-05-12 (initial 2-model comparison)
**Fiber build**: `tetherto/temp-8189` (build 8412, commit `f686a1324`)

##### D.1a Metal — elephant.jpg

| Model | Quant | Metric | b9025 | Fiber | Delta |
|-------|-------|--------|-------|-------|-------|
| Gemma4-E2B | Q4_K_M | Decode (t/s) | 50.73 | 31.45 | **-38.0%** |
| | | Prefill (t/s) | 260.33 | 177.33 | **-31.9%** |
| | | Vision (ms) | 632 | 804 | **+27.2%** |
| | | Total (ms) | 6,602 | 10,130 | **+53.4%** |
| Gemma4-E2B | Q8_0 | Decode (t/s) | 30.88 | 21.79 | **-29.4%** |
| | | Prefill (t/s) | 231.93 | 184.94 | **-20.3%** |
| | | Total (ms) | 10,008 | 13,646 | **+36.3%** |
| Gemma4-E4B | Q4_K_M | Decode (t/s) | 22.82 | 16.78 | **-26.5%** |
| | | Prefill (t/s) | 132.16 | 109.69 | **-17.0%** |
| | | Total (ms) | 13,891 | 18,303 | **+31.8%** |
| Gemma4-E4B | Q8_0 | Decode (t/s) | 14.34 | 12.66 | **-11.7%** |
| | | Prefill (t/s) | 133.36 | 141.72 | +6.3% |
| | | Total (ms) | 21,101 | 23,329 | **+10.6%** |
| Qwen3.5-2B | Q4_K_M | Decode (t/s) | 39.79 | 32.56 | **-18.2%** |
| | | Prefill (t/s) | 218.68 | 253.23 | +15.8% |
| | | Total (ms) | 7,810 | 9,181 | **+17.6%** |
| Qwen3.5-2B | Q8_0 | Decode (t/s) | 30.37 | 25.28 | **-16.8%** |
| | | Prefill (t/s) | 228.06 | 249.70 | +9.5% |
| | | Total (ms) | 9,844 | 11,446 | **+16.3%** |
| Qwen3.5-4B | Q4_K_M | Decode (t/s) | 17.60 | 15.46 | **-12.2%** |
| | | Prefill (t/s) | 125.80 | 125.22 | -0.5% |
| | | Total (ms) | 16,801 | 19,006 | **+13.1%** |
| Qwen3.5-4B | Q8_0 | Decode (t/s) | 14.08 | 13.15 | **-6.6%** |
| | | Prefill (t/s) | 133.69 | 111.00 | **-17.0%** |
| | | Total (ms) | 20,362 | 22,246 | **+9.3%** |

##### D.1b CPU — elephant.jpg

| Model | Quant | Metric | b9025 | Fiber | Delta |
|-------|-------|--------|-------|-------|-------|
| Gemma4-E2B | Q4_K_M | Decode (t/s) | 38.68 | 38.08 | -1.6% |
| | | Prefill (t/s) | 419.64 | 415.57 | -1.0% |
| | | Total (ms) | 9,233 | 9,462 | +2.5% |
| Gemma4-E2B | Q8_0 | Decode (t/s) | 25.23 | 21.09 | **-16.4%** |
| | | Prefill (t/s) | 419.04 | 364.83 | **-12.9%** |
| | | Total (ms) | 12,622 | 15,229 | **+20.7%** |
| Gemma4-E4B | Q4_K_M | Decode (t/s) | 17.22 | 14.83 | **-13.9%** |
| | | Prefill (t/s) | 338.53 | 329.61 | -2.6% |
| | | Total (ms) | 20,156 | 23,830 | **+18.2%** |
| Gemma4-E4B | Q8_0 | Decode (t/s) | 12.15 | 11.45 | -5.8% |
| | | Prefill (t/s) | 234.57 | 260.51 | +11.1% |
| | | Total (ms) | 26,818 | 28,489 | +6.2% |
| Qwen3.5-2B | Q4_K_M | Decode (t/s) | 33.32 | 33.99 | +2.0% |
| | | Prefill (t/s) | 124.12 | 111.75 | **-10.0%** |
| | | Total (ms) | 10,067 | 10,184 | +1.2% |
| Qwen3.5-2B | Q8_0 | Decode (t/s) | 28.72 | 28.00 | -2.5% |
| | | Prefill (t/s) | 170.01 | 139.67 | **-17.8%** |
| | | Total (ms) | 10,677 | 11,224 | +5.1% |
| Qwen3.5-4B | Q4_K_M | Decode (t/s) | 15.96 | 16.45 | +3.1% |
| | | Prefill (t/s) | 53.46 | 46.98 | **-12.1%** |
| | | Total (ms) | 21,219 | 21,438 | +1.0% |
| Qwen3.5-4B | Q8_0 | Decode (t/s) | 12.80 | 13.25 | +3.5% |
| | | Prefill (t/s) | 66.21 | 58.37 | **-11.8%** |
| | | Total (ms) | 24,300 | 24,063 | -1.0% |

##### D.1c Peak RSS Comparison (MB)

| Model | Quant | Metal b9025 | Metal Fiber | CPU b9025 | CPU Fiber |
|-------|-------|-------------|-------------|-----------|-----------|
| Gemma4-E2B | Q4_K_M | 1,266 | 1,249 | 2,589 | 2,562 |
| Gemma4-E2B | Q8_0 | 1,272 | 1,250 | 3,607 | 3,575 |
| Gemma4-E4B | Q4_K_M | 1,353 | 1,331 | 4,123 | 4,091 |
| Gemma4-E4B | Q8_0 | 1,355 | 1,335 | 6,185 | 6,152 |
| Qwen3.5-2B | Q4_K_M | 933 | 946 | 2,173 | 2,176 |
| Qwen3.5-2B | Q8_0 | 933 | 946 | 2,871 | 2,873 |
| Qwen3.5-4B | Q4_K_M | 1,051 | 1,071 | 3,698 | 3,712 |
| Qwen3.5-4B | Q8_0 | 1,052 | 1,072 | 5,361 | 5,374 |

Peak RSS is comparable between branches (within ±2%). CPU backend uses ~2-5x more RSS than Metal due to CPU-mapped model buffers.

#### D.2 Verified Rebuild Validation

The b9025 binary was rebuilt from a verified upstream tag checkout (`git checkout b9025`, confirmed commit `eff06702b`). Full benchmark suite re-run with identical test matrix.

| Model | Build | Vision (ms) | Prefill (t/s) | Decode (t/s) | Total (ms) |
|-------|-------|-------------|---------------|--------------|------------|
| Qwen3.5-2B Q4_K_M | b9025 (verified) | 395 | 334.2 | 52.62 | 5,943 |
| | Fiber | 419 | 302.1 | 38.21 | 7,768 |
| | **Delta** | +6.1% | -9.6% | **-27.4%** | +30.7% |
| Gemma4-E2B Q4_K_M | b9025 (verified) | 604 | 261.9 | 50.72 | 6,574 |
| | Fiber | 603 | 258.2 | 41.88 | 7,670 |
| | **Delta** | -0.2% | -1.4% | **-17.4%** | +16.7% |

##### Cross-Session Decode Consistency (t/s)

| Build | Model | Original (05-07) | Unverified (13:40) | Verified (15:00) |
|-------|-------|-----------------|-------------------|-----------------|
| b9025 | Qwen3.5 | 53.7 | 52.63 | 52.62 |
| b9025 | Gemma4 | 52.1 | 49.79 | 50.72 |
| Fiber | Qwen3.5 | — | 38.23 | 38.21 |
| Fiber | Gemma4 | — | 41.81 | 41.88 |

Intra-run variance <1% for all combinations. Cross-session decode variance <=2.3% (Gemma4 b9025) and <=1.2% (Qwen3.5 b9025).

#### D.3 Three-Way CLI Comparison (b9025 vs U1 vs Fiber)

**Date**: 2026-05-11 (b9025, U1), 2026-05-12 (Fiber verified)

##### Qwen3.5-2B Q4_K_M

| Metric | b9025 | U1 | Delta U1 | Fiber | Delta Fiber |
|--------|-------|-----|------|-------|---------|
| Vision (ms) | 402 | 406 | +1.0% | 419 | +4.2% |
| Img decode (ms) | 2 | 2 | — | — | — |
| Prefill (t/s) | 333.0 | 331.5 | -0.4% | 302.1 | **-9.3%** |
| Decode (t/s) | 53.74 | 53.82 | +0.1% | 38.21 | **-28.9%** |
| Total (ms) | 5,748 | 5,743 | -0.1% | 7,768 | **+35.1%** |

##### Gemma4-E2B Q4_K_M

| Metric | b9025 | U1 | Delta U1 | Fiber | Delta Fiber |
|--------|-------|-----|------|-------|---------|
| Vision (ms) | 604 | 603 | -0.2% | 603 | -0.2% |
| Img decode (ms) | 26 | 22 | -15.4% | — | — |
| Prefill (t/s) | 261.6 | 261.7 | +0.0% | 258.2 | -1.3% |
| Decode (t/s) | 52.12 | 52.11 | -0.0% | 41.88 | **-19.6%** |
| Total (ms) | 6,370 | 6,370 | 0.0% | 7,670 | **+20.4%** |

**Observations:**
- **U1 is identical to b9025 on Mac M4** — all metrics within +/-1%. U1 targets the Qwen3.5 iPhone 16e projection anomaly (183 ms -> 11 ms); on Mac the projection is already 2 ms.
- **Fiber regresses decode by 19-29%** across both models.
- **Fiber prefill regresses 9.3% on Qwen3.5** but only 1.3% on Gemma4 — the missing fused GDN (4743 graph nodes vs 1377, 38 splits vs 2) disproportionately affects the SSM-heavy Qwen3.5 architecture.

#### D.4 Fiber Regression Fix — Progressive Improvement (RC1-RC4)

**Date**: 2026-05-13
**Branch**: `feat/QVAC-18297-fiber-updates` from `tetherto/temp-8189`

Four root causes identified, three fixes applied as individual commits:

| Commit | Fix | Qwen3.5 Decode (t/s) | Gemma4 Decode (t/s) |
|--------|-----|----------------------|---------------------|
| baseline (fiber) | — | 38.21 | 41.88 |
| RC2: cherry-pick `d1649047a` | Metal MUL_MAT Tensor API opt | 38.14 (-0.2%) | 42.09 (+0.5%) |
| RC1: port GGML_OP_GATED_DELTA_NET | Fused GDN Metal SIMD kernel | 45.40 (+18.8%) | 40.90 (-2.3%) |
| RC3: port `342d6125b` | FA dk512_dv512 instantiations | 45.23 (+18.4%) | **49.29 (+17.7%)** |
| RC4: investigation only | No fix needed | — | — |

**Final gap vs b9025**: Qwen3.5 -14.0% (45.23 vs 52.62), Gemma4 -2.8% (49.29 vs 50.72)

##### Root Cause Details

- **RC2 (MUL_MAT)**: Zero effect on M4 Mac — Metal Tensor API is disabled for pre-M5/pre-A19 devices (`has tensor = false`).
- **RC1 (Fused GDN)**: Largest single improvement for Qwen3.5. Ported 4 upstream commits as a squashed commit. 16 files, 563 lines added. Graph splits reduced 38 -> 3 for Qwen3.5 decode.
- **RC3 (FA dk512)**: Largest improvement for Gemma4. Gemma4-E2B uses 512-dim heads for full-attention layers (every 5th layer); Metal had no FA kernel for dk512_dv512, causing auto-FA to globally disable Flash Attention. Added 19 template instantiations.
- **RC4**: `9e4530f51` (view_4d->reshape_4d) and `6aff83a75` (Metal buffer fallback) are both no-ops on M4 Mac during single-token decode.

##### Remaining Qwen3.5 Gap (-14.0%)

Possible causes:
1. Extra graph split: fiber has 3 splits (decode) vs b9025's 2 — one additional GPU<->CPU sync per token
2. State layout transpose overhead: `ggml_cont(ggml_transpose(s))` on input and `ggml_transpose(s_new)` on output add 2 extra ops per GDN layer
3. Upstream micro-optimizations between merge base (4d828bd1a) and b9025 (836 commits) not yet ported

---

### Appendix E: Addon vs CLI Overhead (Mac M4)

**Date**: 2026-05-11
**Addon**: llm-llamacpp v0.20.0 (wt-main branch, Bare runtime)
**CLI**: llama-mtmd-cli b9025 baseline

> **Caveat**: The addon benchmarks used the fiber-based addon, not upstream b9025. Finding #11 (see [Appendix D](#appendix-d-branch-comparison--b9025-vs-u1-vs-fiber)) reveals the fiber fork itself introduces a 19-29% decode regression. The overhead attributed here to JS binding may be partially or entirely caused by fiber fork regression. Isolating true addon overhead requires re-benchmarking the addon against an upstream b9025 build.

#### Qwen3.5-2B Q4_K_M (elephant.jpg, Metal)

| Metric | CLI | Addon | Delta | Delta % |
|--------|-----|-------|-------|---------|
| **Decode (t/s)** | 53.7 | 37.7 | -16.0 | **-29.8%** |
| **Prefill (t/s)** | 333.0 | 306.4 | -26.6 | **-8.0%** |
| Total/Wall (ms) | 5,748 | 7,726 | +1,978 | +34.4% |
| Model load (ms) | 192 | 614 | +422 | +220% |
| TTFT (ms) | — | 901 | — | — |

#### Gemma4-E2B Q4_K_M (elephant.jpg, Metal)

| Metric | CLI | Addon | Delta | Delta % |
|--------|-----|-------|-------|---------|
| **Decode (t/s)** | 52.1 | 42.1 | -10.0 | **-19.2%** |
| **Prefill (t/s)** | 261.6 | 258.9 | -2.7 | **-1.0%** |
| Total/Wall (ms) | 6,370 | 7,484 | +1,114 | +17.5% |
| Model load (ms) | 310 | 786 | +476 | +154% |
| TTFT (ms) | — | 1,120 | — | — |

#### Known Parameter Differences

| Parameter | CLI | Addon |
|-----------|-----|-------|
| Template | `--jinja` | addon template handler |
| Image scaling | `-fit off` | addon default |
| Threads | `--threads 4` | llama.cpp default (all cores) |
| Runtime | native binary | Bare runtime + JS binding |
| Stats granularity | vision_ms, img_decode_ms, prefill_ms, decode_ms | TTFT, TPS, ppTPS only |

---

### Appendix F: Metal Profiling & GPU Analysis

#### F.1 Metal GPU Configuration Comparison

| Property | Mac M4 | iPhone 16e A18 |
|----------|--------|----------------|
| GPU family | MTLGPUFamilyApple9, Metal4 | MTLGPUFamilyApple9 |
| GPU cores | 8 | 5 |
| Unified memory | 16 GB | 8 GB |
| recommendedMaxWorkingSetSize | 12,713 MB | ~5,727 MB |
| BFloat16 | yes | yes |
| Tensor cores | no (pre-M5) | no (pre-A19) |
| Residency sets | yes | yes |

#### F.2 Metal Memory Allocation (Mac M4)

| Component | Gemma4-E2B Q4_K_M | Qwen3.5-2B Q4_K_M |
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

#### F.3 Phase Breakdown — Mac M4 (elephant.jpg, Metal, `--predict 256`)

| Phase | Gemma4-E2B Q4_K_M | Qwen3.5-2B Q4_K_M | Notes |
|-------|--------------------|--------------------|-------|
| Model load | 280 ms | 191 ms | mmap + Metal buffer allocation |
| Vision encode (CLIP) | 585-607 ms | 412-535 ms | SigLIP / Qwen3VL encoder |
| Image decode (projection) | 25 ms | 2 ms | gemma4a cross-attn vs qwen3vl_merger |
| Prefill | 1,091 ms (284 tok, 260 t/s) | 1,212 ms (265 tok, 219 t/s) | LLM prompt eval |
| Decode | 5,027 ms (255 tok, 50.7 t/s) | 6,401 ms (255 tok, 39.8 t/s) | Token generation |
| **Total** | **6,602 ms** | **7,810 ms** | |

#### F.4 Phase Breakdown — iPhone 16e (elephant.jpg, Metal, `--predict 128`)

| Phase | Gemma4-E2B Q4_K_M | Qwen3.5-2B Q4_K_M | Notes |
|-------|--------------------|--------------------|-------|
| Vision encode (CLIP) | 1,272 ms | 829 ms | SigLIP / Qwen3VL encoder |
| Image decode (projection) | 36 ms | 183 ms | gemma4a cross-attn vs qwen3vl_merger |
| Prefill | 2,330 ms (284 tok, 122 t/s) | 1,983 ms (265 tok, 134 t/s) | LLM prompt eval |
| Decode | 5,478 ms (127 tok, 23.2 t/s) | 5,220 ms (127 tok, 24.3 t/s) | Token generation |
| **Total** | **9,885 ms** | **8,086 ms** | |

#### F.5 Phase Speedup — Mac M4 vs iPhone 16e (Gemma4-E2B Q4_K_M)

| Phase | Mac M4 | iPhone 16e | Mac speedup |
|-------|--------|-----------|-------------|
| Vision encode | 611 ms | 1,272 ms | **2.08x** |
| Image decode | 19 ms | 36 ms | **1.89x** |
| Prefill throughput | 260 t/s | 122 t/s | **2.13x** |
| Decode throughput | 51.3 t/s | 23.2 t/s | **2.21x** |

> Mac M4 consistently ~2x faster across all phases. 8 vs 5 GPU cores (1.6x) accounts for part of this; the rest comes from higher memory bandwidth and clock speeds.

#### F.6 Trace Inventory

| Trace | Device | Model | Predict | Size | Method |
|-------|--------|-------|---------|------|--------|
| `mac-m4-gemma4-e2b-q4km.trace` | Mac M4 | Gemma4-E2B Q4_K_M | 256 | 597 MB | `xcrun xctrace record --launch` |
| `mac-m4-qwen3.5-2b-q4km.trace` | Mac M4 | Qwen3.5-2B Q4_K_M | 256 | 480 MB | `xcrun xctrace record --launch` |
| `iPhone16e-gemma4-e2b-q4km.trace` | iPhone 16e | Gemma4-E2B Q4_K_M | 128 | 371 MB | Xcode Instruments GUI (manual) |
| `iPhone16e-qwen3.5-2b-q4km.trace` | iPhone 16e | Qwen3.5-2B Q4_K_M | 128 | 101 MB | Xcode Instruments GUI (manual) |
| `addon-qwen35-2b.trace` | Mac M4 | Qwen3.5-2B Q4_K_M (addon) | 256 | 478 MB | `xcrun xctrace record --launch` |
| `addon-gemma4-e2b.trace` | Mac M4 | Gemma4-E2B Q4_K_M (addon) | 256 | 121 MB | `xcrun xctrace record --launch` |

CLI traces stored in `vlm-benchmark/results/traces/`. Addon traces in `vlm-benchmark/results/traces/addon-mac-2026-05-11T1943/`. Open with: `open <path>.trace`

> Mac profiling is fully automated via `xcrun xctrace record --launch`. iPhone profiling requires manual Instruments GUI interaction because `xctrace --launch` cannot target arbitrary app sandbox processes on iOS.

---

### Appendix G: Android GPU Results

> Android GPU benchmarking will continue under a **separate dedicated report document**. The data below was collected during the Metal baseline investigation and is preserved here for reference.

#### G.1 Android Devices

| Device | SoC | GPU | GPU Cores | Memory | Best Backend | OS | Status |
|--------|-----|-----|-----------|--------|-------------|-----|--------|
| Samsung S25 | Snapdragon 8 Elite | Adreno 830 | — | 12 GB | OpenCL | Android 16 (API 36) | **Tested** |
| Pixel 9 Pro | Tensor G4 | Mali-G715 MC7 | — | 16 GB | Vulkan | Android 15 (API 35) | **Tested** |

#### G.2 Android Build Configuration

| Platform | Build |
|----------|-------|
| Android CPU | NDK r27b: `-DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28 -DGGML_OPENMP=OFF` |
| Android Vulkan | As above + `-DGGML_VULKAN=ON` + SPIR-V headers |
| Android OpenCL | As above + `-DGGML_OPENCL=ON -DGGML_OPENCL_USE_ADRENO_KERNELS=ON` |

#### G.3 Android Measurement Protocol Notes

- Pixel 9 Pro Vulkan: `GGML_VK_DISABLE_COOPMAT=1`, `GGML_VK_DISABLE_COOPMAT2=1`
- Samsung S25: OpenCL binary used for all tests; Vulkan binary crashes on load (driver bug)
- All other parameters same as [Section 1.4](#14-inference-parameters)

#### G.4 Primary Results

All results use elephant.jpg (612 x 408). Peak RSS not captured.

##### Samsung S25 (Adreno 830)

> Vulkan: N/A — Adreno 830 crashes when `libggml-vulkan.so` is loaded, even at `ngl=0` (driver bug).
> Qwen3.5-2B: not benchmarked on S25.

| Backend | Model | Quant | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Peak RSS |
|---------|-------|-------|------------|---------------|-------------|----------|----------|
| OpenCL | Gemma4-E2B | Q4_K_M | 2,871 | 73.36 | 14.95 | 6,742 | **TODO** |
| OpenCL | Gemma4-E2B | Q8_0 | 2,282 | 95.60 | 15.53 | 5,253 | **TODO** |
| OpenCL | Gemma4-E4B | Q4_K_M | 2,669 | 68.55 | 9.34 | 6,812 | **TODO** |
| OpenCL | Gemma4-E4B | Q8_0 | 2,801 | 70.29 | 8.03 | 6,841 | **TODO** |
| CPU | Gemma4-E2B | Q4_K_M | 2,622 | 91.33 | 12.73 | 5,732 | **TODO** |
| CPU | Gemma4-E2B | Q8_0 | 2,181 | 110.33 | 15.81 | 4,755 | **TODO** |
| CPU | Gemma4-E4B | Q4_K_M | 2,378 | 82.95 | 7.21 | 5,802 | **TODO** |
| CPU | Gemma4-E4B | Q8_0 | 2,185 | 71.89 | 7.42 | 6,135 | **TODO** |

##### Pixel 9 Pro (Mali-G715 MC7)

> Qwen3.5-2B produces garbled output on ALL P9P backends (Vulkan: `@@@`, CPU: empty newlines) but works correctly on Apple Silicon. Performance numbers valid for throughput comparison.

| Backend | Model | Quant | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Peak RSS |
|---------|-------|-------|------------|---------------|-------------|----------|----------|
| Vulkan | Gemma4-E2B | Q4_K_M | 25,429 | 8.29 | 10.62 | 59,687 | **TODO** |
| Vulkan | Gemma4-E2B | Q8_0 | 27,544 | 5.68 | 7.91 | 77,544 | **TODO** |
| Vulkan | Gemma4-E4B | Q4_K_M | 27,703 | 5.43 | 6.89 | 80,005 | **TODO** |
| Vulkan | Gemma4-E4B | Q8_0 | 33,773 | 2.86 | 4.69 | 133,074 | **TODO** |
| Vulkan | Qwen3.5-2B | Q4_K_M | 17,843 | 9.48 | 14.22 | 45,798 | **TODO** |
| OpenCL | Gemma4-E2B | Q4_K_M | 34,507 | 3.63 | 10.59 | 112,744 | **TODO** |
| OpenCL | Gemma4-E2B | Q8_0 | 34,516 | 3.66 | 7.86 | 112,112 | **TODO** |
| OpenCL | Gemma4-E4B | Q4_K_M | 41,073 | 2.06 | 6.89 | 178,937 | **TODO** |
| OpenCL | Gemma4-E4B | Q8_0 | 40,928 | 2.08 | 4.64 | 177,466 | **TODO** |
| CPU | Gemma4-E2B | Q4_K_M | 29,956 | 8.06 | 1.02 | 65,192 | **TODO** |
| CPU | Gemma4-E2B | Q8_0 | 29,940 | 8.19 | 1.36 | 64,616 | **TODO** |
| CPU | Gemma4-E4B | Q4_K_M | 30,005 | 7.42 | 0.73 | 68,280 | **TODO** |
| CPU | Gemma4-E4B | Q8_0 | 29,945 | 7.68 | 0.79 | 66,924 | **TODO** |
| CPU | Qwen3.5-2B | Q4_K_M | 21,850 | 4.76 | 1.97 | 77,522 | **TODO** |

#### G.5 Android GPU vs CPU Speedup

##### Samsung S25 — OpenCL vs CPU

| Model | Quant | CPU Decode (t/s) | OpenCL Decode (t/s) | Speedup |
|-------|-------|-----------------|---------------------|---------|
| Gemma4-E2B | Q4_K_M | 12.73 | 14.95 | **1.17x** |
| Gemma4-E2B | Q8_0 | 15.81 | 15.53 | 0.98x |
| Gemma4-E4B | Q4_K_M | 7.21 | 9.34 | **1.30x** |
| Gemma4-E4B | Q8_0 | 7.42 | 8.03 | **1.08x** |

> S25 CPU is fast enough that GPU offloading provides only marginal decode speedup (1.1-1.3x). Q8_0 on CPU is faster than Q4_K_M due to simpler dequantization in the Oryon CPU SIMD pipeline.

##### Pixel 9 Pro — Best GPU vs CPU

| Model | Quant | CPU Decode (t/s) | Best GPU Decode (t/s) | Backend | Speedup |
|-------|-------|-----------------|----------------------|---------|---------|
| Gemma4-E2B | Q4_K_M | 1.02 | 10.62 | Vulkan | **10.4x** |
| Gemma4-E2B | Q8_0 | 1.36 | 7.91 | Vulkan | **5.8x** |
| Gemma4-E4B | Q4_K_M | 0.73 | 6.89 | Vulkan | **9.4x** |
| Gemma4-E4B | Q8_0 | 0.79 | 4.69 | Vulkan | **5.9x** |

> GPU offloading is essential on P9P — CPU decode is 0.7-1.4 t/s (unusable).

#### G.6 Cross-Platform Comparison (All Devices)

##### Best Decode (elephant.jpg, best backend per device)

| Model | Quant | Mac Metal | iPhone 16e Metal | S25 Best | P9P Best | Mac/S25 | Mac/P9P |
|-------|-------|----------|-----------------|---------|---------|---------|---------|
| Gemma4-E2B | Q4_K_M | 50.73 t/s | 27.24 t/s | 14.95 (OCL) | 10.62 (VK) | **3.39x** | **4.78x** |
| Gemma4-E2B | Q8_0 | 30.88 t/s | — (OOM) | 15.81 (CPU) | 7.91 (VK) | **1.95x** | **3.90x** |
| Gemma4-E4B | Q4_K_M | 22.82 t/s | — (OOM) | 9.34 (OCL) | 6.89 (VK) | **2.44x** | **3.31x** |
| Gemma4-E4B | Q8_0 | 14.34 t/s | — (OOM) | 8.03 (OCL) | 4.69 (VK) | **1.79x** | **3.06x** |
| Qwen3.5-2B | Q4_K_M | 39.79 t/s | — | — | 14.22 (VK) | — | **2.80x** |
| Qwen3.5-2B | Q8_0 | 30.37 t/s | — | — | — | — | — |
| Qwen3.5-4B | Q4_K_M | 17.60 t/s | — | — | — | — | — |
| Qwen3.5-4B | Q8_0 | 14.08 t/s | — | — | — | — | — |

##### TTFT (elephant.jpg)

| Model | Quant | Mac Metal (ms) | iPhone 16e Metal (ms) | S25 Best (ms) | P9P Best (ms) |
|-------|-------|---------------|---------------------|--------------|--------------|
| Gemma4-E2B | Q4_K_M | 1,723 | 3,492 | 5,732 (CPU) | 59,687 (VK) |
| Gemma4-E2B | Q8_0 | 1,929 | — (OOM) | 4,755 (CPU) | 64,616 (CPU) |
| Gemma4-E4B | Q4_K_M | 2,921 | — (OOM) | 5,802 (CPU) | 68,280 (CPU) |
| Gemma4-E4B | Q8_0 | 2,966 | — (OOM) | 6,135 (CPU) | 66,924 (CPU) |
| Qwen3.5-2B | Q4_K_M | 1,749 | — | — | 45,798 (VK) |
| Qwen3.5-2B | Q8_0 | 1,693 | — | — | — |
| Qwen3.5-4B | Q4_K_M | 2,650 | — | — | — |
| Qwen3.5-4B | Q8_0 | 2,492 | — | — | — |

> Mac Metal TTFT is 2.0-2.1x faster than iPhone 16e, 2.1-3.3x faster than S25, and 23-37x faster than P9P.

#### G.7 Top-3 Bottlenecks (Android)

Ranked by % of wall-clock time for Gemma4-E2B Q4_K_M on elephant.jpg. Percentages derived from benchmark timing data.

> **TODO** *(deferred to separate Android ticket and report doc)*: Profiler evidence screenshots (Perfetto, Snapdragon Profiler, Mali Streamline) not included. Requires local device access.

##### Samsung S25 OpenCL (Gemma4-E2B Q4_K_M, est. total ~8,000 ms)

| Rank | Phase | Time (est.) | % of Wall | Notes |
|------|-------|------------|-----------|-------|
| 1 | Prefill | ~3,871 ms | **~48%** | 73 t/s — OpenCL dispatch overhead |
| 2 | Vision encode | 2,871 ms | **~36%** | Comparable to CPU (2,622 ms) |
| 3 | Decode | ~1,300 ms | **~16%** | 14.95 t/s — marginal GPU speedup |

##### Pixel 9 Pro Vulkan (Gemma4-E2B Q4_K_M, est. total ~90,000 ms)

| Rank | Phase | Time (est.) | % of Wall | Notes |
|------|-------|------------|-----------|-------|
| 1 | Prefill | ~34,258 ms | **~38%** | 8.29 t/s — extremely slow |
| 2 | Vision encode | 25,429 ms | **~28%** | 10-15x slower than S25 and iPhone |
| 3 | Decode | ~24,104 ms | **~27%** | 10.62 t/s — GPU essential (CPU is 1.02 t/s) |

##### Pixel 9 Pro CPU (Gemma4-E2B Q4_K_M, est. total ~316,000 ms)

| Rank | Phase | Time (est.) | % of Wall | Notes |
|------|-------|------------|-----------|-------|
| 1 | Decode | ~250,980 ms | **~79%** | 1.02 t/s — unusable |
| 2 | Prefill | ~35,236 ms | **~11%** | 8.06 t/s |
| 3 | Vision encode | 29,956 ms | **~9%** | Runs on CPU (no GPU acceleration) |

#### G.8 Android Key Findings

14. **Samsung S25 dramatically outperforms Pixel 9 Pro.** 10-15x faster vision encode, 10-12x faster CPU decode, 1.4-2x faster GPU decode.

15. **Vision encode dominates P9P latency.** 25-41 seconds on P9P vs 1-4s on S25 and ~1.2s on iPhone 16e. #1 optimization target for Tensor G4.

16. **Adreno 830 Vulkan is broken.** Driver crashes on load; OpenCL is the only viable GPU backend on S25.

17. **CPU decode on P9P is unusable.** 0.7-1.4 t/s — GPU offloading is essential.

#### G.9 Android TODO Items

*Deferred to separate Android ticket and report doc.*

| # | Item | Status | Reason |
|---|------|--------|--------|
| A1 | **Peak RSS (MB) — Android devices** | Not captured | `VmHWM` from `/proc/<pid>/status` not read in test harness |
| A2 | **Android profiler traces** | Not captured | Perfetto, Snapdragon Profiler, Streamline require local device access (Firebase provides timing only) |
| A3 | **Android profiler evidence screenshots** | Not included | Requires local device access for profiler instrumentation |
| A4 | **S25 Qwen3.5-2B** | Not benchmarked | Not included in original benchmark matrix |

#### G.10 Android Raw Data & Firebase Paths

All paths relative to `vlm-benchmark/` in the working directory.

**Raw logs — Firebase (Android):**

| Data Set | Path |
|----------|------|
| S25 Firebase raw logs | `results/raw/firebase-s25/` |
| P9P Firebase raw logs | `results/raw/firebase-pixel9/` |
| S25 E2B Q4 runs (v3-v6) | `results/raw/benchmark-s25-e2b-q4-v3/` through `benchmark-s25-e2b-q4-v6/` |
| S25 E2B Q8 runs | `results/raw/benchmark-s25-e2b-q8-v6/` |
| P9P E2B Q4 CPU | `results/raw/benchmark-p9p-e2b-q4-cpu/` |
| P9P E2B Q4 GPU | `results/raw/benchmark-p9p-e2b-q4-gpu/` |
| P9P E4B Q4 CPU | `results/raw/benchmark-p9p-e4b-q4-cpu/` |
| P9P E4B Q4 GPU | `results/raw/benchmark-p9p-e4b-q4-gpu/` |
| P9P E4B Q8 GPU | `results/raw/benchmark-p9p-e4b-q8-gpu/` |
**Firebase APK wrappers:**

| Data Set | Path |
|----------|------|
| Android CPU APK | `firebase-benchmark/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk` |
| Android GPU APK | `firebase-benchmark-gpu/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk` |
| iOS XCTest wrapper | `firebase-benchmark-ios/` |
| GCS models bucket | Private (use `gsutil signurl` for time-limited access) |

#### G.11 How to Reproduce (Android)

##### Android Firebase Test Lab

```
gcloud firebase test android run \
  --type instrumentation \
  --app <apk-wrapper> --test <test-apk> \
  --device model=<device>,version=<api> \
  --timeout 45m
```

---

### Appendix H: Raw Data & Binary Paths

All paths relative to `vlm-benchmark/` in the working directory.

| Data Set | Path |
|----------|------|
| Mac baseline (b9025) | `results/parsed/mac-baseline-2026-05-11T1557.json` |
| Mac U1 | `results/parsed/mac-u1-2026-05-11T1557.json` |
| Mac fiber | `results/parsed/mac-fiber-2026-05-12T1006.json` |
| Mac verified rebuild | `results/parsed/mac-verified-2026-05-12T1500.json` |
| Mac re-run (unverified) | `results/parsed/mac-rerun-2026-05-12T1340.json` |
| Fiber RC1 | `results/parsed/mac-fiber-rc1-2026-05-13T0130.json` |
| Fiber RC2 | `results/parsed/mac-fiber-rc2-2026-05-13T0900.json` |
| Fiber RC3 | `results/parsed/mac-fiber-rc3-2026-05-13T0230.json` |
| b9025 full matrix (8-model, RSS) | `results/parsed/b9025-mac-2026-05-13T1856.json` |
| Fiber full matrix (8-model, RSS) | `results/parsed/fiber-mac-2026-05-13T1856.json` |
| b9025 vs Fiber diff (full matrix) | `results/diffs/b9025-vs-fiber-mac-2026-05-13T1856.md` |
| Addon comparison | `results/parsed/addon-mac-2026-05-11T1943.json` |
| Addon vs CLI diff | `results/diffs/addon-vs-cli-mac-2026-05-11T1943.md` |
| Fiber gap analysis | `QVAC-18297-fiber-b9025-gap.md` |
| All parsed results | `results/all_parsed_results.json` |

**Raw logs — Mac:**

| Data Set | Path |
|----------|------|
| Mac raw CLI logs | `results/raw/mac/` |
| Mac raw addon logs | `results/raw/addon-mac-2026-05-11T1942/` |
| b9025 raw logs (verified) | `results/raw/b9025-mac-2026-05-12T1500/` |
| Fiber raw logs (verified) | `results/raw/fiber-mac-2026-05-12T1500/` |
| Fiber RC1-3 raw logs | `results/raw/fiber-rc{1,2,3}-mac-2026-05-13T*/` |
| b9025 full matrix (8-model, RSS) | `results/raw/b9025-mac-2026-05-13T1856/` |
| Fiber full matrix (8-model, RSS) | `results/raw/fiber-mac-2026-05-13T1856/` |

**Raw logs — iOS:**

| Data Set | Path |
|----------|------|
| iPhone local logs | `results/ios-local/` |
| iOS Firebase submissions | `results/benchmark-ios-e2b-q4/`, `benchmark-ios-e2b-q8/`, `benchmark-ios-e4b-q4/`, `benchmark-ios-e4b-q8/` |

**Profiling traces:**

| Data Set | Path |
|----------|------|
| CLI traces (4 files, ~1.55 GB) | `results/traces/` |
| Addon traces (2 files, ~599 MB) | `results/traces/addon-mac-2026-05-11T1943/` |

**Pre-compiled binaries:**

| Data Set | Path |
|----------|------|
| Binary: b9025 (verified) | `llama.cpp/binaries/b9025/` |
| Binary: b9025 (unverified, reference) | `llama.cpp/binaries/b9025-unverified/` |
| Binary: Fiber (tetherto/temp-8189) | `llama.cpp/binaries/fiber-temp8189/` |
| Binary: Fiber RC1-2 | `llama.cpp/binaries/fiber-rc{1,2}-*/` |
| Binary: Fiber RC3 (FA) | `binaries/fiber-rc3-fa/` |

---

### Appendix I: Benchmark & Test Scripts

All paths relative to `packages/qvac-lib-infer-llamacpp-llm/` (or `packages/llm-llamacpp/` in main repo).

| Script | Purpose |
|--------|---------|
| `benchmarks/run-benchmarks.sh` | Main benchmark harness (bash) |
| `benchmarks/run-benchmarks.ps1` | Windows variant (PowerShell) |
| `benchmarks/performance/` | Parameter sweep suite (JS): `llm-parameter-sweep.js`, `case-runner.js`, `run-param-sweep.js` |
| `benchmarks/performance/models.manifest.json` | Model registry for sweep |
| `benchmarks/performance/README.md` | Sweep documentation (dimensions, flags, resumability) |
| `benchmarks/qvac-18297-vlm-cache-bench.js` | Vision prefix cache bench |
| `benchmarks/client/evaluate_llama.py` | Python evaluation harness |
| `benchmarks/client/comparative_evaluator.py` | Addon vs HuggingFace Transformers comparison |
| `test/unit/test_vision_prefix_cache.cpp` | Vision cache unit tests (16 GoogleTest cases) |
| `test/integration/image.test.js` | VLM integration tests (A2 cache hit/miss, A3 overflow) |

**vlm-benchmark scripts** (in `vlm-benchmark/tools/scripts/`):

| Script | Purpose |
|--------|---------|
| `benchmark-mac-rss.sh` | Full 8-model × 2-backend × 2-branch matrix with `/usr/bin/time -l` RSS capture |
| `parse-mac-logs.py` | Parse llama-mtmd-cli logs into per-config medians with RSS + coherence checking |
| `diff-parsed.py` | Generate Markdown diff report comparing two parsed JSON files |
| `benchmark-mac.sh` | Original Mac benchmark script (no RSS, no pre-built binary support) |

---

### Appendix J: How to Reproduce

#### CLI Benchmark (Mac Metal)

```
DYLD_LIBRARY_PATH=vlm-benchmark/llama.cpp/binaries/b9025/ \
vlm-benchmark/llama.cpp/binaries/b9025/llama-mtmd-cli \
  --model models/gemma-4-E2B-it/gemma-4-E2B-it-Q4_K_M.gguf \
  --mmproj models/gemma-4-E2B-it/mmproj-F16.gguf \
  --image media/elephant.jpg \
  --ctx-size 4096 --predict 256 --gpu-layers 99 --threads 4 \
  --temp 0 --seed 42 --jinja -fit off \
  -p "Describe this image in detail."
```

#### CLI Benchmark (iPhone 16e)

```
xcrun devicectl device process launch --console \
  --device <UDID> \
  <app-sandbox-path>/llama-mtmd-cli \
  --model <sandbox>/gemma-4-E2B-it-Q4_K_M.gguf \
  --mmproj <sandbox>/mmproj-F16.gguf \
  --image <sandbox>/elephant.jpg \
  --ctx-size 4096 --predict 128 --gpu-layers 99 --threads 4 \
  --temp 0 --seed 42 --jinja -fit off \
  -p "Describe this image in detail."
```

#### Metal System Trace (Mac, automated)

```
xcrun xctrace record --template "Metal System Trace" \
  --launch -- \
  vlm-benchmark/llama.cpp/build-mac/bin/llama-mtmd-cli \
  --model <model> --mmproj <mmproj> --image <image> \
  --ctx-size 4096 --predict 256 --gpu-layers 99 --threads 4 \
  --temp 0 --seed 42 --jinja -fit off \
  -p "Describe this image in detail."
```

#### Addon Cache Bench

```
cd packages/qvac-lib-infer-llamacpp-llm
bare benchmarks/qvac-18297-vlm-cache-bench.js
# --device cpu to force CPU; default is GPU on Mac arm64
```

### Appendix K: iPhone 16e Phase 1 Measurements (b9025 only, 2026-05-07)

> Original Phase 1 baseline measurements on iPhone 16e. These used b9025
> (`eff06702b`) via `xcrun devicectl` with `--predict 128`. Superseded by
> the full fiber vs b9025 matrix in [Section 2, iPhone 16e full matrix](#iphone-16e-a18--local-device-full-matrix-added-2026-05-18)
> which uses `--predict 256` and in-process inference.
>
> **Date**: 2026-05-07 (run-2)
> **Raw logs**: Not preserved in vlm-benchmark repo (predates structured log collection).
> **Peak RSS**: Not captured (no `/usr/bin/time -l` on iOS CLI path at that time).

| Backend | Model | Quant | Vision (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Notes |
|---------|-------|-------|------------|---------------|-------------|----------|-------|
| Metal | Gemma4-E2B | Q4_K_M | 1,236 | 125.92 | 27.24 | 3,492 | Run-2 (2026-05-07), validated within 2% of run-1 |
| CPU | Gemma4-E2B | Q4_K_M | 1,151 | 160.96 | 25.37 | 2,916 | CPU prefill faster than Metal (Gemma4-specific) |
| Metal | Qwen3.5-2B | Q4_K_M | 1,012 | 133.66 | 24.33 | 2,995 | Profiling run only (1 run). Vision = encode 829 ms + projection 183 ms |
| Metal | Gemma4-E2B | Q8_0 | — | — | — | — | OOM: `kIOGPUCommandBufferCallbackErrorOutOfMemory` |
| Metal | Gemma4-E4B | Q4_K_M | — | — | — | — | OOM: `kIOGPUCommandBufferCallbackErrorOutOfMemory` |
| Metal | Gemma4-E4B | Q8_0 | — | — | — | — | OOM: `mmap failed: Cannot allocate memory` |

These measurements predate the fiber regression discovery and used `--predict 128`
(not 256) to avoid OOM on smaller context. The full matrix (Section 2) uses
`--predict 256` with in-process inference and captures both fiber and b9025.
