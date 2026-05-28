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

#include <ggml.h>
#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>
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
static struct ggml_tensor* toF32(
    struct ggml_context* ctx, struct ggml_tensor* x) {
  if (x != nullptr && x->type != GGML_TYPE_F32) {
    return ggml_cast(ctx, x, GGML_TYPE_F32);
  }
  return x;
}

// ── M3.1: SigLIP patch + position embed ──────────────────────────────────
Pi05PatchPosOutputs pi05BuildSiglipPatchPosGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* pixel_values,
    struct ggml_tensor* patch_embed_w,
    struct ggml_tensor* patch_embed_b,
    struct ggml_tensor* pos_embed,
    int patch_size) {
  Pi05PatchPosOutputs out{nullptr, nullptr};
  if (ctx == nullptr || pixel_values == nullptr ||
      patch_embed_w == nullptr || pos_embed == nullptr) {
    return out;
  }

  // ggml_conv_2d(stride_w, stride_h, pad_w, pad_h, dil_w, dil_h). SigLIP-
  // So400m/14 uses a 14×14 patch with no padding and stride = patch size,
  // matching PyTorch's `Conv2d(3, 1152, kernel_size=14, stride=14)`.
  struct ggml_tensor* x = ggml_conv_2d(
      ctx,
      patch_embed_w,
      pixel_values,
      patch_size,
      patch_size,
      0,
      0,
      1,
      1);

  // Conv2d output is (W_out, H_out, C_out, N). Flatten the spatial dims
  // into a single "patch" axis (16*16 = 256) and the channels (1152) stay
  // along the fast dim — so the resulting tensor's ne=[C_out, n_patches].
  // That matches the byte layout of numpy's (n_patches, C_out) row-major
  // array, which is what the PyTorch reference stores.
  const int n_patches =
      static_cast<int>(x->ne[0]) * static_cast<int>(x->ne[1]);
  const int hidden = static_cast<int>(x->ne[2]);

  // Reshape (W, H, C, 1) → (n_patches, C) — note: in ggml, dim 0 is the
  // fastest axis, so we put n_patches first to keep (W,H) flattened in
  // memory order. Then transpose to put C on the fast axis so the bias
  // (which has shape (C,)) broadcasts across the slow axis (patches),
  // which is the only direction ggml_add supports without an explicit
  // repeat.
  x = ggml_reshape_2d(ctx, x, n_patches, hidden);
  x = ggml_cont(ctx, ggml_transpose(ctx, x));

  if (patch_embed_b != nullptr) {
    // Conv2d in PyTorch fuses bias into the convolution output. We add
    // it post-reshape; numerically identical for an additive bias.
    // The bias is stored F16 in the GGUF — promote on-graph so the F32
    // conv output and the bias share a dtype.
    x = ggml_add(ctx, x, toF32(ctx, patch_embed_b));
  }

  // Parity gate #1 from plan §5: `vision.patch_embed_out[cam_i]`.
  out.patch_embed_out = x;

  // pos_embed is laid out as (C=1152, n_patches=256) in ggml (the GGUF
  // converter writes it as numpy (n_patches, C), which the ggml loader
  // re-interprets with the last numpy dim as the fast ggml dim). It's
  // stored F16; promote before the add for the same reason as the bias.
  out.pos_embed_out = ggml_add(ctx, x, toF32(ctx, pos_embed));
  return out;
}

// ── Small shared helpers, mirrored from smolvla.cpp's static defs ────────
// LayerNorm with weight + bias.
static struct ggml_tensor* pi05LayerNorm(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* weight, struct ggml_tensor* bias, float eps) {
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
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* weight, struct ggml_tensor* bias) {
  struct ggml_tensor* out = ggml_mul_mat(ctx, weight, x);
  if (bias != nullptr) {
    out = ggml_add(ctx, out, toF32(ctx, bias));
  }
  return out;
}

// ── M3.2: one SigLIP transformer block ──────────────────────────────────
struct ggml_tensor* pi05BuildSiglipBlockGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* x,
    const Pi05SiglipBlockWeights& w,
    int n_patches,
    int hidden,
    int n_heads,
    float layer_norm_eps) {
  if (ctx == nullptr || x == nullptr) {
    return nullptr;
  }
  // Reject missing required tensors up front — the caller is the test
  // harness, which prefers a nullptr return over an undiagnosable
  // crash deep in the graph executor.
  if (w.ln1_w == nullptr || w.ln1_b == nullptr || w.ln2_w == nullptr ||
      w.ln2_b == nullptr || w.attn_q_w == nullptr || w.attn_q_b == nullptr ||
      w.attn_k_w == nullptr || w.attn_k_b == nullptr ||
      w.attn_v_w == nullptr || w.attn_v_b == nullptr ||
      w.attn_out_w == nullptr || w.attn_out_b == nullptr ||
      w.fc1_w == nullptr || w.fc1_b == nullptr || w.fc2_w == nullptr ||
      w.fc2_b == nullptr) {
    return nullptr;
  }
  if (n_heads <= 0 || hidden <= 0 || hidden % n_heads != 0) {
    return nullptr;
  }
  const int head_dim = hidden / n_heads;

  // ── Pre-attention LayerNorm + MHSA + residual ───────────────────────
  struct ggml_tensor* residual = x;
  struct ggml_tensor* h =
      pi05LayerNorm(ctx, x, w.ln1_w, w.ln1_b, layer_norm_eps);

  struct ggml_tensor* q = pi05Linear(ctx, h, w.attn_q_w, w.attn_q_b);
  struct ggml_tensor* k = pi05Linear(ctx, h, w.attn_k_w, w.attn_k_b);
  struct ggml_tensor* v = pi05Linear(ctx, h, w.attn_v_w, w.attn_v_b);

  // Reshape (hidden, n_patches) → (head_dim, n_heads, n_patches).
  q = ggml_reshape_3d(ctx, q, head_dim, n_heads, n_patches);
  k = ggml_reshape_3d(ctx, k, head_dim, n_heads, n_patches);
  v = ggml_reshape_3d(ctx, v, head_dim, n_heads, n_patches);

  // Permute to (head_dim, n_patches, n_heads) so ggml_mul_mat sees each
  // head as an independent (n_patches × head_dim) matmul.
  q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
  v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

  // Scaled dot-product attention: softmax(Q K^T / sqrt(d)) V.
  // ggml_mul_mat(k, q) → (n_patches, n_patches, n_heads).
  struct ggml_tensor* logits = ggml_mul_mat(ctx, k, q);
  struct ggml_tensor* attn = ggml_soft_max_ext(
      ctx, logits, nullptr,
      1.0f / std::sqrt(static_cast<float>(head_dim)), 0.0f);
  // (head_dim, n_patches, n_heads): transpose v to (n_patches, head_dim,
  // n_heads) then mul_mat with the (n_patches, n_patches, n_heads) attn.
  struct ggml_tensor* attn_out = ggml_mul_mat(
      ctx, ggml_cont(ctx, ggml_transpose(ctx, v)), attn);
  // Back to (hidden, n_patches).
  attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
  attn_out = ggml_reshape_2d(ctx, attn_out, hidden, n_patches);

  // Output projection + residual.
  struct ggml_tensor* proj = pi05Linear(ctx, attn_out, w.attn_out_w, w.attn_out_b);
  h = ggml_add(ctx, proj, residual);

  // ── Post-attention LayerNorm + MLP + residual ───────────────────────
  residual = h;
  h = pi05LayerNorm(ctx, h, w.ln2_w, w.ln2_b, layer_norm_eps);
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
    struct ggml_context* ctx,
    struct ggml_tensor* pixel_values,
    const Pi05VisionTowerWeights& w,
    int n_patches,
    int hidden,
    int proj_dim,
    int n_heads,
    int patch_size,
    float layer_norm_eps) {
  Pi05VisionTowerOutputs out{nullptr};
  if (ctx == nullptr || pixel_values == nullptr || w.blocks.empty() ||
      w.post_ln_w == nullptr || w.post_ln_b == nullptr ||
      w.head_w == nullptr || w.head_b == nullptr) {
    return out;
  }

  // Patch + pos embed (M3.1).
  Pi05PatchPosOutputs pp = pi05BuildSiglipPatchPosGraph(
      ctx, pixel_values, w.patch_embed_w, w.patch_embed_b,
      w.pos_embed, patch_size);
  if (pp.pos_embed_out == nullptr) {
    return out;
  }
  struct ggml_tensor* x = pp.pos_embed_out;

  // Transformer stack (M3.2 × N).
  for (const auto& bw : w.blocks) {
    x = pi05BuildSiglipBlockGraph(
        ctx, x, bw, n_patches, hidden, n_heads, layer_norm_eps);
    if (x == nullptr) {
      return out;
    }
  }

  // Post-LayerNorm — the LeRobot SigLIP wrapper applies this
  // immediately before the head Linear; HF naming is
  // `vision_model.post_layernorm`.
  x = pi05LayerNorm(ctx, x, w.post_ln_w, w.post_ln_b, layer_norm_eps);

  // "Connector" head — Linear(hidden → proj_dim). For pi05_base this
  // is the `_siglip.Module(num_classes=2048, pool_type="none")` head,
  // i.e. just a single Linear, no pixel-shuffle (plan §2).
  out.head_out = pi05Linear(ctx, x, w.head_w, w.head_b);
  (void)proj_dim; // shape is inferred from head_w — kept in the signature
                  //  for documentation + caller-side sanity-checking.
  return out;
}

