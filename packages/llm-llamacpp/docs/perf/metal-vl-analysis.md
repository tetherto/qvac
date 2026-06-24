# Metal VLM Architecture & Optimization Analysis

**Phase 2 — LLM-Addon 0.18.0 VLM Optimization (Metal Focus)**

Companion to `gemma4-vl-analysis.md` (cross-platform). This document focuses exclusively on Metal backend optimization for Apple Silicon — Mac M4 as the reference ceiling, iPhone 16e as the deployment target. Covers both Gemma4-VL and Qwen3.5-VL.

Feeds into Phase 3 implementation: iOS Metal task (top-2 VLM optimizations + MLX cross-pollination).

---

## 1. Target Platforms & Constraints

| Property | Mac M4 (reference ceiling) | iPhone 16 Pro | iPhone 16e (deployment target) |
|----------|---------------------------|---------------|-------------------------------|
| SoC | Apple M4 | Apple A18 Pro | Apple A18 |
| GPU cores | 8 | 6 | 5 |
| RAM | 16 GB unified | 8 GB (~5.3 GB Metal working set) | 8 GB (~5.7 GB usable) |
| GPU memory limit | 12.7 GB | ~5.3 GB | ~5.7 GB |
| Metal feature set | Apple GPU Family 9 | Apple GPU Family 9 | Apple GPU Family 9 |
| Memory bandwidth | ~120 GB/s | ~60 GB/s (est.) | ~50 GB/s (est.) |
| Status | **Tested** (local, 2026-05-13) | **Tested** (Firebase, 2026-05-18) | **Tested** (local, 2026-05-18) |

**Model feasibility on iPhone (16e and 16 Pro, in-process XCTest):**

| Model | Total Size | Fits iPhone? |
|-------|-----------|-------------|
| Qwen3.5-2B Q4_K_M | ~1.8 GB | Yes |
| Qwen3.5-2B Q8_0 | ~2.5 GB | Yes |
| Qwen3.5-4B Q4_K_M | ~3.2 GB | Yes |
| Gemma4 E2B Q4_K_M | ~3.8 GB | Yes (largest viable) |
| Qwen3.5-4B Q8_0 | ~4.8 GB | No (Jetsam) |
| Gemma4 E4B Q4_K_M | ~5.5 GB | No (Jetsam) |
| Gemma4 E2B Q8_0 | ~5.6 GB | No (Jetsam) |
| Gemma4 E4B Q8_0 | ~8.5 GB | No (Jetsam) |

In-process Jetsam threshold is ~3.8 GB model+mmproj (XCTest host consumes ~1-2 GB overhead).
E4B and Q8_0 Gemma variants are Mac-only.

---

## 2. Architecture — Layer-by-Layer Breakdown

### 2.1 Pipeline Overview

Both models follow the standard VLM projection architecture but differ significantly in their projection and decoder designs.

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

### 2.3 Gemma4-VL Detailed Architecture

#### Vision Encoder (SigLIP-SO400M/14)

| Component | Details |
|-----------|---------|
| Architecture | ViT-SO400M/14 (Vision Transformer) |
| Parameters | ~400M |
| Patch size | 14x14 |
| Input resolution | 224x224 (base), up to 4 tiles via Pan & Scan |
| Tokens per tile | (224/14)² = 256 |
| Max tokens (4 tiles) | 1024 |
| Hidden dim | 1152 |
| MLP dim | 4304 |
| Attention heads | 16 |
| Head dim | 1152/16 = 72 |
| Layers | 27 |
| Dtype (mmproj) | F16 |

Per-layer ops (single vision transformer block, 256 tokens/tile):

| Op | Input Shape | Output Shape | Dtype | FLOPs |
|----|-------------|--------------|-------|-------|
| LayerNorm (pre-attn) | [256, 1152] | [256, 1152] | F16 | 590K |
| Q projection | [256, 1152] × [1152, 1152] | [256, 1152] | F16 | 680M |
| K projection | [256, 1152] × [1152, 1152] | [256, 1152] | F16 | 680M |
| V projection | [256, 1152] × [1152, 1152] | [256, 1152] | F16 | 680M |
| Attention (QKᵀ) | [16, 256, 72] × [16, 72, 256] | [16, 256, 256] | F16 | 151M |
| Attention (softmax·V) | [16, 256, 256] × [16, 256, 72] | [16, 256, 72] | F16 | 151M |
| Output projection | [256, 1152] × [1152, 1152] | [256, 1152] | F16 | 680M |
| LayerNorm (pre-MLP) | [256, 1152] | [256, 1152] | F16 | 590K |
| MLP up (fc1) | [256, 1152] × [1152, 4304] | [256, 4304] | F16 | 2.53G |
| GELU activation | [256, 4304] | [256, 4304] | F16 | ~1.1M |
| MLP down (fc2) | [256, 4304] × [4304, 1152] | [256, 1152] | F16 | 2.53G |

**Per-layer total: ~8.08 GFLOPs** (single tile)

Additional vision ops:

| Op | Details | FLOPs |
|----|---------|-------|
| Patch embedding (Conv2d) | kernel 14×14, in=3, out=1152, stride=14 | 346M |
| Position embedding add | [256, 1152] | negligible |
| Final LayerNorm | [256, 1152] | negligible |

**Full vision encoder (27 layers, 1 tile): ~218 GFLOPs**
**Full vision encoder (27 layers, 4 tiles): ~873 GFLOPs**

#### Projection MLP (Soft-Token Projector)

**E2B Projection (1152 → 2048):**

| Op | Input Shape | Output Shape | Dtype | FLOPs (256 tokens) |
|----|-------------|--------------|-------|---------------------|
| Linear 1 | [256, 1152] × [1152, 2048] | [256, 2048] | F16 | 1.21G |
| GELU | [256, 2048] | [256, 2048] | F16 | ~524K |
| Linear 2 | [256, 2048] × [2048, 2048] | [256, 2048] | F16 | 2.15G |

**Projection total (E2B, 1 tile): ~3.36 GFLOPs | E2B 4 tiles: ~13.4 GFLOPs**

**E4B Projection (1152 → 3072):**

| Op | Input Shape | Output Shape | Dtype | FLOPs (256 tokens) |
|----|-------------|--------------|-------|---------------------|
| Linear 1 | [256, 1152] × [1152, 3072] | [256, 3072] | F16 | 1.81G |
| GELU | [256, 3072] | [256, 3072] | F16 | ~786K |
| Linear 2 | [256, 3072] × [3072, 3072] | [256, 3072] | F16 | 4.83G |

**Projection total (E4B, 1 tile): ~6.64 GFLOPs | E4B 4 tiles: ~26.6 GFLOPs**

#### LLM Decoder (Gemma 2)

**E2B (2B params):**

| Parameter | Value |
|-----------|-------|
| Layers | 18 |
| Hidden dim | 2048 |
| MLP dim | 16384 |
| Attention heads | 8 |
| KV heads | 1 (GQA 8:1) |
| Head dim | 256 |
| Vocab size | 256,000 |

Per-layer ops (prefill with N tokens):

| Op | Shapes | Dtype (Q4_K_M) | FLOPs (N tokens) |
|----|--------|----------------|-------------------|
| RMSNorm (pre-attn) | [N, 2048] | F16 | 2 × N × 2048 |
| Q projection | [N, 2048] × [2048, 2048] | Q4_K_M | 8.4M×N |
| K projection | [N, 2048] × [2048, 256] | Q4_K_M | 1.05M×N |
| V projection | [N, 2048] × [2048, 256] | Q4_K_M | 1.05M×N |
| RoPE | [N, 2048] | F16 | negligible |
| Attention (QKᵀ) | [8, N, 256] × [1, 256, N] | F16 | 4096×N² |
| Attention (softmax·V) | [8, N, N] × [1, N, 256] | F16 | 4096×N² |
| Output projection | [N, 2048] × [2048, 2048] | Q4_K_M | 8.4M×N |
| RMSNorm (pre-MLP) | [N, 2048] | F16 | 2 × N × 2048 |
| MLP gate | [N, 2048] × [2048, 16384] | Q4_K_M | 67.1M×N |
| MLP up | [N, 2048] × [2048, 16384] | Q4_K_M | 67.1M×N |
| SiLU + elementwise mul | [N, 16384] | F16 | negligible |
| MLP down | [N, 16384] × [16384, 2048] | Q4_K_M | 67.1M×N |

**Per-layer total: ~220M×N + 8192×N² FLOPs**

For vision prefill (N=256, 1 tile): ~56.9G/layer → **18 layers: ~1,024 GFLOPs**
For decode (N=1): ~222M/layer → **18 layers: ~4.0 GFLOPs per token**

**E4B (4B params):** 34 layers, 3072 hidden, 24576 FFN, 16 heads, 8 KV heads (GQA 2:1), head dim 192.
Per-layer: ~510M×N. Vision prefill (N=256): ~130.6G/layer → **34 layers: ~4,440 GFLOPs**. Decode: ~17.3 GFLOPs/token.

#### FLOP Summary

| Component | E2B (1 tile) | E2B (4 tiles) | E4B (1 tile) | E4B (4 tiles) |
|-----------|-------------|---------------|-------------|---------------|
| Vision encoder | 218G | 873G | 218G | 873G |
| Projection MLP | 3.4G | 13.4G | 6.6G | 26.6G |
| LLM prefill (vision tokens) | 1,024G | 4,096G | 4,440G | 17,760G |
| **Total first-image latency** | **1,245G** | **4,982G** | **4,665G** | **18,660G** |
| LLM decode (per token) | 4.0G | 4.0G | 17.3G | 17.3G |

