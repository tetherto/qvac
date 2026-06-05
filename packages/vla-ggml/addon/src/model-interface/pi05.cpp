#ifndef _WIN32
#define _FILE_OFFSET_BITS 64
#endif

#include "model-interface/pi05.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <ggml.h>
#include <gguf.h>

#include "model-interface/gguf_helpers.hpp"
#include "utils/BackendSelection.hpp"
#include "utils/LoggingMacros.hpp"

// Short alias so the QLOG_IF priorities read the same here as in
// smolvla.cpp / BackendSelection.cpp.
using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

namespace qvac_lib_infer_vla_ggml {

// Cast a tensor to F32 if it isn't already. ggml's CPU backend rejects
// `ggml_add`/`ggml_mul` between F32 and F16 directly, so any weight stored
// at lower precision in the GGUF (bias, pos_embed, etc.) has to be
// promoted on the graph side before participating in arithmetic with an
// F32 activation. Mirrors `smolvla.cpp::to_f32`.
static struct ggml_tensor*
toF32(struct ggml_context* ctx, struct ggml_tensor* x) {
  if (x != nullptr && x->type != GGML_TYPE_F32) {
    return ggml_cast(ctx, x, GGML_TYPE_F32);
  }
  return x;
}

// ── M3.1: SigLIP patch + position embed ──────────────────────────────────
Pi05PatchPosOutputs pi05BuildSiglipPatchPosGraph(
    struct ggml_context* ctx, struct ggml_tensor* pixelValues,
    struct ggml_tensor* patchEmbedW, struct ggml_tensor* patchEmbedB,
    struct ggml_tensor* posEmbed, int patchSize) {
  Pi05PatchPosOutputs out{nullptr, nullptr};
  if (ctx == nullptr || pixelValues == nullptr || patchEmbedW == nullptr ||
      posEmbed == nullptr) {
    return out;
  }

  // ggml_conv_2d(stride_w, stride_h, pad_w, pad_h, dil_w, dil_h). SigLIP-
  // So400m/14 uses a 14×14 patch with no padding and stride = patch size,
  // matching PyTorch's `Conv2d(3, 1152, kernel_size=14, stride=14)`.
  struct ggml_tensor* x = ggml_conv_2d(
      ctx, patchEmbedW, pixelValues, patchSize, patchSize, 0, 0, 1, 1);

  // Conv2d output is (W_out, H_out, C_out, N). Flatten the spatial dims
  // into a single "patch" axis (16*16 = 256) and the channels (1152) stay
  // along the fast dim — so the resulting tensor's ne=[C_out, n_patches].
  // That matches the byte layout of numpy's (n_patches, C_out) row-major
  // array, which is what the PyTorch reference stores.
  const int nPatches = static_cast<int>(x->ne[0]) * static_cast<int>(x->ne[1]);
  const int hidden = static_cast<int>(x->ne[2]);

  // Reshape (W, H, C, 1) → (n_patches, C) — note: in ggml, dim 0 is the
  // fastest axis, so we put n_patches first to keep (W,H) flattened in
  // memory order. Then transpose to put C on the fast axis so the bias
  // (which has shape (C,)) broadcasts across the slow axis (patches),
  // which is the only direction ggml_add supports without an explicit
  // repeat.
  x = ggml_reshape_2d(ctx, x, nPatches, hidden);
  x = ggml_cont(ctx, ggml_transpose(ctx, x));

  if (patchEmbedB != nullptr) {
    // Conv2d in PyTorch fuses bias into the convolution output. We add
    // it post-reshape; numerically identical for an additive bias.
    // The bias is stored F16 in the GGUF — promote on-graph so the F32
    // conv output and the bias share a dtype.
    x = ggml_add(ctx, x, toF32(ctx, patchEmbedB));
  }

  // Parity gate #1 from plan §5: `vision.patch_embed_out[cam_i]`.
  out.patch_embed_out = x;

  // pos_embed is laid out as (C=1152, n_patches=256) in ggml (the GGUF
  // converter writes it as numpy (n_patches, C), which the ggml loader
  // re-interprets with the last numpy dim as the fast ggml dim). It's
  // stored F16; promote before the add for the same reason as the bias.
  out.pos_embed_out = ggml_add(ctx, x, toF32(ctx, posEmbed));
  return out;
}

// ── Small shared helpers, mirrored from smolvla.cpp's static defs ────────
// LayerNorm with weight + bias.
static struct ggml_tensor* pi05LayerNorm(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    struct ggml_tensor* bias, float eps) {
  x = ggml_norm(ctx, x, eps);
  if (weight != nullptr) {
    x = ggml_mul(ctx, x, toF32(ctx, weight));
  }
  if (bias != nullptr) {
    x = ggml_add(ctx, x, toF32(ctx, bias));
  }
  return x;
}

// Linear: y = x @ W^T (+ b). ggml_mul_mat takes (weight, input) and
// produces (out_features, ...) so the caller treats `x` as (..., in_feat).
static struct ggml_tensor* pi05Linear(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    struct ggml_tensor* bias) {
  struct ggml_tensor* out = ggml_mul_mat(ctx, weight, x);
  if (bias != nullptr) {
    out = ggml_add(ctx, out, toF32(ctx, bias));
  }
  return out;
}

// ── M3.2: one SigLIP transformer block ──────────────────────────────────
struct ggml_tensor* pi05BuildSiglipBlockGraph(
    struct ggml_context* ctx, struct ggml_tensor* x,
    const Pi05SiglipBlockWeights& w, int nPatches, int hidden, int nHeads,
    float layerNormEps) {
  if (ctx == nullptr || x == nullptr) {
    return nullptr;
  }
  // Reject missing required tensors up front — the caller is the test
  // harness, which prefers a nullptr return over an undiagnosable
  // crash deep in the graph executor.
  if (w.ln1_w == nullptr || w.ln1_b == nullptr || w.ln2_w == nullptr ||
      w.ln2_b == nullptr || w.attn_q_w == nullptr || w.attn_q_b == nullptr ||
      w.attn_k_w == nullptr || w.attn_k_b == nullptr || w.attn_v_w == nullptr ||
      w.attn_v_b == nullptr || w.attn_out_w == nullptr ||
      w.attn_out_b == nullptr || w.fc1_w == nullptr || w.fc1_b == nullptr ||
      w.fc2_w == nullptr || w.fc2_b == nullptr) {
    return nullptr;
  }
  if (nHeads <= 0 || hidden <= 0 || hidden % nHeads != 0) {
    return nullptr;
  }
  const int headDim = hidden / nHeads;

  // ── Pre-attention LayerNorm + MHSA + residual ───────────────────────
  struct ggml_tensor* residual = x;
  struct ggml_tensor* h = pi05LayerNorm(ctx, x, w.ln1_w, w.ln1_b, layerNormEps);

  struct ggml_tensor* q = pi05Linear(ctx, h, w.attn_q_w, w.attn_q_b);
  struct ggml_tensor* k = pi05Linear(ctx, h, w.attn_k_w, w.attn_k_b);
  struct ggml_tensor* v = pi05Linear(ctx, h, w.attn_v_w, w.attn_v_b);

  // Reshape (hidden, n_patches) → (head_dim, n_heads, n_patches).
  q = ggml_reshape_3d(ctx, q, headDim, nHeads, nPatches);
  k = ggml_reshape_3d(ctx, k, headDim, nHeads, nPatches);
  v = ggml_reshape_3d(ctx, v, headDim, nHeads, nPatches);

  // Permute to (head_dim, n_patches, n_heads) so ggml_mul_mat sees each
  // head as an independent (n_patches × head_dim) matmul.
  q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

  // Scaled dot-product attention: softmax(Q K^T / sqrt(d)) V.
  // ggml_mul_mat(k, q) → (n_patches, n_patches, n_heads).
  struct ggml_tensor* logits = ggml_mul_mat(ctx, k, q);
  struct ggml_tensor* attn = ggml_soft_max_ext(
      ctx,
      logits,
      nullptr,
      1.0f / std::sqrt(static_cast<float>(headDim)),
      0.0f);
  // (head_dim, n_patches, n_heads): transpose v to (n_patches, head_dim,
  // n_heads) then mul_mat with the (n_patches, n_patches, n_heads) attn.
  struct ggml_tensor* attnOut =
      ggml_mul_mat(ctx, ggml_cont(ctx, ggml_transpose(ctx, v)), attn);
  // Back to (hidden, n_patches).
  attnOut = ggml_cont(ctx, ggml_permute(ctx, attnOut, 0, 2, 1, 3));
  attnOut = ggml_reshape_2d(ctx, attnOut, hidden, nPatches);

  // Output projection + residual.
  struct ggml_tensor* proj =
      pi05Linear(ctx, attnOut, w.attn_out_w, w.attn_out_b);
  h = ggml_add(ctx, proj, residual);

  // ── Post-attention LayerNorm + MLP + residual ───────────────────────
  residual = h;
  h = pi05LayerNorm(ctx, h, w.ln2_w, w.ln2_b, layerNormEps);
  h = pi05Linear(ctx, h, w.fc1_w, w.fc1_b);
  // HF SigLIP uses GELU (default activation in SiglipMLP for the So400m
  // checkpoint). ggml_gelu is the tanh approximation, which matches
  // pytorch's `nn.functional.gelu(approximate="tanh")` to within F32
  // rounding noise.
  h = ggml_gelu(ctx, h);
  h = pi05Linear(ctx, h, w.fc2_w, w.fc2_b);
  return ggml_add(ctx, h, residual);
}

// ── M3.3: full SigLIP-So400m/14 vision tower ────────────────────────────
Pi05VisionTowerOutputs pi05BuildSiglipTowerGraph(
    struct ggml_context* ctx, struct ggml_tensor* pixelValues,
    const Pi05VisionTowerWeights& w, int nPatches, int hidden, int projDim,
    int nHeads, int patchSize, float layerNormEps) {
  Pi05VisionTowerOutputs out{nullptr};
  if (ctx == nullptr || pixelValues == nullptr || w.blocks.empty() ||
      w.post_ln_w == nullptr || w.post_ln_b == nullptr || w.head_w == nullptr ||
      w.head_b == nullptr) {
    return out;
  }

  // Patch + pos embed (M3.1).
  Pi05PatchPosOutputs pp = pi05BuildSiglipPatchPosGraph(
      ctx,
      pixelValues,
      w.patch_embed_w,
      w.patch_embed_b,
      w.pos_embed,
      patchSize);
  if (pp.pos_embed_out == nullptr) {
    return out;
  }
  struct ggml_tensor* x = pp.pos_embed_out;

  // Transformer stack (M3.2 × N).
  for (const auto& bw : w.blocks) {
    x = pi05BuildSiglipBlockGraph(
        ctx, x, bw, nPatches, hidden, nHeads, layerNormEps);
    if (x == nullptr) {
      return out;
    }
  }

  // Post-LayerNorm — the LeRobot SigLIP wrapper applies this
  // immediately before the head Linear; HF naming is
  // `vision_model.post_layernorm`.
  x = pi05LayerNorm(ctx, x, w.post_ln_w, w.post_ln_b, layerNormEps);

  // "Connector" head — Linear(hidden → proj_dim). For pi05_base this
  // is the `_siglip.Module(num_classes=2048, pool_type="none")` head,
  // i.e. just a single Linear, no pixel-shuffle (plan §2).
  out.head_out = pi05Linear(ctx, x, w.head_w, w.head_b);
  (void)projDim; // shape is inferred from head_w — kept in the signature
                 //  for documentation + caller-side sanity-checking.
  return out;
}

// ── M3.4: PaliGemma token embedder + sqrt(hidden) scaling ────────────────
struct ggml_tensor* pi05BuildVlmEmbedGraph(
    struct ggml_context* ctx, struct ggml_tensor* tokens,
    struct ggml_tensor* embedTokens, int hidden) {
  if (ctx == nullptr || tokens == nullptr || embedTokens == nullptr) {
    return nullptr;
  }
  // Embedding lookup: row[i] = embed_tokens[tokens[i]]. ggml_get_rows
  // produces ne=[hidden, n_tokens] (it picks columns of the I32 indices
  // out of `embed_tokens` whose ne=[hidden, vocab]).
  struct ggml_tensor* e = ggml_get_rows(ctx, embedTokens, tokens);
  // Gemma-1 embedding scale. Pre-norm RMSNorm divides by sqrt(mean(x²)),
  // so without this scale every block sees inputs ≈ 1/sqrt(hidden)
  // smaller than the checkpoint expects.
  const float scale = std::sqrt(static_cast<float>(hidden));
  return ggml_scale(ctx, e, scale);
}

// Gemma-1 RMSNorm: `(1 + scale) * normed`. The GGUF converter
// copies the raw PyTorch tensor as `.scale`, so the `+1` happens
// here on the graph side. We compute `normed * scale + normed` to
// avoid needing a one-tensor.
static struct ggml_tensor* pi05GemmaRmsNorm(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* scale,
    float eps) {
  struct ggml_tensor* normed = ggml_rms_norm(ctx, x, eps);
  if (scale == nullptr) {
    return normed;
  }
  struct ggml_tensor* scaleF32 = toF32(ctx, scale);
  // (1 + scale) * normed = normed + normed * scale
  return ggml_add(ctx, normed, ggml_mul(ctx, normed, scaleF32));
}

// ── M3.5: one Gemma-1 VLM block ─────────────────────────────────────────
struct ggml_tensor* pi05BuildGemmaVlmBlockGraph(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* positions, struct ggml_tensor* attnMask,
    const Pi05GemmaBlockWeights& w, int hidden, int nHeads, int nKvHeads,
    int headDim, int seqLen, float rmsNormEps, float ropeFreqBase,
    struct ggml_tensor** outKPostRope, struct ggml_tensor** outV) {
  if (ctx == nullptr || x == nullptr || positions == nullptr ||
      w.pre_attn_norm_scale == nullptr || w.attn_q_w == nullptr ||
      w.attn_k_w == nullptr || w.attn_v_w == nullptr || w.attn_o_w == nullptr ||
      w.pre_ffw_norm_scale == nullptr || w.mlp_gate_w == nullptr ||
      w.mlp_up_w == nullptr || w.mlp_down_w == nullptr) {
    return nullptr;
  }

