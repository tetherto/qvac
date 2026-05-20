#include "model-interface/pi05.hpp"

#include <cmath>
#include <stdexcept>

#include <ggml.h>

namespace qvac_lib_infer_vla_ggml {

// Cast a tensor to F32 if it isn't already. ggml's CPU backend rejects
// `ggml_add`/`ggml_mul` between F32 and F16 directly, so any weight stored
// at lower precision in the GGUF (bias, pos_embed, etc.) has to be
// promoted on the graph side before participating in arithmetic with an
// F32 activation. Mirrors `smolvla.cpp::to_f32`.
static struct ggml_tensor* to_f32(
    struct ggml_context* ctx, struct ggml_tensor* x) {
  if (x != nullptr && x->type != GGML_TYPE_F32) {
    return ggml_cast(ctx, x, GGML_TYPE_F32);
  }
  return x;
}

// ── M3.1: SigLIP patch + position embed ──────────────────────────────────
Pi05PatchPosOutputs pi05_build_siglip_patch_pos_graph(
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
  // array, which is what the Phase-0 dump stored.
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
    x = ggml_add(ctx, x, to_f32(ctx, patch_embed_b));
  }

  // Parity gate #1 from plan §5: `vision.patch_embed_out[cam_i]`.
  out.patch_embed_out = x;

  // pos_embed is laid out as (C=1152, n_patches=256) in ggml (the GGUF
  // converter writes it as numpy (n_patches, C), which the ggml loader
  // re-interprets with the last numpy dim as the fast ggml dim). It's
  // stored F16; promote before the add for the same reason as the bias.
  out.pos_embed_out = ggml_add(ctx, x, to_f32(ctx, pos_embed));
  return out;
}

// ── Small shared helpers, mirrored from smolvla.cpp's static defs ────────
// LayerNorm with weight + bias.
static struct ggml_tensor* pi05_layer_norm(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* weight, struct ggml_tensor* bias, float eps) {
  x = ggml_norm(ctx, x, eps);
  if (weight != nullptr) {
    x = ggml_mul(ctx, x, to_f32(ctx, weight));
  }
  if (bias != nullptr) {
    x = ggml_add(ctx, x, to_f32(ctx, bias));
  }
  return x;
}

// Linear: y = x @ W^T (+ b). ggml_mul_mat takes (weight, input) and
// produces (out_features, ...) so the caller treats `x` as (..., in_feat).
static struct ggml_tensor* pi05_linear(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* weight, struct ggml_tensor* bias) {
  struct ggml_tensor* out = ggml_mul_mat(ctx, weight, x);
  if (bias != nullptr) {
    out = ggml_add(ctx, out, to_f32(ctx, bias));
  }
  return out;
}

// ── M3.2: one SigLIP transformer block ──────────────────────────────────
struct ggml_tensor* pi05_build_siglip_block_graph(
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
  const int head_dim = hidden / n_heads;

  // ── Pre-attention LayerNorm + MHSA + residual ───────────────────────
  struct ggml_tensor* residual = x;
  struct ggml_tensor* h =
      pi05_layer_norm(ctx, x, w.ln1_w, w.ln1_b, layer_norm_eps);

  struct ggml_tensor* q = pi05_linear(ctx, h, w.attn_q_w, w.attn_q_b);
  struct ggml_tensor* k = pi05_linear(ctx, h, w.attn_k_w, w.attn_k_b);
  struct ggml_tensor* v = pi05_linear(ctx, h, w.attn_v_w, w.attn_v_b);

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
  struct ggml_tensor* proj = pi05_linear(ctx, attn_out, w.attn_out_w, w.attn_out_b);
  h = ggml_add(ctx, proj, residual);

  // ── Post-attention LayerNorm + MLP + residual ───────────────────────
  residual = h;
  h = pi05_layer_norm(ctx, h, w.ln2_w, w.ln2_b, layer_norm_eps);
  h = pi05_linear(ctx, h, w.fc1_w, w.fc1_b);
  // HF SigLIP uses GELU (default activation in SiglipMLP for the So400m
  // checkpoint). ggml_gelu is the tanh approximation, which matches
  // pytorch's `nn.functional.gelu(approximate="tanh")` to within F32
  // rounding noise.
  h = ggml_gelu(ctx, h);
  h = pi05_linear(ctx, h, w.fc2_w, w.fc2_b);
  return ggml_add(ctx, h, residual);
}