// ── M3.4: PaliGemma token embedder + sqrt(hidden) scaling ────────────────
struct ggml_tensor* pi05BuildVlmEmbedGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* tokens,
    struct ggml_tensor* embed_tokens,
    int hidden) {
  if (ctx == nullptr || tokens == nullptr || embed_tokens == nullptr) {
    return nullptr;
  }
  // Embedding lookup: row[i] = embed_tokens[tokens[i]]. ggml_get_rows
  // produces ne=[hidden, n_tokens] (it picks columns of the I32 indices
  // out of `embed_tokens` whose ne=[hidden, vocab]).
  struct ggml_tensor* e = ggml_get_rows(ctx, embed_tokens, tokens);
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
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* scale, float eps) {
  struct ggml_tensor* normed = ggml_rms_norm(ctx, x, eps);
  if (scale == nullptr) {
    return normed;
  }
  struct ggml_tensor* scale_f32 = toF32(ctx, scale);
  // (1 + scale) * normed = normed + normed * scale
  return ggml_add(ctx, normed, ggml_mul(ctx, normed, scale_f32));
}

// ── M3.5: one Gemma-1 VLM block ─────────────────────────────────────────
struct ggml_tensor* pi05BuildGemmaVlmBlockGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* x,
    struct ggml_tensor* positions,
    struct ggml_tensor* attn_mask,
    const Pi05GemmaBlockWeights& w,
    int hidden,
    int n_heads,
    int n_kv_heads,
    int head_dim,
    int seq_len,
    float rms_norm_eps,
    float rope_freq_base,
    struct ggml_tensor** out_k_post_rope,
    struct ggml_tensor** out_v) {
  if (ctx == nullptr || x == nullptr || positions == nullptr ||
      w.pre_attn_norm_scale == nullptr || w.attn_q_w == nullptr ||
      w.attn_k_w == nullptr || w.attn_v_w == nullptr ||
      w.attn_o_w == nullptr || w.pre_ffw_norm_scale == nullptr ||
      w.mlp_gate_w == nullptr || w.mlp_up_w == nullptr ||
      w.mlp_down_w == nullptr) {
    return nullptr;
  }

  // ── Pre-attn RMSNorm ───────────────────────────────────────────────
  struct ggml_tensor* residual = x;
  struct ggml_tensor* h =
      pi05GemmaRmsNorm(ctx, x, w.pre_attn_norm_scale, rms_norm_eps);

  // ── Q, K, V projections (Gemma-1 has no attn bias) ────────────────
  struct ggml_tensor* q = pi05Linear(ctx, h, w.attn_q_w, nullptr);
  struct ggml_tensor* k = pi05Linear(ctx, h, w.attn_k_w, nullptr);
  struct ggml_tensor* v = pi05Linear(ctx, h, w.attn_v_w, nullptr);

  // Reshape to per-head views. MQA: Q is split into n_heads, K/V into
  // n_kv_heads (1 for pi05). ggml broadcasts the kv-head dim against
  // the q-head dim when n_kv_heads < n_heads.
  q = ggml_reshape_3d(ctx, q, head_dim, n_heads, seq_len);
  k = ggml_reshape_3d(ctx, k, head_dim, n_kv_heads, seq_len);
  v = ggml_reshape_3d(ctx, v, head_dim, n_kv_heads, seq_len);

  // RoPE on Q and K (NEOX style, Gemma-1 freq_base = 10000). Per-head
  // — ggml_rope_ext walks the seq dim using `positions`.
  const int n_rot = head_dim;
  const int rope_mode = GGML_ROPE_TYPE_NEOX;
  q = ggml_rope_ext(
      ctx, q, positions, /*freq_factors=*/nullptr,
      n_rot, rope_mode, /*n_ctx_orig=*/0,
      rope_freq_base, /*freq_scale=*/1.0f,
      /*ext_factor=*/0.0f, /*attn_factor=*/1.0f,
      /*beta_fast=*/32.0f, /*beta_slow=*/1.0f);
  k = ggml_rope_ext(
      ctx, k, positions, /*freq_factors=*/nullptr,
      n_rot, rope_mode, /*n_ctx_orig=*/0,
      rope_freq_base, /*freq_scale=*/1.0f,
      /*ext_factor=*/0.0f, /*attn_factor=*/1.0f,
      /*beta_fast=*/32.0f, /*beta_slow=*/1.0f);

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
  if (out_k_post_rope != nullptr) {
    ggml_set_output(k);
    *out_k_post_rope = k;
  }
  if (out_v != nullptr) {
    ggml_set_output(v);
    *out_v = v;
  }

  // Attention: softmax(K^T · Q / sqrt(head_dim) + mask) · V.
  // mul_mat(K, Q) broadcasts K's kv_heads=1 across Q's n_heads=8.
  struct ggml_tensor* logits = ggml_mul_mat(ctx, k, q);
  const float scale = 1.0f / std::sqrt(static_cast<float>(head_dim));
  struct ggml_tensor* attn =
      ggml_soft_max_ext(ctx, logits, attn_mask, scale, /*max_bias=*/0.0f);
  // V^T: (n_patches, head_dim, n_kv_heads). mul_mat with attn (n_k, n_q, n_heads)
  // → (head_dim, n_q, n_heads).
  struct ggml_tensor* attn_out = ggml_mul_mat(
      ctx, ggml_cont(ctx, ggml_transpose(ctx, v)), attn);
  // Back to (hidden, seq_q).
  attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
  attn_out = ggml_reshape_2d(ctx, attn_out, hidden, seq_len);

  // O proj + residual.
  struct ggml_tensor* proj = pi05Linear(ctx, attn_out, w.attn_o_w, nullptr);
  h = ggml_add(ctx, proj, residual);

  // ── Pre-FFW RMSNorm + GeGLU MLP + residual ────────────────────────
  residual = h;
  h = pi05GemmaRmsNorm(ctx, h, w.pre_ffw_norm_scale, rms_norm_eps);
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
    struct ggml_context* ctx,
    struct ggml_tensor* x,
    struct ggml_tensor* positions,
    struct ggml_tensor* attn_mask,
    const std::vector<Pi05GemmaBlockWeights>& blocks,
    struct ggml_tensor* final_norm_scale,
    int hidden,
    int n_heads,
    int n_kv_heads,
    int head_dim,
    int seq_len,
    float rms_norm_eps,
    float rope_freq_base,
    std::vector<struct ggml_tensor*>* out_keys,
    std::vector<struct ggml_tensor*>* out_values) {
  if (ctx == nullptr || x == nullptr || positions == nullptr ||
      blocks.empty() || final_norm_scale == nullptr) {
    return nullptr;
  }
  if (out_keys != nullptr) {
    out_keys->assign(blocks.size(), nullptr);
  }
  if (out_values != nullptr) {
    out_values->assign(blocks.size(), nullptr);
  }
  struct ggml_tensor* h = x;
  for (size_t i = 0; i < blocks.size(); ++i) {
    struct ggml_tensor* k_out = nullptr;
    struct ggml_tensor* v_out = nullptr;
    h = pi05BuildGemmaVlmBlockGraph(
        ctx, h, positions, attn_mask, blocks[i],
        hidden, n_heads, n_kv_heads, head_dim,
        seq_len, rms_norm_eps, rope_freq_base,
        (out_keys != nullptr) ? &k_out : nullptr,
        (out_values != nullptr) ? &v_out : nullptr);
    if (h == nullptr) {
      return nullptr;
    }
    if (out_keys != nullptr) {
      (*out_keys)[i] = k_out;
    }
    if (out_values != nullptr) {
      (*out_values)[i] = v_out;
    }
  }
  return pi05GemmaRmsNorm(ctx, h, final_norm_scale, rms_norm_eps);
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
    float t, int dim, float min_period, float max_period, float* out) {
  if (out == nullptr || dim <= 0 || (dim & 1) != 0) {
    return;
  }
  const int n = dim / 2;
  const double td = static_cast<double>(t);
  const double log_min = std::log(static_cast<double>(min_period));
  const double log_max = std::log(static_cast<double>(max_period));
  const double two_pi = 2.0 * 3.14159265358979323846;
  for (int i = 0; i < n; ++i) {
    const double fraction =
        (n > 1) ? (static_cast<double>(i) / static_cast<double>(n - 1))
                : 0.0;
    const double period = std::exp(log_min + fraction * (log_max - log_min));
    const double phase = (two_pi / period) * td;
    out[i] = static_cast<float>(std::sin(phase));
    out[n + i] = static_cast<float>(std::cos(phase));
  }
}