  // ── Pre-attn RMSNorm ───────────────────────────────────────────────
  struct ggml_tensor* residual = x;
  struct ggml_tensor* h =
      pi05GemmaRmsNorm(ctx, x, w.pre_attn_norm_scale, rmsNormEps);

  // ── Q, K, V projections (Gemma-1 has no attn bias) ────────────────
  struct ggml_tensor* q = pi05Linear(ctx, h, w.attn_q_w, nullptr);
  struct ggml_tensor* k = pi05Linear(ctx, h, w.attn_k_w, nullptr);
  struct ggml_tensor* v = pi05Linear(ctx, h, w.attn_v_w, nullptr);

  // Reshape to per-head views. MQA: Q is split into n_heads, K/V into
  // n_kv_heads (1 for pi05). ggml broadcasts the kv-head dim against
  // the q-head dim when n_kv_heads < n_heads.
  q = ggml_reshape_3d(ctx, q, headDim, nHeads, seqLen);
  k = ggml_reshape_3d(ctx, k, headDim, nKvHeads, seqLen);
  v = ggml_reshape_3d(ctx, v, headDim, nKvHeads, seqLen);

  // RoPE on Q and K (NEOX style, Gemma-1 freq_base = 10000). Per-head
  // — ggml_rope_ext walks the seq dim using `positions`.
  const int nRot = headDim;
  const int ropeMode = GGML_ROPE_TYPE_NEOX;
  q = ggml_rope_ext(
      ctx,
      q,
      positions,
      /*freq_factors=*/nullptr,
      nRot,
      ropeMode,
      /*n_ctx_orig=*/0,
      ropeFreqBase,
      /*freq_scale=*/1.0f,
      /*ext_factor=*/0.0f,
      /*attn_factor=*/1.0f,
      /*beta_fast=*/32.0f,
      /*beta_slow=*/1.0f);
  k = ggml_rope_ext(
      ctx,
      k,
      positions,
      /*freq_factors=*/nullptr,
      nRot,
      ropeMode,
      /*n_ctx_orig=*/0,
      ropeFreqBase,
      /*freq_scale=*/1.0f,
      /*ext_factor=*/0.0f,
      /*attn_factor=*/1.0f,
      /*beta_fast=*/32.0f,
      /*beta_slow=*/1.0f);

  // Permute to (head_dim, seq, heads) — the layout ggml_mul_mat
  // consumes per-head as independent (seq × head_dim) batches.
  q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

  // Expose post-RoPE K/V to callers that want to cache them for the
  // expert path's joint attention. Layout is ne=[head_dim, seq,
  // n_kv_heads] — identical to what `pi05BuildExpertBlockGraph`
  // accepts as cached_k/cached_v. `ggml_set_output` is critical: it
  // prevents `ggml_gallocr` from reusing the K/V buffers after their
  // last in-graph consumer (the joint softmax / attn matmul), which
  // would otherwise corrupt them by the time the caller reads back via
  // `ggml_backend_tensor_get`.
  if (outKPostRope != nullptr) {
    ggml_set_output(k);
    *outKPostRope = k;
  }
  if (outV != nullptr) {
    ggml_set_output(v);
    *outV = v;
  }

  // Attention: softmax(K^T · Q / sqrt(head_dim) + mask) · V.
  // mul_mat(K, Q) broadcasts K's kv_heads=1 across Q's n_heads=8.
  struct ggml_tensor* logits = ggml_mul_mat(ctx, k, q);
  const float scale = 1.0f / std::sqrt(static_cast<float>(headDim));
  struct ggml_tensor* attn =
      ggml_soft_max_ext(ctx, logits, attnMask, scale, /*max_bias=*/0.0f);
  // V^T: (n_patches, head_dim, n_kv_heads). mul_mat with attn (n_k, n_q,
  // n_heads) → (head_dim, n_q, n_heads).
  struct ggml_tensor* attnOut =
      ggml_mul_mat(ctx, ggml_cont(ctx, ggml_transpose(ctx, v)), attn);
  // Back to (hidden, seq_q).
  attnOut = ggml_cont(ctx, ggml_permute(ctx, attnOut, 0, 2, 1, 3));
  attnOut = ggml_reshape_2d(ctx, attnOut, hidden, seqLen);

  // O proj + residual.
  struct ggml_tensor* proj = pi05Linear(ctx, attnOut, w.attn_o_w, nullptr);
  h = ggml_add(ctx, proj, residual);

