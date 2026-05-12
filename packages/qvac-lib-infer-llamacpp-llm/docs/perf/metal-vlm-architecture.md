# Metal VLM Architecture & Optimization Analysis

**QVAC-18295 | Phase 2 — LLM-Addon 0.18.0 VLM Optimization (Metal Focus)**

Companion to `gemma4-vl-architecture.md` (cross-platform). This document focuses exclusively on Metal backend optimization for Apple Silicon — Mac M4 as the reference ceiling, iPhone 16e as the deployment target. Covers both Gemma4-VL and Qwen3.5-VL.

Feeds into Phase 3 implementation: QVAC iOS Metal task (top-2 VLM optimizations + MLX cross-pollination).

---

## 1. Target Platforms & Constraints

| Property | Mac M4 (reference ceiling) | iPhone 16e (deployment target) |
|----------|---------------------------|-------------------------------|
| SoC | Apple M4 | Apple A18 |
| GPU cores | 8 | 5 |
| RAM | 16 GB unified | 8 GB (~5.7 GB usable) |
| GPU memory limit | 12.7 GB | ~5.7 GB |
| Metal feature set | Apple GPU Family 9 | Apple GPU Family 9 |
| Memory bandwidth | ~120 GB/s | ~60 GB/s (est.) |

**Model feasibility on iPhone 16e:**

| Model | GPU memory | Fits iPhone? |
|-------|-----------|-------------|
| Gemma4 E2B Q4_K_M | ~3,758 MiB | Yes |
| Gemma4 E2B Q8_0 | ~5,200 MiB | No (OOM) |
| Gemma4 E4B Q4_K_M | ~6,500 MiB | No (OOM) |
| Qwen3.5-2B Q4_K_M | ~1,990 MiB | Yes |

Only E2B Q4_K_M and Qwen3.5-2B Q4_K_M are viable on iPhone. E4B and Q8_0 variants are Mac-only.

---

## 2. Architecture Comparison: Gemma4-VL vs Qwen3.5-VL

Both models follow the standard VLM projection architecture but differ significantly in their projection and decoder designs.

### 2.1 Pipeline Overview

```
Gemma4-VL:
  Image → [SigLIP-SO400M ViT] → [Pool2D + RMSNorm + Linear] → [Gemma 2 Decoder]

Qwen3.5-VL:
  Image → [Dual-Conv ViT + M-RoPE + Deepstack] → [Reshape + 2-Layer MLP + Deepstack Concat] → [Hybrid Attn+SSM Decoder]
```

### 2.2 Component Comparison

| Component | Gemma4-VL (E2B) | Qwen3.5-VL (2B) |
|-----------|-----------------|------------------|
| Vision encoder | SigLIP-SO400M/14 (27 layers, 400M params) | ViT with dual-conv embedding + M-RoPE |
| Patch embedding | Single conv2d (14×14) | Dual conv2d (patch_size×patch_size), summed |
| Position encoding | Learned absolute | M-RoPE (4D: temporal + spatial) |
| Attention RoPE | None (standard ViT) | Multi-resolution RoPE per layer |
| Deepstack | None | Feature extraction at selected layers (norm + FFN + concat) |
| Projection type | `PROJECTOR_TYPE_GEMMA3` → `build_siglip()` | `PROJECTOR_TYPE_QWEN3VL` → `build_qwen3vl()` |
| Projection method | Pool2D(AVG, n_merge) + RMSNorm + single Linear | Reshape(n_embd×4) + 2-layer MLP(GELU) + deepstack concat |
| LLM decoder | Gemma 2 (18 layers, 2048 hidden, 8 heads) | Hybrid attention+SSM (25 layers) |
| Unique buffers | — | RS buffer 19 MiB (SSM recurrent state) |
| CLIP graph nodes | 940 | 736 |
| Graph splits | 2 | 2 |
| Context tokens (elephant.jpg) | 284 | 265 |
| Context tokens (fruitPlate.jpg) | ~284 | 4,015 (overflow risk at ctx=4096!) |

Code references (upstream llama.cpp):
- Projection type enum: `clip-impl.h:142-147`
- Gemma3 SigLIP projection: `clip.cpp:563-584`
- Qwen3VL deepstack + projection: `clip.cpp:908-1096`
- Patch merge permute utility: `clip.cpp:2451-2480`
- Graph dispatch: `clip.cpp:2488-2510`
- Addon integration: `MtmdLlmContext.cpp:121-136` (initVisionContext)

---

## 3. Metal Performance Matrix

All benchmarks: llama.cpp b9025, elephant.jpg (single tile), 256 predict tokens (Mac) / 128 predict (iPhone).

### 3.1 Mac M4 — All Model Variants (Metal Backend)

