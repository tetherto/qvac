# Gemma4-VL Architecture & Optimization Opportunity Analysis

**QVAC-18295 | Phase 2 — LLM-Addon 0.18.0 VLM Optimization**

Target platforms:
- Android Adreno (primary) — Samsung S25, Snapdragon 8 Elite, Adreno 830
- Android Mali (primary) — Pixel 9 Pro, Tensor G4, Mali-G715 MC7
- iOS Metal (secondary) — iPhone 16e, A18
- Mac Metal (reference ceiling) — Mac M4, 8 GPU cores, 16 GB unified memory

Phase 1 cross-device decode hierarchy (E2B Q4_K_M, best backend per device):
Mac M4 51.3 t/s → iPhone 16e 27.2 → S25 15.0 → P9P 10.6 t/s (Mac/iPhone 1.88x, Mac/S25 3.43x, Mac/P9P 4.83x)

---

## 1. Architecture Overview

Gemma4-VL follows a standard VLM projection-model architecture with three stages:

```
Image --> [Vision Encoder (SigLIP-SO400M)] --> [Projection MLP] --> [LLM Decoder (Gemma 2)]
                                                                         ^
Text  -------------------------------------------------------------------|
```

In llama.cpp, the vision encoder + projection run as a separate CLIP model (`mmproj` file, always F16), producing vision embeddings that are concatenated with text token embeddings before LLM prefill.

---

## 2. Layer-by-Layer Breakdown

### 2.1 Vision Encoder (SigLIP-SO400M/14)

| Component | Details |
|-----------|---------|
| Architecture | ViT-SO400M/14 (Vision Transformer) |
| Parameters | ~400M |
| Patch size | 14x14 |
| Input resolution | 224x224 (base), up to 4 tiles via Pan & Scan |
| Tokens per tile | (224/14)^2 = 256 |
| Max tokens (4 tiles) | 1024 |
| Hidden dim | 1152 |
| MLP dim | 4304 |
| Attention heads | 16 |
| Head dim | 1152/16 = 72 |
| Layers | 27 |
| Dtype (mmproj) | F16 |

#### Per-layer ops (single vision transformer block):

| Op | Input Shape | Output Shape | Dtype | FLOPs (per token=256, single tile) |
|----|-------------|--------------|-------|-------------------------------------|
| LayerNorm (pre-attn) | [256, 1152] | [256, 1152] | F16 | 2 * 256 * 1152 = 590K |
| Q projection | [256, 1152] x [1152, 1152] | [256, 1152] | F16 | 2 * 256 * 1152^2 = 680M |
| K projection | [256, 1152] x [1152, 1152] | [256, 1152] | F16 | 680M |
| V projection | [256, 1152] x [1152, 1152] | [256, 1152] | F16 | 680M |
| Attention (QK^T) | [16, 256, 72] x [16, 72, 256] | [16, 256, 256] | F16 | 2 * 16 * 256 * 256 * 72 = 151M |
| Attention (softmax*V) | [16, 256, 256] x [16, 256, 72] | [16, 256, 72] | F16 | 2 * 16 * 256 * 72 * 256 = 151M |
| Output projection | [256, 1152] x [1152, 1152] | [256, 1152] | F16 | 680M |
| LayerNorm (pre-MLP) | [256, 1152] | [256, 1152] | F16 | 590K |
| MLP up (fc1) | [256, 1152] x [1152, 4304] | [256, 4304] | F16 | 2 * 256 * 1152 * 4304 = 2.53G |
| GELU activation | [256, 4304] | [256, 4304] | F16 | ~1.1M (negligible) |
| MLP down (fc2) | [256, 4304] x [4304, 1152] | [256, 1152] | F16 | 2.53G |

**Per-layer total: ~8.08 GFLOPs** (single tile, 256 tokens)

**Full vision encoder (27 layers, 1 tile): ~218 GFLOPs**
**Full vision encoder (27 layers, 4 tiles): ~873 GFLOPs**