  // ── Pre-FFW RMSNorm + GeGLU MLP + residual ────────────────────────
  residual = h;
  h = pi05GemmaRmsNorm(ctx, h, w.pre_ffw_norm_scale, rmsNormEps);
  struct ggml_tensor* gate = pi05Linear(ctx, h, w.mlp_gate_w, nullptr);
  struct ggml_tensor* up = pi05Linear(ctx, h, w.mlp_up_w, nullptr);
  // GeGLU: gelu(gate) * up. ggml_gelu is the tanh approximation —
  // matches PyTorch's `gelu_pytorch_tanh` (lerobot pi05 hidden_act).
  gate = ggml_gelu(ctx, gate);
  struct ggml_tensor* ff = ggml_mul(ctx, gate, up);
  struct ggml_tensor* down = pi05Linear(ctx, ff, w.mlp_down_w, nullptr);
  return ggml_add(ctx, down, residual);
}

// ── M3.6: full VLM prefill (18 blocks + final RMSNorm) ──────────────────
struct ggml_tensor* pi05BuildVlmPrefillGraph(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* positions, struct ggml_tensor* attnMask,
    const std::vector<Pi05GemmaBlockWeights>& blocks,
    struct ggml_tensor* finalNormScale, int hidden, int nHeads, int nKvHeads,
    int headDim, int seqLen, float rmsNormEps, float ropeFreqBase,
    std::vector<struct ggml_tensor*>* outKeys,
    std::vector<struct ggml_tensor*>* outValues) {
  if (ctx == nullptr || x == nullptr || positions == nullptr ||
      blocks.empty() || finalNormScale == nullptr) {
    return nullptr;
  }
  if (outKeys != nullptr) {
    outKeys->assign(blocks.size(), nullptr);
  }
  if (outValues != nullptr) {
    outValues->assign(blocks.size(), nullptr);
  }
  struct ggml_tensor* h = x;
  for (size_t i = 0; i < blocks.size(); ++i) {
    struct ggml_tensor* kOut = nullptr;
    struct ggml_tensor* vOut = nullptr;
    h = pi05BuildGemmaVlmBlockGraph(
        ctx,
        h,
        positions,
        attnMask,
        blocks[i],
        hidden,
        nHeads,
        nKvHeads,
        headDim,
        seqLen,
        rmsNormEps,
        ropeFreqBase,
        (outKeys != nullptr) ? &kOut : nullptr,
        (outValues != nullptr) ? &vOut : nullptr);
    if (h == nullptr) {
      return nullptr;
    }
    if (outKeys != nullptr) {
      (*outKeys)[i] = kOut;
    }
    if (outValues != nullptr) {
      (*outValues)[i] = vOut;
    }
  }
  return pi05GemmaRmsNorm(ctx, h, finalNormScale, rmsNormEps);
}

// ── M3.7a: sin-cos time embedding ───────────────────────────────────────
//
// Reference: openpi `create_sinusoidal_pos_embedding`
// (lerobot/pi05/modeling_pi05.py:81). The reference computes
// internally in float64 and casts the output to F32; we do the same
// to avoid F32 cancellation between `t / period` and
// `2π · t / period` at the tiniest periods (4 ms × 1 → tens of
// thousands of radians, where F32 loses precision).
void pi05ComputeTimeSincos(
    float t, int dim, float minPeriod, float maxPeriod, float* out) {
  if (out == nullptr || dim <= 0 || (dim & 1) != 0) {
    return;
  }
  const int n = dim / 2;
  const double td = static_cast<double>(t);
  const double logMin = std::log(static_cast<double>(minPeriod));
  const double logMax = std::log(static_cast<double>(maxPeriod));
  const double twoPi = 2.0 * 3.14159265358979323846;
  for (int i = 0; i < n; ++i) {
    const double fraction =
        (n > 1) ? (static_cast<double>(i) / static_cast<double>(n - 1)) : 0.0;
    const double period = std::exp(logMin + fraction * (logMax - logMin));
    const double phase = (twoPi / period) * td;
    out[i] = static_cast<float>(std::sin(phase));
    out[n + i] = static_cast<float>(std::cos(phase));
  }
}

// ── M3.7b: MLP + swish chain ────────────────────────────────────────────
struct ggml_tensor* pi05BuildTimeMlpGraph(
    struct ggml_context* ctx, struct ggml_tensor* timeEmb,
    struct ggml_tensor* timeMlpInW, struct ggml_tensor* timeMlpInB,
    struct ggml_tensor* timeMlpOutW, struct ggml_tensor* timeMlpOutB) {
  if (ctx == nullptr || timeEmb == nullptr || timeMlpInW == nullptr ||
      timeMlpInB == nullptr || timeMlpOutW == nullptr ||
      timeMlpOutB == nullptr) {
    return nullptr;
  }
  // Linear → SiLU → Linear → SiLU. SiLU is swish (x * sigmoid(x)) —
  // openpi uses `nn.swish` which is JAX's alias for SiLU; ggml_silu
  // matches.
  struct ggml_tensor* h = pi05Linear(ctx, timeEmb, timeMlpInW, timeMlpInB);
  h = ggml_silu(ctx, h);
  h = pi05Linear(ctx, h, timeMlpOutW, timeMlpOutB);
  h = ggml_silu(ctx, h);
  return h;
}

// ── M3.8: adaRMSNorm split (scale, shift, gate) ─────────────────────────
Pi05AdaSplit pi05BuildAdarmsSplitGraph(
    struct ggml_context* ctx, struct ggml_tensor* cond,
    struct ggml_tensor* adaDenseW, struct ggml_tensor* adaDenseB, int hidden) {
  Pi05AdaSplit out{nullptr, nullptr, nullptr};
  if (ctx == nullptr || cond == nullptr || adaDenseW == nullptr ||
      adaDenseB == nullptr || hidden <= 0) {
    return out;
  }
  // modulation = cond @ W^T + b  →  (3*hidden,)
  struct ggml_tensor* mod = pi05Linear(ctx, cond, adaDenseW, adaDenseB);
  // Chunk into three contiguous (hidden,) slices. `mod` is 1-D
  // (ne[0] = 3*hidden), so a 1-D view with the right offset suffices.
  const size_t es = ggml_element_size(mod);
  out.scale = ggml_view_1d(ctx, mod, hidden, /*offset=*/0);
  out.shift = ggml_view_1d(ctx, mod, hidden, /*offset=*/hidden * es);
  out.gate = ggml_view_1d(ctx, mod, hidden, /*offset=*/2 * hidden * es);
  return out;
}

// ── adaRMSNorm application: `(1 + ada_scale) * rms_norm(x) + ada_shift` ─
// Per openpi/gemma.py:130. The base `.scale` weight is *not* used in the
// adaptive branch (the formula doesn't reference it). For pi05_base the
// converter writes that weight as zeros anyway — see the rationale in
// `_optional_pt_keys_with_shape` in convert_pi05_to_gguf.py.
static struct ggml_tensor* pi05AdarmsApply(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* adaScale, struct ggml_tensor* adaShift, float eps) {
  struct ggml_tensor* normed = ggml_rms_norm(ctx, x, eps);
  // normed * (1 + ada_scale) = normed + normed * ada_scale
  struct ggml_tensor* s =
      ggml_add(ctx, normed, ggml_mul(ctx, normed, adaScale));
  return ggml_add(ctx, s, adaShift);
}

// ── M3.9: one expert block (Gemma-1 300M) with joint attention ──────────
struct ggml_tensor* pi05BuildExpertBlockGraph(
    struct ggml_context* ctx, struct ggml_tensor* xExp,
    struct ggml_tensor* actPositions, struct ggml_tensor* cachedK,
    struct ggml_tensor* cachedV, struct ggml_tensor* cond,
    const Pi05ExpertBlockWeights& w, int expertHidden, int nHeads, int nKvHeads,
    int headDim, int prefixLen, int nAct, float rmsNormEps,
    float ropeFreqBase) {
  if (ctx == nullptr || xExp == nullptr || actPositions == nullptr ||
      cachedK == nullptr || cachedV == nullptr || cond == nullptr ||
      w.pre_attn_ada_w == nullptr || w.pre_attn_ada_b == nullptr ||
      w.pre_ffw_ada_w == nullptr || w.pre_ffw_ada_b == nullptr ||
      w.attn_q_w == nullptr || w.attn_k_w == nullptr || w.attn_v_w == nullptr ||
      w.attn_o_w == nullptr || w.mlp_gate_w == nullptr ||
      w.mlp_up_w == nullptr || w.mlp_down_w == nullptr) {
    return nullptr;
  }

  // ── Pre-attn adaRMSNorm + per-block ada split ──────────────────────
  Pi05AdaSplit a = pi05BuildAdarmsSplitGraph(
      ctx, cond, w.pre_attn_ada_w, w.pre_attn_ada_b, expertHidden);
  if (a.scale == nullptr) {
    return nullptr;
  }

  struct ggml_tensor* h =
      pi05AdarmsApply(ctx, xExp, a.scale, a.shift, rmsNormEps);

  // ── Q, K, V projections (Gemma-1 expert has no attn bias) ─────────
  struct ggml_tensor* q = pi05Linear(ctx, h, w.attn_q_w, nullptr);
  struct ggml_tensor* kExp = pi05Linear(ctx, h, w.attn_k_w, nullptr);
  struct ggml_tensor* vExp = pi05Linear(ctx, h, w.attn_v_w, nullptr);

  // Reshape to per-head layout. Q goes through 8-head expansion; K/V
  // stay at 1 head (MQA).
  q = ggml_reshape_3d(ctx, q, headDim, nHeads, nAct);
  kExp = ggml_reshape_3d(ctx, kExp, headDim, nKvHeads, nAct);
  vExp = ggml_reshape_3d(ctx, vExp, headDim, nKvHeads, nAct);

  // RoPE on Q and expert K (NEOX, base 10000 like the VLM). The
  // cached prefix K from the VLM was already RoPE-rotated at prefill
  // time and uses positions 0..prefix_len-1; the expert's positions
  // continue from there (act_positions).
  const int nRot = headDim;
  const int ropeMode = GGML_ROPE_TYPE_NEOX;
  q = ggml_rope_ext(
      ctx,
      q,
      actPositions,
      /*freq_factors=*/nullptr,
      nRot,
      ropeMode,
      0,
      ropeFreqBase,
      1.0f,
      0.0f,
      1.0f,
      32.0f,
      1.0f);
  kExp = ggml_rope_ext(
      ctx,
      kExp,
      actPositions,
      /*freq_factors=*/nullptr,
      nRot,
      ropeMode,
      0,
      ropeFreqBase,
      1.0f,
      0.0f,
      1.0f,
      32.0f,
      1.0f);

  // Permute Q/K/V to ggml's attention layout (head_dim, seq, heads).
  q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  kExp = ggml_cont(ctx, ggml_permute(ctx, kExp, 0, 2, 1, 3));
  vExp = ggml_cont(ctx, ggml_permute(ctx, vExp, 0, 2, 1, 3));

  // The cached prefix K/V is stored ne=[head_dim, prefix_len, n_kv_heads]
  // already — no permute needed, and tensors from ggml_new_tensor_3d +
  // ggml_backend_tensor_set are inherently contiguous.
  struct ggml_tensor* kCachedC = cachedK;
  struct ggml_tensor* vCachedC = cachedV;

  // Concatenate on the seq axis (ggml dim 1). Both halves are
  // ne=[head_dim, seq_*, n_kv_heads]; the joint K/V is
  // ne=[head_dim, prefix_len + n_act, n_kv_heads].
  struct ggml_tensor* kJoint = ggml_concat(ctx, kCachedC, kExp, /*dim=*/1);
  struct ggml_tensor* vJoint = ggml_concat(ctx, vCachedC, vExp, /*dim=*/1);

  // Joint softmax. mul_mat(K_joint, Q) broadcasts kv_heads=1 across
  // Q's n_heads=8, producing ne=[seq_k, seq_q, n_heads].
  struct ggml_tensor* logits = ggml_mul_mat(ctx, kJoint, q);
  const float scale = 1.0f / std::sqrt(static_cast<float>(headDim));
  struct ggml_tensor* attn = ggml_soft_max_ext(
      ctx, logits, /*mask=*/nullptr, scale, /*max_bias=*/0.0f);

  // V_joint^T then mul_mat with attn → ne=[head_dim, seq_q, n_heads].
  struct ggml_tensor* attnOut =
      ggml_mul_mat(ctx, ggml_cont(ctx, ggml_transpose(ctx, vJoint)), attn);
  // Back to (head_dim*n_heads, n_act) = (expert_q_dim, n_act). The
  // expert's o_proj reads (n_heads*head_dim, expert_hidden), so we
  // reshape to ne=[n_heads*head_dim, n_act].
  attnOut = ggml_cont(ctx, ggml_permute(ctx, attnOut, 0, 2, 1, 3));
  attnOut = ggml_reshape_2d(ctx, attnOut, nHeads * headDim, nAct);

  // O-proj + gated residual.
  struct ggml_tensor* proj = pi05Linear(ctx, attnOut, w.attn_o_w, nullptr);
  // Gated residual: x + ada_gate * proj  (per-channel multiply,
  // broadcasts the (expert_hidden,) gate across n_act).
  h = ggml_add(ctx, xExp, ggml_mul(ctx, proj, a.gate));

  // ── Pre-FFW adaRMSNorm + GeGLU MLP + gated residual ────────────────
  Pi05AdaSplit b = pi05BuildAdarmsSplitGraph(
      ctx, cond, w.pre_ffw_ada_w, w.pre_ffw_ada_b, expertHidden);
  if (b.scale == nullptr) {
    return nullptr;
  }
  struct ggml_tensor* normedFfw =
      pi05AdarmsApply(ctx, h, b.scale, b.shift, rmsNormEps);
  struct ggml_tensor* gate = pi05Linear(ctx, normedFfw, w.mlp_gate_w, nullptr);
  struct ggml_tensor* up = pi05Linear(ctx, normedFfw, w.mlp_up_w, nullptr);
  gate = ggml_gelu(ctx, gate);
  struct ggml_tensor* ff = ggml_mul(ctx, gate, up);
  struct ggml_tensor* down = pi05Linear(ctx, ff, w.mlp_down_w, nullptr);
  return ggml_add(ctx, h, ggml_mul(ctx, down, b.gate));
}

// ── M3.10: full expert pass (18 blocks + final adaRMSNorm + action_out) ─
Pi05ExpertODEStepOutputs pi05BuildExpertOdeStepGraph(
    struct ggml_context* ctx, struct ggml_tensor* xExp,
    struct ggml_tensor* actPositions,
    const std::vector<struct ggml_tensor*>& cachedK,
    const std::vector<struct ggml_tensor*>& cachedV, struct ggml_tensor* cond,
    const std::vector<Pi05ExpertBlockWeights>& blocks,
    struct ggml_tensor* finalNormAdaW, struct ggml_tensor* finalNormAdaB,
    struct ggml_tensor* actionOutProjW, struct ggml_tensor* actionOutProjB,
    int expertHidden, int nHeads, int nKvHeads, int headDim, int prefixLen,
    int nAct, float rmsNormEps, float ropeFreqBase) {
  Pi05ExpertODEStepOutputs out{nullptr, nullptr};
  if (ctx == nullptr || xExp == nullptr || actPositions == nullptr ||
      cond == nullptr || blocks.empty() || cachedK.size() != blocks.size() ||
      cachedV.size() != blocks.size() || finalNormAdaW == nullptr ||
      finalNormAdaB == nullptr || actionOutProjW == nullptr ||
      actionOutProjB == nullptr) {
    return out;
  }
  struct ggml_tensor* h = xExp;
  for (size_t i = 0; i < blocks.size(); ++i) {
    h = pi05BuildExpertBlockGraph(
        ctx,
        h,
        actPositions,
        cachedK[i],
        cachedV[i],
        cond,
        blocks[i],
        expertHidden,
        nHeads,
        nKvHeads,
        headDim,
        prefixLen,
        nAct,
        rmsNormEps,
        ropeFreqBase);
    if (h == nullptr) {
      return out;
    }
  }
  // Final adaRMSNorm — same modulation form as the per-block norms.
  Pi05AdaSplit fin = pi05BuildAdarmsSplitGraph(
      ctx, cond, finalNormAdaW, finalNormAdaB, expertHidden);
  if (fin.scale == nullptr) {
    return out;
  }
  out.final_out = pi05AdarmsApply(ctx, h, fin.scale, fin.shift, rmsNormEps);

  // action_out_proj — Linear(expert_hidden → action_dim).
  out.v_t = pi05Linear(ctx, out.final_out, actionOutProjW, actionOutProjB);
  return out;
}

// ── M3.11: explicit-Euler ODE step ──────────────────────────────────────
struct ggml_tensor* pi05BuildEulerStepGraph(
    struct ggml_context* ctx, struct ggml_tensor* xT, struct ggml_tensor* vT,
    float dt) {
  if (ctx == nullptr || xT == nullptr || vT == nullptr) {
    return nullptr;
  }
  return ggml_add(ctx, xT, ggml_scale(ctx, vT, dt));
}

// ─────────────────────────────────────────────────────────────────────────
// Production loader, inference, and Pi05Model wiring.
//
// The implementation composes the sub-graph helpers into a single
// `IVlaModel` entry point. Per-camera SigLIP towers, PaliGemma embedding
// lookup, VLM prefill with K/V taps, and the 10-step ODE loop all happen
// in a single `infer()` call.
//
// Known limitations:
//   * Backends: CPU and GPU (Vulkan/Metal/OpenCL) are supported, but
//     joint-attention shader compatibility varies by driver.
//   * Attention masks: the inference fast-path slices the prefix to its
//     leading-contiguous valid range and runs the VLM prefill /
//     joint-attn without a softmax mask. Same trick the M3.5/M3.6/M3.13
//     tests use. Holes in the middle of `lang_mask` are rejected up
//     front. Adding a proper additive attention mask is a follow-up.
//   * No mmap fast path. `gguf_init_from_file` with `no_alloc=false`
//     drops weights into a malloc'd `ggml_context`. Adds a few hundred
//     MB to the resident set vs the smolvla mmap path; not a blocker
//     for the desktop integration test, will revisit for mobile.
// ─────────────────────────────────────────────────────────────────────────

struct Pi05ModelInternal {
  // hparams (also mirrored into Pi05Model::hparams_)
  int vision_image_size = 224;
  int vision_patch_size = 14;
  int vision_n_patches = 256;
  int vision_n_layers = 27;
  int vision_hidden = 1152;
  int vision_n_heads = 16;
  int vision_proj_dim = 2048;
  float vision_layer_norm_eps = 1e-6f;