### 2.4 Qwen3.5-VL Detailed Architecture

#### Text Model Configuration

| Property | Value |
|---|---:|
| Architecture | `qwen35` |
| Parameters | 1.88B |
| Quantization | Q4_K - Medium, 5.40 BPW |
| Tensor mix | 133 f32, 36 q8_0, 98 q4_K, 36 q5_K, 17 q6_K |
| Layers | 24 |
| Hidden size | 2048 |
| FFN size | 6144 |
| Heads | 8 |
| KV heads | 2 |
| Head dim | 256 |
| Context train length | 262,144 |
| Full attention interval | 4 |
| SSM conv kernel | 4 |
| SSM state size | 128 |
| SSM group count | 16 |
| SSM time-step rank | 16 |
| SSM inner size | 2048 |

With `full_attention_interval=4`, the 24 text layers split into ~6 full-attention layers and ~18 recurrent SSM (Gated Delta Net) layers. Only the 6 attention layers maintain a KV cache.

#### Vision / Projector Configuration

| Property | Value |
|---|---:|
| Projector type | `qwen3vl_merger` |
| Vision hidden size | 1024 |
| Vision heads | 16 |
| Vision layers | 24 |
| Vision FFN size | 4096 |
| Projection dim | 2048 |
| Patch size | 16 |
| Merge factor | 2×2 |
| Test image patch grid (640×480) | 40 × 30 = 1200 patches |
| Merged image tokens | 300 |
| mmproj file | `mmproj-F16.gguf`, 637 MiB |

#### Vision Encoder Per-Layer Breakdown

FLOP estimates: 1 multiply-add = 2 FLOPs. Dense upper-bound for 640×480 test image (1200 vision patches, 300 merged tokens).

| Stage | Freq | Input shape | Output shape | Dtype | Op types | Est. FLOPs |
|---|---:|---|---|---|---|---:|
| Patch embedding 0 | 1 | im2col 768×1200 | 1024×1200 | f16→f32 | IM2COL, MUL_MAT | 1.89B |
| Patch embedding 1 | 1 | im2col 768×1200 | 1024×1200 | f16→f32 | IM2COL, MUL_MAT | 1.89B |
| Patch sum + fold | 1 | two 40×30×1024 maps | 1024×1200 | f32 | ADD, PERMUTE | memory-bound |
| Position embed resize/add | 1 | pos table 1024×48×48 | 1024×1200 | f32 | UPSCALE, ADD | memory-bound |
| Vision layer norm 1 | 24 | 1024×1200 | 1024×1200 | f32 | NORM, MUL, ADD | ~0.05B total |
| Vision QKV projection | 24 | 1024×1200 | 3072×1200 | f32 | MUL_MAT, ADD | 7.55B/layer |
| Vision M-RoPE | 24 | Q/K: 64×16×1200 | same | f32 | ROPE | memory+trig |
| Vision attention | 24 | Q/K/V: 64×16×1200 | 1024×1200 | f32/f16 | FLASH_ATTN_EXT | ~5.90B/layer |
| Vision attention output | 24 | 1024×1200 | 1024×1200 | f32 | MUL_MAT, ADD | 2.52B/layer |
| Vision layer norm 2 | 24 | 1024×1200 | 1024×1200 | f32 | NORM, MUL, ADD | ~0.05B total |
| Vision FFN up | 24 | 1024×1200 | 4096×1200 | f32 | MUL_MAT, ADD | 10.07B/layer |
| Vision GELU | 24 | 4096×1200 | 4096×1200 | f32 | GELU | ~0.12B total |
| Vision FFN down | 24 | 4096×1200 | 1024×1200 | f32 | MUL_MAT, ADD | 10.07B/layer |
| Vision residuals | 48 | 1024×1200 | 1024×1200 | f32 | ADD | memory-bound |
| Post-layer norm | 1 | 1024×1200 | 1024×1200 | f32 | NORM | ~0.01B |
| 2×2 merge reshape | 1 | 1024×1200 | 4096×300 | f32 | RESHAPE | metadata |
| Merger MLP up | 1 | 4096×300 | 4096×300 | f32 | MUL_MAT, GELU | ~10.07B |
| Merger MLP down | 1 | 4096×300 | 2048×300 | f32 | MUL_MAT | ~5.03B |

**Total vision dense compute (640×480 test image): ~880–900B FLOPs**, dominated by the 24 vision blocks.

#### Text Model Per-Layer Breakdown

| Stage | Freq | Input shape (T=300) | Dtype mix | Op types | Est. FLOPs |
|---|---:|---|---|---|---:|
| Pre-attn RMS_NORM | 24 | 2048×T | f32 | RMS_NORM, MUL | ~0.03B total |
| **Recurrent SSM layers (~18):** | | | | | |
| SSM qkv projection | ~18 | 2048×T → 6144×T | q/K mix | MUL_MAT | 7.55B/layer |
| SSM z projection | ~18 | 2048×T → 2048×T | q4_K | MUL_MAT | 2.52B/layer |
| SSM beta projection | ~18 | 2048×T → 16×T | quantized small | MUL_MAT, SIGMOID | 0.02B/layer |
| SSM alpha projection | ~18 | 2048×T → 16×T | q8_0 | MUL_MAT, SOFTPLUS | 0.02B/layer |
| SSM conv | ~18 | 6144×T | f32 | SSM_CONV, SILU | ~0.02B/layer |
| Gated Delta Net | ~18 | q/k/v/gate/state | f32 | GATED_DELTA_NET | ~1-2B/layer |
| SSM gated RMS_NORM | ~18 | 128×16×T | f32 | RMS_NORM, SILU, MUL | reduction-bound |
| SSM output projection | ~18 | 2048×T | quantized | MUL_MAT | 2.52B/layer |
| **Full-attention layers (~6):** | | | | | |
| Q+gate projection | ~6 | 2048×T → 4096×T | quantized | MUL_MAT | 5.03B/layer |
| K/V projections | ~6 | 2048×T → 512×T each | quantized | MUL_MAT, RMS_NORM | 1.26B/layer |
| Full attention | ~6 | 8 heads, 2 KV heads | f32/f16 | ROPE, FLASH_ATTN_EXT | ~0.75B/layer |
| Attn output projection | ~6 | 2048×T | quantized | MUL_MAT | 2.52B/layer |
| **FFN (all 24 layers):** | | | | | |
| FFN gate+up | 24 | 2048×T → 6144×T (×2) | q/K mix | MUL_MAT | 15.1B/layer |
| SwiGLU | 24 | 6144×T | f32 | GLU | activation-bound |
| FFN down | 24 | 6144×T → 2048×T | q/K mix | MUL_MAT | 7.55B/layer |

At T=300: recurrent SSM layers ~33–36B FLOPs each; full-attention layers ~31–33B FLOPs each. FFN projections dominate dense math.

### 2.5 Projection Layer Comparison

The projection layer bridges vision encoder output and LLM input embeddings. Despite being a small fraction of total compute, it shows the most dramatic cross-device performance divergence.

#### Gemma4: Pool2D + Linear

Implementation: `clip.cpp:563-584` → `build_siglip()`

```
ViT output [n_embd=1152, n_patches]
  → transpose + reshape to [patches_per_side, patches_per_side, n_embd, batch]
  → pool_2d(AVG, kernel=n_merge, stride=n_merge)
  → reshape + transpose back to [n_embd, n_tokens_reduced]
  → rms_norm + learned scale
  → mul_mat(mm_input_proj_w^T)                    # 1152 → 2048
```

~9 ops (mostly zero-cost reshapes, 1 pool2d, 1 norm, 1 matmul).

#### Qwen3.5: Deepstack + MLP

Implementation: `clip.cpp:908-1096` → `build_qwen3vl()`

**During ViT forward pass** (per deepstack layer):
```
layer output [n_embd, n_pos]
  → reshape to [n_embd * merge_factor, n_pos / merge_factor]
  → layer_norm + 2-layer FFN (GELU)
  → concat with accumulated deepstack features
```

**Final projection** (after ViT):
```
ViT output [n_embd=1152, n_pos]
  → reshape to [n_embd * 4, n_pos / 4]
  → 2-layer MLP: mm_0_w → GELU → mm_1_w
  → concat with deepstack_features
```

~20+ ops per inference. `ggml_concat` grows a tensor across layers; final concat merges all features.

#### iPhone Projection Anomaly

| Device | Branch | Gemma4 img_decode | Qwen3.5 img_decode | Cross-Model Ratio |
|--------|--------|-------------------|---------------------|-------------------|
| Mac M4 | b9025 | 19 ms | 2 ms | Qwen3.5 9.5× faster |
| iPhone 16 Pro | b9025 | 38 ms | 9 ms | Qwen3.5 4.2× faster |
| iPhone 16 Pro | fiber | 132 ms | 9 ms | Gemma4 14.7× slower |
| iPhone 16e | b9025 | 38 ms | 9 ms | Qwen3.5 4.2× faster |
| iPhone 16e | fiber | 1,122 ms | 820 ms | Both catastrophic |
| **Mac↔16e ratio (b9025)** | | **2.0×** | **4.5×** | |
| **Mac↔16e ratio (fiber)** | | **59×** | **410×** | |