#### Additional vision ops:
| Op | Details | FLOPs |
|----|---------|-------|
| Patch embedding (Conv2d) | kernel 14x14, in=3, out=1152, stride=14 | 2 * 256 * 3 * 14 * 14 * 1152 = 346M |
| Position embedding add | [256, 1152] | 295K (negligible) |
| Final LayerNorm | [256, 1152] | 590K (negligible) |

### 2.2 Projection MLP (Soft-Token Projector)

| Component | Details |
|-----------|---------|
| Architecture | 2-layer MLP with GELU |
| Input dim | 1152 (SigLIP hidden) |
| Output dim | 2048 (E2B) / 3072 (E4B) |
| Dtype | F16 |

#### E2B Projection (1152 -> 2048):

| Op | Input Shape | Output Shape | Dtype | FLOPs (256 tokens) |
|----|-------------|--------------|-------|---------------------|
| Linear 1 | [256, 1152] x [1152, 2048] | [256, 2048] | F16 | 2 * 256 * 1152 * 2048 = 1.21G |
| GELU | [256, 2048] | [256, 2048] | F16 | ~524K |
| Linear 2 | [256, 2048] x [2048, 2048] | [256, 2048] | F16 | 2 * 256 * 2048^2 = 2.15G |

**Projection total (E2B, 1 tile): ~3.36 GFLOPs**
**Projection total (E2B, 4 tiles): ~13.4 GFLOPs**

#### E4B Projection (1152 -> 3072):

| Op | Input Shape | Output Shape | Dtype | FLOPs (256 tokens) |
|----|-------------|--------------|-------|---------------------|
| Linear 1 | [256, 1152] x [1152, 3072] | [256, 3072] | F16 | 2 * 256 * 1152 * 3072 = 1.81G |
| GELU | [256, 3072] | [256, 3072] | F16 | ~786K |
| Linear 2 | [256, 3072] x [3072, 3072] | [256, 3072] | F16 | 2 * 256 * 3072^2 = 4.83G |

**Projection total (E4B, 1 tile): ~6.64 GFLOPs**
**Projection total (E4B, 4 tiles): ~26.6 GFLOPs**

### 2.3 LLM Decoder (Gemma 2)

#### E2B (2B params):

| Parameter | Value |
|-----------|-------|
| Layers | 18 |
| Hidden dim | 2048 |
| MLP dim | 16384 |
| Attention heads | 8 |
| KV heads | 1 (GQA 8:1) |
| Head dim | 2048/8 = 256 |
| Vocab size | 256,000 |

#### Per-layer ops (prefill with N tokens):

| Op | Shapes | Dtype (Q4_K_M) | FLOPs (N tokens) |
|----|--------|----------------|-------------------|
| RMSNorm (pre-attn) | [N, 2048] | F16 (unquantized) | 2 * N * 2048 |
| Q projection | [N, 2048] x [2048, 2048] | Q4_K_M | 2 * N * 2048^2 = 8.4M*N |
| K projection | [N, 2048] x [2048, 256] | Q4_K_M | 2 * N * 2048 * 256 = 1.05M*N |
| V projection | [N, 2048] x [2048, 256] | Q4_K_M | 1.05M*N |
| RoPE | [N, 2048] | F16 | negligible |
| Attention (QK^T) | [8, N, 256] x [1, 256, N] | F16 | 2 * 8 * N * 256 * N = 4096*N^2 |
| Attention (softmax*V) | [8, N, N] x [1, N, 256] | F16 | 4096*N^2 |
| Output projection | [N, 2048] x [2048, 2048] | Q4_K_M | 8.4M*N |
| RMSNorm (pre-MLP) | [N, 2048] | F16 | 2 * N * 2048 |
| MLP gate | [N, 2048] x [2048, 16384] | Q4_K_M | 2 * N * 2048 * 16384 = 67.1M*N |
| MLP up | [N, 2048] x [2048, 16384] | Q4_K_M | 67.1M*N |
| SiLU + elementwise mul | [N, 16384] | F16 | negligible |
| MLP down | [N, 16384] x [16384, 2048] | Q4_K_M | 67.1M*N |