  int vlm_n_layers = 18;
  int vlm_hidden = 2048;
  int vlm_n_heads = 8;
  int vlm_n_kv_heads = 1;
  int vlm_head_dim = 256;
  int vlm_vocab_size = 257152;

  int expert_n_layers = 18;
  int expert_hidden = 1024;
  int expert_n_heads = 8;
  int expert_n_kv_heads = 1;
  int expert_head_dim = 256;

  int action_dim = 32;
  int action_horizon = 50;
  int max_token_len = 200;
  int num_cameras = 3;
  int cond_dim = 1024;
  int n_inference_steps = 10;
  float rms_norm_eps = 1e-6f;
  float rope_freq_base = 10000.0f;
  float min_period = 4e-3f;
  float max_period = 4.0f;

  // weight pointers — all owned by `ctx_w` below.
  struct ggml_tensor* vision_patch_embed_w = nullptr;
  struct ggml_tensor* vision_patch_embed_b = nullptr;
  struct ggml_tensor* vision_pos_embed = nullptr;
  std::vector<Pi05SiglipBlockWeights> vision_blocks;
  struct ggml_tensor* vision_post_ln_w = nullptr;
  struct ggml_tensor* vision_post_ln_b = nullptr;
  struct ggml_tensor* vision_head_w = nullptr;
  struct ggml_tensor* vision_head_b = nullptr;

  struct ggml_tensor* vlm_embed_tokens = nullptr;
  std::vector<Pi05GemmaBlockWeights> vlm_blocks;
  struct ggml_tensor* vlm_final_norm_w = nullptr;

  std::vector<Pi05ExpertBlockWeights> expert_blocks;
  struct ggml_tensor* expert_final_norm_ada_w = nullptr;
  struct ggml_tensor* expert_final_norm_ada_b = nullptr;

  struct ggml_tensor* action_in_w = nullptr;
  struct ggml_tensor* action_in_b = nullptr;
  struct ggml_tensor* action_out_w = nullptr;
  struct ggml_tensor* action_out_b = nullptr;
  struct ggml_tensor* time_mlp_in_w = nullptr;
  struct ggml_tensor* time_mlp_in_b = nullptr;
  struct ggml_tensor* time_mlp_out_w = nullptr;
  struct ggml_tensor* time_mlp_out_b = nullptr;

  // backends + memory
  struct gguf_context* gguf = nullptr;
  struct ggml_context* ctx_w = nullptr;
  ggml_backend_t backend = nullptr;
  ggml_backend_t backend_cpu = nullptr;
  bool has_gpu = false;
  std::string backend_name = "none";

  // Backend buffer(s) that own the weight tensor storage. Populated by
  // load_weights_alloc_copy after the backends are initialised; freed
  // before ctx_w in the destructor so any tensors they reference stay
  // valid through the free callback.
  std::vector<ggml_backend_buffer_t> bufs_w;