// ── M3.3: full SigLIP-So400m/14 vision tower ────────────────────────────
Pi05VisionTowerOutputs pi05_build_siglip_tower_graph(
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
  Pi05PatchPosOutputs pp = pi05_build_siglip_patch_pos_graph(
      ctx, pixel_values, w.patch_embed_w, w.patch_embed_b,
      w.pos_embed, patch_size);
  if (pp.pos_embed_out == nullptr) {
    return out;
  }
  struct ggml_tensor* x = pp.pos_embed_out;

  // Transformer stack (M3.2 × N).
  for (const auto& bw : w.blocks) {
    x = pi05_build_siglip_block_graph(
        ctx, x, bw, n_patches, hidden, n_heads, layer_norm_eps);
    if (x == nullptr) {
      return out;
    }
  }

  // Post-LayerNorm — the LeRobot SigLIP wrapper applies this
  // immediately before the head Linear; HF naming is
  // `vision_model.post_layernorm`.
  x = pi05_layer_norm(ctx, x, w.post_ln_w, w.post_ln_b, layer_norm_eps);

  // "Connector" head — Linear(hidden → proj_dim). For pi05_base this
  // is the `_siglip.Module(num_classes=2048, pool_type="none")` head,
  // i.e. just a single Linear, no pixel-shuffle (plan §2).
  out.head_out = pi05_linear(ctx, x, w.head_w, w.head_b);
  (void)proj_dim; // shape is inferred from head_w — kept in the signature
                  //  for documentation + caller-side sanity-checking.
  return out;
}