**Per-layer total: ~220M*N + 8192*N^2 FLOPs**

For vision prefill (N=256 tokens, 1 tile):
- Linear ops: 220M * 256 = 56.3G per layer
- Attention: 8192 * 256^2 = 537M per layer
- Per-layer: ~56.9G
- **18 layers total: ~1,024 GFLOPs**

For decode (N=1, context=256):
- Linear ops: 220M per layer
- Attention: 8192 * 256 = 2.1M per layer (KV cache lookup)
- Per-layer: ~222M
- **18 layers total: ~4.0 GFLOPs per token**

#### E4B (4B params):

| Parameter | Value |
|-----------|-------|
| Layers | 34 |
| Hidden dim | 3072 |
| MLP dim | 24576 |
| Attention heads | 16 |
| KV heads | 8 (GQA 2:1) |
| Head dim | 3072/16 = 192 |

**Per-layer linear FLOPs (N tokens):**
- Q: 2 * N * 3072^2 = 18.9M*N
- K: 2 * N * 3072 * 1536 = 9.4M*N
- V: 9.4M*N
- O: 18.9M*N
- Gate: 2 * N * 3072 * 24576 = 151M*N
- Up: 151M*N
- Down: 151M*N

**Per-layer total: ~510M*N + attention**

For vision prefill (N=256, 1 tile):
- 510M * 256 = 130.6G per layer
- **34 layers total: ~4,440 GFLOPs**

For decode (N=1):
- ~510M per layer
- **34 layers total: ~17.3 GFLOPs per token**

### 2.4 FLOP Summary

| Component | E2B (1 tile) | E2B (4 tiles) | E4B (1 tile) | E4B (4 tiles) |
|-----------|-------------|---------------|-------------|---------------|
| Vision encoder | 218G | 873G | 218G | 873G |
| Projection MLP | 3.4G | 13.4G | 6.6G | 26.6G |
| LLM prefill (vision tokens) | 1,024G | 4,096G | 4,440G | 17,760G |
| **Total first-image latency** | **1,245G** | **4,982G** | **4,665G** | **18,660G** |
| LLM decode (per token) | 4.0G | 4.0G | 17.3G | 17.3G |

---

## 3. Quantization Opportunity Table

The vision encoder (mmproj) is currently **always F16** in llama.cpp. This is the key insight: while the LLM is already quantized, the vision encoder and projection remain at full precision.

| Layer / Component | Current Dtype | Candidate Dtype | Expected Speed-up | Expected Quality Risk | Notes |
|-------------------|---------------|-----------------|-------------------|-----------------------|-------|
| Vision encoder attention (QKV+O) | F16 | Q8_0 | 1.5-2x memory BW, ~1.3x speed | Low — attention weights are robust to quantization | SigLIP attention layers have high redundancy; INT8 PTQ well-studied on ViT |
| Vision encoder MLP (fc1, fc2) | F16 | Q8_0 | 1.5-2x memory BW, ~1.3x speed | Low-Medium — MLPs more sensitive than attention | Calibrate on representative image set; watch for saturation in GELU region |
| Vision encoder MLP (fc1, fc2) | F16 | Q4_K_M | 3-4x memory BW, ~1.8x speed | Medium-High — aggressive for vision | May degrade fine-grained feature extraction; test on OCR/text-in-image tasks |
| Projection MLP (Linear 1) | F16 | Q8_0 | 1.5x memory BW | Low — first linear is a simple mapping | Cross-modal alignment layer; conservative quantization preferred |
| Projection MLP (Linear 2) | F16 | Q8_0 | 1.5x memory BW | Medium — final projection affects all downstream tokens | Critical for vision-language alignment; validate with VQA accuracy |
| LLM attention KV cache | F16 | Q8_0 / Q4_0 | Reduces KV memory 2-4x | Low (Q8_0), Medium (Q4_0) | Enables longer contexts or larger models within memory budget |
| LLM (already quantized) | Q4_K_M | IQ3_XXS | 1.3x memory BW | High — below 4-bit degrades coherence | Only viable if Q4_K_M OOMs (iPhone 16e E4B case) |
| Vision patch embedding (Conv2d) | F16 | Q8_0 | Negligible (tiny layer) | None | Not worth the complexity; single conv, tiny FLOP contribution |
| Vision LayerNorms | F16 | F16 (keep) | N/A | N/A | Normalization layers must stay high precision |
| LLM RMSNorms | F16 (keep) | F16 (keep) | N/A | N/A | Already high precision; do not quantize |