  ~Pi05ModelInternal() {
    // Free weight buffers FIRST — they reference ctx_w's tensors.
    for (ggml_backend_buffer_t buf : bufs_w) {
      if (buf != nullptr) {
        ggml_backend_buffer_free(buf);
      }
    }
    bufs_w.clear();
    // gguf next — owns the tensor metadata.
    if (gguf != nullptr) {
      gguf_free(gguf);
      gguf = nullptr;
    }
    if (ctx_w != nullptr) {
      ggml_free(ctx_w);
      ctx_w = nullptr;
    }
    // Only free the GPU backend if it's a distinct handle.
    if (backend != nullptr && backend != backend_cpu) {
      ggml_backend_free(backend);
    }
    if (backend_cpu != nullptr) {
      ggml_backend_free(backend_cpu);
    }
  }
};

namespace {

// ── Multi-backend graph scheduler helpers ─────────────────────────────────
// Cloned from smolvla.cpp's staged_graph pattern. The scheduler routes
// each op to the first backend that supports it — ops the GPU rejects
// (typically Conv2d on Adreno OpenCL / older Vulkan) auto-fall-back to
// CPU. On CPU-only configs we use the simpler gallocr path to avoid
// scheduler overhead.

struct Pi05StagedGraph {
  struct ggml_context* ctx = nullptr;
  struct ggml_cgraph* gf = nullptr;
  ggml_gallocr_t allocr = nullptr;
  ggml_backend_sched_t sched = nullptr;
};

static Pi05StagedGraph pi05BuildStaged(size_t ctxBytes, int maxNodes) {
  Pi05StagedGraph sg{};
  struct ggml_init_params params{ctxBytes, nullptr, /*no_alloc=*/true};
  sg.ctx = ggml_init(params);
  if (sg.ctx == nullptr)
    return sg;
  sg.gf = ggml_new_graph_custom(sg.ctx, maxNodes, false);
  return sg;
}

static bool pi05AllocStagedSimple(Pi05StagedGraph& sg, ggml_backend_t backend) {
  sg.allocr = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend));
  if (sg.allocr == nullptr)
    return false;
  return ggml_gallocr_alloc_graph(sg.allocr, sg.gf);
}

static bool pi05AllocStagedSched(
    Pi05StagedGraph& sg, ggml_backend_t gpu, ggml_backend_t cpu) {
  ggml_backend_t backends[] = {gpu, cpu};
  sg.sched = ggml_backend_sched_new(
      backends, nullptr, 2, GGML_DEFAULT_GRAPH_SIZE, false, true);
  if (sg.sched == nullptr)
    return false;
  return ggml_backend_sched_alloc_graph(sg.sched, sg.gf);
}

static bool pi05ComputeStaged(Pi05StagedGraph& sg, ggml_backend_t backend) {
  if (sg.sched != nullptr) {
    return ggml_backend_sched_graph_compute(sg.sched, sg.gf) ==
           GGML_STATUS_SUCCESS;
  }
  return ggml_backend_graph_compute(backend, sg.gf) == GGML_STATUS_SUCCESS;
}

static void pi05FreeStaged(Pi05StagedGraph& sg) {
  if (sg.sched != nullptr)
    ggml_backend_sched_free(sg.sched);
  if (sg.allocr != nullptr)
    ggml_gallocr_free(sg.allocr);
  if (sg.ctx != nullptr)
    ggml_free(sg.ctx);
  sg = {};
}

// RAII wrapper so the four graph-compute sites stay readable.
struct Pi05StagedGuard {
  Pi05StagedGraph sg;
  ~Pi05StagedGuard() { pi05FreeStaged(sg); }
};

// alloc+copy weight loader. Allocates a backend buffer of the right
// type for every tensor metadata in ctx_w, then reads each tensor's
// bytes from the GGUF file and copies into the buffer via
// ggml_backend_tensor_set. Direct port of smolvla.cpp's
// load_weights_alloc_copy, scoped to pi05's model struct.
//
// On CPU backends this still works (ggml_backend_alloc_ctx_tensors_from_buft
// produces a host-side buffer). On GPU backends (Vulkan / Metal / OpenCL)
// the buffer lives in device memory so the scheduler can run weighted
// ops directly without per-op host→device copies.
static bool pi05LoadWeightsAllocCopy(
    Pi05ModelInternal& m, const char* path, gguf_context* gguf,
    ggml_backend_buffer_type_t buft, size_t dataOffset,
    int64_t nTensorsInGguf) {
  size_t totalSize = 0;
  for (struct ggml_tensor* t = ggml_get_first_tensor(m.ctx_w); t != nullptr;
       t = ggml_get_next_tensor(m.ctx_w, t)) {
    totalSize += ggml_nbytes(t);
  }
  QLOG_IF(
      Priority::INFO,
      "pi05LoadModel: alloc+copy path, total weights " +
          std::to_string((int)(totalSize / (1024 * 1024))) + " MB");

  ggml_backend_buffer_t buf =
      ggml_backend_alloc_ctx_tensors_from_buft(m.ctx_w, buft);
  if (buf == nullptr) {
    const char* bname = ggml_backend_name(m.backend);
    QLOG_IF(
        Priority::ERROR,
        std::string(
            "pi05LoadModel: ggml_backend_alloc_ctx_tensors_from_buft "
            "FAILED for ") +
            std::to_string((int)(totalSize / (1024 * 1024))) +
            " MB on backend '" + (bname != nullptr ? bname : "?") + "'");
    return false;
  }
  ggml_backend_buffer_set_usage(buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
  m.bufs_w.push_back(buf);

  FILE* f = std::fopen(path, "rb");
  if (f == nullptr) {
    QLOG_IF(
        Priority::ERROR,
        std::string("pi05LoadModel: fopen failed for '") + path + "'");
    return false;
  }
  std::vector<uint8_t> readBuf;
  int nCopied = 0;
  for (int64_t i = 0; i < nTensorsInGguf; i++) {
    const char* name = gguf_get_tensor_name(gguf, i);
    struct ggml_tensor* t = ggml_get_tensor(m.ctx_w, name);
    if (t == nullptr) {
      continue;
    }
    size_t off = dataOffset + gguf_get_tensor_offset(gguf, i);
    size_t nbytes = ggml_nbytes(t);
    if (readBuf.size() < nbytes) {
      readBuf.resize(nbytes);
    }
#ifdef _WIN32
    int seekErr = _fseeki64(f, (int64_t)off, SEEK_SET);
#else
    int seekErr = fseeko(f, static_cast<off_t>(off), SEEK_SET);
#endif
    if (seekErr != 0 || std::fread(readBuf.data(), 1, nbytes, f) != nbytes) {
      QLOG_IF(
          Priority::ERROR,
          std::string("pi05LoadModel: failed to read tensor '") + name +
              "' at offset " + std::to_string(off));
      std::fclose(f);
      return false;
    }
    ggml_backend_tensor_set(t, readBuf.data(), 0, nbytes);
    nCopied++;
  }
  std::fclose(f);
  const char* bname = ggml_backend_name(m.backend);
  QLOG_IF(
      Priority::INFO,
      "pi05LoadModel: alloc+copy buffer ready, " + std::to_string(nCopied) +
          " tensors, backend='" + (bname != nullptr ? bname : "?") + "'");
  return true;
}

} // namespace