The original Phase 1 anomaly (183 ms Qwen3.5 projection on iPhone 16e) was measured
with the fiber fork. New b9025 data (2026-05-18) shows the projection is only 9 ms
on b9025 — the anomaly was a **fiber-specific regression**, not a hardware limitation.
The fiber regression is catastrophic on iPhone 16e (5-core A18) but negligible on
iPhone 16 Pro (6-core A18 Pro), suggesting a GPU occupancy threshold effect.

**Hypothesis 1: Deepstack concat buffer reallocation** — `ggml_concat` accumulates features across deepstack layers, requiring growing GPU memory allocation. On Mac M4, the 12.7 GB limit and larger cache hierarchy absorb this. On iPhone 16e, the smaller ~5.7 GB limit may force buffer eviction and reallocation.

**Hypothesis 2: Kernel dispatch overhead on A18** — Each deepstack layer adds ~6 kernel dispatches. With multiple deepstack layers, total dispatch overhead becomes significant on A18's 5-core GPU.

**Hypothesis 3: CLIP compute buffer pressure** — Qwen3.5's CLIP compute buffer is 223 MiB vs Gemma4's 101 MiB. On iPhone 16e, this competes with model weights for GPU memory.

**Hypothesis 4: Metal shader specialization gap** — Deepstack operations (concat along feature dim, non-standard stride reshapes) may lack optimized Metal shader paths on A18.

**Resolution**: U1 (deepstack preallocation) validated Hypothesis 1 — replaced chained `ggml_concat` with pre-allocated buffer + `ggml_set_inplace`. Result: **183 ms → 11 ms on iPhone (−94%)**.

#### Projection Optimization Opportunities

**P1. Fuse deepstack operations** (Impact: high, Cost: M) — Fuse norm + FFN into a single Metal kernel and pre-allocate concat output buffer. Target: `clip.cpp:1055-1070`. Expected: 50–80% reduction on iPhone.

**P2. Pre-allocate deepstack output tensor** (Impact: medium, Cost: S) — Replace growing `ggml_concat` chain with single pre-allocated buffer. **Implemented as U1** — 183→11 ms on iPhone.

**P3. mmproj weight quantization F16→Q8_0** (Impact: medium, Cost: M) — Halve memory bandwidth requirements. Gemma4 mmproj: 154→~77 MiB. Low risk for linear transforms.

**P4. Pool2D kernel optimization for Gemma4** (Impact: low, Cost: S) — Metal-specialized kernel for exact dimensions (n_merge=2/4, 1152-dim). Expected: 5–10 ms on iPhone.

**P5. Vision embedding cache with projection bypass** (Impact: high on repeat, Cost: S) — Cache post-projection embeddings. Bypasses vision+projection on cache hit. **Implemented as A2** — saves 666ms (Gemma4) / 1,012ms (Qwen3.5) on iPhone per hit.

**P6. SigLIP FP16 standardization overflow** (Impact: correctness, Cost: S) — `std_bias` reaches ~5.4e4, approaching FP16 max (6.55e4). Can cause `-inf`/NaN in vision embeddings. Mitigation: cast to FP32 or BF16 on Apple GPU Family 9+.

---

## 3. Metal Quantization Opportunity Table

Metal-specific quantization analysis covering both models. BFloat16 is fully supported on Apple GPU Family 9 (M4, A18).

| Rank | Layer / Component | Model(s) | Current Dtype | Candidate Dtype | Expected Speed-up (Metal) | Expected Quality Risk | Notes |
|---:|---|---|---|---|---|---|---|
| 1 | Vision FFN up/down | Both | F16 (mmproj) | Q8_0 or BF16 | 1.3–1.8× vision block speed | Low–Medium | Largest repeated vision MLP cost. BF16 is Metal-native on Apple9; provides middle ground between F16 and Q8_0 with same numerical fidelity. |
| 2 | Vision QKV + output projections | Both | F16 (mmproj) | Q8_0 | 1.2–1.6× vision block speed | Medium | Attention projections more sensitive; start with Q8_0, compare embeddings. SigLIP heads (72-dim) have high redundancy. |
| 3 | Projection MLP weights | Both | F16 (mmproj) | Q8_0 | 1.2–1.5× projection speed | Medium–High | Gemma4: 154 MiB → ~77 MiB. Qwen3.5 merger MLP directly forms text embeddings — avoid Q4 until quality tested. |
| 4 | KV cache | Both | F16 | Q4_0 (symmetric) | 4× KV memory reduction | Low (Qwen3.5), Medium (Gemma4) | Qwen3.5 has only 6/24 layers with KV cache — ideal target. Symmetric Q4_0 enables fused Flash Attention path; mismatched types force non-fused fallback. |
| 5 | LLM FFN gate/up/down | Both | Q4_K_M/Q5_K/Q6_K | Keep Q4_K_M | — | — | Q4_K_M already optimal for Metal decode (1.5–1.7× faster than Q8_0). No further quantization beneficial. |
| 6 | Qwen3.5 SSM qkv/z/out projections | Qwen3.5 | Q4_K/Q5_K mix | Keep current | — | — | These dominate recurrent text layers after FFN. Current quant adequate. |
| 7 | Qwen3.5 SSM alpha/beta projections | Qwen3.5 | q8_0 small matrices | Keep q8_0 or F16 | Correctness first | Low | Small-M q8_0×f32 Vulkan path is broken on Mali; Metal path is fine. Do not quantize further. |
| 8 | Vision patch embedding conv | Both | F16 | Keep F16 | Negligible | None | Single conv, tiny FLOP contribution — not worth quantizing. |
| 9 | Norms, biases, position embeddings | Both | F32 | Keep F32 | None | Low | Normalization layers must stay high precision. Memory and reductions dominate. |
| 10 | BF16 mmproj (Apple9+ only) | Both | F16 mmproj file | BF16 mmproj file | Memory −25% vs F16 | Negligible | BFloat16 fully supported on M4/A18. Middle ground if Q8_0 shows quality regression. Lower priority than rank 3. |
| 11 | LLM (aggressive) | Both | Q4_K_M | IQ3_XXS | 1.3× memory BW | High | Only if Q4_K_M OOMs (iPhone E4B case). Below 4-bit degrades coherence. |

---

## 4. Metal Layer Fusion Opportunity Table

Metal-specific fusion opportunities. Metal compute shaders support threadgroup memory, SIMD-group operations, and function constants for efficient fusion.