**Key quantization insight:** Quantizing the mmproj from F16 to Q8_0 would reduce it from ~940MB to ~470MB and reduce memory-bandwidth pressure during vision encoding — directly addressing the Pixel 9 Pro 25-41s vision encoding bottleneck.

---

## 4. Layer Fusion Opportunity Table

| Op Pair / Triplet | Frequency | Expected Speed-up | Impl Cost | Notes |
|-------------------|-----------|-------------------|-----------|-------|
| RMSNorm + Q/K/V projection | 18 (E2B) / 34 (E4B) per LLM layer | 1.1-1.2x (kernel launch reduction) | M | Eliminates one global memory round-trip; well-studied fusion in TensorRT/vLLM |
| QKV projection fusion (single GEMM) | 18/34 per LLM layer | 1.2-1.4x on Adreno/Mali | M | Concatenate Q/K/V weight matrices; single larger GEMM better utilizes GPU ALUs |
| SiLU + elementwise mul (gate*up) | 18/34 per LLM layer | 1.05-1.1x | S | Trivial pointwise fusion; small but free wins |
| MLP gate+up projection fusion | 18/34 per LLM layer | 1.2-1.3x on GPU | M | Single GEMM for [gate, up] concatenated weights; doubles GEMM size for better utilization |
| LayerNorm + MLP fc1 (vision) | 27 per vision layer | 1.1-1.15x | M | Same pattern as LLM RMSNorm fusion |
| Attention softmax + V matmul | 27 (vision) + 18/34 (LLM) | 1.05-1.1x | L | Flash attention pattern; complex on mobile GPUs due to shared memory limits |
| Patch embed Conv2d + LayerNorm + position add | 1x (vision entry) | 1.05x | S | Single fused kernel for vision input; minimal gain but trivial |
| Projection Linear1 + GELU + Linear2 | 1x per image | 1.15-1.2x | M | Fuse entire 2-layer projection MLP into single kernel (small tensor, high launch overhead) |
| Multi-tile vision batching | 1x per multi-tile image | 1.5-2x on GPU | M | Batch all 4 tiles through vision encoder simultaneously instead of sequentially |

**Key fusion insight:** On Mali-G715 where vision encoding takes 25-41s, multi-tile batching + QKV fusion within vision layers could reduce this by 30-50%. The sequential per-tile processing is extremely inefficient on GPUs that have idle compute units.

---

## 5. Kernel Rewrite Candidates Table