// pi05LoadModel — opens the GGUF, allocates backends, populates the
// model struct's tensor pointers. Throws std::runtime_error on any
// missing tensor or wrong architecture key.
static std::unique_ptr<Pi05ModelInternal> pi05LoadModel(
    const std::string& ggufPath, bool forceCpu,
    const std::string& backendsDir) {
  vla_backend_selection::loadBackendsOnce(backendsDir);
  auto m = std::make_unique<Pi05ModelInternal>();

  ggml_backend_dev_t cpuDev =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (cpuDev == nullptr) {
    throw std::runtime_error("pi05LoadModel: no CPU backend available");
  }
  m->backend_cpu = ggml_backend_dev_init(cpuDev, nullptr);
  if (m->backend_cpu == nullptr) {
    throw std::runtime_error("pi05LoadModel: failed to init CPU backend");
  }
  m->backend = m->backend_cpu;
  const char* cpuName = ggml_backend_name(m->backend_cpu);
  m->backend_name = cpuName != nullptr ? cpuName : "CPU";
  m->has_gpu = false;

  // Try to upgrade to a GPU device unless the caller forced CPU.
  // Failure here is non-fatal — we keep the CPU backend already wired
  // above. Adreno GPUs are filtered out by
  // vla_backend_selection::pickBestGpuDevice() so older Snapdragon
  // devices fall through to CPU rather than crash on
  // ggml_backend_dev_init. Mirrors smolvla.cpp::try_init_gpu_backend.
  if (!forceCpu) {
    ggml_backend_dev_t gpu = vla_backend_selection::pickBestGpuDevice();
    if (gpu != nullptr) {
      ggml_backend_t gpuBackend = ggml_backend_dev_init(gpu, nullptr);
      if (gpuBackend != nullptr) {
        m->backend = gpuBackend;
        m->has_gpu = true;
        const char* bname = ggml_backend_name(gpuBackend);
        const char* ddesc = ggml_backend_dev_description(gpu);
        m->backend_name = bname != nullptr ? bname : "gpu";
        QLOG_IF(
            Priority::INFO,
            std::string("pi05LoadModel: using GPU backend: ") +
                (bname != nullptr ? bname : "?") + " (" +
                (ddesc != nullptr ? ddesc : "?") + ")");
      } else {
        QLOG_IF(
            Priority::WARNING,
            "pi05LoadModel: ggml_backend_dev_init returned null; "
            "staying on CPU");
      }
    } else {
      QLOG_IF(Priority::INFO, "pi05LoadModel: no GPU device picked; using CPU");
    }
  } else {
    QLOG_IF(
        Priority::INFO,
        "pi05LoadModel: forceCpu=true — skipping GPU selection");
  }

  // GPU path: no_alloc=true so the GGUF loader doesn't mmap; we then
  // allocate a backend (device) buffer via pi05LoadWeightsAllocCopy
  // and read the weights into it. Required for GPU compute — without
  // it the scheduler would copy weights per-op every step.
  //
  // CPU path: no_alloc=false so gguf_init_from_file mmap's the file
  // and the tensors' `data` pointers point straight at the OS page
  // cache. Zero extra heap allocation, lazy paging, low resident
  // footprint. Critical for iOS pi05 — iPhone 16/17 have 8 GB RAM
  // and iOS jetsam kills foreground apps that hit ~3–4 GB resident.
  // The previous code path called pi05LoadWeightsAllocCopy
  // unconditionally, which allocated a CPU-heap buffer of ~4 GB
  // for the GGUF data even on CPU backend — that copy was tripping
  // the jetsam kill mid-load (confirmed via bare_console.log in run
  // 26285927725: app process died right after the sha256-verify
  // step, before any inference output).
  struct gguf_init_params gp{};
  gp.no_alloc = m->has_gpu;
  gp.ctx = &m->ctx_w;
  m->gguf = gguf_init_from_file(ggufPath.c_str(), gp);
  if (m->gguf == nullptr) {
    throw std::runtime_error(
        "pi05LoadModel: gguf_init_from_file failed for " + ggufPath);
  }

  const std::string arch = ggufGetStrOr(m->gguf, "general.architecture", "");
  if (arch != "pi05") {
    throw std::runtime_error(
        "pi05LoadModel: expected general.architecture=pi05, got '" + arch +
        "'");
  }

  // hparams (all keys per the converter's stamp_metadata).
  m->vision_image_size = ggufGetU32Or(m->gguf, "pi05.image_resolution", 224);
  m->vision_n_layers = ggufGetU32Or(m->gguf, "pi05.vision.num_layers", 27);
  m->vlm_n_layers = ggufGetU32Or(m->gguf, "pi05.vlm.num_layers", 18);
  m->vlm_hidden = ggufGetU32Or(m->gguf, "pi05.vlm.hidden_size", 2048);
  m->vlm_n_heads = ggufGetU32Or(m->gguf, "pi05.vlm.num_heads", 8);
  m->vlm_n_kv_heads = ggufGetU32Or(m->gguf, "pi05.vlm.num_kv_heads", 1);
  m->vlm_head_dim = ggufGetU32Or(m->gguf, "pi05.vlm.head_dim", 256);
  m->vlm_vocab_size = ggufGetU32Or(m->gguf, "pi05.vocab_size", 257152);
  m->expert_hidden = ggufGetU32Or(m->gguf, "pi05.expert.hidden_size", 1024);
  m->expert_n_layers = ggufGetU32Or(m->gguf, "pi05.expert.num_layers", 18);
  m->action_dim = ggufGetU32Or(m->gguf, "pi05.action_dim", 32);
  m->action_horizon = ggufGetU32Or(m->gguf, "pi05.action_horizon", 50);
  m->max_token_len = ggufGetU32Or(m->gguf, "pi05.max_token_len", 200);
  m->num_cameras = ggufGetU32Or(m->gguf, "pi05.num_cameras", 3);
  m->vision_n_patches = (m->vision_image_size / m->vision_patch_size) *
                        (m->vision_image_size / m->vision_patch_size);

  // Sanity-check hparams — reject zeros (division/scaling UB), unreasonable
  // upper bounds (OOM / integer overflow from crafted GGUFs), and
  // consistency constraints (head_dim compatibility, patch divisibility).
  if (m->vision_n_layers == 0 || m->vision_n_layers > 512 ||
      m->vlm_n_layers == 0 || m->vlm_n_layers > 512 ||
      m->expert_n_layers == 0 || m->expert_n_layers > 512 ||
      m->action_horizon == 0 || m->action_horizon > 1024 ||
      m->max_token_len == 0 || m->max_token_len > 8192 || m->num_cameras == 0 ||
      m->num_cameras > 16 || m->action_dim == 0 || m->action_dim > 512 ||
      m->vision_image_size == 0 || m->vision_image_size > 2048 ||
      m->expert_hidden == 0 || m->expert_hidden > 16384 || m->vlm_hidden == 0 ||
      m->vlm_n_heads == 0 || m->vlm_n_kv_heads == 0 || m->vlm_head_dim == 0 ||
      m->expert_n_heads == 0 || m->expert_n_kv_heads == 0 ||
      m->expert_head_dim == 0 || m->vlm_vocab_size == 0 ||
      m->vlm_vocab_size > 1048576 || m->vision_n_patches == 0 ||
      m->vision_image_size % m->vision_patch_size != 0 ||
      m->vlm_hidden % m->vlm_n_heads != 0 ||
      m->expert_hidden % m->expert_n_heads != 0) {
    throw std::runtime_error(
        "pi05LoadModel: one or more GGUF hparams are out of expected range");
  }

  // The ODE loop indexes k_cache (sized vlm_n_layers) with expert_n_layers.
  // Both are 18 for pi05_base; reject any checkpoint where they differ.
  if (m->vlm_n_layers != m->expert_n_layers) {
    throw std::runtime_error(
        "pi05LoadModel: vlm_n_layers (" + std::to_string(m->vlm_n_layers) +
        ") != expert_n_layers (" + std::to_string(m->expert_n_layers) +
        "); this implementation requires them to match");
  }

  // VLM prefill K/V cache is copied into expert-sized KV tensors. Reject
  // mismatched geometry to prevent buffer overflows.
  if (m->vlm_head_dim != m->expert_head_dim ||
      m->vlm_n_kv_heads != m->expert_n_kv_heads) {
    throw std::runtime_error(
        "pi05LoadModel: VLM/expert KV geometry mismatch (vlm_head_dim=" +
        std::to_string(m->vlm_head_dim) +
        " expert_head_dim=" + std::to_string(m->expert_head_dim) +
        " vlm_n_kv_heads=" + std::to_string(m->vlm_n_kv_heads) +
        " expert_n_kv_heads=" + std::to_string(m->expert_n_kv_heads) + ")");
  }

  // GPU only: allocate a backend buffer and copy the GGUF data into
  // it. Required for GPU compute — without it the tensors' `data`
  // pointers stay NULL (no_alloc=true) and graph_compute segfaults
  // the moment a kernel tries to read a weight. (skipping smolvla's
  // mmap+host_ptr fast path; that's a follow-up optimisation.)
  //
  // CPU only: NO buffer copy. `data` pointers are already valid from
  // the mmap path (no_alloc=false above). Allocating + copying here
  // would double the resident footprint and trip iOS jetsam on 8 GB
  // iPhones (see comment on `gp.no_alloc = m->has_gpu` above).
  //
  // NOTE: this runs BEFORE the tensor-pointer population below so the
  // CPU fallback (which frees and reopens ctx_w) doesn't leave any
  // m->vision_*/vlm_blocks/expert_blocks pointers dangling into a
  // freed context.
  if (m->has_gpu) {
    ggml_backend_buffer_type_t buft =
        ggml_backend_get_default_buffer_type(m->backend);
    const size_t dataOffset = gguf_get_data_offset(m->gguf);
    const int64_t nTensorsInGguf = gguf_get_n_tensors(m->gguf);
    if (!pi05LoadWeightsAllocCopy(
            *m, ggufPath.c_str(), m->gguf, buft, dataOffset, nTensorsInGguf)) {
      QLOG_IF(
          Priority::WARNING,
          "pi05LoadModel: GPU weight alloc failed — falling back to CPU");
      ggml_backend_free(m->backend);
      m->backend = m->backend_cpu;
      m->has_gpu = false;
      const char* cpuName = ggml_backend_name(m->backend_cpu);
      m->backend_name = cpuName != nullptr ? cpuName : "CPU";
      // Reopen GGUF with no_alloc=false so tensor data is mmap'd.
      gguf_free(m->gguf);
      ggml_free(m->ctx_w);
      m->ctx_w = nullptr;
      m->gguf = nullptr;
      struct gguf_init_params gp2{};
      gp2.no_alloc = false;
      gp2.ctx = &m->ctx_w;
      m->gguf = gguf_init_from_file(ggufPath.c_str(), gp2);
      if (m->gguf == nullptr) {
        throw std::runtime_error(
            "pi05LoadModel: gguf re-open for CPU fallback failed");
      }
    }
  }

  // Populate tensor pointers from the final (possibly fallback) ctx_w.
  auto mustGet = [&](const std::string& name) -> struct ggml_tensor* {
    struct ggml_tensor* t = ggml_get_tensor(m->ctx_w, name.c_str());
    if (t == nullptr) {
      throw std::runtime_error(
          "pi05LoadModel: tensor missing from GGUF: " + name);
    }
    return t;
  };

  // Vision
  m->vision_patch_embed_w = mustGet("vision.patch_embed.weight");
  m->vision_patch_embed_b = mustGet("vision.patch_embed.bias");
  m->vision_pos_embed = mustGet("vision.pos_embed");
  m->vision_post_ln_w = mustGet("vision.post_ln.weight");
  m->vision_post_ln_b = mustGet("vision.post_ln.bias");
  m->vision_head_w = mustGet("vision.head.weight");
  m->vision_head_b = mustGet("vision.head.bias");
  m->vision_blocks.resize(m->vision_n_layers);
  for (int i = 0; i < m->vision_n_layers; ++i) {
    const std::string b = "vision.blk." + std::to_string(i);
    auto& bw = m->vision_blocks[i];
    bw.ln1_w = mustGet(b + ".ln1.weight");
    bw.ln1_b = mustGet(b + ".ln1.bias");
    bw.attn_q_w = mustGet(b + ".attn_q.weight");
    bw.attn_q_b = mustGet(b + ".attn_q.bias");
    bw.attn_k_w = mustGet(b + ".attn_k.weight");
    bw.attn_k_b = mustGet(b + ".attn_k.bias");
    bw.attn_v_w = mustGet(b + ".attn_v.weight");
    bw.attn_v_b = mustGet(b + ".attn_v.bias");
    bw.attn_out_w = mustGet(b + ".attn_out.weight");
    bw.attn_out_b = mustGet(b + ".attn_out.bias");
    bw.ln2_w = mustGet(b + ".ln2.weight");
    bw.ln2_b = mustGet(b + ".ln2.bias");
    bw.fc1_w = mustGet(b + ".fc1.weight");
    bw.fc1_b = mustGet(b + ".fc1.bias");
    bw.fc2_w = mustGet(b + ".fc2.weight");
    bw.fc2_b = mustGet(b + ".fc2.bias");
  }

  // VLM
  m->vlm_embed_tokens = mustGet("vlm.embed_tokens");
  m->vlm_final_norm_w = mustGet("vlm.final_norm.scale");
  m->vlm_blocks.resize(m->vlm_n_layers);
  for (int i = 0; i < m->vlm_n_layers; ++i) {
    const std::string b = "vlm.blk." + std::to_string(i);
    auto& bw = m->vlm_blocks[i];
    bw.pre_attn_norm_scale = mustGet(b + ".pre_attn_norm.scale");
    bw.attn_q_w = mustGet(b + ".attn.q.weight");
    bw.attn_k_w = mustGet(b + ".attn.k.weight");
    bw.attn_v_w = mustGet(b + ".attn.v.weight");
    bw.attn_o_w = mustGet(b + ".attn.o.weight");
    bw.pre_ffw_norm_scale = mustGet(b + ".pre_ffw_norm.scale");
    bw.mlp_gate_w = mustGet(b + ".mlp.gate.weight");
    bw.mlp_up_w = mustGet(b + ".mlp.up.weight");
    bw.mlp_down_w = mustGet(b + ".mlp.down.weight");
  }

  // Expert
  m->expert_final_norm_ada_w = mustGet("expert.final_norm.ada.weight");
  m->expert_final_norm_ada_b = mustGet("expert.final_norm.ada.bias");
  m->expert_blocks.resize(m->expert_n_layers);
  for (int i = 0; i < m->expert_n_layers; ++i) {
    const std::string b = "expert.blk." + std::to_string(i);
    auto& bw = m->expert_blocks[i];
    bw.pre_attn_ada_w = mustGet(b + ".pre_attn_norm.ada.weight");
    bw.pre_attn_ada_b = mustGet(b + ".pre_attn_norm.ada.bias");
    bw.pre_ffw_ada_w = mustGet(b + ".pre_ffw_norm.ada.weight");
    bw.pre_ffw_ada_b = mustGet(b + ".pre_ffw_norm.ada.bias");
    bw.attn_q_w = mustGet(b + ".attn.q.weight");
    bw.attn_k_w = mustGet(b + ".attn.k.weight");
    bw.attn_v_w = mustGet(b + ".attn.v.weight");
    bw.attn_o_w = mustGet(b + ".attn.o.weight");
    bw.mlp_gate_w = mustGet(b + ".mlp.gate.weight");
    bw.mlp_up_w = mustGet(b + ".mlp.up.weight");
    bw.mlp_down_w = mustGet(b + ".mlp.down.weight");
  }

  // Projections
  m->action_in_w = mustGet("proj.action_in.weight");
  m->action_in_b = mustGet("proj.action_in.bias");
  m->action_out_w = mustGet("proj.action_out.weight");
  m->action_out_b = mustGet("proj.action_out.bias");
  m->time_mlp_in_w = mustGet("proj.time_mlp_in.weight");
  m->time_mlp_in_b = mustGet("proj.time_mlp_in.bias");
  m->time_mlp_out_w = mustGet("proj.time_mlp_out.weight");
  m->time_mlp_out_b = mustGet("proj.time_mlp_out.bias");

  return m;
}