// ── M3.7b: MLP + swish chain ────────────────────────────────────────────
struct ggml_tensor* pi05BuildTimeMlpGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* time_emb,
    struct ggml_tensor* time_mlp_in_w,
    struct ggml_tensor* time_mlp_in_b,
    struct ggml_tensor* time_mlp_out_w,
    struct ggml_tensor* time_mlp_out_b) {
  if (ctx == nullptr || time_emb == nullptr ||
      time_mlp_in_w == nullptr || time_mlp_in_b == nullptr ||
      time_mlp_out_w == nullptr || time_mlp_out_b == nullptr) {
    return nullptr;
  }
  // Linear → SiLU → Linear → SiLU. SiLU is swish (x * sigmoid(x)) —
  // openpi uses `nn.swish` which is JAX's alias for SiLU; ggml_silu
  // matches.
  struct ggml_tensor* h = pi05Linear(ctx, time_emb, time_mlp_in_w, time_mlp_in_b);
  h = ggml_silu(ctx, h);
  h = pi05Linear(ctx, h, time_mlp_out_w, time_mlp_out_b);
  h = ggml_silu(ctx, h);
  return h;
}

// ── M3.8: adaRMSNorm split (scale, shift, gate) ─────────────────────────
Pi05AdaSplit pi05BuildAdarmsSplitGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* cond,
    struct ggml_tensor* ada_dense_w,
    struct ggml_tensor* ada_dense_b,
    int hidden) {
  Pi05AdaSplit out{nullptr, nullptr, nullptr};
  if (ctx == nullptr || cond == nullptr || ada_dense_w == nullptr ||
      ada_dense_b == nullptr || hidden <= 0) {
    return out;
  }
  // modulation = cond @ W^T + b  →  (3*hidden,)
  struct ggml_tensor* mod = pi05Linear(ctx, cond, ada_dense_w, ada_dense_b);
  // Chunk into three contiguous (hidden,) slices. `mod` is 1-D
  // (ne[0] = 3*hidden), so a 1-D view with the right offset suffices.
  const size_t es = ggml_element_size(mod);
  out.scale = ggml_view_1d(ctx, mod, hidden, /*offset=*/0);
  out.shift = ggml_view_1d(ctx, mod, hidden, /*offset=*/hidden * es);
  out.gate = ggml_view_1d(
      ctx, mod, hidden, /*offset=*/2 * hidden * es);
  return out;
}

// ── adaRMSNorm application: `(1 + ada_scale) * rms_norm(x) + ada_shift` ─
// Per openpi/gemma.py:130. The base `.scale` weight is *not* used in the
// adaptive branch (the formula doesn't reference it). For pi05_base the
// converter writes that weight as zeros anyway — see the rationale in
// `_optional_pt_keys_with_shape` in convert_pi05_to_gguf.py.
static struct ggml_tensor* pi05AdarmsApply(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* ada_scale, struct ggml_tensor* ada_shift,
    float eps) {
  struct ggml_tensor* normed = ggml_rms_norm(ctx, x, eps);
  // normed * (1 + ada_scale) = normed + normed * ada_scale
  struct ggml_tensor* s = ggml_add(
      ctx, normed, ggml_mul(ctx, normed, ada_scale));
  return ggml_add(ctx, s, ada_shift);
}