// ── M3.4: PaliGemma token embedder + sqrt(hidden) scaling ────────────────
struct ggml_tensor* pi05_build_vlm_embed_graph(
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

// Gemma-1 RMSNorm: `(1 + scale) * normed`. The Phase-2 converter
// copies the raw PyTorch tensor as `.scale`, so the `+1` happens
// here on the graph side. We compute `normed * scale + normed` to
// avoid needing a one-tensor.
static struct ggml_tensor* pi05_gemma_rms_norm(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* scale, float eps) {
  struct ggml_tensor* normed = ggml_rms_norm(ctx, x, eps);
  if (scale == nullptr) {
    return normed;
  }
  struct ggml_tensor* scale_f32 = to_f32(ctx, scale);
  // (1 + scale) * normed = normed + normed * scale
  return ggml_add(ctx, normed, ggml_mul(ctx, normed, scale_f32));
}

// ── M3.5: one Gemma-1 VLM block ─────────────────────────────────────────
struct ggml_tensor* pi05_build_gemma_vlm_block_graph(
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
    float rope_freq_base) {
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
      pi05_gemma_rms_norm(ctx, x, w.pre_attn_norm_scale, rms_norm_eps);

  // ── Q, K, V projections (Gemma-1 has no attn bias) ────────────────
  struct ggml_tensor* q = pi05_linear(ctx, h, w.attn_q_w, nullptr);
  struct ggml_tensor* k = pi05_linear(ctx, h, w.attn_k_w, nullptr);
  struct ggml_tensor* v = pi05_linear(ctx, h, w.attn_v_w, nullptr);

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
  struct ggml_tensor* proj = pi05_linear(ctx, attn_out, w.attn_o_w, nullptr);
  h = ggml_add(ctx, proj, residual);

  // ── Pre-FFW RMSNorm + GeGLU MLP + residual ────────────────────────
  residual = h;
  h = pi05_gemma_rms_norm(ctx, h, w.pre_ffw_norm_scale, rms_norm_eps);
  struct ggml_tensor* gate = pi05_linear(ctx, h, w.mlp_gate_w, nullptr);
  struct ggml_tensor* up = pi05_linear(ctx, h, w.mlp_up_w, nullptr);
  // GeGLU: gelu(gate) * up. ggml_gelu is the tanh approximation —
  // matches PyTorch's `gelu_pytorch_tanh` (lerobot pi05 hidden_act).
  gate = ggml_gelu(ctx, gate);
  struct ggml_tensor* ff = ggml_mul(ctx, gate, up);
  struct ggml_tensor* down = pi05_linear(ctx, ff, w.mlp_down_w, nullptr);
  return ggml_add(ctx, down, residual);
}

// ── M3.6: full VLM prefill (18 blocks + final RMSNorm) ──────────────────
struct ggml_tensor* pi05_build_vlm_prefill_graph(
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
    float rope_freq_base) {
  if (ctx == nullptr || x == nullptr || positions == nullptr ||
      blocks.empty() || final_norm_scale == nullptr) {
    return nullptr;
  }
  struct ggml_tensor* h = x;
  for (const auto& bw : blocks) {
    h = pi05_build_gemma_vlm_block_graph(
        ctx, h, positions, attn_mask, bw,
        hidden, n_heads, n_kv_heads, head_dim,
        seq_len, rms_norm_eps, rope_freq_base);
    if (h == nullptr) {
      return nullptr;
    }
  }
  return pi05_gemma_rms_norm(ctx, h, final_norm_scale, rms_norm_eps);
}

// ── M3.7a: sin-cos time embedding ───────────────────────────────────────
//
// Reference: openpi `create_sinusoidal_pos_embedding`
// (lerobot/pi05/modeling_pi05.py:81). The reference computes
// internally in float64 and casts the output to F32; we do the same
// to avoid F32 cancellation between `t / period` and
// `2π · t / period` at the tiniest periods (4 ms × 1 → tens of
// thousands of radians, where F32 loses precision).
void pi05_compute_time_sincos(
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
struct ggml_tensor* pi05_build_time_mlp_graph(
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
  struct ggml_tensor* h = pi05_linear(ctx, time_emb, time_mlp_in_w, time_mlp_in_b);
  h = ggml_silu(ctx, h);
  h = pi05_linear(ctx, h, time_mlp_out_w, time_mlp_out_b);
  h = ggml_silu(ctx, h);
  return h;
}

// ── M3.8: adaRMSNorm split (scale, shift, gate) ─────────────────────────
Pi05AdaSplit pi05_build_adarms_split_graph(
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
  struct ggml_tensor* mod = pi05_linear(ctx, cond, ada_dense_w, ada_dense_b);
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
static struct ggml_tensor* pi05_adarms_apply(
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
struct ggml_tensor* pi05_build_expert_block_graph(
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
  Pi05AdaSplit a = pi05_build_adarms_split_graph(
      ctx, cond, w.pre_attn_ada_w, w.pre_attn_ada_b, expert_hidden);
  if (a.scale == nullptr) {
    return nullptr;
  }

  struct ggml_tensor* h =
      pi05_adarms_apply(ctx, x_exp, a.scale, a.shift, rms_norm_eps);

  // ── Q, K, V projections (Gemma-1 expert has no attn bias) ─────────
  struct ggml_tensor* q = pi05_linear(ctx, h, w.attn_q_w, nullptr);
  struct ggml_tensor* k_exp = pi05_linear(ctx, h, w.attn_k_w, nullptr);
  struct ggml_tensor* v_exp = pi05_linear(ctx, h, w.attn_v_w, nullptr);

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
  // already — no permute needed, just `ggml_cont` so we can concat with
  // the expert tensors. (cached_k/v come straight from the caller; if
  // they're already contiguous this is a cheap no-op in ggml.)
  struct ggml_tensor* k_cached_c = ggml_cont(ctx, cached_k);
  struct ggml_tensor* v_cached_c = ggml_cont(ctx, cached_v);

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
  struct ggml_tensor* proj = pi05_linear(ctx, attn_out, w.attn_o_w, nullptr);
  // Gated residual: x + ada_gate * proj  (per-channel multiply,
  // broadcasts the (expert_hidden,) gate across n_act).
  h = ggml_add(ctx, x_exp, ggml_mul(ctx, proj, a.gate));

  // ── Pre-FFW adaRMSNorm + GeGLU MLP + gated residual ────────────────
  Pi05AdaSplit b = pi05_build_adarms_split_graph(
      ctx, cond, w.pre_ffw_ada_w, w.pre_ffw_ada_b, expert_hidden);
  if (b.scale == nullptr) {
    return nullptr;
  }
  struct ggml_tensor* normed_ffw =
      pi05_adarms_apply(ctx, h, b.scale, b.shift, rms_norm_eps);
  struct ggml_tensor* gate = pi05_linear(ctx, normed_ffw, w.mlp_gate_w, nullptr);
  struct ggml_tensor* up = pi05_linear(ctx, normed_ffw, w.mlp_up_w, nullptr);
  gate = ggml_gelu(ctx, gate);
  struct ggml_tensor* ff = ggml_mul(ctx, gate, up);
  struct ggml_tensor* down = pi05_linear(ctx, ff, w.mlp_down_w, nullptr);
  return ggml_add(ctx, h, ggml_mul(ctx, down, b.gate));
}

// ── M3.10: full expert pass (18 blocks + final adaRMSNorm + action_out) ─
Pi05ExpertODEStepOutputs pi05_build_expert_ode_step_graph(
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
    h = pi05_build_expert_block_graph(
        ctx, h, act_positions, cached_k[i], cached_v[i], cond,
        blocks[i],
        expert_hidden, n_heads, n_kv_heads, head_dim,
        prefix_len, n_act, rms_norm_eps, rope_freq_base);
    if (h == nullptr) {
      return out;
    }
  }
  // Final adaRMSNorm — same modulation form as the per-block norms.
  Pi05AdaSplit fin = pi05_build_adarms_split_graph(
      ctx, cond, final_norm_ada_w, final_norm_ada_b, expert_hidden);
  if (fin.scale == nullptr) {
    return out;
  }
  out.final_out = pi05_adarms_apply(
      ctx, h, fin.scale, fin.shift, rms_norm_eps);

  // action_out_proj — Linear(expert_hidden → action_dim).
  out.v_t = pi05_linear(
      ctx, out.final_out, action_out_proj_w, action_out_proj_b);
  return out;
}

// ── M3.11: explicit-Euler ODE step ──────────────────────────────────────
struct ggml_tensor* pi05_build_euler_step_graph(
    struct ggml_context* ctx,
    struct ggml_tensor* x_t,
    struct ggml_tensor* v_t,
    float dt) {
  if (ctx == nullptr || x_t == nullptr || v_t == nullptr) {
    return nullptr;
  }
  return ggml_add(ctx, x_t, ggml_scale(ctx, v_t, dt));
}

Pi05Model::Pi05Model(
    const std::string& /*ggufPath*/,
    bool /*forceCpu*/,
    const std::string& /*backendsDir*/) {
  // Pre-populate sentinel hparams matching the spec in plan §2 so any
  // accessor that fires before this throw — e.g. an over-eager unit test —
  // sees the right shape. Once the load path is implemented, these will be
  // overwritten from the GGUF metadata keys (pi05.action_horizon,
  // pi05.image_resolution, pi05.num_cameras, …).
  hparams_.chunk_size = 50;
  hparams_.action_dim = 32;
  hparams_.max_action_dim = 32;
  hparams_.max_state_dim = 32;
  hparams_.tokenizer_max_length = 200;
  hparams_.vision_image_size = 224;
  hparams_.num_cameras = 3;
  hparams_.state_input_mode = VlaHparamsGeneric::StateInputMode::Discrete;

  throw std::runtime_error(
      "pi05 model loading not yet implemented (Phase 1 stub); "
      "see plan.md Phase 3 for the milestone breakdown");
}

bool Pi05Model::infer(
    const float** /*images*/,
    int /*n_images*/,
    int /*img_width*/,
    int /*img_height*/,
    const float* /*state*/,
    int /*state_dim*/,
    const int32_t* /*lang_tokens*/,
    const bool* /*lang_mask*/,
    int /*lang_len*/,
    const float* /*noise*/,
    float* /*actions_out*/,
    int* /*n_actions_out*/,
    VlaTimingGeneric* /*timing_out*/) {
  throw std::runtime_error("pi05 inference not yet implemented");
}

} // namespace qvac_lib_infer_vla_ggml