// pi05Inference — composes M3.1 (vision per cam) + M3.4 (embedder)
// + M3.6 (VLM prefill with KV taps) + M3.12 (ODE loop) into a single
// pass. Returns true on success.
static bool pi05Inference(
    Pi05ModelInternal& m, const float** images, int nImages,
    const int32_t* langTokens, const bool* langMask, int langLen,
    const float* noise, float* actionsOut, int* nActionsOut,
    VlaTimingGeneric* timingOut) {
  if (actionsOut == nullptr || nActionsOut == nullptr) {
    return false;
  }
  if (images == nullptr || langTokens == nullptr || langMask == nullptr) {
    return false;
  }
  if (noise == nullptr) {
    return false;
  }
  const auto tStart = std::chrono::steady_clock::now();
  if (nImages < 1 || nImages > m.num_cameras) {
    return false;
  }
  for (int i = 0; i < nImages; ++i) {
    if (images[i] == nullptr) {
      return false;
    }
  }
  if (langLen != m.max_token_len) {
    return false;
  }
  for (int i = 0; i < langLen; ++i) {
    if (langTokens[i] < 0 || langTokens[i] >= m.vlm_vocab_size) {
      return false;
    }
  }
  // Find leading-contiguous valid range; reject holes.
  int validLang = 0;
  while (validLang < langLen && langMask[validLang]) {
    ++validLang;
  }
  for (int i = validLang; i < langLen; ++i) {
    if (langMask[i]) {
      return false;
    }
  }
  const int prefixLen = nImages * m.vision_n_patches + validLang;

  // ── Vision tower per camera ────────────────────────────────────────
  const auto tVisStart = std::chrono::steady_clock::now();
  const int h = m.vision_image_size;
  const size_t perImageOut =
      static_cast<size_t>(m.vision_n_patches) * m.vision_proj_dim;
  std::vector<std::vector<float>> imageFeatures(nImages);
  const size_t imgFloats = static_cast<size_t>(3) * h * h;

  // P5: construct vision tower weight struct once (all fields are immutable
  // pointers into the model's weight context).
  Pi05VisionTowerWeights tw{};
  tw.patch_embed_w = m.vision_patch_embed_w;
  tw.patch_embed_b = m.vision_patch_embed_b;
  tw.pos_embed = m.vision_pos_embed;
  tw.blocks = m.vision_blocks;
  tw.post_ln_w = m.vision_post_ln_w;
  tw.post_ln_b = m.vision_post_ln_b;
  tw.head_w = m.vision_head_w;
  tw.head_b = m.vision_head_b;

  for (int cam = 0; cam < nImages; ++cam) {
    // CHW row-major is already ggml's (W, H, C, 1) layout for square images.
    const float* imgData = images[cam];

    Pi05StagedGuard vg;
    vg.sg = pi05BuildStaged(size_t{32} * 1024 * 1024, 8192);
    if (vg.sg.ctx == nullptr) {
      return false;
    }
    struct ggml_tensor* pixels =
        ggml_new_tensor_4d(vg.sg.ctx, GGML_TYPE_F32, h, h, 3, 1);

    auto outs = pi05BuildSiglipTowerGraph(
        vg.sg.ctx,
        pixels,
        tw,
        m.vision_n_patches,
        m.vision_hidden,
        m.vision_proj_dim,
        m.vision_n_heads,
        m.vision_patch_size,
        m.vision_layer_norm_eps);
    if (outs.head_out == nullptr) {
      return false;
    }
    ggml_build_forward_expand(vg.sg.gf, outs.head_out);

    // Vision tower has Conv2d in patch embed — that's the op that may
    // need to fall back to CPU on some GPU backends (Adreno OpenCL,
    // older Vulkan). The scheduler routes Conv2d to CPU if the GPU
    // doesn't support it; rest of the SigLIP tower stays on GPU.
    const bool ok = m.has_gpu
                        ? pi05AllocStagedSched(vg.sg, m.backend, m.backend_cpu)
                        : pi05AllocStagedSimple(vg.sg, m.backend_cpu);
    if (!ok) {
      return false;
    }
    ggml_backend_tensor_set(pixels, imgData, 0, imgFloats * sizeof(float));
    if (!pi05ComputeStaged(vg.sg, m.backend)) {
      return false;
    }
    imageFeatures[cam].resize(perImageOut);
    ggml_backend_tensor_get(
        outs.head_out,
        imageFeatures[cam].data(),
        0,
        perImageOut * sizeof(float));
  }
  const auto tVisEnd = std::chrono::steady_clock::now();

  // ── Language embedding (valid tokens only) ─────────────────────────
  std::vector<float> langEmbeds(static_cast<size_t>(validLang) * m.vlm_hidden);
  {
    Pi05StagedGuard eg;
    eg.sg = pi05BuildStaged(size_t{32} * 1024 * 1024, GGML_DEFAULT_GRAPH_SIZE);
    if (eg.sg.ctx == nullptr) {
      return false;
    }
    struct ggml_tensor* tok =
        ggml_new_tensor_1d(eg.sg.ctx, GGML_TYPE_I32, validLang);
    struct ggml_tensor* emb = pi05BuildVlmEmbedGraph(
        eg.sg.ctx, tok, m.vlm_embed_tokens, m.vlm_hidden);
    if (emb == nullptr) {
      return false;
    }
    ggml_build_forward_expand(eg.sg.gf, emb);
    const bool ok = m.has_gpu
                        ? pi05AllocStagedSched(eg.sg, m.backend, m.backend_cpu)
                        : pi05AllocStagedSimple(eg.sg, m.backend_cpu);
    if (!ok) {
      return false;
    }
    ggml_backend_tensor_set(
        tok, langTokens, 0, static_cast<size_t>(validLang) * sizeof(int32_t));
    if (!pi05ComputeStaged(eg.sg, m.backend)) {
      return false;
    }
    ggml_backend_tensor_get(
        emb, langEmbeds.data(), 0, langEmbeds.size() * sizeof(float));
  }

  // ── Concat prefix (images + lang) ──────────────────────────────────
  std::vector<float> prefix(static_cast<size_t>(prefixLen) * m.vlm_hidden);
  {
    size_t off = 0;
    for (int cam = 0; cam < nImages; ++cam) {
      std::memcpy(
          prefix.data() + off,
          imageFeatures[cam].data(),
          imageFeatures[cam].size() * sizeof(float));
      off += imageFeatures[cam].size();
    }
    std::memcpy(
        prefix.data() + off,
        langEmbeds.data(),
        langEmbeds.size() * sizeof(float));
  }

  // ── VLM prefill with K/V taps ──────────────────────────────────────
  const auto tPrefillStart = std::chrono::steady_clock::now();
  const size_t perLayerKv =
      static_cast<size_t>(m.vlm_head_dim) * prefixLen * m.vlm_n_kv_heads;
  // Flat buffers — one allocation each instead of n_layers separate vectors.
  std::vector<float> kCache(static_cast<size_t>(m.vlm_n_layers) * perLayerKv);
  std::vector<float> vCache(static_cast<size_t>(m.vlm_n_layers) * perLayerKv);
  {
    Pi05StagedGuard pg;
    pg.sg = pi05BuildStaged(size_t{64} * 1024 * 1024, 65536);
    if (pg.sg.ctx == nullptr) {
      return false;
    }
    struct ggml_tensor* x =
        ggml_new_tensor_2d(pg.sg.ctx, GGML_TYPE_F32, m.vlm_hidden, prefixLen);
    struct ggml_tensor* pos =
        ggml_new_tensor_1d(pg.sg.ctx, GGML_TYPE_I32, prefixLen);

    std::vector<struct ggml_tensor*> outKeys;
    std::vector<struct ggml_tensor*> outValues;
    struct ggml_tensor* finalOut = pi05BuildVlmPrefillGraph(
        pg.sg.ctx,
        x,
        pos,
        /*attn_mask=*/nullptr,
        m.vlm_blocks,
        m.vlm_final_norm_w,
        m.vlm_hidden,
        m.vlm_n_heads,
        m.vlm_n_kv_heads,
        m.vlm_head_dim,
        prefixLen,
        m.rms_norm_eps,
        m.rope_freq_base,
        &outKeys,
        &outValues);
    if (finalOut == nullptr) {
      return false;
    }
    ggml_build_forward_expand(pg.sg.gf, finalOut);
    for (auto* kT : outKeys) {
      ggml_build_forward_expand(pg.sg.gf, kT);
    }
    for (auto* vT : outValues) {
      ggml_build_forward_expand(pg.sg.gf, vT);
    }
    const bool ok = m.has_gpu
                        ? pi05AllocStagedSched(pg.sg, m.backend, m.backend_cpu)
                        : pi05AllocStagedSimple(pg.sg, m.backend_cpu);
    if (!ok) {
      return false;
    }
    std::vector<int32_t> posData(prefixLen);
    for (int i = 0; i < prefixLen; ++i) {
      posData[i] = i;
    }
    ggml_backend_tensor_set(x, prefix.data(), 0, prefix.size() * sizeof(float));
    ggml_backend_tensor_set(
        pos, posData.data(), 0, posData.size() * sizeof(int32_t));
    if (!pi05ComputeStaged(pg.sg, m.backend)) {
      return false;
    }
    for (int l = 0; l < m.vlm_n_layers; ++l) {
      ggml_backend_tensor_get(
          outKeys[l],
          kCache.data() + static_cast<size_t>(l) * perLayerKv,
          0,
          perLayerKv * sizeof(float));
      ggml_backend_tensor_get(
          outValues[l],
          vCache.data() + static_cast<size_t>(l) * perLayerKv,
          0,
          perLayerKv * sizeof(float));
    }
  }
  const auto tPrefillEnd = std::chrono::steady_clock::now();

  // ── ODE loop (10 steps) ────────────────────────────────────────────
  const auto tOdeStart = std::chrono::steady_clock::now();
  const float dt = -1.0f / m.n_inference_steps;
  std::vector<float> xT(static_cast<size_t>(m.action_horizon) * m.action_dim);
  std::memcpy(xT.data(), noise, xT.size() * sizeof(float));
  std::vector<float> sincosBuf(m.cond_dim);
  std::vector<int32_t> actPosData(m.action_horizon);
  for (int i = 0; i < m.action_horizon; ++i) {
    actPosData[i] = prefixLen + i;
  }
  std::vector<float> xNextBuf(xT.size());

  for (int step = 0; step < m.n_inference_steps; ++step) {
    const float t = 1.0f + step * dt;
    pi05ComputeTimeSincos(
        t, m.cond_dim, m.min_period, m.max_period, sincosBuf.data());

    Pi05StagedGuard og;
    og.sg = pi05BuildStaged(size_t{96} * 1024 * 1024, 32768);
    if (og.sg.ctx == nullptr) {
      return false;
    }
    struct ggml_tensor* xTT = ggml_new_tensor_2d(
        og.sg.ctx, GGML_TYPE_F32, m.action_dim, m.action_horizon);
    struct ggml_tensor* sincosT =
        ggml_new_tensor_1d(og.sg.ctx, GGML_TYPE_F32, m.cond_dim);
    struct ggml_tensor* actPosT =
        ggml_new_tensor_1d(og.sg.ctx, GGML_TYPE_I32, m.action_horizon);
    std::vector<struct ggml_tensor*> cachedKT(m.expert_n_layers);
    std::vector<struct ggml_tensor*> cachedVT(m.expert_n_layers);
    for (int l = 0; l < m.expert_n_layers; ++l) {
      cachedKT[l] = ggml_new_tensor_3d(
          og.sg.ctx,
          GGML_TYPE_F32,
          m.expert_head_dim,
          prefixLen,
          m.expert_n_kv_heads);
      cachedVT[l] = ggml_new_tensor_3d(
          og.sg.ctx,
          GGML_TYPE_F32,
          m.expert_head_dim,
          prefixLen,
          m.expert_n_kv_heads);
    }

    struct ggml_tensor* cond = pi05BuildTimeMlpGraph(
        og.sg.ctx,
        sincosT,
        m.time_mlp_in_w,
        m.time_mlp_in_b,
        m.time_mlp_out_w,
        m.time_mlp_out_b);

    struct ggml_tensor* xExpT = ggml_mul_mat(og.sg.ctx, m.action_in_w, xTT);
    xExpT = ggml_add(
        og.sg.ctx, xExpT, ggml_cast(og.sg.ctx, m.action_in_b, GGML_TYPE_F32));

    auto outs = pi05BuildExpertOdeStepGraph(
        og.sg.ctx,
        xExpT,
        actPosT,
        cachedKT,
        cachedVT,
        cond,
        m.expert_blocks,
        m.expert_final_norm_ada_w,
        m.expert_final_norm_ada_b,
        m.action_out_w,
        m.action_out_b,
        m.expert_hidden,
        m.expert_n_heads,
        m.expert_n_kv_heads,
        m.expert_head_dim,
        prefixLen,
        m.action_horizon,
        m.rms_norm_eps,
        m.rope_freq_base);
    if (outs.v_t == nullptr) {
      return false;
    }
    struct ggml_tensor* xNext =
        pi05BuildEulerStepGraph(og.sg.ctx, xTT, outs.v_t, dt);
    ggml_build_forward_expand(og.sg.gf, xNext);

    const bool ok = m.has_gpu
                        ? pi05AllocStagedSched(og.sg, m.backend, m.backend_cpu)
                        : pi05AllocStagedSimple(og.sg, m.backend_cpu);
    if (!ok) {
      return false;
    }
    ggml_backend_tensor_set(xTT, xT.data(), 0, xT.size() * sizeof(float));
    ggml_backend_tensor_set(
        sincosT, sincosBuf.data(), 0, sincosBuf.size() * sizeof(float));
    ggml_backend_tensor_set(
        actPosT, actPosData.data(), 0, actPosData.size() * sizeof(int32_t));
    for (int l = 0; l < m.expert_n_layers; ++l) {
      ggml_backend_tensor_set(
          cachedKT[l],
          kCache.data() + static_cast<size_t>(l) * perLayerKv,
          0,
          perLayerKv * sizeof(float));
      ggml_backend_tensor_set(
          cachedVT[l],
          vCache.data() + static_cast<size_t>(l) * perLayerKv,
          0,
          perLayerKv * sizeof(float));
    }
    if (!pi05ComputeStaged(og.sg, m.backend)) {
      return false;
    }
    ggml_backend_tensor_get(
        xNext, xNextBuf.data(), 0, xNextBuf.size() * sizeof(float));
    std::swap(xT, xNextBuf);
  }
  const auto tOdeEnd = std::chrono::steady_clock::now();

  std::memcpy(actionsOut, xT.data(), xT.size() * sizeof(float));
  *nActionsOut = m.action_horizon;

  if (timingOut != nullptr) {
    const auto tEnd = std::chrono::steady_clock::now();
    auto toMs = [](auto a, auto b) {
      return std::chrono::duration<double, std::milli>(b - a).count();
    };
    timingOut->vision_ms = toMs(tVisStart, tVisEnd);
    timingOut->prefill_compute_ms = toMs(tPrefillStart, tPrefillEnd);
    timingOut->prefill_total_ms = toMs(tPrefillStart, tPrefillEnd);
    timingOut->ode_ms = toMs(tOdeStart, tOdeEnd);
    timingOut->total_ms = toMs(tStart, tEnd);
  }
  return true;
}