| Op | Current Backend Impl | Bottleneck Reason (Phase 1 Evidence) | Proposed Change | Expected Speed-up | Impl Cost |
|----|---------------------|--------------------------------------|-----------------|-------------------|-----------|
| Vision encoder GEMM (Mali Vulkan) | Generic Vulkan matmul, no cooperative matrix | Mali-G715 vision encode 25-41s across ALL backends; no coopmat support (GGML_VK_DISABLE_COOPMAT=1 required) | Write Mali-optimized tiled matmul using subgroup operations + shared memory; 8x8 or 16x16 output tiles | 2-4x vision encode speed | L |
| Vision encoder GEMM (Adreno OpenCL) | Generic OpenCL matmul | Adreno OpenCL gives only 1.1-1.3x over CPU for decode; vision not offloaded effectively | Adreno-specific OpenCL kernel with optimized local memory tiling, vectorized loads (float4), and warp-level reduction | 1.5-2x vision + decode | L |
| F16 dequant + GEMM (Vulkan) | Separate dequant pass then GEMM | Vision encoder is F16 — full dequant pass unnecessary, but current pipeline treats F16 same as quant types | Bypass dequant for F16 inputs; direct F16 GEMM path | 1.2-1.4x vision encode | M |
| Softmax kernel (Mali Vulkan) | Generic 2-pass softmax (max-reduce + normalize) | Part of attention overhead in 27 vision layers; Mali register pressure causes spillage | Single-pass online softmax with subgroup reductions; reduces global memory traffic by 50% | 1.1-1.2x attention | M |
| Multi-head attention (vision, Mali) | Loop over heads with separate dispatches | 27 layers x 16 heads = 432 kernel dispatches per tile per attention op; Mali dispatch overhead ~50us each | Batched multi-head attention kernel: single dispatch processes all 16 heads | 1.3-1.5x attention throughput | M |
| Conv2d patch embedding | Generic im2col + GEMM | Not a bottleneck currently but adds dispatch overhead on GPU path | Direct conv kernel optimized for 14x14 stride=14 (non-overlapping) — essentially a reshape + matmul | 1.1x | S |
| KV cache memory layout (Adreno) | Row-major contiguous | Phase 1 shows Adreno OpenCL minimal speedup over CPU (1.1-1.3x) — memory access pattern suboptimal | Tile-major KV cache layout optimized for GPU texture cache on Adreno | 1.2-1.5x decode | M |

### Metal Phase 1 Evidence (Mac M4 + iPhone 16e)

Metal System Traces (4 trace files, ~1.55 GB total) provide per-phase timing that validates the kernel-level bottleneck analysis:

| Phase | Mac M4 Metal | iPhone 16e Metal | Mac speedup |
|-------|-------------|-----------------|-------------|
| Vision encode (CLIP) | 611 ms | 1,272 ms | 2.08x |
| Image projection | 19 ms | 36 ms | 1.89x |
| Prefill (284 tok) | 1,094 ms (260 t/s) | 2,330 ms (122 t/s) | 2.13x |
| Decode (255/127 tok) | 4,973 ms (51.3 t/s) | 5,478 ms (23.2 t/s) | 2.21x |

Metal GPU memory footprint (Gemma 4 E2B Q4_K_M, Mac M4):
- Model buffer (GPU): 2,948 MiB | Compute buffer (LLM): 519 MiB
- CLIP compute buffer: 101 MiB | KV cache: 36 MiB
- **Total GPU resident: ~3,758 MiB** (30% of 12,713 MiB recommended limit)
- Graph nodes: 1,500 (LLM) + 940 (CLIP); graph splits: 2

**Key kernel insight:** The Mali-G715 vision encoding bottleneck (25-41s) is almost certainly due to the generic Vulkan GEMM kernel performing poorly without cooperative matrix support. A Mali-specific tiled GEMM using subgroup operations could yield 2-4x improvement, bringing vision encode from 25-41s down to 8-15s. Metal profiling confirms vision encode is 2.8–5.7x faster on Metal than CPU (Mac M4), demonstrating that GPU-accelerated vision encoding is viable — the Mali bottleneck is backend-specific, not inherent to GPU vision processing.

---

## 6. MLX Cross-Reference

### MLX Optimizations (from Asana 1214117968658871: "Qwen3.5-VL on Apple Silicon")