// ── M3.9: one expert block (Gemma-1 300M) with joint attention ──────────
struct ggml_tensor* pi05BuildExpertBlockGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* x_exp,
    struct ggml_tensor* act_positions,
    struct ggml_tensor* cached_k,
    struct ggml_tensor* cached_v,
    struct ggml_tensor* cond,
    const Pi05ExpertBlockWeights& w,
    int expert_hidden,
    int n_heads,
    int n_kv_heads,
    int head_dim,
    int prefix_len,
    int n_act,
    float rms_norm_eps,
    float rope_freq_base) {
  if (ctx == nullptr || x_exp == nullptr || act_positions == nullptr ||
      cached_k == nullptr || cached_v == nullptr || cond == nullptr ||
      w.pre_attn_ada_w == nullptr || w.pre_attn_ada_b == nullptr ||
      w.pre_ffw_ada_w == nullptr || w.pre_ffw_ada_b == nullptr ||
      w.attn_q_w == nullptr || w.attn_k_w == nullptr ||
      w.attn_v_w == nullptr || w.attn_o_w == nullptr ||
      w.mlp_gate_w == nullptr || w.mlp_up_w == nullptr ||
      w.mlp_down_w == nullptr) {
    return nullptr;
  }

  // ── Pre-attn adaRMSNorm + per-block ada split ──────────────────────
  Pi05AdaSplit a = pi05BuildAdarmsSplitGraph(
      ctx, cond, w.pre_attn_ada_w, w.pre_attn_ada_b, expert_hidden);
  if (a.scale == nullptr) {
    return nullptr;
  }

  struct ggml_tensor* h =
      pi05AdarmsApply(ctx, x_exp, a.scale, a.shift, rms_norm_eps);

  // ── Q, K, V projections (Gemma-1 expert has no attn bias) ─────────
  struct ggml_tensor* q = pi05Linear(ctx, h, w.attn_q_w, nullptr);
  struct ggml_tensor* k_exp = pi05Linear(ctx, h, w.attn_k_w, nullptr);
  struct ggml_tensor* v_exp = pi05Linear(ctx, h, w.attn_v_w, nullptr);

  // Reshape to per-head layout. Q goes through 8-head expansion; K/V
  // stay at 1 head (MQA).
  q = ggml_reshape_3d(ctx, q, head_dim, n_heads, n_act);
  k_exp = ggml_reshape_3d(ctx, k_exp, head_dim, n_kv_heads, n_act);
  v_exp = ggml_reshape_3d(ctx, v_exp, head_dim, n_kv_heads, n_act);

  // RoPE on Q and expert K (NEOX, base 10000 like the VLM). The
  // cached prefix K from the VLM was already RoPE-rotated at prefill
  // time and uses positions 0..prefix_len-1; the expert's positions
  // continue from there (act_positions).
  const int n_rot = head_dim;
  const int rope_mode = GGML_ROPE_TYPE_NEOX;
  q = ggml_rope_ext(
      ctx, q, act_positions, /*freq_factors=*/nullptr,
      n_rot, rope_mode, 0, rope_freq_base, 1.0f, 0.0f, 1.0f, 32.0f, 1.0f);
  k_exp = ggml_rope_ext(
      ctx, k_exp, act_positions, /*freq_factors=*/nullptr,
      n_rot, rope_mode, 0, rope_freq_base, 1.0f, 0.0f, 1.0f, 32.0f, 1.0f);

  // Permute Q/K/V to ggml's attention layout (head_dim, seq, heads).
  q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  k_exp = ggml_cont(ctx, ggml_permute(ctx, k_exp, 0, 2, 1, 3));
  v_exp = ggml_cont(ctx, ggml_permute(ctx, v_exp, 0, 2, 1, 3));

  // The cached prefix K/V is stored ne=[head_dim, prefix_len, n_kv_heads]
  // already — no permute needed, and tensors from ggml_new_tensor_3d +
  // ggml_backend_tensor_set are inherently contiguous.
  struct ggml_tensor* k_cached_c = cached_k;
  struct ggml_tensor* v_cached_c = cached_v;

  // Concatenate on the seq axis (ggml dim 1). Both halves are
  // ne=[head_dim, seq_*, n_kv_heads]; the joint K/V is
  // ne=[head_dim, prefix_len + n_act, n_kv_heads].
  struct ggml_tensor* k_joint = ggml_concat(ctx, k_cached_c, k_exp, /*dim=*/1);
  struct ggml_tensor* v_joint = ggml_concat(ctx, v_cached_c, v_exp, /*dim=*/1);

  // Joint softmax. mul_mat(K_joint, Q) broadcasts kv_heads=1 across
  // Q's n_heads=8, producing ne=[seq_k, seq_q, n_heads].
  struct ggml_tensor* logits = ggml_mul_mat(ctx, k_joint, q);
  const float scale = 1.0f / std::sqrt(static_cast<float>(head_dim));
  struct ggml_tensor* attn = ggml_soft_max_ext(
      ctx, logits, /*mask=*/nullptr, scale, /*max_bias=*/0.0f);

  // V_joint^T then mul_mat with attn → ne=[head_dim, seq_q, n_heads].
  struct ggml_tensor* attn_out = ggml_mul_mat(
      ctx, ggml_cont(ctx, ggml_transpose(ctx, v_joint)), attn);
  // Back to (head_dim*n_heads, n_act) = (expert_q_dim, n_act). The
  // expert's o_proj reads (n_heads*head_dim, expert_hidden), so we
  // reshape to ne=[n_heads*head_dim, n_act].
  attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
  attn_out = ggml_reshape_2d(
      ctx, attn_out, n_heads * head_dim, n_act);

  // O-proj + gated residual.
  struct ggml_tensor* proj = pi05Linear(ctx, attn_out, w.attn_o_w, nullptr);
  // Gated residual: x + ada_gate * proj  (per-channel multiply,
  // broadcasts the (expert_hidden,) gate across n_act).
  h = ggml_add(ctx, x_exp, ggml_mul(ctx, proj, a.gate));

  // ── Pre-FFW adaRMSNorm + GeGLU MLP + gated residual ────────────────
  Pi05AdaSplit b = pi05BuildAdarmsSplitGraph(
      ctx, cond, w.pre_ffw_ada_w, w.pre_ffw_ada_b, expert_hidden);
  if (b.scale == nullptr) {
    return nullptr;
  }
  struct ggml_tensor* normed_ffw =
      pi05AdarmsApply(ctx, h, b.scale, b.shift, rms_norm_eps);
  struct ggml_tensor* gate = pi05Linear(ctx, normed_ffw, w.mlp_gate_w, nullptr);
  struct ggml_tensor* up = pi05Linear(ctx, normed_ffw, w.mlp_up_w, nullptr);
  gate = ggml_gelu(ctx, gate);
  struct ggml_tensor* ff = ggml_mul(ctx, gate, up);
  struct ggml_tensor* down = pi05Linear(ctx, ff, w.mlp_down_w, nullptr);
  return ggml_add(ctx, h, ggml_mul(ctx, down, b.gate));
}

// ── M3.10: full expert pass (18 blocks + final adaRMSNorm + action_out) ─
Pi05ExpertODEStepOutputs pi05BuildExpertOdeStepGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* x_exp,
    struct ggml_tensor* act_positions,
    const std::vector<struct ggml_tensor*>& cached_k,
    const std::vector<struct ggml_tensor*>& cached_v,
    struct ggml_tensor* cond,
    const std::vector<Pi05ExpertBlockWeights>& blocks,
    struct ggml_tensor* final_norm_ada_w,
    struct ggml_tensor* final_norm_ada_b,
    struct ggml_tensor* action_out_proj_w,
    struct ggml_tensor* action_out_proj_b,
    int expert_hidden,
    int n_heads,
    int n_kv_heads,
    int head_dim,
    int prefix_len,
    int n_act,
    float rms_norm_eps,
    float rope_freq_base) {
  Pi05ExpertODEStepOutputs out{nullptr, nullptr};
  if (ctx == nullptr || x_exp == nullptr || act_positions == nullptr ||
      cond == nullptr || blocks.empty() ||
      cached_k.size() != blocks.size() ||
      cached_v.size() != blocks.size() ||
      final_norm_ada_w == nullptr || final_norm_ada_b == nullptr ||
      action_out_proj_w == nullptr || action_out_proj_b == nullptr) {
    return out;
  }
  struct ggml_tensor* h = x_exp;
  for (size_t i = 0; i < blocks.size(); ++i) {
    h = pi05BuildExpertBlockGraph(
        ctx, h, act_positions, cached_k[i], cached_v[i], cond,
        blocks[i],
        expert_hidden, n_heads, n_kv_heads, head_dim,
        prefix_len, n_act, rms_norm_eps, rope_freq_base);
    if (h == nullptr) {
      return out;
    }
  }
  // Final adaRMSNorm — same modulation form as the per-block norms.
  Pi05AdaSplit fin = pi05BuildAdarmsSplitGraph(
      ctx, cond, final_norm_ada_w, final_norm_ada_b, expert_hidden);
  if (fin.scale == nullptr) {
    return out;
  }
  out.final_out = pi05AdarmsApply(
      ctx, h, fin.scale, fin.shift, rms_norm_eps);

  // action_out_proj — Linear(expert_hidden → action_dim).
  out.v_t = pi05Linear(
      ctx, out.final_out, action_out_proj_w, action_out_proj_b);
  return out;
}