Pi05Model::Pi05Model(
    const std::string& ggufPath, bool forceCpu,
    const std::string& backendsDir) {
  impl_ = pi05LoadModel(ggufPath, forceCpu, backendsDir);
  hparams_.chunk_size = impl_->action_horizon;
  hparams_.action_dim = impl_->action_dim;
  hparams_.max_action_dim = impl_->action_dim;
  hparams_.max_state_dim = impl_->action_dim;
  hparams_.tokenizer_max_length = impl_->max_token_len;
  hparams_.vision_image_size = impl_->vision_image_size;
  hparams_.num_cameras = impl_->num_cameras;
  hparams_.state_input_mode = VlaHparamsGeneric::StateInputMode::Discrete;
}

Pi05Model::~Pi05Model() = default;

std::string Pi05Model::backendName() const {
  return impl_ ? impl_->backend_name : std::string("none");
}

bool Pi05Model::hasGpu() const { return impl_ && impl_->has_gpu; }

bool Pi05Model::infer(
    const float** images, int nImages, int imgWidth, int imgHeight,
    const float* /*state*/, // pi05 uses discrete state in the prompt
    int /*state_dim*/, const int32_t* langTokens, const bool* langMask,
    int langLen, const float* noise, float* actionsOut, int* nActionsOut,
    VlaTimingGeneric* timingOut) {
  if (!impl_) {
    return false;
  }
  const int expected = impl_->vision_image_size;
  if (imgWidth != expected || imgHeight != expected) {
    return false;
  }
  return pi05Inference(
      *impl_,
      images,
      nImages,
      langTokens,
      langMask,
      langLen,
      noise,
      actionsOut,
      nActionsOut,
      timingOut);
}

} // namespace qvac_lib_infer_vla_ggml