| Op Pair / Triplet | Model(s) | Frequency | Expected Speed-up (Metal) | Impl Cost | Notes |
|---|---|---:|---|---|---|
| RMSNorm + Q/K/V projection | Both | 18–34 LLM layers | 1.1–1.2× per LLM layer | M | Eliminates one global memory round-trip. Well-studied in TensorRT/vLLM. Metal threadgroup memory enables single-pass. |
| QKV projection fusion (single GEMM) | Both | 18–34 LLM + 24–27 vision | 1.2–1.4× attention | M | Concatenate Q/K/V weights; single larger GEMM better utilizes Metal GPU ALUs. Must handle GQA head count split. |
| MLP gate+up projection fusion | Both | 18–34 LLM layers | 1.2–1.3× MLP | M | Single GEMM for [gate, up] concatenated weights. Doubles GEMM size for better utilization. |
| SiLU/GELU + elementwise mul (gate·up) | Both | 18–34 LLM layers | 1.05–1.1× | S | Trivial pointwise fusion. Small but free. |
| LayerNorm + MLP fc1 (vision) | Both | 24–27 vision layers | 1.1–1.15× vision | M | Same pattern as LLM RMSNorm fusion. |
| Attention softmax + V matmul | Both | 24–27 vision + 18–34 LLM | 1.05–1.1× | L | Flash attention pattern. Metal shared memory limits make this complex on mobile. External [metal-flash-attention](https://github.com/philipturner/metal-flash-attention) shows 43–120% speedup via two-pass online softmax. |
| Projection Linear1 + GELU + Linear2 | Both | 1× per image | 1.15–1.2× projection | M | Fuse entire projection MLP into single kernel. High launch overhead for small tensor. |
| Vision multi-tile batching | Both | 1× per multi-tile image | 1.5–2× on GPU | M | Batch all Pan&Scan tiles in single forward pass. Currently sequential per-tile. Mac M4 Metal single-tile already efficient (630ms); gain largest on multi-tile. |
| Patch embed Conv2d + LayerNorm + pos add | Both | 1× (vision entry) | 1.05× | S | Single fused kernel for vision input. Minimal gain but trivial. |
| Qwen3.5 deepstack reshape+norm+FFN | Qwen3.5 | per deepstack layer | 50–80% projection (iPhone) | M | Target: `clip.cpp:1055-1070`. U1 preallocation already solved the buffer issue (183→11ms); remaining fusion of norm+FFN into fewer dispatches is incremental. |
| Qwen3.5 SSM alpha+softplus+mul | Qwen3.5 | ~18 layers | 2–5% text prompt | S/M | SSM alpha path emits ADD, SOFTPLUS, MUL — trivial pointwise fusion. |
| SSM_CONV + SILU + Q/K/V views | Qwen3.5 | ~18 layers | 3–8% text prompt | M | Reduces memory traffic in recurrent layers. |
| RMS_NORM + SILU(gate) + MUL (gated norm) | Qwen3.5 | ~18 layers | 3–8% text prompt | M | RMS_NORM + MUL fusion already exists in llama.cpp CPU backend; Metal equivalent would be incremental. |
| ROPE + PERMUTE + CPY (attention prep) | Both | ~6 text + 24 vision | 2–6% prompt/mmproj | M | Debug graph shows explicit permutes and f16 copies before flash attention. |

---

## 5. Metal Kernel Rewrite Candidates

Metal-specific kernel optimization targets. References Phase 1 Metal System Trace evidence and fiber fork gap analysis findings.

| Rank | Op | Current Metal Impl | Bottleneck Reason (Phase 1 Evidence) | Proposed Metal Change | Expected Speed-up | Impl Cost |
|---:|---|---|---|---|---|---|
| 1 | Fused Gated Delta Net (GDN) | Was CPU-only in fiber fork; ported as RC1 | Missing Metal kernel caused 38 graph splits per decode token → 28.8% Qwen3.5 regression. b9025 has fused `GGML_OP_GATED_DELTA_NET` Metal SIMD kernel (221 lines, simd_sum, function constants). | **Already ported** (RC1): 16 files, 563 lines. Graph splits 38→3. Qwen3.5 decode +18.8%. | +18.8% Qwen3.5 decode | Done |
| 2 | Flash Attention dk512_dv512 | Missing FA template for 512-dim heads | Gemma4 E2B uses 512-dim heads for full-attention layers (every 5th). Missing dk512_dv512 template caused FA to globally disable for all 35 layers → 17.4% regression. | **Already fixed** (RC3): Added 19 template instantiations across all quant types. Gemma4 FA enabled, graph splits 2/1. | +17.7% Gemma4 decode | Done |
| 3 | Vision encoder GEMM specialization | Generic ggml-metal GEMM kernels | Vision encode is 2–5.7× faster on Metal than CPU but generic kernels don't exploit ViT-specific tiling. Gemma4: 1152 hidden, 16 heads, 72 head_dim. Qwen3.5: 1024, 16 heads, 64 head_dim. | Metal compute kernels with architecture-specific tiling for exact ViT dimensions. Metal Performance Primitives (Metal 4) could simplify from Cost:L to Cost:M. | 15–25% vision encode | L |
| 4 | CLIP Flash Attention on Metal | Auto-detected with fallback warning | `clip.cpp:3334` — FA for CLIP model. External [metal-flash-attention](https://github.com/philipturner/metal-flash-attention) shows 43–120% speedup via two-pass online softmax. Apple lacks native FP32 atomics, which is why ggml-metal FA regresses on some configs. | Evaluate external two-pass implementation for integration into ggml-metal FA path. | 10–20% vision encode | S–M |
| 5 | SigLIP FP16 standardization overflow | Standard F16 norm | `std_bias` reaches ~5.4e4, approaching FP16 max (6.55e4). Certain input images could trigger `-inf`/NaN in Gemma4 vision embeddings. | Cast standardization norm layer to FP32 or BF16 on Apple GPU Family 9+. Verify whether ggml-metal already promotes this op. | Correctness fix | S |
| 6 | Metal MUL_MAT Tensor API | Pre-M5/pre-A19: Tensor API disabled (`has tensor = false`) | `d1649047a` restructured Metal matmul (NRA=64→128 B tile, direct device memory read). Cherry-picked as RC2 — **zero effect on M4 Mac** because Metal Tensor API requires M5/A19+. | No action for current targets. Monitor for M5/A19 devices where this will matter. | 0% (current targets) | Done |
| 7 | Patch embedding conv kernel | im2col + GEMM in mmproj | im2col materialization is memory-heavy. Both models use non-overlapping patches (stride=patch_size) — can bypass im2col entirely. | Direct conv kernel for non-overlapping patches: reshape + batched matmul. | 5–15% image encode | M |
| 8 | Metal Performance Primitives matmul2d | Not available (requires Metal 4) | WWDC 2025 `matmul2d_descriptor` API provides native tensor ops at shader level — SIMD-group and threadgroup scope. | Future: replace hand-tuned GEMM kernels with MPP equivalents. Simplifies kernel specialization (rank 3) from Cost:L to Cost:M. | Forward-looking | N/A |

---

## 6. MLX Cross-Reference

### 6.1 MLX Cross-Pollination

| MLX Optimization | What We Ported | Status |
|---|---|---|
| Content-addressed vision prefix caching | Full port → A2 (VisionPrefixCache class, SHA-256 + LRU) | **Done** |
| Op fusion (lazy graph evaluation) | Partial port → U1 Cost-S (static deepstack preallocation) | **Done** |
| Zero-copy unified-memory | Already default on Apple Silicon UMA (`ggml-metal-device.m:783`) | **No action needed** |
| Runtime lazy graph evaluation (JIT) | Not feasible — requires ggml architecture redesign | **Not ported** |
| QKV / gate+up GEMM fusion | <5% impact on Metal (decode is bandwidth-limited at ~51.5 t/s Mac, ~25 t/s iPhone) | **Not ported** |

### 6.2 MLX Performance Gap Context

Benchmarks show MLX achieves ~230 tok/s vs llama.cpp ~150 tok/s on Apple Silicon for comparable models. The gap is primarily due to `mx.compile()` automatic kernel fusion and lazy evaluation — techniques noted above as "not feasible" without ggml architecture redesign. RMS_NORM + MUL fusion already exists in llama.cpp's CPU backend; the Metal equivalent would be incremental but does not close the fundamental gap. MLX wins on long token generation (25% faster); llama.cpp wins on prompt-processing-heavy workloads.

### 6.3 Portability Assessment

**Portable from MLX (implemented):**
1. **Vision prefix caching** (A2) — saves 630ms Mac / 1,012ms iPhone per cache hit
2. **Static deepstack preallocation** (U1) — 183→11ms iPhone projection

**Portable in concept (not yet implemented):**
1. **Static op fusion patterns** — norm+linear, gate+up (Section 4 fusion table entries)
2. **Batched dispatch** — multi-tile batching, batched multi-head attention

**Not portable:**
1. **Zero-copy UMA** — already native on Apple Silicon; not applicable to Android
2. **Runtime graph optimization** — MLX's JIT has no Vulkan/OpenCL equivalent; must be done at compile time
3. **Apple BF16-specific fast paths** — limited portability to Android (Mali no BF16, Adreno TBD)

---

## 7. Ranked Recommendations — Top 5

Ranked by (impact × breadth) ÷ cost. Split by implementation location.

### Implemented Cherry-Picks from Upstream b9025

| RC | Optimization | Implementation | Measured Impact (M4 Mac) | Status |
|---|---|---|---|---|
| **RC1** | **Fused Gated Delta Net (GDN) Metal kernel** | Ported 16 files / 563 lines, adding fused `GGML_OP_GATED_DELTA_NET` Metal SIMD kernel (221 lines, `simd_sum`, function constants). Closes the Section 5 rank-1 gap. | Qwen3.5 decode 38.21 → 45.40 t/s (**+18.8%**); graph splits 38→3, nodes 4743→1431 | Done |
| **RC2** | **Metal MUL_MAT Tensor API restructure** (`d1649047a`) | Cherry-picked Metal matmul restructure (NRA=64→128 B tile, direct device memory read). Closes the Section 5 rank-6 gap. | **0% on M4 Mac** — Metal Tensor API requires M5/A19+; harmless forward-looking change for future devices | Done |
| **RC3** | **Flash Attention dk512_dv512 template** | Added 19 FA template instantiations across all quant types for 512-dim heads. Gemma4 E2B uses 512-dim heads on every 5th (full-attention) layer; the missing template was globally disabling FA across all 35 layers. Closes the Section 5 rank-2 gap. | Gemma4 decode 41.88 → 49.29 t/s (**+17.7%**); FA enabled, graph splits 2/1 | Done |

**Justification:** RC1, RC2, and RC3 are implemented and cherry-picked from upstream llama.cpp `b9025`. They directly close the top three Metal-kernel gaps identified by the fiber-fork performance audit (Section 5 ranks 1, 2, 6 and Appendix G.3 root causes 1–3). RC1 and RC3 deliver the two largest decode wins on M4 Mac (+18.8% Qwen3.5, +17.7% Gemma4) and together recover Gemma4 to within 2.8% of the b9025 baseline. RC2 is a forward-looking restructure: zero effect on current M4 targets but activates on M5/A19+ devices, so it is retained to avoid re-porting later. See Appendix G.4 for the progressive-fix benchmark table.

### Top-5 Summary

| Rank | Optimization | Target | Expected Impact | Cost | Status |
|---:|---|---|---|---|---|
| 1 | **Model-aware hybrid dispatch (A1)** | Both models, Mac+iPhone | TTFT −20 to −40% every call | S | Deferred (no per-phase backend hook) |
| 2 | **Post-projection vision cache (A2)** | Both models, Mac+iPhone | TTFT −100% on cache hit | S | **Done** (a531624b) |
| 3 | **Qwen3VL deepstack fusion (U1)** | Qwen3.5, iPhone | Projection −94% (183→11ms) | S | **Done** (3cd776c5c) |
| 4 | **mmproj quantization F16→Q8_0 (U2)** | Both models, all platforms | Memory −50%, BW +1.5–2× | M | Not started |
| 5 | **KV cache quantization Q4_0 (F1)** | Both, esp. Qwen3.5 | 75% KV memory reduction | S | Not started |

### 7.1 Addon-Level Optimizations (MtmdLlmContext.cpp)

| Rank | Optimization | TTFT Impact | Cost | Details |
|------|-------------|------------|------|---------|
| **A1** | **Model-aware hybrid dispatch** | −20 to −40% | S | Route Gemma4 prefill to CPU (1.63× faster), Qwen3.5 prefill to Metal (2.54× faster). Keep decode on Metal for both. Requires per-model dispatch table in addon. |
| **A2** | **Post-projection vision cache** | −100% on hit | S | LRU cache keyed by image hash, storing post-projection embeddings. Bypasses vision+projection on repeat images. Saves 666ms (Gemma4) / 1,012ms (Qwen3.5) on iPhone per hit. **Implemented.** |
| **A3** | **Qwen3.5 context overflow guard** | crash prevention | S | Pre-calculate vision token count before encoding. Qwen3.5 + large images produce 4,015 tokens, overflowing the 4,096 context window. **Implemented.** |
| **A4** | **Metal backend auto-detection** | UX | S | Auto-set `mparams.backend_device = "Metal"` on Apple platforms in `initVisionContext()`. |

### 7.2 Upstream llama.cpp Optimizations

| Rank | Optimization | Impact | Cost | Target | Details |
|------|-------------|--------|------|--------|---------|
| **U1** | **Qwen3VL deepstack fusion** | Projection −94% on iPhone | S | `clip.cpp:1055-1070` | Pre-allocate concat output buffer. **Implemented** — 183→11ms. |
| **U2** | **mmproj quantization (F16→Q8_0)** | Memory −50%, BW +1.5–2× | M | clip.cpp weight loading | Add Q8_0 quantization for projection weights. Gemma4: 154→~77 MiB. |
| **U3** | **Batch vision encoding** | Vision −30 to −50% (multi-tile) | M | `mtmd.cpp:824` | Fix TODO: implement batched encoding in `clip_image_batch_encode()`. |
| **U4** | **CLIP flash attention on Metal** | Vision −10 to −20% | S | `clip.cpp:3334` | Evaluate external metal-flash-attention two-pass approach. |
| **U5** | **Vision encoder Metal kernel specialization** | Vision −15 to −25% | L | ggml-metal | Custom kernels for ViT dimensions. |
| **U6** | **BF16 mmproj on Apple GPU Family 9+** | Memory −25% vs F16 | S | clip.cpp | Middle ground if Q8_0 shows quality regression. |
| **U7** | **MTMD vision CPU fallback monitor** | Regression watchpoint | S | addon test | Assert vision TTFT < 2s on Metal. [llama.cpp #22582](https://github.com/ggml-org/llama.cpp/issues/22582) reference. |
| **U8** | **Input-adaptive visual preprocessing** | Vision −50%+, tokens −55% | L | clip.cpp | [arxiv 2512.20839](https://arxiv.org/abs/2512.20839) — content-aware resolution selection. |

### 7.3 Priority Matrix

For Phase 3 (top-2 optimizations), the recommended pair is:

**Primary: A1 (hybrid dispatch) + A2 (vision cache)** — Both addon-level (no upstream dependency). A1 improves every inference call. A2 eliminates vision+projection on cache hit. Combined TTFT: −20 to −40% (miss) / −70 to −90% (hit).

**Secondary: U1 (deepstack fusion)** — Upstream change with highest single-optimization impact for Qwen3.5 on iPhone. **Already implemented.**

---

## Appendix A: Metal Performance Matrix

All benchmarks: llama.cpp b9025, elephant.jpg (single tile), 256 predict tokens (Mac) / 128 predict (iPhone).

### A.1 Mac M4 — All Model Variants (Metal Backend)

| Model | Vision (ms) | Projection (ms) | Prefill (t/s) | Decode (t/s) | TTFT (ms) | Total (ms) |
|-------|------------|-----------------|---------------|-------------|----------|-----------|
| Gemma4 E2B Q4_K_M | 630 | 19 | 259.6 | 51.28 | 1,724 | 6,512 |
| Gemma4 E2B Q8_0 | 689 | — | 237.0 | 30.30 | 1,887 | 10,062 |
| Gemma4 E4B Q4_K_M | 768 | — | 135.9 | 23.28 | 2,858 | 13,619 |
| Gemma4 E4B Q8_0 | 827 | — | 138.4 | 15.26 | 2,880 | 20,040 |
| **Qwen3.5-2B Q4_K_M** | **417** | **2** | **323.6** | **51.83** | **1,236** | **5,947** |

Qwen3.5 is the fastest model on Mac Metal — 32% faster vision, 10.5× faster projection, and identical decode ceiling to Gemma4 E2B.

### A.2 iPhone 16e — b9025 Baseline (Metal, local, 2026-05-18)

> Full 3-run median matrix. Source: `vlm-benchmark/results/raw/ios-local-b9025-{model}-2026-05-18T1659/`

| Model | Vision (ms) | img_decode (ms) | Prefill (t/s) | Decode (t/s) |
|-------|------------|----------------|---------------|-------------|
| Gemma4 E2B Q4_K_M | 1,285 | 38 | 122.7 | 27.26 |
| Qwen3.5-2B Q4_K_M | 927 | 9 | 150.0 | 27.69 |
| Qwen3.5-2B Q8_0 | 924 | 9 | 154.3 | 21.86 |
| Qwen3.5-4B Q4_K_M | 1,058 | 10 | 82.7 | 12.28 |

> Phase 1 reference (b9025, 2026-05-07, `--predict 128`): Gemma4 E2B Q4_K_M 27.24 t/s, Qwen3.5-2B Q4_K_M 24.34 t/s. Phase 1 Qwen3.5 projection anomaly (183 ms) was measured on fiber, not b9025.

### A.3 iPhone 16 Pro — b9025 Baseline (Metal, Firebase, 2026-05-18)

> Firebase Test Lab (`DEVICE_CAPACITY_LOW`, iOS 18.3.2). Full 3-run median.
| Model | Vision (ms) | Prefill (t/s) | Decode (t/s) |
|-------|------------|---------------|-------------|
| Gemma4 E2B Q4_K_M | 879 | 176.2 | 30.0 |
| Qwen3.5-2B Q4_K_M | 591 | 222.2 | 31.0 |
| Qwen3.5-2B Q8_0 | 549 | 241.5 | 23.2 |
| Qwen3.5-4B Q4_K_M | 647 | 124.4 | 14.6 |

> Caveat: Firebase RSS values (75-135 MB via `mach_task_basic_info`) are not
> comparable to local measurements. Firebase does not expose thermal state.

### A.3 Metal vs CPU — Per-Phase Dispatch Analysis

| Phase | Gemma4 E2B | Qwen3.5-2B | Optimal Dispatch |
|-------|-----------|-----------|-----------------|
| **Vision encode** | Metal 3.4× faster (630 vs 2,113 ms) | Metal 4.6× faster (417 vs 1,922 ms) | Metal (both) |
| **Projection** | Metal (19 ms vs ~100 ms CPU est.) | Metal on Mac (2 ms), 183 ms on iPhone 16e fiber (9 ms on b9025 — fiber-specific) | Metal Mac / investigate iPhone |
| **Prefill** | **CPU 1.63× faster** (424 vs 260 t/s) | **Metal 2.54× faster** (324 vs 127 t/s) | **Model-dependent!** |
| **Decode** | Metal 1.32× faster (51.3 vs 38.7 t/s) | Metal 1.58× faster (51.8 vs 32.7 t/s) | Metal (both) |

**Critical finding**: Gemma4 and Qwen3.5 require **opposite prefill dispatch strategies**.

### A.4 Metal Decode Speedup by Quantization

| Model | CPU (t/s) | Metal (t/s) | Speedup |
|-------|----------|------------|---------|
| Gemma4 E2B Q4_K_M | 38.74 | 51.28 | 1.32× |
| Gemma4 E2B Q8_0 | 25.18 | 30.30 | 1.20× |
| Gemma4 E4B Q4_K_M | 17.64 | 23.28 | 1.32× |
| Gemma4 E4B Q8_0 | 12.12 | 15.26 | 1.26× |
| Qwen3.5-2B Q4_K_M | 32.74 | 51.83 | 1.58× |

Q4_K_M provides 1.5–1.7× faster decode than Q8_0 on both CPU and Metal. Qwen3.5 benefits most from Metal (1.58×).

### A.5 Vision Pipeline: Metal vs CPU

| Model | CPU (ms) | Metal (ms) | Speedup |
|-------|---------|-----------|---------|
| Gemma4 E2B Q4_K_M | 2,113 | 630 | 3.35× |
| Gemma4 E2B Q8_0 | 1,941 | 689 | 2.82× |
| Gemma4 E4B Q4_K_M | 4,370 | 768 | 5.69× |
| Gemma4 E4B Q8_0 | 3,881 | 827 | 4.69× |
| Qwen3.5-2B Q4_K_M | 1,922 | 417 | 4.61× |

### A.6 Cross-Device Metal Comparison (b9025)

| Metric | Mac M4 (8 cores) | iPhone 16 Pro (6 cores) | iPhone 16e (5 cores) | Mac/16e Ratio |
|--------|--------|------------|-----------|-----------------|
| Gemma4 E2B decode | 50.73 t/s | 30.0 t/s | 27.26 t/s | 1.86× |
| Gemma4 E2B vision | 632 ms | 879 ms | 1,285 ms | 2.03× |
| Qwen3.5-2B decode | 39.79 t/s | 31.0 t/s | 27.69 t/s | 1.44× |
| Qwen3.5-2B vision | 537 ms | 591 ms | 927 ms | 1.73× |
| Qwen3.5-4B decode | 17.60 t/s | 14.6 t/s | 12.28 t/s | 1.43× |

iPhone 16 Pro sits between Mac M4 and iPhone 16e as expected — 6 GPU cores vs
5 (16e) and 8 (M4). All b9025 img_decode values are 9-40 ms across all devices.
The original 183 ms Qwen3.5 projection anomaly was fiber-specific (see Section 2.5).

---

## Appendix B: GPU Memory Analysis

### B.1 Buffer Breakdown (Mac M4, Metal)

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

### B.2 Memory Observations

- **Qwen3.5 uses 47% less total GPU memory** — significant for iPhone headroom
- **CLIP compute buffer is 2.2× larger for Qwen3.5** (223 vs 101 MiB), likely due to deepstack feature accumulation
- **Gemma4 has separate mmproj buffer** (154 MiB F16) — direct quantization target
- iPhone headroom: Gemma4 ~1.9 GB free, Qwen3.5 ~3.7 GB free

---

## Appendix C: Phase Timing Analysis

### C.1 Mac M4 — Full Pipeline (elephant.jpg, 256 predict)

| Phase | Gemma4 E2B Q4_K_M | Qwen3.5-2B Q4_K_M | Δ |
|-------|-------------------|---------------------|---|
| Model load | 280 ms | 191 ms | Qwen3.5 32% faster |
| Vision encode | 611 ms | 415 ms | Qwen3.5 32% faster |
| Image projection | 19 ms | 2 ms | Qwen3.5 9.5× faster |
| Prefill | 1,094 ms (284 tok, 260 t/s) | 807 ms (265 tok, 329 t/s) | Qwen3.5 26% faster |
| Decode | 4,973 ms (255 tok, 51.3 t/s) | 4,920 ms (255 tok, 51.8 t/s) | **Identical ceiling** |
| **Total** | **6,512 ms** | **5,947 ms** | Qwen3.5 9% faster |

Both models hit the same decode ceiling (~51.5 t/s) — M4's memory bandwidth limit (~120 GB/s).

### C.2 iPhone 16e — Full Pipeline (elephant.jpg, 128 predict, Phase 1 b9025)

> Phase 1 data (2026-05-07, b9025 via `xcrun devicectl`). The 183 ms Qwen3.5
> projection value was from a fiber measurement — b9025 projection is 9 ms
> (see Section 2.5 and Appendix G.5 for the corrected analysis).

| Phase | Gemma4 E2B Q4_K_M | Qwen3.5-2B Q4_K_M | Δ |
|-------|-------------------|---------------------|---|
| Vision encode | 1,272 ms | 829 ms | Qwen3.5 35% faster |
| Image projection | 36 ms | **183 ms** (fiber) | **Qwen3.5 5.1× slower** (fiber only; b9025 = 9 ms) |
| Prefill | 2,330 ms (284 tok, 122 t/s) | 1,983 ms (265 tok, 134 t/s) | Qwen3.5 15% faster |
| Decode | 5,478 ms (127 tok, 23.2 t/s) | 5,220 ms (127 tok, 24.3 t/s) | Qwen3.5 5% faster |
| **Total** | **9,885 ms** | **8,086 ms** | Qwen3.5 18% faster overall |

Despite the projection anomaly (fiber-specific), Qwen3.5 is faster end-to-end on iPhone.

### C.3 Phase Cost Distribution (iPhone 16e, % of total)

| Phase | Gemma4 E2B | Qwen3.5-2B |
|-------|-----------|-----------|
| Vision encode | 12.9% | 10.3% |
| Image projection | 0.4% | **2.3%** |
| Prefill | 23.6% | 24.5% |
| Decode | **55.4%** | **64.6%** |

Decode dominates (55–65%). Vision + projection: 13% Gemma4, 12–13% Qwen3.5.

---

## Appendix D: Impact Projection

### D.1 With A1 + A2 (Addon-Only, No Upstream Changes)

| Platform | Model | Current TTFT | Projected TTFT (miss) | Projected TTFT (hit) | Current Decode |
|----------|-------|-------------|----------------------|-----------------------|----------------|
| Mac M4 | Gemma4 E2B | 1,724 ms | ~1,400 ms | <500 ms | 51.3 t/s |
| Mac M4 | Qwen3.5-2B | 1,236 ms | ~1,200 ms | <500 ms | 51.8 t/s |
| iPhone 16e | Gemma4 E2B | 3,492 ms | ~2,800 ms | <1,000 ms | 27.2 t/s |
| iPhone 16e | Qwen3.5-2B | ~3,200 ms* | ~3,000 ms | <800 ms | 24.3 t/s |

*Estimated from phase sum.

### D.2 With A1 + A2 + U1 (Addon + Upstream Deepstack Fix)

| Platform | Model | Projected TTFT (miss) | Projected TTFT (hit) |
|----------|-------|----------------------|-----------------------|
| Mac M4 | Gemma4 E2B | ~1,400 ms | <500 ms |
| Mac M4 | Qwen3.5-2B | ~1,200 ms | <500 ms |
| iPhone 16e | Gemma4 E2B | ~2,800 ms | <1,000 ms |
| iPhone 16e | Qwen3.5-2B | ~2,200 ms | <800 ms |

### D.3 Decode Ceiling

Both models are memory-bandwidth-limited at decode:
- Mac M4: ~51.5 t/s — saturates ~120 GB/s
- iPhone 16e: ~25–27 t/s — saturates ~60 GB/s

No software optimization can meaningfully improve decode throughput.

---

## Appendix E: Qwen3.5-VL Metal-Specific Considerations

### E.1 Strengths on Metal
- 47% less GPU memory than Gemma4 E2B → more headroom for context and batching
- Faster vision encoding (417ms vs 630ms Mac, 829ms vs 1,236ms iPhone)
- Metal prefill 2.54× faster than CPU (unique among all tested models)
- Identical decode ceiling to Gemma4 E2B (~51.5 t/s Mac, ~25 t/s iPhone)
- Coherent output on Metal (validated; garbled on Android Vulkan/OpenCL)

### E.2 Weaknesses on Metal
- **Projection anomaly on iPhone** (183ms fiber vs 9ms b9025 vs 2ms Mac) — **resolved by U1** (183→11ms on fiber); b9025 has no anomaly (9ms)
- **Context overflow risk** — large images produce 4,015 tokens, nearly filling 4,096 context — **guarded by A3**
- **No iPhone Qwen3.5 TTFT baseline** — explicit measurement needed
- SSM recurrent state (19 MiB RS buffer) adds memory overhead not present in Gemma4

### E.3 Architecture Uniqueness
- **Hybrid attention + SSM decoder** — only 6 of 24 layers use full attention with KV cache; remaining 18 use Gated Delta Net (GDN) linear attention with no KV cache. Makes KV quantization (F1) particularly effective.
- **Deepstack feature extraction** — features from intermediate ViT layers processed and concatenated with projection, giving multi-scale visual information. Architecturally superior but computationally expensive.
- **M-RoPE (Multi-Resolution RoPE)** — 4D positional encoding (temporal + 3 spatial) in vision encoder. Interleaved-MRoPE distributes temporal, height, width info more evenly, with native support up to 262K tokens.

---

## Appendix F: Phase 3 Optimization Status

### F.1 Implemented

| ID | Optimization | Branch / Commit | Measured Impact | Notes |
|---|---|---|---|---|
| **A2** | Post-projection vision cache | `feat/QVAC-18297-vlm-pr1-cache-and-overflow-guard` commit `a531624b` | Saves ~649 ms (Mac) / ~1,012 ms (iPhone) per cache-hit | SHA-256 keyed LRU, 5–10 entries. Ported from MLX content-addressed caching. |
| **A3** | Qwen3.5 context overflow guard | Same branch, commit `670be1db` | Prevents crash on large images (4,015 tokens at ctx=4096) | Typed `ContextOverflow` error replaces crash. |
| **U1** | Deepstack preallocation | `feat/QVAC-18297-u1-deepstack-prealloc` commit `3cd776c5c` | Qwen3.5 iPhone projection: **183 ms → 11 ms (−94%)**; Mac: no change | Replaced chained `ggml_concat` with pre-allocated buffer. |
| **F4** | Hybrid/recurrent multi-turn cache fix | `feat/QVAC-18297-f4-hybrid-multiturn-cache` commit `567bc4b23` | No regression in single-shot. Multi-turn: avoids full re-processing. | Fix in `llama_memory_hybrid::seq_pos_min()`. |
| **F6** | Metal vision encode profiling | `feat/QVAC-18297-f6-metal-vision-profile` commit `a38d3036c` | Profiling-only — traces captured (469 MB Gemma4, 376 MB Qwen3.5) | Mac M4 Metal System Traces ready for Instruments analysis. |

### F.2 Deferred / Not Started

| ID | Optimization | Reason | Could revisit? |
|---|---|---|---|
| **A1** | Model-aware hybrid dispatch | No per-phase backend hook in upstream llama.cpp | Yes — if llama.cpp adds phase-specific backend routing |
| **U1 (Cost-M)** | Deepstack norm+FFN kernel fusion | Cost-S fix already reduced 183→11 ms; remaining 11→~5 ms is low ROI | Low priority |
| **U2** | mmproj quantization F16→Q8_0 | Requires quality validation (VQA/OCR benchmarks) | Yes — next priority after PR merge |
| **F1** | KV cache quantization Q4_0 | Addon-only change. Qwen3.5 has only 6/24 layers with KV cache — ideal target. | High priority (P1) |
| **F5** | Speculative decoding | Requires ≥2.5× draft-to-target speed ratio on UMA | Medium priority |

### F.3 Mac M4 Branch Benchmark Results (2026-05-11)

Independent benchmark of each llama.cpp branch vs b9025 baseline. Metal, elephant.jpg, 256 predict, 1 warmup + 3 measured runs (median).

| Branch | Gemma4 Total (ms) | Qwen3.5 Total (ms) | Δ vs Baseline | Verdict |
|---|---|---|---|---|
| b9025 baseline | 6,370 | 5,748 | — | Reference |
| U1 (deepstack) | 6,370 | 5,743 | ±0.1% | No change on Mac (expected) |
| F4 (multi-turn) | 6,357 | 5,740 | ±0.2% | No regression |
| F6 (profiling) | 6,359 | 5,741 | ±0.1% | Identical to baseline |

### F.4 Remaining Validation

- [ ] iPhone 16e benchmarks for A2+A3 (cache hit/miss delta)
- [x] iPhone 16 Pro benchmarks (Firebase, fiber + b9025, 4 models) — 2026-05-18
- [x] iPhone 16e full matrix (local, fiber + b9025, 4 models) — 2026-05-18
- [ ] iPhone 17 — not in Firebase catalog (2026-05-18)
- [ ] Text-only LLM regression test (≤ 2% threshold) — llama-bench bridge not yet implemented
- [ ] F6 trace analysis in Instruments — identify top-5 bottleneck Metal kernels in vision encode
- [ ] F4 multi-turn validation with `llama-server`

---

## Appendix G: Fiber Fork Analysis

### G.1 Addon vs CLI Overhead (Mac M4)

**Date**: 2026-05-11. Addon: llm-llamacpp v0.20.0 (Bare runtime). CLI: llama-mtmd-cli b9025 baseline.

| Metric | Qwen3.5 CLI | Qwen3.5 Addon | Delta | Gemma4 CLI | Gemma4 Addon | Delta |
|--------|------------|--------------|-------|-----------|-------------|-------|
| Total (ms) | 5,748 | 7,726 | +34.4% | 6,370 | 7,484 | +17.5% |
| Decode (t/s) | 53.7 | 37.7 | −29.8% | 52.1 | 42.1 | −19.2% |
| Prefill (t/s) | 333.0 | 306.4 | −8.0% | 261.6 | 258.9 | −1.0% |
| Model load (ms) | 192 | 614 | +220% | 310 | 786 | +154% |

**Note**: The fiber fork itself introduces a 19–29% decode regression vs upstream b9025. Since the addon benchmarks used the fiber-based addon, the overhead attributed to JS binding may be partially or entirely caused by the fiber fork regression.

### G.2 Fiber Decode Regression — Verified (2026-05-12)

| Model | b9025 (t/s) | Fiber (t/s) | Delta |
|-------|------------|------------|-------|
| Qwen3.5-2B Q4_K_M | 52.62 | 38.21 | **−27.4%** |
| Gemma 4 E2B Q4_K_M | 50.72 | 41.88 | **−17.4%** |

Verified across 3 independent benchmark sessions. Intra-session variance <1%. Binary provenance confirmed via verified rebuild.

### G.3 Root Cause Analysis

| # | Root Cause | Models | Impact | Remediation | Complexity |
|---|-----------|--------|--------|-------------|------------|
| 1 | Missing fused GDN Metal kernel | Qwen3.5 | ~28% | Port 4 upstream commits | High |
| 2 | Missing Metal MUL_MAT optimization | Both | ~5–10% | Cherry-pick `d1649047a` | Low |
| 3 | Gemma4 FA auto-disabled (dk512) | Gemma4 | ~10–15% | Add FA dk512 templates | Medium |
| 4 | Fiber attention path changes | Both | 0–5% | Investigate/verify | Low |

### G.4 Progressive Fix Results (feat/QVAC-18297-fiber-updates)

| Stage | Qwen3.5 Decode (t/s) | vs b9025 | Gemma4 Decode (t/s) | vs b9025 |
|-------|----------------------|----------|---------------------|----------|
| b9025 baseline | 52.62 | — | 50.72 | — |
| Fiber baseline | 38.21 | −27.4% | 41.88 | −17.4% |
| + RC2 (MUL_MAT) | 38.14 | −27.5% | 42.09 | −17.0% |
| + RC1 (Fused GDN) | 45.40 | −13.7% | 40.90 | −19.4% |
| + RC3 (FA dk512) | 45.23 | −14.0% | **49.29** | **−2.8%** |

**RC2 (Metal MUL_MAT)**: Zero effect on M4 Mac — Metal Tensor API disabled for pre-M5/pre-A19 devices.
**RC1 (Fused GDN)**: Largest single improvement for Qwen3.5. Graph splits 38→3, nodes 4743→1431. +18.8%.
**RC3 (FA dk512)**: Largest improvement for Gemma4. Gemma4 E2B uses 512-dim heads for full-attention layers; missing dk512_dv512 template caused global FA disable. Added 19 template instantiations. +17.7%.
**RC4**: Both `9e4530f51` (view_4d→reshape_4d) and `6aff83a75` (Metal buffer fallback) are no-ops on M4 Mac during single-token decode.

### G.5 Fiber Regression is Device-Dependent (added 2026-05-18)

iPhone 16 Pro and iPhone 16e full-matrix benchmarks (2026-05-18) reveal that the
fiber Metal regression is **dramatically amplified on iPhone 16e but negligible on
iPhone 16 Pro**, despite both having 8 GB RAM and Apple GPU Family 9.

| Device | Model | Fiber decode (t/s) | b9025 decode (t/s) | Delta | Fiber img_decode (ms) | b9025 img_decode (ms) |
|--------|-------|-------------------|-------------------|-------|----------------------|----------------------|
| **iPhone 16 Pro** | Gemma4-E2B Q4 | 30.9 | 30.0 | −2.9% | 132 | 38 |
| **iPhone 16 Pro** | Qwen3.5-2B Q4 | 31.4 | 31.0 | −1.3% | 9 | 9 |
| **iPhone 16e** | Gemma4-E2B Q4 | 17.0 | 27.3 | **−37.7%** | 1,122 | 38 |
| **iPhone 16e** | Qwen3.5-2B Q4 | 8.2 | 27.7 | **−70.4%** | 820 | 9 |
| **iPhone 16e** | Qwen3.5-4B Q4 | 4.0 | 12.3 | **−67.5%** | 2,133 | 10 |
| Mac M4 | Gemma4-E2B Q4 | 31.45 | 50.73 | −38.0% | — | — |
| Mac M4 | Qwen3.5-2B Q4 | 32.56 | 39.79 | −18.2% | — | — |

The `img_decode` (projection) step is the smoking gun: 30-210× slower on fiber vs
b9025 on iPhone 16e, but only 3.5× on iPhone 16 Pro and unmeasured on Mac. This
suggests a GPU occupancy threshold — fiber's unoptimized projection path saturates
the 5-core A18 GPU but has enough headroom on the 6-core A18 Pro.

The original Phase 1 "Qwen3.5 projection anomaly" (183 ms on iPhone 16e, Section 2.5)
was a fiber-specific artifact, not a hardware limitation. On b9025, the projection is
9 ms on both iPhone models.

**Source logs**:
- iPhone 16e: `vlm-benchmark/results/raw/ios-local-{fiber,b9025}-*-2026-05-18T1659/`

### G.6 Remaining Qwen3.5 Gap (−14.0% on Mac M4)

Possible causes after all fixes:
1. Extra graph split: fiber has 3 splits (decode) vs b9025's 2 — one additional GPU↔CPU sync per token
2. State layout transpose overhead: `ggml_cont(ggml_transpose(s))` on input + `ggml_transpose(s_new)` on output — 2 extra ops per GDN layer
3. Upstream micro-optimizations between merge base (4d828bd1a) and b9025 (836 commits) not yet ported

### G.7 Three-Way CLI Comparison: b9025 vs U1 vs Fiber

| Metric | b9025 | U1 (deepstack) | Δ U1 | Fiber | Δ Fiber |
|--------|-------|----------------|------|-------|---------|
| **Qwen3.5 decode (t/s)** | 53.74 | 53.82 | +0.1% | 38.21 | −28.9% |
| Qwen3.5 vision (ms) | 402 | 406 | +1.0% | 419 | +4.2% |
| Qwen3.5 total (ms) | 5,748 | 5,743 | −0.1% | 7,768 | +35.1% |
| **Gemma4 decode (t/s)** | 52.12 | 52.11 | −0.0% | 41.88 | −19.6% |
| Gemma4 vision (ms) | 604 | 603 | −0.2% | 603 | −0.2% |
| Gemma4 total (ms) | 6,370 | 6,370 | 0.0% | 7,670 | +20.4% |

U1 is identical to b9025 on Mac M4 (expected — iPhone-specific fix).

### G.8 Upstream Commits Cherry-Picked

| Commit | Description | Files |
|--------|-------------|-------|
| `c5a778891` | ggml: add GATED_DELTA_NET op | 15 (+627) |
| `d28961d81` | llama: enable chunked fused GDN + Metal kernel | 20 (+675) |
| `e30f1fdf7` | graph: remove redundant GDN state transposes | 5 (+46/−57) |
| `f17b3be63` | llama: fix pooling assertion crash in chunked GDN | 2 (+40) |
| `d1649047a` | metal: optimize Metal Tensor API MUL_MAT | 6 (+233/−109) |
| `342d6125b` | metal: FA dk512_dv512 instantiations | — |

---

## Appendix H: Methodology & Sources

### H.1 Source Reports

| Report | Content | Devices |
|--------|---------|---------|
| `gemma4-vl-baseline.md` | Phase 1 mobile baseline: CPU/Vulkan/OpenCL/Metal | S25, P9P, iPhone 16e |
| `metal-baseline.md` | Metal-specific benchmarks, GPU memory, phase timings, System Traces | Mac M4, iPhone 16e |
| `vlm-mac-baseline.md` | Mac M4 full CPU+Metal matrix, all model variants | Mac M4 |

### H.2 Metal System Traces

| Trace File | Device | Model | Size | Predict Tokens |
|-----------|--------|-------|------|---|
| `mac-m4-gemma4-e2b-q4km.trace` | Mac M4 | Gemma4 E2B Q4_K_M | 597 MB | 256 |
| `mac-m4-qwen3.5-2b-q4km.trace` | Mac M4 | Qwen3.5-2B Q4_K_M | 480 MB | 256 |
| `iPhone16e-gemma4-e2b-q4km.trace` | iPhone 16e | Gemma4 E2B Q4_K_M | 371 MB | 128 |
| `iPhone16e-qwen3.5-2b-q4km.trace` | iPhone 16e | Qwen3.5-2B Q4_K_M | 101 MB | 128 |

### H.3 Fiber Fork Analysis Sources

| Source | Content |
|--------|---------|
| `vlm-benchmark/QVAC-18297-fiber-b9025-gap.md` | Root cause analysis, progressive fix results |
| `vlm-benchmark/results/parsed/mac-verified-2026-05-12T1500.json` | Verified b9025 rebuild baseline |
| `vlm-benchmark/results/parsed/mac-fiber-rc{1,2,3}-*.json` | Progressive fix benchmarks |
| `vlm-benchmark/results/parsed/mac-baseline-2026-05-11T1557.json` | b9025 branch benchmarks |
| `vlm-benchmark/results/parsed/mac-u1-2026-05-11T1557.json` | U1 deepstack prealloc benchmarks |

### H.4 Code References

- Upstream llama.cpp: `tools/mtmd/` (clip.cpp, clip-impl.h, mtmd.cpp, mtmd-helper.cpp)
- Addon integration: `packages/qvac-lib-infer-llamacpp-llm/addon/src/model-interface/MtmdLlmContext.cpp`
- llama.cpp version: b9025
- Reproducibility: Run-2 validation shows ±2% variance

### H.5 External Research References

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
- Metal FlashAttention (two-pass online softmax, 43–120% speedup): [github.com/philipturner/metal-flash-attention](https://github.com/philipturner/metal-flash-attention)
- MetalQwen3 (complete Metal transformer with QKV fusion): [github.com/BoltzmannEntropy/metalQwen3](https://github.com/BoltzmannEntropy/metalQwen3)
- MTMD vision CPU fallback (BF16 mmproj on CPU in server path): [llama.cpp #22582](https://github.com/ggml-org/llama.cpp/issues/22582)

---

## Appendix I: Forward-Looking — Metal 4 and Next-Gen Hardware

WWDC 2025 introduced Metal 4 with features relevant to LLM/VLM inference on future Apple Silicon (iPhone 17, next-gen Macs):

**Metal Performance Primitives (MPP):** New `matmul2d_descriptor` API provides native tensor operations at shader level, programmable at SIMD-group and threadgroup scope. For ggml-metal, MPP could replace hand-tuned GEMM kernels — potentially simplifying U5 (vision encoder specialization) from Cost:L to Cost:M.

**Shader ML / ML Encoder:** Native tensor support in Metal shaders. ML workloads execute on GPU timeline alongside rendering/compute. Relevant if QVAC integrates vision into a rendering pipeline (camera preview → VLM). Not immediately actionable for current CLI/addon architecture.

**BFloat16 on Apple GPU Family 9:** Already fully supported on M4 and A18 (current targets). MPSGraph adds BFloat16 for mixed-precision inference. Relevant to U6 (BF16 mmproj) and P6 (SigLIP FP16 overflow).

**Target timeline:** Current M4/A18 targets are Apple GPU Family 9 / Metal 3. Metal 4 APIs require minimum deployment target updates for future devices.

---

## Appendix J: Qwen3.5-VL Cross-Platform Architecture Reference

Reference material from the Qwen3.5-VL cross-platform analysis. Included here for completeness — primary platforms are Android Adreno/Mali; Metal is secondary in that analysis.

### J.1 Evidence Corrections

The older Phase 1 and Phase 2 reports are still useful for platform timing but their Vulkan root-cause conclusions are stale.

| Earlier claim | Current status | Superseding evidence |
|---|---|---|
| Vulkan garbled VLM output caused by CLIP/mmproj corruption | Superseded | `VULKAN_DEBUG_HANDOFF.md`: isolated Vulkan mmproj is good; coherent fix is two Qwen3.5 text SSM CPU fallbacks |
| Text-only Vulkan is fine, decoder path not involved | Superseded nuance | Text-only tests did not exercise SSM tensor shapes from image-token prompt |
| `check 584` Q5_K matmul drift is primary shader bug | Superseded | Confirmed garble-causing failures are checks 590 and 593 |

### J.2 Platform Bottlenecks (Cross-Platform)

| Platform | Best backend | Bottleneck |
|---|---|---|
| Adreno 830 | OpenCL | Production-ready; optimize TTFT and decode overhead |
| Mali-G715 | Vulkan | Needs two SSM Vulkan kernel fixes + mmproj TTFT |
| iOS / Apple | Metal | Reference for fusion and memory layout; iOS secondary |

### J.3 Recommended Build Profiles (Android)

| Profile | Target | Key Flags | Recommendation |
|---|---|---|---|
| Adreno production | Samsung S25 | GGML_OPENCL=ON, GGML_OPENCL_USE_ADRENO_KERNELS=ON | OpenCL default; CPU fallback for unsupported ops |
| Mali Vulkan production | Pixel 9 | GGML_VULKAN=ON, CHECK_RESULTS=OFF | `--device Vulkan0 --op-offload` with two CPU fallback guards |
| CPU optimized fallback | All ARM64 | GGML_OPENMP=ON, GGML_CPU_KLEIDIAI=ON | Correctness fallback and benchmark baseline |

### J.4 Ranked Phase 3 Recommendations (Cross-Platform)

1. Fix two Qwen3.5 SSM Vulkan kernels on Mali (`q8_0×f32` small-M matmul + SSM `RMS_NORM`)
2. Optimize Qwen3VL mmproj patch embedding + vision FFN kernels (Mali Vulkan, Adreno OpenCL)
3. Keep Adreno on OpenCL; invest in Adreno-specific Qwen3.5/VLM kernels
4. Add SSM graph fusions (alpha+softplus+mul, SSM_CONV+SILU, gated RMS_NORM)
5. Run quantization sweeps for mmproj and SSM projections (FP16/Q8/Q5 before Q4)

---

## Appendix K: Advanced KV Cache Strategies

KV cache optimization is the highest-impact remaining lever for memory-constrained deployment (iPhone 16e has only ~1.9 GB free with Gemma4 loaded).

**Tier 1 — Immediate (llama.cpp native, addon config change):**
- `--cache-type-k q4_0 --cache-type-v q4_0` — 75% KV memory reduction. Qwen3.5 hybrid models reported token-identical at Q4_0 KV. Symmetric types enable fused Flash Attention path.
- Per-head adaptive quantization ([llama.cpp #21385](https://github.com/ggml-org/llama.cpp/issues/21385)): Bottom 2% of heads by entropy contribute disproportionately to quantization error. Not yet merged.
- TurboQuant ([llama.cpp #20969](https://github.com/ggml-org/llama.cpp/discussions/20969)): WHT rotation for extreme KV compression. Qwen3.5 advantage: only 6/24 layers have KV cache.

**Tier 2 — Medium-term (upstream/fork):**
- Open-TQ-Metal ([arxiv 2604.16957](https://arxiv.org/abs/2604.16957)): Fused compressed-domain attention on Apple Silicon. Quantizes KV to INT4 on-the-fly, computes attention directly on compressed representation. Enables 128K-context for 70B on 64GB Mac.

**Tier 3 — Research (VLM-specific):**
- AKVQ-VL ([arxiv 2501.15021](https://arxiv.org/abs/2501.15021)): Attention-aware KV cache adaptive 2-bit quantization. 2.13× peak memory reduction, 3.25× batch size increase.
- Q Cache ([arxiv 2602.01901](https://arxiv.org/abs/2602.01901)): Visual attention valuable in less than half of decode layers. Complementary to KV quantization.