// ── M3.11: explicit-Euler ODE step ──────────────────────────────────────
struct ggml_tensor* pi05BuildEulerStepGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* x_t,
    struct ggml_tensor* v_t,
    float dt) {
  if (ctx == nullptr || x_t == nullptr || v_t == nullptr) {
    return nullptr;
  }
  return ggml_add(ctx, x_t, ggml_scale(ctx, v_t, dt));
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

static Pi05StagedGraph pi05BuildStaged(size_t ctx_bytes, int max_nodes) {
  Pi05StagedGraph sg{};
  struct ggml_init_params params{ctx_bytes, nullptr, /*no_alloc=*/true};
  sg.ctx = ggml_init(params);
  if (sg.ctx == nullptr) return sg;
  sg.gf = ggml_new_graph_custom(sg.ctx, max_nodes, false);
  return sg;
}

static bool pi05AllocStagedSimple(
    Pi05StagedGraph& sg, ggml_backend_t backend) {
  sg.allocr = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend));
  if (sg.allocr == nullptr) return false;
  return ggml_gallocr_alloc_graph(sg.allocr, sg.gf);
}

static bool pi05AllocStagedSched(
    Pi05StagedGraph& sg, ggml_backend_t gpu, ggml_backend_t cpu) {
  ggml_backend_t backends[] = {gpu, cpu};
  sg.sched = ggml_backend_sched_new(
      backends, nullptr, 2, GGML_DEFAULT_GRAPH_SIZE, false, true);
  if (sg.sched == nullptr) return false;
  return ggml_backend_sched_alloc_graph(sg.sched, sg.gf);
}

static bool pi05ComputeStaged(
    Pi05StagedGraph& sg, ggml_backend_t backend) {
  if (sg.sched != nullptr) {
    return ggml_backend_sched_graph_compute(sg.sched, sg.gf) ==
           GGML_STATUS_SUCCESS;
  }
  return ggml_backend_graph_compute(backend, sg.gf) == GGML_STATUS_SUCCESS;
}