| MLX Optimization | Description | Portable to Vulkan/OpenCL (Adreno + Mali)? | Notes |
|------------------|-------------|---------------------------------------------|-------|
| Op fusion + lazy graph evaluation | MLX defers execution and fuses adjacent ops into single Metal kernels, amortizing kernel-launch overhead | **Partially portable** | Vulkan compute pipelines are pre-compiled; can't do runtime lazy fusion. However, static fusion patterns (norm+matmul, gate+up) are implementable. The dispatch overhead savings are even MORE critical on Mali (50us per dispatch vs Metal's ~5us). Static fusion opportunities identified in Section 4 above. |
| Zero-copy unified-memory paths | MLX exploits Apple Silicon UMA — GPU and CPU share physical memory with no copies | **Not portable to Adreno/Mali** | Android GPUs (Adreno, Mali) have separate GPU memory pools. Even with "shared" memory on mobile SoCs, explicit cache flush/invalidate is required. Cannot eliminate host-device transfers. However, can minimize copies via persistent mapped buffers (Vulkan VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT). |
| Content-addressed vision prefix caching | Caches vision encoder output keyed by image hash; subsequent queries about same image skip entire vision encode | **Fully portable** | This is a pure software optimization independent of GPU backend. Particularly valuable given Phase 1 data: Pixel 9 Pro vision encode is 25-41s. Caching eliminates this entirely for follow-up turns. Implementation: hash input image pixels, store vision embeddings in LRU cache. |

### Portability Assessment

**High-value portable optimizations:**

1. **Vision prefix caching** — Directly applicable. Saves 25–41s on Pixel 9 Pro, 2.2–2.9s on S25, 1.2s on iPhone 16e, and 630ms on Mac M4 per follow-up query about the same image. No GPU-specific code needed. This is the single highest-impact optimization from MLX's playbook.

2. **Static op fusion patterns** — The specific fusions MLX applies (norm+linear, gate+up projection) can be implemented as pre-compiled Vulkan/OpenCL compute pipelines. Unlike MLX's dynamic fusion, these must be identified statically and written as custom kernels. The patterns from Section 4 (RMSNorm+QKV, gate+up GEMM, projection MLP fusion) are all statically deterministic.

3. **Lazy evaluation concept (batched dispatch)** — While true lazy evaluation isn't possible with Vulkan's pre-compiled pipeline model, the concept of batching related operations into fewer dispatches IS portable. Multi-tile batching, batched multi-head attention, and QKV fusion all reduce dispatch count.

**Non-portable optimizations:**

1. **Zero-copy UMA** — Fundamental hardware difference. Android SoCs technically have unified memory, but GPU caches are not coherent with CPU caches without explicit synchronization. The overhead of cache maintenance limits the benefit.

2. **Runtime graph optimization** — MLX's JIT-like graph optimization has no direct equivalent in Vulkan/OpenCL static pipeline model. Must be done at compile time through manual kernel design.

### Phase 1 Validation: CPU Prefill > GPU on Apple Silicon (Gemma 4)

The MLX cross-reference predicted that Apple's Accelerate BLAS would compete with GPU for batch operations. Phase 1 confirms this on both Apple Silicon platforms:

| Device | CPU Prefill (t/s) | Metal Prefill (t/s) | CPU advantage |
|--------|------------------|---------------------|---------------|
| Mac M4 (E2B Q4_K_M) | 424 | 260 | **1.63x** |
| Mac M4 (E4B Q4_K_M) | 353 | 136 | **2.60x** |
| iPhone 16e (E2B Q4_K_M) | 161 | 126 | **1.28x** |

The CPU advantage increases with model size (E4B: 2.6x vs E2B: 1.6x on Mac), confirming GPU dispatch overhead is proportionally worse for larger batch operations. Samsung S25 shows the same pattern: CPU prefill (91 t/s) beats OpenCL prefill (56–73 t/s) by 1.25–1.6x. A hybrid dispatch strategy (CPU for prefill, GPU for decode) should be the default on all platforms except Mali-G715 where CPU is too slow for both phases.

---

## 7. Top-5 Ranked Recommendations for Phase 3

Ranked by **expected speed-up / implementation cost**, prioritizing the primary platforms (Adreno + Mali).

### Rank 1: Vision Prefix Caching