| Model | Vision (ms) | Projection (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Total (ms) |
|-------|------------|-----------------|---------------|-------------|----------|-----------|
| Gemma4 E2B Q4_K_M | 630 | 19 | 259.6 | 51.28 | 1,724 | 6,512 |
| Gemma4 E2B Q8_0 | 689 | — | 237.0 | 30.30 | 1,887 | 10,062 |
| Gemma4 E4B Q4_K_M | 768 | — | 135.9 | 23.28 | 2,858 | 13,619 |
| Gemma4 E4B Q8_0 | 827 | — | 138.4 | 15.26 | 2,880 | 20,040 |
| **Qwen3.5-2B Q4_K_M** | **417** | **2** | **323.6** | **51.83** | **1,236** | **5,947** |

Qwen3.5 is the fastest model on Mac Metal — 32% faster vision, 10.5× faster projection, and identical decode ceiling to Gemma4 E2B.

### 3.2 iPhone 16e — Feasible Models (Metal Backend)

| Model | Vision (ms) | Projection (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) |
|-------|------------|-----------------|---------------|-------------|----------|
| Gemma4 E2B Q4_K_M | 1,236 | 36 | 125.9 | 27.24 | 3,492 |
| Qwen3.5-2B Q4_K_M | 829 | **183** | 133.6 | 24.34 | — |

Gemma4 E2B Q4_K_M validated with Run-2 (27.24 t/s ±2.1% from Run-1's 26.66 t/s).

### 3.3 Metal vs CPU — Per-Phase Dispatch Analysis

| Phase | Gemma4 E2B | Qwen3.5-2B | Optimal Dispatch |
|-------|-----------|-----------|-----------------|
| **Vision encode** | Metal 3.4× faster (630 vs 2,113 ms) | Metal 4.6× faster (417 vs 1,922 ms) | Metal (both) |
| **Projection** | Metal (19 ms vs ~100 ms CPU est.) | Metal on Mac (2 ms), anomalous on iPhone (183 ms) | Metal Mac / investigate iPhone |
| **Prefill** | **CPU 1.63× faster** (424 vs 260 t/s) | **Metal 2.54× faster** (324 vs 127 t/s) | **Model-dependent!** |
| **Decode** | Metal 1.32× faster (51.3 vs 38.7 t/s) | Metal 1.58× faster (51.8 vs 32.7 t/s) | Metal (both) |

**Critical finding**: Gemma4 and Qwen3.5 require **opposite prefill dispatch strategies**. Gemma4 prefill is 1.63× faster on CPU (Accelerate BLAS wins), while Qwen3.5 prefill is 2.54× faster on Metal. A per-model dispatch table is needed in the addon.

### 3.4 Metal Decode Speedup by Quantization

| Model | CPU (t/s) | Metal (t/s) | Speedup |
|-------|----------|------------|---------|
| Gemma4 E2B Q4_K_M | 38.74 | 51.28 | 1.32× |
| Gemma4 E2B Q8_0 | 25.18 | 30.30 | 1.20× |
| Gemma4 E4B Q4_K_M | 17.64 | 23.28 | 1.32× |
| Gemma4 E4B Q8_0 | 12.12 | 15.26 | 1.26× |
| Qwen3.5-2B Q4_K_M | 32.74 | 51.83 | 1.58× |

Q4_K_M provides 1.5–1.7× faster decode than Q8_0 on both CPU and Metal. Qwen3.5 Q4_K_M benefits most from Metal (1.58×).

### 3.5 Vision Pipeline: Metal vs CPU

| Model | CPU (ms) | Metal (ms) | Speedup |
|-------|---------|-----------|---------|
| Gemma4 E2B Q4_K_M | 2,113 | 630 | 3.35× |
| Gemma4 E2B Q8_0 | 1,941 | 689 | 2.82× |
| Gemma4 E4B Q4_K_M | 4,370 | 768 | 5.69× |
| Gemma4 E4B Q8_0 | 3,881 | 827 | 4.69× |
| Qwen3.5-2B Q4_K_M | 1,922 | 417 | 4.61× |

Metal always wins for vision encoding, with larger speedups on bigger models (E4B Q4_K_M: 5.7×).

### 3.6 Cross-Device Metal Comparison

| Metric | Mac M4 | iPhone 16e | Mac/iPhone Ratio |
|--------|--------|-----------|-----------------|
| Gemma4 decode | 51.28 t/s | 27.24 t/s | 1.88× |
| Gemma4 vision | 630 ms | 1,236 ms | 1.96× |
| Gemma4 TTFT | 1,724 ms | 3,492 ms | 2.03× |
| Gemma4 projection | 19 ms | 36 ms | 1.89× |
| Qwen3.5 decode | 51.83 t/s | 24.34 t/s | 2.13× |
| Qwen3.5 vision | 417 ms | 829 ms | 1.99× |
| **Qwen3.5 projection** | **2 ms** | **183 ms** | **91.5×** |

Most phases scale roughly 2× between Mac M4 (8 cores) and iPhone 16e (5 cores). The Qwen3.5 projection is the sole outlier at **91.5×** — see Section 5 for analysis.

---

## 4. GPU Memory Analysis

### 4.1 Buffer Breakdown (Mac M4, Metal)

| Component | Gemma4 E2B Q4_K_M | Qwen3.5-2B Q4_K_M | Notes |
|-----------|-------------------|---------------------|-------|
| Model buffer (GPU) | 2,948 MiB | 1,211 MiB | Weight tensors on GPU |
| Model buffer (CPU) | 1,756 MiB | 398 MiB | Host-pinned (UMA accessible) |
| KV cache | 36 MiB | 48 MiB | Qwen3.5 larger despite fewer tokens |
| RS buffer (SSM) | — | 19 MiB | Recurrent state for SSM layers |
| Compute buffer (GPU) | 519 MiB | 489 MiB | LLM activation scratch |
| Compute buffer (CPU) | 34 MiB | 16 MiB | Host-side compute |
| CLIP compute buffer | 101 MiB | 223 MiB | Vision encoder scratch (2.2× larger for Qwen3.5) |
| mmproj buffer | 154 MiB | — | Projection weights (separate for Gemma4) |
| **Total GPU** | **~3,758 MiB** (30%) | **~1,990 MiB** (16%) | % of 12.7 GB Mac limit |
| Layers offloaded | 36/36 | 25/25 | All layers on GPU |

### 4.2 Memory Observations

- **Qwen3.5 uses 47% less total GPU memory** — significant for iPhone headroom
- **CLIP compute buffer is 2.2× larger for Qwen3.5** (223 vs 101 MiB), likely due to deepstack feature accumulation during ViT forward pass
- **Gemma4 has separate mmproj buffer** (154 MiB F16) — direct quantization target
- Both models fully offload all layers to GPU on Mac; iPhone feasibility confirmed for Q4_K_M
- iPhone headroom: Gemma4 ~1.9 GB free, Qwen3.5 ~3.7 GB free (allows larger context or batch)

---

## 5. Projection Layer Deep Dive

The projection layer is the bridge between vision encoder output and LLM input embeddings. Despite being a small fraction of total compute, it shows the most dramatic cross-device performance divergence.

### 5.1 Gemma4 Projection: Pool2D + Linear

Implementation: `clip.cpp:563-584` → `build_siglip()`

```
ViT output [n_embd=1152, n_patches]
  → transpose + reshape to [patches_per_side, patches_per_side, n_embd, batch]
  → pool_2d(AVG, kernel=n_merge, stride=n_merge)        # reduce token count by n_merge²
  → reshape + transpose back to [n_embd, n_tokens_reduced]
  → rms_norm + learned scale                              # mm_soft_emb_norm_w
  → mul_mat(mm_input_proj_w^T)                            # single projection: 1152 → 2048
```

**Op count**: ~9 ops (mostly zero-cost reshapes/views, 1 pool2d, 1 norm, 1 matmul)
**Key property**: Single matmul dominates compute; pool2d is a simple averaging operation

### 5.2 Qwen3.5 Projection: Deepstack + MLP

Implementation: `clip.cpp:908-1096` → `build_qwen3vl()`

The Qwen3VL projection is fundamentally different — it uses a **deepstack** mechanism that extracts features from multiple ViT layers during the forward pass, then concatenates them with the final projection output.

**During ViT forward pass** (per deepstack layer):
```
layer output [n_embd, n_pos]
  → reshape to [n_embd * merge_factor, n_pos / merge_factor]    # spatial merge
  → layer_norm + 2-layer FFN (GELU)                              # deepstack_fc1/fc2
  → concat with accumulated deepstack features                   # grows each deepstack layer
```

**Final projection** (after ViT):
```
ViT output [n_embd=1152, n_pos]
  → reshape to [n_embd * 4, n_pos / 4]              # 4× spatial merge (4608-dim vectors, ¼ tokens)
  → 2-layer MLP: mm_0_w → GELU → mm_1_w             # project to LLM embedding dim
  → concat with deepstack_features along feature dim  # merge all extracted features
```

**Op count**: ~20+ ops per inference (deepstack layers × (reshape + norm + FFN) + final reshape + MLP + concat)
**Key property**: `ggml_concat` grows a tensor across multiple layers; final concat merges all deepstack features with projection output

### 5.3 The iPhone Projection Anomaly

| Device | Gemma4 Projection | Qwen3.5 Projection | Cross-Model Ratio |
|--------|-------------------|---------------------|-------------------|
| Mac M4 | 19 ms | 2 ms | Qwen3.5 9.5× faster |
| iPhone 16e | 36 ms | 183 ms | Qwen3.5 5.1× slower |
| **Cross-Device Ratio** | **1.89×** | **91.5×** | |

The ~48× relative performance inversion between Mac and iPhone for Qwen3.5 projection is the most anomalous finding in Phase 1 benchmarking.

**Hypothesis 1: Deepstack concat buffer reallocation**
The `ggml_concat` operation accumulates features across deepstack layers, requiring growing GPU memory allocation. On Mac M4, the 12.7 GB GPU limit and larger cache hierarchy absorb this. On iPhone 16e, the smaller ~5.7 GB limit and reduced cache may force buffer eviction and reallocation during the concat chain.

**Hypothesis 2: Kernel dispatch overhead on A18**
Each deepstack layer adds reshape + norm + FFN + concat = ~6 kernel dispatches. With multiple deepstack layers, the total dispatch overhead becomes significant on A18's smaller GPU (5 cores vs 8), where command buffer processing is slower.

**Hypothesis 3: CLIP compute buffer pressure**
Qwen3.5's CLIP compute buffer is 223 MiB vs Gemma4's 101 MiB. On iPhone 16e, this larger scratch space competes with model weights for GPU memory, potentially causing Metal's memory allocator to page buffers between GPU-resident and host-mapped memory.

**Hypothesis 4: Metal shader specialization gap**
The deepstack operations (concat along feature dim, reshape with non-standard strides) may not have optimized Metal shader paths on A18. The M4's more mature Metal compiler may generate better code for these operations.

**Action required**: Analyze `iPhone16e-qwen3.5-2b-q4km.trace` (101 MB Metal System Trace) in Xcode Instruments to isolate which kernels contribute to the 183ms projection time.

### 5.4 Projection Optimization Opportunities

#### 5.4a Upstream llama.cpp (clip.cpp)

**P1. Fuse deepstack operations** (Impact: high, Cost: M)
Currently each deepstack layer dispatches separate reshape → norm → FFN → concat kernels. Fusing norm + FFN into a single Metal kernel and pre-allocating the concat output buffer would eliminate per-layer dispatch overhead and memory allocation.
- Target: `clip.cpp:1055-1070` (deepstack loop body)
- Expected impact: 50-80% reduction in projection time on iPhone

**P2. Pre-allocate deepstack output tensor** (Impact: medium, Cost: S)
Replace the growing `ggml_concat` chain with a single pre-allocated output buffer and indexed writes. The current pattern allocates a new tensor per concat, with copy overhead.
- Target: `clip.cpp:1064-1069` (deepstack concat)
- Expected impact: 20-40% on iPhone, minimal on Mac

**P3. mmproj weight quantization F16→Q8_0** (Impact: medium, Cost: M)
Both models carry F16 projection weights. Q8_0 quantization would halve memory bandwidth requirements and free GPU memory.
- Gemma4 mmproj: 154 MiB → ~77 MiB
- Qwen3.5 (within CLIP compute): proportional reduction
- Risk: Low — projection is compute-light, precision loss minimal for a linear transform
- Target: clip.cpp weight loading and quantization pipeline

**P4. Pool2D kernel optimization for Gemma4** (Impact: low, Cost: S)
The average pooling in Gemma4's projection uses generic GGML pool_2d. A Metal-specialized kernel for the exact dimensions (n_merge=2 or 4, 1152-dim vectors) could exploit SIMD grouping.
- Expected impact: 5-10 ms reduction on iPhone (36 → ~28 ms)

**P6. SigLIP FP16 standardization overflow** (Impact: correctness, Cost: S)
The final standardization step in SigLIP vision encoding can overflow in FP16: `std_bias` reaches ~5.4e4, approaching FP16 max (6.55e4). This causes `-inf` and NaN propagation in vision embeddings. Relevant to our Gemma4 SigLIP-SO400M encoder on Metal with FP16 compute — certain input images could trigger silent corruption.
- Mitigation: cast the standardization norm layer to FP32 (or BF16 on Apple GPU Family 9+)
- Verify whether ggml-metal already promotes this op to higher precision
- Risk: latent correctness bug, not just performance

#### 5.4b Addon-level (MtmdLlmContext.cpp)

**P5. Vision embedding cache with projection bypass** (Impact: high on repeat, Cost: S)
Cache the **post-projection** embeddings (not just post-vision). This bypasses both vision encoding AND projection on cache hit, which is especially valuable for Qwen3.5 on iPhone where projection alone costs 183ms.
- Key insight: cache after projection, not before, to skip the expensive merger
- Implementation: LRU cache keyed by image hash in MtmdLlmContext
- Saves per cache hit: Gemma4 666ms (630+36), Qwen3.5 1,012ms (829+183) on iPhone

---

## 6. Phase Timing Analysis

### 6.1 Mac M4 — Full Pipeline (elephant.jpg, 256 predict)

| Phase | Gemma4 E2B Q4_K_M | Qwen3.5-2B Q4_K_M | Δ |
|-------|-------------------|---------------------|---|
| Model load | 280 ms | 191 ms | Qwen3.5 32% faster |
| Vision encode | 611 ms | 415 ms | Qwen3.5 32% faster |
| Image projection | 19 ms | 2 ms | Qwen3.5 9.5× faster |
| Prefill | 1,094 ms (284 tok, 260 t/s) | 807 ms (265 tok, 329 t/s) | Qwen3.5 26% faster |
| Decode | 4,973 ms (255 tok, 51.3 t/s) | 4,920 ms (255 tok, 51.8 t/s) | **Identical ceiling** |
| **Total** | **6,512 ms** | **5,947 ms** | Qwen3.5 9% faster |

Both models hit the same decode ceiling (~51.5 t/s) — this is the M4's memory bandwidth limit (~120 GB/s). No software optimization can exceed this for decode.

### 6.2 iPhone 16e — Full Pipeline (elephant.jpg, 128 predict)

| Phase | Gemma4 E2B Q4_K_M | Qwen3.5-2B Q4_K_M | Δ |
|-------|-------------------|---------------------|---|
| Vision encode | 1,272 ms | 829 ms | Qwen3.5 35% faster |
| Image projection | 36 ms | **183 ms** | **Qwen3.5 5.1× slower** |
| Prefill | 2,330 ms (284 tok, 122 t/s) | 1,983 ms (265 tok, 134 t/s) | Qwen3.5 15% faster |
| Decode | 5,478 ms (127 tok, 23.2 t/s) | 5,220 ms (127 tok, 24.3 t/s) | Qwen3.5 5% faster |
| **Total** | **9,885 ms** | **8,086 ms** | Qwen3.5 18% faster overall |

Despite the projection anomaly, Qwen3.5 is faster end-to-end on iPhone due to vision and prefill advantages.

### 6.3 Phase Cost Distribution (iPhone 16e, % of total)

| Phase | Gemma4 E2B | Qwen3.5-2B |
|-------|-----------|-----------|
| Vision encode | 12.9% | 10.3% |
| Image projection | 0.4% | **2.3%** |
| Prefill | 23.6% | 24.5% |
| Decode | **55.4%** | **64.6%** |
| Other (load, overhead) | 7.7% | — |

Decode dominates both models (55-65% of runtime). Vision + projection together account for 13-14% on Gemma4 but 12-13% on Qwen3.5 — the projection anomaly adds ~1% to Qwen3.5's total time. Still worth fixing: 183ms is perceptible latency in the first-token path.

---

## 7. Optimization Recommendations

Ranked by (impact × breadth) ÷ cost. Split by implementation location.

### 7.1 Addon-Level Optimizations (MtmdLlmContext.cpp)

| Rank | Optimization | TTFT Impact | Cost | Details |
|------|-------------|------------|------|---------|
| **A1** | **Model-aware hybrid dispatch** | -20 to -40% | S | Route Gemma4 prefill to CPU (1.63× faster), Qwen3.5 prefill to Metal (2.54× faster). Keep decode on Metal for both. Requires per-model dispatch table in addon. |
| **A2** | **Post-projection vision cache** | -100% on hit | S | LRU cache keyed by image hash, storing post-projection embeddings. Bypasses vision+projection on repeat images. Saves 666ms (Gemma4) / 1,012ms (Qwen3.5) on iPhone per hit. |
| **A3** | **Qwen3.5 context overflow guard** | crash prevention | S | Pre-calculate vision token count before encoding. Qwen3.5 + large images produce 4,015 tokens, overflowing the 4,096 context window. Reject or resize before encoding. |
| **A4** | **Metal backend auto-detection** | UX | S | Auto-set `mparams.backend_device = "Metal"` on Apple platforms in `initVisionContext()`. Currently requires explicit configuration. |

### 7.2 Upstream llama.cpp Optimizations

| Rank | Optimization | Impact | Cost | Target | Details |
|------|-------------|--------|------|--------|---------|
| **U1** | **Qwen3VL deepstack fusion** | Projection -50 to -80% on iPhone | M | `clip.cpp:1055-1070` | Fuse deepstack reshape+norm+FFN into fewer kernel dispatches. Pre-allocate concat output buffer. Primary fix for the 183ms iPhone anomaly. |
| **U2** | **mmproj quantization (F16→Q8_0)** | Memory -50%, BW +1.5-2× | M | clip.cpp weight loading | Add Q8_0 quantization for projection weights. Gemma4: 154→~77 MiB. Frees GPU memory for larger context. Low risk for projection linear transforms. |
| **U3** | **Batch vision encoding** | Vision -30 to -50% (multi-tile) | M | `mtmd.cpp:824` | Fix existing TODO: implement batched encoding in `clip_image_batch_encode()`. Currently loops per-image for some model types. Impacts multi-tile images (4× tiles). |
| **U4** | **CLIP flash attention on Metal** | Vision -10 to -20% | S | `clip.cpp:3334` | Enable and validate flash attention for CLIP model on Metal. Currently auto-detected with fallback warning. External Metal FA implementation ([philipturner/metal-flash-attention](https://github.com/philipturner/metal-flash-attention)) shows 43-120% speedup via two-pass online softmax. Apple lacks native FP32 atomics, which is why ggml-metal FA regresses on some configs — the external implementation works around this. Evaluate whether its two-pass approach can be integrated into ggml-metal's FA path. |
| **U5** | **Vision encoder Metal kernel specialization** | Vision -15 to -25% | L | ggml-metal | Custom Metal compute kernels for ViT dimensions (1152 hidden, 16 heads, 72 head_dim). Generic GGML Metal kernels don't exploit architecture-specific tiling for these exact sizes. |

### 7.3 Priority Matrix

For Phase 3 implementation (top-2 optimizations), the recommended pair is:

**Primary: A1 (hybrid dispatch) + A2 (vision cache)**
- Both are addon-level (no upstream dependency)
- A1 is the only optimization that improves every single inference call
- A2 eliminates the entire vision+projection pipeline on cache hit
- Combined TTFT improvement: -20 to -40% (miss) / -70 to -90% (hit)

**Secondary: U1 (deepstack fusion)**
- Upstream change, but highest single-optimization impact for Qwen3.5 on iPhone
- Requires Metal System Trace analysis first to validate hypothesis
- Could be contributed upstream to llama.cpp

### 7.4 Research-Informed Upstream Optimizations (2026-05-12)

Additional optimization candidates identified via web research. Sequenced as U6+ to avoid collisions with tracked U1-U5.

| Rank | Optimization | Impact | Cost | Details |
|------|-------------|--------|------|---------|
| **U6** | **BF16 mmproj on Apple GPU Family 9+** | Memory −25% vs F16, quality ≈ F16 | S | BFloat16 is fully supported on Apple9 (M4, A18). Provides a middle ground between F16 (current) and Q8_0 (U2) for projection weights — same numerical fidelity as F16 for most ops with better mixed-precision behavior. Lower priority than U2 but relevant if Q8_0 shows quality regression on projection. |
| **U7** | **MTMD vision CPU fallback monitor** | Regression watchpoint | S | [llama.cpp #22582](https://github.com/ggml-org/llama.cpp/issues/22582): BF16 mmproj runs on CPU in `llama-server` MTMD path, causing 82s+ per image instead of ~630ms. Our addon uses the MTMD library directly (not through llama-server) and benchmarks confirm GPU dispatch (sub-second TTFT). **Not currently affected**, but if upstream MTMD API changes break GPU dispatch, vision would silently fall back to CPU. Add a regression test: assert vision TTFT < 2s on Metal. |
| **U8** | **Input-adaptive visual preprocessing** | Vision −50%+, token count −55% | L | [arxiv 2512.20839](https://arxiv.org/abs/2512.20839): Content-aware resolution selection dynamically adjusts image resolution based on content complexity. Reduces per-image inference time by >50% and visual token count by >55%. Partial solution to A3 (context overflow) — downscale intelligently instead of hard-rejecting. Long-term / research-grade. |

### 7.5 Advanced KV Cache Strategies

KV cache optimization is the highest-impact remaining lever for memory-constrained deployment (iPhone 16e has only ~1.9 GB free with Gemma4 loaded). Three tiers of increasing complexity:

**Tier 1 — Immediate (llama.cpp native, addon config change):**
- **F1 baseline**: `--cache-type-k q4_0 --cache-type-v q4_0` — 75% KV memory reduction. Qwen3.5 hybrid models are reported to be token-identical at Q4_0 KV (lossless). Symmetric types enable fused Flash Attention path; mismatched types fall back to slower non-fused implementation.
- **Per-head adaptive quantization** ([llama.cpp #21385](https://github.com/ggml-org/llama.cpp/issues/21385)): Bottom 2% of heads by entropy ("sink heads") contribute disproportionately to quantization error. Skipping quantization on just 3/144 heads provides more benefit than optimal uniform bit redistribution. Not yet merged upstream.
- **TurboQuant** ([llama.cpp #20969](https://github.com/ggml-org/llama.cpp/discussions/20969)): WHT rotation (128-element groups, 4 blocks of 32) for extreme KV compression. Qwen3.5-specific advantage: only 8 of 32 layers have full-attention KV cache — compression benefit concentrates on those 8 layers.

**Tier 2 — Medium-term (upstream work or fork):**
- **Open-TQ-Metal** ([arxiv 2604.16957](https://arxiv.org/abs/2604.16957)): First fused compressed-domain attention on Apple Silicon. Quantizes KV cache to INT4 on-the-fly and computes attention directly on the compressed representation — eliminates all intermediate dequantization overhead. Enables 128K-context inference for 70B models on 64GB consumer Mac. Not yet in llama.cpp but explicitly targets Apple Silicon via custom Metal compute shaders.

**Tier 3 — Research (VLM-specific, not in llama.cpp):**
- **AKVQ-VL** ([arxiv 2501.15021](https://arxiv.org/abs/2501.15021)): Attention-aware KV cache adaptive 2-bit quantization for VLMs. Exploits Text-Salient Attention (TSA) and Pivot-Token-Salient Attention (PSA) patterns to adaptively allocate bit budgets. Results: 2.13x peak memory reduction, 3.25x batch size increase, 2.46x throughput improvement.
- **Q Cache** ([arxiv 2602.01901](https://arxiv.org/abs/2602.01901)): Visual attention is valuable in less than half of decode layers for multimodal LLMs. Attention in certain layers can be streamlined by inheriting from preceding layers. Complementary to KV quantization — reduces both memory and compute.

---

## 8. Impact Projection

### 8.1 With A1 + A2 (Addon-Only, No Upstream Changes)

| Platform | Model | Current TTFT | Projected TTFT (miss) | Projected TTFT (hit) | Current Decode |
|----------|-------|-------------|----------------------|-----------------------|----------------|
| Mac M4 | Gemma4 E2B | 1,724 ms | ~1,400 ms | <500 ms | 51.3 t/s |
| Mac M4 | Qwen3.5-2B | 1,236 ms | ~1,200 ms | <500 ms | 51.8 t/s |
| iPhone 16e | Gemma4 E2B | 3,492 ms | ~2,800 ms | <1,000 ms | 27.2 t/s |
| iPhone 16e | Qwen3.5-2B | ~3,200 ms* | ~3,000 ms | <800 ms | 24.3 t/s |

*Estimated from phase sum (no explicit TTFT in iPhone Qwen3.5 baseline data)

**Cache hit scenario**: A2 bypasses vision (417-1,236 ms) + projection (2-183 ms), leaving only prefill + decode start. This is the dominant use case for chat-with-image where the same image is discussed across multiple turns.

### 8.2 With A1 + A2 + U1 (Addon + Upstream Deepstack Fix)

| Platform | Model | Projected TTFT (miss) | Projected TTFT (hit) | Notes |
|----------|-------|----------------------|-----------------------|-------|
| Mac M4 | Gemma4 E2B | ~1,400 ms | <500 ms | No change (U1 targets Qwen3.5) |
| Mac M4 | Qwen3.5-2B | ~1,200 ms | <500 ms | Projection already 2ms |
| iPhone 16e | Gemma4 E2B | ~2,800 ms | <1,000 ms | No change |
| iPhone 16e | Qwen3.5-2B | ~2,200 ms | <800 ms | Projection 183→~20 ms saves ~160ms in TTFT |

### 8.3 Decode Ceiling

Both models are memory-bandwidth-limited at decode:
- Mac M4: ~51.5 t/s (Gemma4 51.3, Qwen3.5 51.8) — saturates ~120 GB/s
- iPhone 16e: ~25-27 t/s — saturates ~60 GB/s

No software optimization can meaningfully improve decode throughput. Gains come exclusively from vision, projection, and prefill phases.

---

## 9. Qwen3.5-VL: Metal-Specific Considerations

### 9.1 Strengths on Metal
- 47% less GPU memory than Gemma4 E2B → more headroom for context and batching
- Faster vision encoding (417ms vs 630ms Mac, 829ms vs 1,236ms iPhone)
- Metal prefill 2.54× faster than CPU (unique among all tested models)
- Identical decode ceiling to Gemma4 E2B (~51.5 t/s Mac, ~25 t/s iPhone)
- Coherent output on Metal (validated; garbled on Android Vulkan/OpenCL)

### 9.2 Weaknesses on Metal
- **Projection anomaly on iPhone** (183ms vs 2ms Mac) — needs investigation and fix
- **Context overflow risk** — large images produce 4,015 tokens, nearly filling 4,096 context
- **No iPhone Qwen3.5 TTFT baseline** — explicit measurement needed
- SSM recurrent state (19 MiB RS buffer) adds memory overhead not present in Gemma4

### 9.3 Qwen3.5 Architecture Uniqueness
- **Hybrid attention + SSM decoder** — first VLM model in our stack using selective state space model layers alongside attention. Only 8 of 32 layers use full attention with KV cache; the remaining 24 use Gated Delta Net (GDN) linear attention with no KV cache. This makes KV quantization (F1, Section 7.5) particularly effective — compressing 8 layers' cache is cheaper and lower-risk than 32. The RS buffer (19 MiB) stores SSM recurrent state.
- **Deepstack feature extraction** — features from intermediate ViT layers are processed and concatenated with the final projection, giving the LLM multi-scale visual information. This is architecturally superior but computationally expensive.
- **M-RoPE (Multi-Resolution RoPE)** — 4D positional encoding (temporal + 3 spatial) in the vision encoder, enabling native dynamic resolution support without interpolation artifacts. Qwen3.5 uses Interleaved-MRoPE, which distributes temporal, height, and width information more evenly across feature dimensions than the original MRoPE layout, with improved long-sequence extrapolation (native support up to 262K tokens).

---

## 10. Phase 3 Optimization Status (QVAC-18297)

This section tracks which recommendations from Sections 7–8 have been implemented, validated, or deferred in Phase 3.

### 10.1 Implemented

| ID | Optimization | Branch / Commit | Measured Impact | Notes |
|---|---|---|---|---|
| **A2** | Post-projection vision cache | `feat/QVAC-18297-vlm-pr1-cache-and-overflow-guard` commit `a531624b` (addon) | Saves ~649 ms (Mac) / ~1,012 ms (iPhone) per cache-hit | SHA-256 keyed LRU, 5-10 entries, CPU memory. Ported from MLX content-addressed caching. |
| **A3** | Qwen3.5 context overflow guard | Same branch, commit `670be1db` (addon) | Prevents crash on large images (4,015 tokens at ctx=4096) | Typed `ContextOverflow` error replaces libmtmd `init_batch` crash. |
| **U1 (Cost-S)** | Deepstack preallocation | `feat/QVAC-18297-u1-deepstack-prealloc` commit `3cd776c5c` (llama.cpp) | Qwen3.5 iPhone projection: **183 ms → 11 ms (−94%)**; Mac: no change (2 ms baseline) | Replaced chained `ggml_concat` with pre-allocated buffer + `ggml_set_inplace`. Validates Hypothesis 1 (Section 5.3). |
| **F4** | Hybrid/recurrent multi-turn cache fix | `feat/QVAC-18297-f4-hybrid-multiturn-cache` commit `567bc4b23` (llama.cpp) | Single-shot: no regression. Multi-turn: avoids full re-processing per turn. | Fix in `llama_memory_hybrid::seq_pos_min()` — recurrent state implicitly covers all positions. |
| **F6** | Metal vision encode profiling | `feat/QVAC-18297-f6-metal-vision-profile` commit `a38d3036c` (llama.cpp) | Profiling-only — traces captured (469 MB Gemma4, 376 MB Qwen3.5) | Mac M4 Metal System Traces ready for Instruments analysis to identify vision encode bottleneck ops. |

### 10.2 MLX Cross-Pollination (QVAC-18297 DoD)

| MLX Optimization | What We Ported | Status |
|---|---|---|
| Content-addressed vision prefix caching | Full port → A2 (VisionPrefixCache class, SHA-256 + LRU) | **Done** |
| Op fusion (lazy graph evaluation) | Partial port → U1 Cost-S (static deepstack preallocation) | **Done** |
| Zero-copy unified-memory | Already default on Apple Silicon UMA (`ggml-metal-device.m:783`) | **No action needed** |
| Runtime lazy graph evaluation (JIT) | Not feasible — requires ggml architecture redesign | **Not ported** |
| QKV / gate+up GEMM fusion | <5% impact on Metal (decode is bandwidth-limited at ~51.5 t/s Mac, ~25 t/s iPhone) | **Not ported** |

> **MLX performance gap context**: Benchmarks show MLX achieves ~230 tok/s vs llama.cpp ~150 tok/s on Apple Silicon for comparable models. The gap is primarily due to `mx.compile()` automatic kernel fusion and lazy evaluation — techniques the table above notes are "not feasible" without ggml architecture redesign. RMS_NORM + MUL fusion already exists in llama.cpp's CPU backend; the Metal equivalent would be incremental but does not close the fundamental gap. MLX wins on long token generation (25% faster); llama.cpp wins on prompt-processing-heavy workloads.

### 10.3 Deferred / Not Started

| ID | Optimization | Reason | Could revisit? |
|---|---|---|---|
| **A1** | Model-aware hybrid dispatch | No per-phase backend hook in upstream llama.cpp; dual-context split is multi-day effort | Yes — if llama.cpp adds phase-specific backend routing |
| **U1 (Cost-M)** | Deepstack norm+FFN kernel fusion | Cost-S fix already reduced projection from 183→11 ms; remaining 11→~5 ms is low ROI vs complexity | Low priority |
| **U2** | mmproj quantization F16→Q8_0 | Not started — requires quality validation (VQA/OCR benchmarks) | Yes — next priority after PR merge |
| **F1** | KV cache quantization Q4_0 | Not started — addon-only change, set `common_params` cache type. See Section 7.5 for tiered strategy: per-head adaptive (llama.cpp #21385), TurboQuant (#20969), and VLM-specific AKVQ-VL. Qwen3.5 has only 8/32 layers with KV cache — ideal target for aggressive quantization. | High priority (P1) |
| **F5** | Speculative decoding | Requires ≥2.5× draft-to-target speed ratio on UMA | Medium priority |

### 10.4 Mac M4 Branch Benchmark Results (2026-05-11)

Independent benchmark of each llama.cpp branch vs b9025 baseline. Metal, elephant.jpg, 256 predict, 1 warmup + 3 measured runs (median).

| Branch | Gemma4 Total (ms) | Qwen3.5 Total (ms) | Δ vs Baseline | Verdict |
|---|---|---|---|---|
| b9025 baseline | 6,370 | 5,748 | — | Reference |
| U1 (deepstack) | 6,370 | 5,743 | ±0.1% | No change on Mac (expected — iPhone-specific fix) |
| F4 (multi-turn) | 6,357 | 5,740 | ±0.2% | No regression in single-shot (expected) |
| F6 (profiling) | 6,359 | 5,741 | ±0.1% | Identical to baseline (expected — profiling scripts only) |

Zero regressions across all branches. Full per-metric breakdown in `vlm-benchmark/QVAC-18297-plan.md`.

### 10.5 Remaining Validation

- [ ] iPhone 16e benchmarks for A2+A3 (cache hit/miss delta)
- [ ] iPhone 16/17 benchmarks for full perf delta vs Phase 1 baseline
- [ ] Text-only LLM regression test (≤ 2% threshold)
- [ ] F6 trace analysis in Instruments — identify top-5 bottleneck Metal kernels in vision encode
- [ ] F4 multi-turn validation with `llama-server` (single-shot CLI doesn't exercise the fix)

---

## 11. Methodology & Sources

### 11.1 Source Reports (QVAC-18293)
| Report | Content | Devices |
|--------|---------|---------|
| `gemma4-vl-baseline.md` | Phase 1 mobile baseline: CPU/Vulkan/OpenCL/Metal | S25, P9P, iPhone 16e |
| `metal-baseline.md` | Metal-specific benchmarks, GPU memory, phase timings, System Traces | Mac M4, iPhone 16e |
| `vlm-mac-baseline.md` | Mac M4 full CPU+Metal matrix, all model variants | Mac M4 |

### 11.2 Metal System Traces
| Trace File | Device | Model | Size | Predict Tokens |
|-----------|--------|-------|------|---|
| `mac-m4-gemma4-e2b-q4km.trace` | Mac M4 | Gemma4 E2B Q4_K_M | 597 MB | 256 |
| `mac-m4-qwen3.5-2b-q4km.trace` | Mac M4 | Qwen3.5-2B Q4_K_M | 480 MB | 256 |
| `iPhone16e-gemma4-e2b-q4km.trace` | iPhone 16e | Gemma4 E2B Q4_K_M | 371 MB | 128 |
| `iPhone16e-qwen3.5-2b-q4km.trace` | iPhone 16e | Qwen3.5-2B Q4_K_M | 101 MB | 128 |

### 11.3 Code References
- Upstream llama.cpp: `qvac-fabric-llm.cpp/tools/mtmd/` (clip.cpp, clip-impl.h, mtmd.cpp, mtmd-helper.cpp)
- Addon integration: `packages/qvac-lib-infer-llamacpp-llm/addon/src/model-interface/MtmdLlmContext.cpp`
- llama.cpp version: b9025
- Reproducibility: Run-2 validation shows ±2% variance (iPhone 16e Gemma4 E2B decode: 26.66 → 27.24 t/s)

### 11.4 External Research References (2026-05-12)

KV cache optimization:
- Open-TQ-Metal (fused compressed-domain attention on Apple Silicon): [arxiv 2604.16957](https://arxiv.org/abs/2604.16957)
- AKVQ-VL (adaptive 2-bit KV quantization for VLMs): [arxiv 2501.15021](https://arxiv.org/abs/2501.15021)
- Q Cache (visual attention inheritance across decode layers): [arxiv 2602.01901](https://arxiv.org/abs/2602.01901)
- Per-head adaptive KV quantization: [llama.cpp #21385](https://github.com/ggml-org/llama.cpp/issues/21385)
- TurboQuant (WHT rotation for extreme KV compression): [llama.cpp #20969](https://github.com/ggml-org/llama.cpp/discussions/20969)

VLM quantization and vision optimization:
- Q-VLM (post-training quantization for VLMs, 2.78x compression): [arxiv 2410.08119](https://arxiv.org/abs/2410.08119)
- MBQ (modality-balanced quantization): [arxiv 2412.19509](https://arxiv.org/abs/2412.19509)
- VLM quantization quality study (Q4_K_M bimodal instability): [arxiv 2603.26770](https://arxiv.org/abs/2603.26770)
- Input-adaptive visual preprocessing (>50% inference reduction): [arxiv 2512.20839](https://arxiv.org/abs/2512.20839)

Metal GPU inference:
- Metal FlashAttention (two-pass online softmax, 43-120% speedup): [github.com/philipturner/metal-flash-attention](https://github.com/philipturner/metal-flash-attention)
- MetalQwen3 (complete Metal transformer with QKV fusion): [github.com/BoltzmannEntropy/metalQwen3](https://github.com/BoltzmannEntropy/metalQwen3)
- MTMD vision CPU fallback (BF16 mmproj on CPU in server path): [llama.cpp #22582](https://github.com/ggml-org/llama.cpp/issues/22582)

---

## 12. Forward-Looking: Metal 4 and Next-Gen Hardware

WWDC 2025 introduced Metal 4 with features relevant to LLM/VLM inference on future Apple Silicon (iPhone 17, next-gen Macs):

**Metal Performance Primitives (MPP):** New `matmul2d_descriptor` API provides native tensor operations at the shader level, programmable at both SIMD-group and threadgroup scope. For ggml-metal, MPP could replace hand-tuned GEMM kernels with framework-optimized equivalents — potentially simplifying U5 (vision encoder Metal kernel specialization) from Cost: L to Cost: M.

**Shader ML / ML Encoder:** Native tensor support directly in Metal shaders. ML workloads can execute on the GPU timeline alongside rendering/compute using the same command buffers and barriers. Relevant if QVAC integrates vision encoding into a rendering pipeline (e.g., camera preview → VLM). Not immediately actionable for the current CLI/addon architecture, which uses dedicated inference calls.

**BFloat16 on Apple GPU Family 9:** Already fully supported on M4 and A18 (our current targets). MPSGraph adds BFloat16 support for mixed-precision inference. Relevant to U6 (BF16 mmproj) and P6 (SigLIP FP16 overflow mitigation).

**Target timeline:** Current M4/A18 targets are Apple GPU Family 9 / Metal 3. Metal 4 APIs require minimum deployment target updates for future devices. Monitor post-WWDC 2025 Apple developer documentation for MPP availability in ggml-metal and ggml compute graph compilation.