static void pi05FreeStaged(Pi05StagedGraph& sg) {
  if (sg.sched != nullptr) ggml_backend_sched_free(sg.sched);
  if (sg.allocr != nullptr) ggml_gallocr_free(sg.allocr);
  if (sg.ctx != nullptr) ggml_free(sg.ctx);
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
    ggml_backend_buffer_type_t buft, size_t data_offset,
    int64_t n_tensors_in_gguf) {
  size_t total_size = 0;
  for (struct ggml_tensor* t = ggml_get_first_tensor(m.ctx_w); t != nullptr;
       t = ggml_get_next_tensor(m.ctx_w, t)) {
    total_size += ggml_nbytes(t);
  }
  QLOG_IF(
      Priority::INFO,
      "pi05LoadModel: alloc+copy path, total weights " +
          std::to_string((int)(total_size / (1024 * 1024))) + " MB");

  ggml_backend_buffer_t buf =
      ggml_backend_alloc_ctx_tensors_from_buft(m.ctx_w, buft);
  if (buf == nullptr) {
    const char* bname = ggml_backend_name(m.backend);
    QLOG_IF(
        Priority::ERROR,
        std::string(
            "pi05LoadModel: ggml_backend_alloc_ctx_tensors_from_buft "
            "FAILED for ") +
            std::to_string((int)(total_size / (1024 * 1024))) +
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
  std::vector<uint8_t> read_buf;
  int n_copied = 0;
  for (int64_t i = 0; i < n_tensors_in_gguf; i++) {
    const char* name = gguf_get_tensor_name(gguf, i);
    struct ggml_tensor* t = ggml_get_tensor(m.ctx_w, name);
    if (t == nullptr) {
      continue;
    }
    size_t off = data_offset + gguf_get_tensor_offset(gguf, i);
    size_t nbytes = ggml_nbytes(t);
    if (read_buf.size() < nbytes) {
      read_buf.resize(nbytes);
    }
#ifdef _WIN32
    int seek_err = _fseeki64(f, (int64_t)off, SEEK_SET);
#else
    int seek_err = fseeko(f, static_cast<off_t>(off), SEEK_SET);
#endif
    if (seek_err != 0 || std::fread(read_buf.data(), 1, nbytes, f) != nbytes) {
      QLOG_IF(
          Priority::ERROR,
          std::string("pi05LoadModel: failed to read tensor '") + name +
              "' at offset " + std::to_string(off));
      std::fclose(f);
      return false;
    }
    ggml_backend_tensor_set(t, read_buf.data(), 0, nbytes);
    n_copied++;
  }
  std::fclose(f);
  const char* bname = ggml_backend_name(m.backend);
  QLOG_IF(
      Priority::INFO,
      "pi05LoadModel: alloc+copy buffer ready, " +
          std::to_string(n_copied) + " tensors, backend='" +
          (bname != nullptr ? bname : "?") + "'");
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

  ggml_backend_dev_t cpu_dev =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (cpu_dev == nullptr) {
    throw std::runtime_error("pi05LoadModel: no CPU backend available");
  }
  m->backend_cpu = ggml_backend_dev_init(cpu_dev, nullptr);
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
      ggml_backend_t gpu_backend = ggml_backend_dev_init(gpu, nullptr);
      if (gpu_backend != nullptr) {
        m->backend = gpu_backend;
        m->has_gpu = true;
        const char* bname = ggml_backend_name(gpu_backend);
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
      QLOG_IF(
          Priority::INFO,
          "pi05LoadModel: no GPU device picked; using CPU");
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

  const std::string arch =
      ggufGetStrOr(m->gguf, "general.architecture", "");
  if (arch != "pi05") {
    throw std::runtime_error(
        "pi05LoadModel: expected general.architecture=pi05, got '" +
        arch + "'");
  }

  // hparams (all keys per the converter's stamp_metadata).
  m->vision_image_size =
      ggufGetU32Or(m->gguf, "pi05.image_resolution", 224);
  m->vision_n_layers =
      ggufGetU32Or(m->gguf, "pi05.vision.num_layers", 27);
  m->vlm_n_layers = ggufGetU32Or(m->gguf, "pi05.vlm.num_layers", 18);
  m->vlm_hidden = ggufGetU32Or(m->gguf, "pi05.vlm.hidden_size", 2048);
  m->vlm_n_heads = ggufGetU32Or(m->gguf, "pi05.vlm.num_heads", 8);
  m->vlm_n_kv_heads =
      ggufGetU32Or(m->gguf, "pi05.vlm.num_kv_heads", 1);
  m->vlm_head_dim = ggufGetU32Or(m->gguf, "pi05.vlm.head_dim", 256);
  m->vlm_vocab_size = ggufGetU32Or(m->gguf, "pi05.vocab_size", 257152);
  m->expert_hidden =
      ggufGetU32Or(m->gguf, "pi05.expert.hidden_size", 1024);
  m->expert_n_layers =
      ggufGetU32Or(m->gguf, "pi05.expert.num_layers", 18);
  m->action_dim = ggufGetU32Or(m->gguf, "pi05.action_dim", 32);
  m->action_horizon = ggufGetU32Or(m->gguf, "pi05.action_horizon", 50);
  m->max_token_len =
      ggufGetU32Or(m->gguf, "pi05.max_token_len", 200);
  m->num_cameras = ggufGetU32Or(m->gguf, "pi05.num_cameras", 3);
  m->vision_n_patches =
      (m->vision_image_size / m->vision_patch_size) *
      (m->vision_image_size / m->vision_patch_size);

  // Sanity-check hparams — reject zeros (division/scaling UB), unreasonable
  // upper bounds (OOM / integer overflow from crafted GGUFs), and
  // consistency constraints (head_dim compatibility, patch divisibility).
  if (m->vision_n_layers == 0 || m->vision_n_layers > 512 ||
      m->vlm_n_layers == 0 || m->vlm_n_layers > 512 ||
      m->expert_n_layers == 0 || m->expert_n_layers > 512 ||
      m->action_horizon == 0 || m->action_horizon > 1024 ||
      m->max_token_len == 0 || m->max_token_len > 8192 ||
      m->num_cameras == 0 || m->num_cameras > 16 ||
      m->action_dim == 0 || m->action_dim > 512 ||
      m->vision_image_size == 0 || m->vision_image_size > 2048 ||
      m->expert_hidden == 0 || m->expert_hidden > 16384 ||
      m->vlm_hidden == 0 || m->vlm_n_heads == 0 ||
      m->vlm_n_kv_heads == 0 || m->vlm_head_dim == 0 ||
      m->expert_n_heads == 0 || m->expert_n_kv_heads == 0 ||
      m->expert_head_dim == 0 ||
      m->vlm_vocab_size == 0 || m->vlm_vocab_size > 1048576 ||
      m->vision_n_patches == 0 ||
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
        std::to_string(m->vlm_head_dim) + " expert_head_dim=" +
        std::to_string(m->expert_head_dim) + " vlm_n_kv_heads=" +
        std::to_string(m->vlm_n_kv_heads) + " expert_n_kv_heads=" +
        std::to_string(m->expert_n_kv_heads) + ")");
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
    const size_t data_offset = gguf_get_data_offset(m->gguf);
    const int64_t n_tensors_in_gguf = gguf_get_n_tensors(m->gguf);
    if (!pi05LoadWeightsAllocCopy(
            *m, ggufPath.c_str(), m->gguf, buft, data_offset,
            n_tensors_in_gguf)) {
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
  auto must_get = [&](const std::string& name) -> struct ggml_tensor* {
    struct ggml_tensor* t = ggml_get_tensor(m->ctx_w, name.c_str());
    if (t == nullptr) {
      throw std::runtime_error(
          "pi05LoadModel: tensor missing from GGUF: " + name);
    }
    return t;
  };

  // Vision
  m->vision_patch_embed_w = must_get("vision.patch_embed.weight");
  m->vision_patch_embed_b = must_get("vision.patch_embed.bias");
  m->vision_pos_embed = must_get("vision.pos_embed");
  m->vision_post_ln_w = must_get("vision.post_ln.weight");
  m->vision_post_ln_b = must_get("vision.post_ln.bias");
  m->vision_head_w = must_get("vision.head.weight");
  m->vision_head_b = must_get("vision.head.bias");
  m->vision_blocks.resize(m->vision_n_layers);
  for (int i = 0; i < m->vision_n_layers; ++i) {
    const std::string b = "vision.blk." + std::to_string(i);
    auto& bw = m->vision_blocks[i];
    bw.ln1_w = must_get(b + ".ln1.weight");
    bw.ln1_b = must_get(b + ".ln1.bias");
    bw.attn_q_w = must_get(b + ".attn_q.weight");
    bw.attn_q_b = must_get(b + ".attn_q.bias");
    bw.attn_k_w = must_get(b + ".attn_k.weight");
    bw.attn_k_b = must_get(b + ".attn_k.bias");
    bw.attn_v_w = must_get(b + ".attn_v.weight");
    bw.attn_v_b = must_get(b + ".attn_v.bias");
    bw.attn_out_w = must_get(b + ".attn_out.weight");
    bw.attn_out_b = must_get(b + ".attn_out.bias");
    bw.ln2_w = must_get(b + ".ln2.weight");
    bw.ln2_b = must_get(b + ".ln2.bias");
    bw.fc1_w = must_get(b + ".fc1.weight");
    bw.fc1_b = must_get(b + ".fc1.bias");
    bw.fc2_w = must_get(b + ".fc2.weight");
    bw.fc2_b = must_get(b + ".fc2.bias");
  }

  // VLM
  m->vlm_embed_tokens = must_get("vlm.embed_tokens");
  m->vlm_final_norm_w = must_get("vlm.final_norm.scale");
  m->vlm_blocks.resize(m->vlm_n_layers);
  for (int i = 0; i < m->vlm_n_layers; ++i) {
    const std::string b = "vlm.blk." + std::to_string(i);
    auto& bw = m->vlm_blocks[i];
    bw.pre_attn_norm_scale = must_get(b + ".pre_attn_norm.scale");
    bw.attn_q_w = must_get(b + ".attn.q.weight");
    bw.attn_k_w = must_get(b + ".attn.k.weight");
    bw.attn_v_w = must_get(b + ".attn.v.weight");
    bw.attn_o_w = must_get(b + ".attn.o.weight");
    bw.pre_ffw_norm_scale = must_get(b + ".pre_ffw_norm.scale");
    bw.mlp_gate_w = must_get(b + ".mlp.gate.weight");
    bw.mlp_up_w = must_get(b + ".mlp.up.weight");
    bw.mlp_down_w = must_get(b + ".mlp.down.weight");
  }

  // Expert
  m->expert_final_norm_ada_w = must_get("expert.final_norm.ada.weight");
  m->expert_final_norm_ada_b = must_get("expert.final_norm.ada.bias");
  m->expert_blocks.resize(m->expert_n_layers);
  for (int i = 0; i < m->expert_n_layers; ++i) {
    const std::string b = "expert.blk." + std::to_string(i);
    auto& bw = m->expert_blocks[i];
    bw.pre_attn_ada_w = must_get(b + ".pre_attn_norm.ada.weight");
    bw.pre_attn_ada_b = must_get(b + ".pre_attn_norm.ada.bias");
    bw.pre_ffw_ada_w = must_get(b + ".pre_ffw_norm.ada.weight");
    bw.pre_ffw_ada_b = must_get(b + ".pre_ffw_norm.ada.bias");
    bw.attn_q_w = must_get(b + ".attn.q.weight");
    bw.attn_k_w = must_get(b + ".attn.k.weight");
    bw.attn_v_w = must_get(b + ".attn.v.weight");
    bw.attn_o_w = must_get(b + ".attn.o.weight");
    bw.mlp_gate_w = must_get(b + ".mlp.gate.weight");
    bw.mlp_up_w = must_get(b + ".mlp.up.weight");
    bw.mlp_down_w = must_get(b + ".mlp.down.weight");
  }

  // Projections
  m->action_in_w = must_get("proj.action_in.weight");
  m->action_in_b = must_get("proj.action_in.bias");
  m->action_out_w = must_get("proj.action_out.weight");
  m->action_out_b = must_get("proj.action_out.bias");
  m->time_mlp_in_w = must_get("proj.time_mlp_in.weight");
  m->time_mlp_in_b = must_get("proj.time_mlp_in.bias");
  m->time_mlp_out_w = must_get("proj.time_mlp_out.weight");
  m->time_mlp_out_b = must_get("proj.time_mlp_out.bias");

  return m;
}

// pi05Inference — composes M3.1 (vision per cam) + M3.4 (embedder)
// + M3.6 (VLM prefill with KV taps) + M3.12 (ODE loop) into a single
// pass. Returns true on success.
static bool pi05Inference(
    Pi05ModelInternal& m,
    const float** images,
    int n_images,
    const int32_t* lang_tokens,
    const bool* lang_mask,
    int lang_len,
    const float* noise,
    float* actions_out,
    int* n_actions_out,
    VlaTimingGeneric* timing_out) {
  if (actions_out == nullptr || n_actions_out == nullptr) {
    return false;
  }
  if (images == nullptr || lang_tokens == nullptr || lang_mask == nullptr) {
    return false;
  }
  if (noise == nullptr) {
    return false;
  }
  const auto t_start = std::chrono::steady_clock::now();
  if (n_images < 1 || n_images > m.num_cameras) {
    return false;
  }
  for (int i = 0; i < n_images; ++i) {
    if (images[i] == nullptr) {
      return false;
    }
  }
  if (lang_len != m.max_token_len) {
    return false;
  }
  for (int i = 0; i < lang_len; ++i) {
    if (lang_tokens[i] < 0 || lang_tokens[i] >= m.vlm_vocab_size) {
      return false;
    }
  }
  // Find leading-contiguous valid range; reject holes.
  int valid_lang = 0;
  while (valid_lang < lang_len && lang_mask[valid_lang]) {
    ++valid_lang;
  }
  for (int i = valid_lang; i < lang_len; ++i) {
    if (lang_mask[i]) {
      return false;
    }
  }
  const int prefix_len = n_images * m.vision_n_patches + valid_lang;

  // ── Vision tower per camera ────────────────────────────────────────
  const auto t_vis_start = std::chrono::steady_clock::now();
  const int H = m.vision_image_size;
  const size_t per_image_out =
      static_cast<size_t>(m.vision_n_patches) * m.vision_proj_dim;
  std::vector<std::vector<float>> image_features(n_images);
  const size_t img_floats = static_cast<size_t>(3) * H * H;

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

  for (int cam = 0; cam < n_images; ++cam) {
    // CHW row-major is already ggml's (W, H, C, 1) layout for square images.
    const float* img_data = images[cam];

    Pi05StagedGuard vg;
    vg.sg = pi05BuildStaged(size_t{32} * 1024 * 1024, 8192);
    if (vg.sg.ctx == nullptr) {
      return false;
    }
    struct ggml_tensor* pixels =
        ggml_new_tensor_4d(vg.sg.ctx, GGML_TYPE_F32, H, H, 3, 1);

    auto outs = pi05BuildSiglipTowerGraph(
        vg.sg.ctx, pixels, tw, m.vision_n_patches, m.vision_hidden,
        m.vision_proj_dim, m.vision_n_heads, m.vision_patch_size,
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
    ggml_backend_tensor_set(pixels, img_data, 0,
                            img_floats * sizeof(float));
    if (!pi05ComputeStaged(vg.sg, m.backend)) {
      return false;
    }
    image_features[cam].resize(per_image_out);
    ggml_backend_tensor_get(outs.head_out, image_features[cam].data(), 0,
                            per_image_out * sizeof(float));
  }
  const auto t_vis_end = std::chrono::steady_clock::now();

  // ── Language embedding (valid tokens only) ─────────────────────────
  std::vector<float> lang_embeds(
      static_cast<size_t>(valid_lang) * m.vlm_hidden);
  {
    Pi05StagedGuard eg;
    eg.sg = pi05BuildStaged(size_t{32} * 1024 * 1024,
                              GGML_DEFAULT_GRAPH_SIZE);
    if (eg.sg.ctx == nullptr) {
      return false;
    }
    struct ggml_tensor* tok =
        ggml_new_tensor_1d(eg.sg.ctx, GGML_TYPE_I32, valid_lang);
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
    ggml_backend_tensor_set(tok, lang_tokens, 0,
                            static_cast<size_t>(valid_lang) *
                                sizeof(int32_t));
    if (!pi05ComputeStaged(eg.sg, m.backend)) {
      return false;
    }
    ggml_backend_tensor_get(emb, lang_embeds.data(), 0,
                            lang_embeds.size() * sizeof(float));
  }

  // ── Concat prefix (images + lang) ──────────────────────────────────
  std::vector<float> prefix(
      static_cast<size_t>(prefix_len) * m.vlm_hidden);
  {
    size_t off = 0;
    for (int cam = 0; cam < n_images; ++cam) {
      std::memcpy(prefix.data() + off, image_features[cam].data(),
                  image_features[cam].size() * sizeof(float));
      off += image_features[cam].size();
    }
    std::memcpy(prefix.data() + off, lang_embeds.data(),
                lang_embeds.size() * sizeof(float));
  }

  // ── VLM prefill with K/V taps ──────────────────────────────────────
  const auto t_prefill_start = std::chrono::steady_clock::now();
  const size_t per_layer_kv =
      static_cast<size_t>(m.vlm_head_dim) * prefix_len * m.vlm_n_kv_heads;
  // Flat buffers — one allocation each instead of n_layers separate vectors.
  std::vector<float> k_cache(static_cast<size_t>(m.vlm_n_layers) * per_layer_kv);
  std::vector<float> v_cache(static_cast<size_t>(m.vlm_n_layers) * per_layer_kv);
  {
    Pi05StagedGuard pg;
    pg.sg = pi05BuildStaged(size_t{64} * 1024 * 1024, 65536);
    if (pg.sg.ctx == nullptr) {
      return false;
    }
    struct ggml_tensor* x = ggml_new_tensor_2d(
        pg.sg.ctx, GGML_TYPE_F32, m.vlm_hidden, prefix_len);
    struct ggml_tensor* pos =
        ggml_new_tensor_1d(pg.sg.ctx, GGML_TYPE_I32, prefix_len);

    std::vector<struct ggml_tensor*> out_keys;
    std::vector<struct ggml_tensor*> out_values;
    struct ggml_tensor* final_out = pi05BuildVlmPrefillGraph(
        pg.sg.ctx, x, pos, /*attn_mask=*/nullptr, m.vlm_blocks,
        m.vlm_final_norm_w, m.vlm_hidden, m.vlm_n_heads,
        m.vlm_n_kv_heads, m.vlm_head_dim, prefix_len, m.rms_norm_eps,
        m.rope_freq_base, &out_keys, &out_values);
    if (final_out == nullptr) {
      return false;
    }
    ggml_build_forward_expand(pg.sg.gf, final_out);
    for (auto* k_t : out_keys) {
      ggml_build_forward_expand(pg.sg.gf, k_t);
    }
    for (auto* v_t : out_values) {
      ggml_build_forward_expand(pg.sg.gf, v_t);
    }
    const bool ok = m.has_gpu
        ? pi05AllocStagedSched(pg.sg, m.backend, m.backend_cpu)
        : pi05AllocStagedSimple(pg.sg, m.backend_cpu);
    if (!ok) {
      return false;
    }
    std::vector<int32_t> pos_data(prefix_len);
    for (int i = 0; i < prefix_len; ++i) {
      pos_data[i] = i;
    }
    ggml_backend_tensor_set(x, prefix.data(), 0,
                            prefix.size() * sizeof(float));
    ggml_backend_tensor_set(pos, pos_data.data(), 0,
                            pos_data.size() * sizeof(int32_t));
    if (!pi05ComputeStaged(pg.sg, m.backend)) {
      return false;
    }
    for (int L = 0; L < m.vlm_n_layers; ++L) {
      ggml_backend_tensor_get(out_keys[L],
                              k_cache.data() + static_cast<size_t>(L) * per_layer_kv,
                              0, per_layer_kv * sizeof(float));
      ggml_backend_tensor_get(out_values[L],
                              v_cache.data() + static_cast<size_t>(L) * per_layer_kv,
                              0, per_layer_kv * sizeof(float));
    }
  }
  const auto t_prefill_end = std::chrono::steady_clock::now();

  // ── ODE loop (10 steps) ────────────────────────────────────────────
  const auto t_ode_start = std::chrono::steady_clock::now();
  const float dt = -1.0f / m.n_inference_steps;
  std::vector<float> x_t(
      static_cast<size_t>(m.action_horizon) * m.action_dim);
  std::memcpy(x_t.data(), noise, x_t.size() * sizeof(float));
  std::vector<float> sincos_buf(m.cond_dim);
  std::vector<int32_t> act_pos_data(m.action_horizon);
  for (int i = 0; i < m.action_horizon; ++i) {
    act_pos_data[i] = prefix_len + i;
  }
  std::vector<float> x_next_buf(x_t.size());

  for (int step = 0; step < m.n_inference_steps; ++step) {
    const float t = 1.0f + step * dt;
    pi05ComputeTimeSincos(t, m.cond_dim, m.min_period, m.max_period,
                             sincos_buf.data());

    Pi05StagedGuard og;
    og.sg = pi05BuildStaged(size_t{96} * 1024 * 1024, 32768);
    if (og.sg.ctx == nullptr) {
      return false;
    }
    struct ggml_tensor* x_t_t = ggml_new_tensor_2d(
        og.sg.ctx, GGML_TYPE_F32, m.action_dim, m.action_horizon);
    struct ggml_tensor* sincos_t =
        ggml_new_tensor_1d(og.sg.ctx, GGML_TYPE_F32, m.cond_dim);
    struct ggml_tensor* act_pos_t =
        ggml_new_tensor_1d(og.sg.ctx, GGML_TYPE_I32, m.action_horizon);
    std::vector<struct ggml_tensor*> cached_k_t(m.expert_n_layers);
    std::vector<struct ggml_tensor*> cached_v_t(m.expert_n_layers);
    for (int L = 0; L < m.expert_n_layers; ++L) {
      cached_k_t[L] = ggml_new_tensor_3d(
          og.sg.ctx, GGML_TYPE_F32, m.expert_head_dim, prefix_len,
          m.expert_n_kv_heads);
      cached_v_t[L] = ggml_new_tensor_3d(
          og.sg.ctx, GGML_TYPE_F32, m.expert_head_dim, prefix_len,
          m.expert_n_kv_heads);
    }

    struct ggml_tensor* cond = pi05BuildTimeMlpGraph(
        og.sg.ctx, sincos_t, m.time_mlp_in_w, m.time_mlp_in_b,
        m.time_mlp_out_w, m.time_mlp_out_b);

    struct ggml_tensor* x_exp_t =
        ggml_mul_mat(og.sg.ctx, m.action_in_w, x_t_t);
    x_exp_t = ggml_add(
        og.sg.ctx, x_exp_t,
        ggml_cast(og.sg.ctx, m.action_in_b, GGML_TYPE_F32));

    auto outs = pi05BuildExpertOdeStepGraph(
        og.sg.ctx, x_exp_t, act_pos_t, cached_k_t, cached_v_t, cond,
        m.expert_blocks, m.expert_final_norm_ada_w,
        m.expert_final_norm_ada_b, m.action_out_w, m.action_out_b,
        m.expert_hidden, m.expert_n_heads, m.expert_n_kv_heads,
        m.expert_head_dim, prefix_len, m.action_horizon,
        m.rms_norm_eps, m.rope_freq_base);
    if (outs.v_t == nullptr) {
      return false;
    }
    struct ggml_tensor* x_next =
        pi05BuildEulerStepGraph(og.sg.ctx, x_t_t, outs.v_t, dt);
    ggml_build_forward_expand(og.sg.gf, x_next);

    const bool ok = m.has_gpu
        ? pi05AllocStagedSched(og.sg, m.backend, m.backend_cpu)
        : pi05AllocStagedSimple(og.sg, m.backend_cpu);
    if (!ok) {
      return false;
    }
    ggml_backend_tensor_set(x_t_t, x_t.data(), 0,
                            x_t.size() * sizeof(float));
    ggml_backend_tensor_set(sincos_t, sincos_buf.data(), 0,
                            sincos_buf.size() * sizeof(float));
    ggml_backend_tensor_set(act_pos_t, act_pos_data.data(), 0,
                            act_pos_data.size() * sizeof(int32_t));
    for (int L = 0; L < m.expert_n_layers; ++L) {
      ggml_backend_tensor_set(cached_k_t[L],
                              k_cache.data() + static_cast<size_t>(L) * per_layer_kv,
                              0, per_layer_kv * sizeof(float));
      ggml_backend_tensor_set(cached_v_t[L],
                              v_cache.data() + static_cast<size_t>(L) * per_layer_kv,
                              0, per_layer_kv * sizeof(float));
    }
    if (!pi05ComputeStaged(og.sg, m.backend)) {
      return false;
    }
    ggml_backend_tensor_get(x_next, x_next_buf.data(), 0,
                            x_next_buf.size() * sizeof(float));
    std::swap(x_t, x_next_buf);
  }
  const auto t_ode_end = std::chrono::steady_clock::now();

  std::memcpy(actions_out, x_t.data(), x_t.size() * sizeof(float));
  *n_actions_out = m.action_horizon;

  if (timing_out != nullptr) {
    const auto t_end = std::chrono::steady_clock::now();
    auto to_ms = [](auto a, auto b) {
      return std::chrono::duration<double, std::milli>(b - a).count();
    };
    timing_out->vision_ms = to_ms(t_vis_start, t_vis_end);
    timing_out->prefill_compute_ms = to_ms(t_prefill_start, t_prefill_end);
    timing_out->prefill_total_ms = to_ms(t_prefill_start, t_prefill_end);
    timing_out->ode_ms = to_ms(t_ode_start, t_ode_end);
    timing_out->total_ms = to_ms(t_start, t_end);
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
  hparams_.state_input_mode =
      VlaHparamsGeneric::StateInputMode::Discrete;
}

Pi05Model::~Pi05Model() = default;

std::string Pi05Model::backendName() const {
  return impl_ ? impl_->backend_name : std::string("none");
}

bool Pi05Model::hasGpu() const { return impl_ && impl_->has_gpu; }

bool Pi05Model::infer(
    const float** images,
    int n_images,
    int img_width,
    int img_height,
    const float* /*state*/, // pi05 uses discrete state in the prompt
    int /*state_dim*/,
    const int32_t* lang_tokens,
    const bool* lang_mask,
    int lang_len,
    const float* noise,
    float* actions_out,
    int* n_actions_out,
    VlaTimingGeneric* timing_out) {
  if (!impl_) {
    return false;
  }
  const int expected = impl_->vision_image_size;
  if (img_width != expected || img_height != expected) {
    return false;
  }
  return pi05Inference(*impl_, images, n_images, lang_tokens, lang_mask,
                         lang_len, noise, actions_out, n_actions_out,
                         timing_out);
}

} // namespace qvac_lib_infer_vla_ggml