| Metric | Value |
|--------|-------|
| Expected speed-up | 25–41s saved on P9P, 2.2–2.9s on S25, 1.2s on iPhone 16e, 630ms on Mac M4 (eliminates vision encode on cache hit) |
| Implementation cost | **S** (software-only, ~1-2 days) |
| Score (speed-up/cost) | Extremely high — eliminates the #1 bottleneck entirely for multi-turn conversations |
| Platforms benefited | All, but transformative on Mali |
| Approach | Hash image pixels (SHA-256 of raw pixel buffer), LRU cache of vision embeddings (keyed by hash). Cache size: 5-10 images (~5-10MB for E2B embeddings). Integrate into llama.cpp's `llava_image_embed_make_with_bytes()` path. |

### Rank 2: Mali-Optimized Vision GEMM Kernel

| Metric | Value |
|--------|-------|
| Expected speed-up | 2-4x vision encode on Mali (25-41s -> 8-15s) |
| Implementation cost | **L** (specialized Vulkan compute shader, ~2-3 weeks) |
| Score (speed-up/cost) | High — addresses the largest single bottleneck |
| Platforms benefited | Mali-G715 (Pixel 9 Pro) and future Mali devices |
| Approach | Custom Vulkan compute shader using subgroup operations (subgroupAdd, subgroupShuffle) for cooperative reduction. Tile-based output (8x8 or 16x16) with shared memory staging. Must handle F16 inputs natively (no unnecessary dequant). Fall back to generic kernel on unsupported devices. |

### Rank 3: Vision Encoder Multi-Tile Batching

| Metric | Value |
|--------|-------|
| Expected speed-up | 1.5-2x on multi-tile images (GPU utilization boost) |
| Implementation cost | **M** (~1 week) |
| Score (speed-up/cost) | High — moderate effort, compounds with Rank 2 |
| Platforms benefited | All GPU backends (Vulkan, OpenCL, Metal) |
| Approach | Currently Pan & Scan tiles are processed sequentially through the vision encoder. Batch all tiles into a single forward pass (batch dim on the GEMM), processing 4x256=1024 tokens simultaneously. This better saturates GPU compute units, especially on Mali where dispatch overhead is high. Mac M4 Metal single-tile vision encode (630ms) is already efficient — batching gain will be largest on Mali where per-tile dispatch overhead dominates (25–41s). Requires modifying `clip_image_batch_encode()` in llama.cpp. |

### Rank 4: mmproj Quantization (F16 -> Q8_0)

| Metric | Value |
|--------|-------|
| Expected speed-up | 1.3-1.5x vision encode speed, 50% memory reduction (940MB -> 470MB) |
| Implementation cost | **M** (~1 week: quantization tooling + validation) |
| Score (speed-up/cost) | Moderate-High — enables E4B on iPhone 16e, speeds vision on all platforms |
| Platforms benefited | All, especially memory-constrained (iPhone 16e). Mac M4 Metal profiling shows F16 mmproj occupies 101 MiB CLIP compute + 154 MiB mmproj buffer; Q8_0 would halve this to ~128 MiB total |
| Approach | Add Q8_0 quantization support to mmproj GGUF conversion. Validate on VQA/OCR benchmarks (must maintain >98% of F16 accuracy). The 50% memory reduction also frees headroom for larger LLM quants or longer contexts. Provide both F16 and Q8_0 mmproj variants. |

### Rank 5: Static Op Fusion (QKV + Gate/Up GEMM Fusion)

| Metric | Value |
|--------|-------|
| Expected speed-up | 1.2-1.4x decode speed, 1.1-1.2x vision encode |
| Implementation cost | **M** (~1-2 weeks) |
| Score (speed-up/cost) | Moderate — steady improvement across all phases |
| Platforms benefited | All GPU backends |
| Approach | Fuse Q/K/V weight matrices into single concatenated GEMM (output split post-multiply). Same for gate+up MLP projections. Reduces kernel dispatch count by ~40% in LLM and ~30% in vision encoder. Must handle split output correctly for GQA (different head counts for Q vs K/V). For Adreno: also investigate single fused OpenCL kernel for RMSNorm+GEMM to reduce the CPU-GPU synchronization that limits OpenCL speedup to 1.1-1.3x. |

---

## 8. Impact Projection (Combined)

If all 5 recommendations are implemented, projected performance on primary targets:

| Platform | Current TTFT | Projected TTFT | Current Decode | Projected Decode |
|----------|-------------|----------------|----------------|------------------|
| Mac M4 (E2B Q4_K_M, Metal) | 1.7s | ~1.5s (cache miss) / <0.5s (cache hit) | 51.3 t/s | 53-55 t/s |
| iPhone 16e (E2B Q4_K_M, Metal) | ~3.5s | ~2.5s (cache miss) / <1s (cache hit) | 27.2 t/s | 29-31 t/s |
| Samsung S25 (E2B Q4_K_M, OpenCL) | 4.8s | ~3-4s (cache miss) / <1s (cache hit) | 15.0 t/s | 17-20 t/s |
| Pixel 9 Pro (E2B Q4_K_M, Vulkan) | 59.7s | ~8-12s (cache miss) / <1s (cache hit) | 10.6 t/s | 12-14 t/s |

The largest gains come from vision prefix caching (multi-turn) and the Mali-optimized kernel (single-turn on Pixel 9 Pro). Together these transform the Pixel 9 Pro from unusable (60s TTFT) to responsive (<12s first query, <1s follow-up). Mac M4 establishes the memory-bandwidth-saturated ceiling: even with all optimizations, mobile devices will not exceed ~55 t/s decode. The primary optimization opportunity on Mac is vision prefix caching (saving 630ms) and mmproj quantization (freeing memory for larger models/contexts).

---

## Appendix A: Methodology Notes

- FLOP counts use the standard formula: 2*M*N*K for matrix multiplication (multiply-accumulate counted as 2 ops)
- "Expected speed-up" estimates are based on: memory bandwidth reduction (quantization), kernel dispatch reduction (fusion), and compute utilization improvement (custom kernels)
- Phase 1 evidence referenced throughout from three QVAC-18293 baseline profiling reports (llama.cpp b9025):
  1. `gemma4-vl-baseline.md` — Mobile benchmarks: Samsung S25 (Adreno 830), Pixel 9 Pro (Mali-G715), iPhone 16e (A18). CPU, Vulkan, OpenCL, Metal backends. Run-1 + Run-2 validation.
  2. `metal-baseline.md` — Apple Metal GPU benchmarks: Mac M4 + iPhone 16e cross-device Metal comparison, Metal System Traces (4 trace files, ~1.55 GB), GPU memory allocation breakdown, per-phase timing.
  3. `vlm-mac-baseline.md` — Mac M4 full CPU+Metal benchmark matrix: all Gemma 4 variants (E2B/E4B, Q4_K_M/Q8_0) plus Qwen3.5-2B comparison.
- Metal System Trace files available for GPU shader and memory analysis:
  - `mac-m4-gemma4-e2b-q4km.trace` (597 MB), `mac-m4-qwen3.5-2b-q4km.trace` (480 MB)
  - `iPhone16e-gemma4-e2b-q4km.trace` (371 MB), `iPhone16e-qwen3.5-2b-q4km.trace` (101 MB)
- iPhone 16e Run-2 (2026-05-07) validates Run-1 within ±2% for vision encode and Metal decode, confirming benchmark reproducibility
- Architecture details derived from: SigLIP paper (Zhai et al. 2023), Gemma 2 technical report (Google 2024), llama.cpp source (ggml-model-gemma.cpp, clip.cpp), and GGUF model inspection

## Appendix B: Out of Scope

- **Imagination IMG DXT (Pixel 10)** — deferred per task spec; architecture not yet publicly documented
- **Training/fine-tuning optimizations** — inference-only focus
- **Server/cloud deployment** — mobile-first scope
- **Speculative decoding** — orthogonal optimization, tracked separately
