// Make off_t 64-bit on 32-bit POSIX targets so fseeko can address
// past 2 GB (smolvla GGUF is ~2.2 GB). Must precede any system header.
#ifndef _WIN32
#define _FILE_OFFSET_BITS 64
#endif

#include "smolvla.hpp"

#include "../utils/BackendSelection.hpp"
#include "../utils/LoggingMacros.hpp"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <mutex>
#include <numbers>
#include <random>
#include <string>

#ifndef _WIN32
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

static double now_ms() {
  return std::chrono::duration<double, std::milli>(
             std::chrono::high_resolution_clock::now().time_since_epoch())
      .count();
}

// ============================================================
// Utility: GGML graph helpers
// ============================================================

static struct ggml_tensor*
to_f32(struct ggml_context* ctx, struct ggml_tensor* x) {
  if (x && x->type != GGML_TYPE_F32) {
    return ggml_cast(ctx, x, GGML_TYPE_F32);
  }
  return x;
}

static struct ggml_tensor* smolvla_layer_norm(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    struct ggml_tensor* bias, float eps) {
  x = ggml_norm(ctx, x, eps);
  x = ggml_mul(ctx, x, to_f32(ctx, weight));
  if (bias) {
    x = ggml_add(ctx, x, to_f32(ctx, bias));
  }
  return x;
}

static struct ggml_tensor* smolvla_rms_norm(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    float eps) {
  x = ggml_rms_norm(ctx, x, eps);
  x = ggml_mul(ctx, x, to_f32(ctx, weight));
  return x;
}

static struct ggml_tensor*
smolvla_silu(struct ggml_context* ctx, struct ggml_tensor* x) {
  return ggml_silu(ctx, x);
}

// GELU with tanh approximation
static struct ggml_tensor*
smolvla_gelu(struct ggml_context* ctx, struct ggml_tensor* x) {
  return ggml_gelu(ctx, x);
}

// Linear layer: y = x @ W^T + b
// x: (..., in_features)
// weight: (out_features, in_features)
// bias: (out_features,) or NULL
static struct ggml_tensor* smolvla_linear(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    struct ggml_tensor* bias) {
  struct ggml_tensor* out = ggml_mul_mat(ctx, weight, x);
  if (bias) {
    out = ggml_add(ctx, out, to_f32(ctx, bias));
  }
  return out;
}

// ============================================================
// SigLIP Vision Encoder
// ============================================================

// Build patch embedding only (conv2d — CPU-only op)
// Returns: (n_patches, hidden_size) = (1024, 768)
static struct ggml_tensor* build_siglip_patch_embed(
    struct ggml_context* ctx, smolvla_model& model,
    struct ggml_tensor* pixel_values) {
  const auto& hp = model.hparams;
  const auto& vw = model.vision;

  struct ggml_tensor* x = ggml_conv_2d(
      ctx,
      vw.patch_embed_weight,
      pixel_values,
      hp.vision_patch_size,
      hp.vision_patch_size,
      0,
      0,
      1,
      1);

  int n_patches = hp.patches_per_image();
  x = ggml_reshape_2d(ctx, x, n_patches, hp.vision_hidden_size);
  x = ggml_cont(ctx, ggml_transpose(ctx, x));

  if (vw.patch_embed_bias) {
    x = ggml_add(ctx, x, to_f32(ctx, vw.patch_embed_bias));
  }
  if (vw.pos_embed) {
    x = ggml_add(ctx, x, to_f32(ctx, vw.pos_embed));
  }

  return x;
}

// Build SigLIP transformer layers (no conv2d — Vulkan compatible)
// Input: (n_patches, hidden_size) = (1024, 768)
// Output: (n_patches, hidden_size) = (1024, 768)
static struct ggml_tensor* build_siglip_transformer(
    struct ggml_context* ctx, smolvla_model& model, struct ggml_tensor* x) {
  const auto& hp = model.hparams;
  const auto& vw = model.vision;
  int n_patches = hp.patches_per_image();

  // Transformer layers
  for (int i = 0; i < hp.vision_num_layers; i++) {
    const auto& layer = vw.layers[i];

    // Pre-norm (LayerNorm)
    struct ggml_tensor* residual = x;
    x = smolvla_layer_norm(
        ctx, x, layer.ln1_weight, layer.ln1_bias, hp.vision_layer_norm_eps);

    // Multi-head self-attention
    int d = hp.vision_hidden_size;
    int h = hp.vision_num_heads;
    int dh = d / h;

    struct ggml_tensor *q, *k, *v;
    if (layer.qkv_proj_w) {
      struct ggml_tensor* qkv =
          smolvla_linear(ctx, x, layer.qkv_proj_w, layer.qkv_proj_b);
      q = ggml_cont(ctx, ggml_view_2d(ctx, qkv, d, n_patches, qkv->nb[1], 0));
      k = ggml_cont(
          ctx,
          ggml_view_2d(
              ctx, qkv, d, n_patches, qkv->nb[1], d * ggml_element_size(qkv)));
      v = ggml_cont(
          ctx,
          ggml_view_2d(
              ctx,
              qkv,
              d,
              n_patches,
              qkv->nb[1],
              2 * d * ggml_element_size(qkv)));
    } else {
      q = smolvla_linear(ctx, x, layer.q_proj_w, layer.q_proj_b);
      k = smolvla_linear(ctx, x, layer.k_proj_w, layer.k_proj_b);
      v = smolvla_linear(ctx, x, layer.v_proj_w, layer.v_proj_b);
    }

    // Reshape to (n_patches, n_heads, head_dim)
    q = ggml_reshape_3d(ctx, q, dh, h, n_patches);
    k = ggml_reshape_3d(ctx, k, dh, h, n_patches);
    v = ggml_reshape_3d(ctx, v, dh, h, n_patches);

    // Permute for attention: (head_dim, n_patches, n_heads) for GGML matmul
    q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3)); // (dh, L, H)
    k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
    v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

    // Attention: softmax(Q @ K^T / sqrt(d)) @ V — fused scale+softmax.
    struct ggml_tensor* attn = ggml_mul_mat(ctx, k, q); // (L, L, H)
    attn = ggml_soft_max_ext(
        ctx, attn, nullptr, 1.0f / sqrtf((float)dh), 0.0f);
    struct ggml_tensor* attn_out = ggml_mul_mat(
        ctx, ggml_cont(ctx, ggml_transpose(ctx, v)), attn); // (dh, L, H)

    // Reshape back to (n_patches, hidden_size)
    attn_out =
        ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3)); // (dh, H, L)
    attn_out = ggml_reshape_2d(ctx, attn_out, d, n_patches);

    // Output projection
    x = smolvla_linear(ctx, attn_out, layer.out_proj_w, layer.out_proj_b);

    // Residual
    x = ggml_add(ctx, x, residual);

    // Post-norm + MLP
    residual = x;
    x = smolvla_layer_norm(
        ctx, x, layer.ln2_weight, layer.ln2_bias, hp.vision_layer_norm_eps);

    // MLP: fc1 -> GELU -> fc2
    x = smolvla_linear(ctx, x, layer.fc1_weight, layer.fc1_bias);
    x = smolvla_gelu(ctx, x);
    x = smolvla_linear(ctx, x, layer.fc2_weight, layer.fc2_bias);

    // Residual
    x = ggml_add(ctx, x, residual);
  }

  // Post-LayerNorm
  if (vw.post_ln_weight) {
    x = smolvla_layer_norm(
        ctx, x, vw.post_ln_weight, vw.post_ln_bias, hp.vision_layer_norm_eps);
  }

  // x is now (1024, 768)
  return x;
}

// Full SigLIP: patch embed + transformer
struct ggml_tensor* build_siglip_graph(
    struct ggml_context* ctx, smolvla_model& model,
    struct ggml_tensor* pixel_values) {
  struct ggml_tensor* patches =
      build_siglip_patch_embed(ctx, model, pixel_values);
  return build_siglip_transformer(ctx, model, patches);
}

// ============================================================
// Connector: PixelShuffle + MLP projection
// ============================================================

struct ggml_tensor* build_connector_graph(
    struct ggml_context* ctx, smolvla_model& model,
    struct ggml_tensor* vision_output) // (1024, 768)
{
  const auto& hp = model.hparams;
  int sf = hp.connector_scale_factor;      // 4
  int n_patches = hp.patches_per_image();  // 1024
  int side = (int)sqrtf((float)n_patches); // 32
  int d = hp.vision_hidden_size;           // 768

  // PixelShuffle:
  // Input: (1024, 768) = (32*32, 768)
  // Step 1: reshape to (32, 32, 768)
  struct ggml_tensor* x = ggml_reshape_3d(ctx, vision_output, d, side, side);

  // Step 2: reshape to (32, 8, 768*4) -- group width by scale_factor
  x = ggml_reshape_3d(ctx, x, d * sf, side / sf, side);

  // Step 3: permute to (8, 32, 768*4) -> (8, 8, 768*16)
  x = ggml_cont(ctx, ggml_permute(ctx, x, 0, 2, 1, 3));
  x = ggml_reshape_3d(ctx, x, d * sf * sf, side / sf, side / sf);

  // Step 4: permute back and reshape to (64, 12288)
  x = ggml_cont(ctx, ggml_permute(ctx, x, 0, 2, 1, 3));
  int n_tokens = hp.tokens_per_image();               // 64
  x = ggml_reshape_2d(ctx, x, d * sf * sf, n_tokens); // (64, 12288)

  // MLP projection: Linear(12288, 960, bias=False)
  x = smolvla_linear(ctx, x, model.connector.proj_weight, nullptr);

  return x; // (64, 960)
}

// ============================================================
// SmolLM2 Transformer Block (single layer)
// ============================================================

// Single transformer layer (SmolLM2 or Expert)
// If kv_key_out / kv_val_out are non-null, stores post-RoPE K/V tensors (before
// GQA repeat)
static struct ggml_tensor* build_transformer_layer(
    struct ggml_context* ctx,
    struct ggml_tensor* hidden_states, // (seq_len, hidden_size)
    const transformer_layer_weights& lw, struct ggml_tensor* position_ids,
    int num_heads, int num_kv_heads, int head_dim, float rms_eps,
    struct ggml_tensor* attn_mask = nullptr,
    struct ggml_tensor** kv_key_out = nullptr,
    struct ggml_tensor** kv_val_out = nullptr) {
  int seq_len = hidden_states->ne[1];

  // Pre-attention RMSNorm
  struct ggml_tensor* residual = hidden_states;
  hidden_states =
      smolvla_rms_norm(ctx, hidden_states, lw.attn_norm_weight, rms_eps);

  // QKV projections — fused or unfused
  struct ggml_tensor *q, *k, *v;
  int q_dim = num_heads * head_dim;
  int kv_dim_each = num_kv_heads * head_dim;

  if (lw.qkv_proj_weight) {
    // Fused: one matmul, then split via views
    struct ggml_tensor* qkv =
        ggml_mul_mat(ctx, lw.qkv_proj_weight, hidden_states);
    q = ggml_view_2d(ctx, qkv, q_dim, seq_len, qkv->nb[1], 0);
    k = ggml_view_2d(
        ctx,
        qkv,
        kv_dim_each,
        seq_len,
        qkv->nb[1],
        q_dim * ggml_element_size(qkv));
    v = ggml_view_2d(
        ctx,
        qkv,
        kv_dim_each,
        seq_len,
        qkv->nb[1],
        (q_dim + kv_dim_each) * ggml_element_size(qkv));
    q = ggml_cont(ctx, q);
    k = ggml_cont(ctx, k);
    v = ggml_cont(ctx, v);
  } else {
    q = smolvla_linear(ctx, hidden_states, lw.q_proj_weight, nullptr);
    k = smolvla_linear(ctx, hidden_states, lw.k_proj_weight, nullptr);
    v = smolvla_linear(ctx, hidden_states, lw.v_proj_weight, nullptr);
  }

  // Reshape to multi-head before RoPE
  q = ggml_reshape_3d(ctx, q, head_dim, num_heads, seq_len);
  k = ggml_reshape_3d(ctx, k, head_dim, num_kv_heads, seq_len);
  v = ggml_reshape_3d(ctx, v, head_dim, num_kv_heads, seq_len);

  // Apply RoPE
  if (position_ids) {
    q = ggml_rope(ctx, q, position_ids, head_dim, GGML_ROPE_TYPE_NEOX);
    k = ggml_rope(ctx, k, position_ids, head_dim, GGML_ROPE_TYPE_NEOX);
  }

  // Store KV cache (post-RoPE, pre-GQA-repeat) if requested
  if (kv_key_out)
    *kv_key_out = k;
  if (kv_val_out)
    *kv_val_out = v;

  // GQA repeat for attention computation
  int kv_groups = num_heads / num_kv_heads;
  struct ggml_tensor* k_expanded = k;
  struct ggml_tensor* v_expanded = v;
  if (kv_groups > 1) {
    k_expanded = ggml_reshape_4d(ctx, k, head_dim, 1, num_kv_heads, seq_len);
    k_expanded = ggml_repeat(
        ctx,
        k_expanded,
        ggml_new_tensor_4d(
            ctx, k->type, head_dim, kv_groups, num_kv_heads, seq_len));
    k_expanded = ggml_reshape_3d(ctx, k_expanded, head_dim, num_heads, seq_len);

    v_expanded = ggml_reshape_4d(ctx, v, head_dim, 1, num_kv_heads, seq_len);
    v_expanded = ggml_repeat(
        ctx,
        v_expanded,
        ggml_new_tensor_4d(
            ctx, v->type, head_dim, kv_groups, num_kv_heads, seq_len));
    v_expanded = ggml_reshape_3d(ctx, v_expanded, head_dim, num_heads, seq_len);
  }

  // Attention computation. ggml_flash_attn_ext was measured ~3× slower
  // per layer on Intel Iris Xe Vulkan (correct F16-mask + GGML_PREC_F32
  // recipe). Not yet benchmarked on Adreno OpenCL or Mali.
  q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  k_expanded = ggml_cont(ctx, ggml_permute(ctx, k_expanded, 0, 2, 1, 3));
  v_expanded = ggml_cont(ctx, ggml_permute(ctx, v_expanded, 0, 2, 1, 3));

  struct ggml_tensor* attn_weights = ggml_mul_mat(ctx, k_expanded, q);
  // Fused scale + (optional) mask + softmax.
  attn_weights = ggml_soft_max_ext(
      ctx, attn_weights, attn_mask, 1.0f / sqrtf((float)head_dim), 0.0f);

  struct ggml_tensor* attn_out = ggml_mul_mat(
      ctx, ggml_cont(ctx, ggml_transpose(ctx, v_expanded)), attn_weights);

  attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
  attn_out = ggml_reshape_2d(ctx, attn_out, num_heads * head_dim, seq_len);

  // Output projection
  attn_out = smolvla_linear(ctx, attn_out, lw.o_proj_weight, nullptr);

  // Residual connection
  hidden_states = ggml_add(ctx, attn_out, residual);

  // Post-attention RMSNorm + MLP
  residual = hidden_states;
  hidden_states =
      smolvla_rms_norm(ctx, hidden_states, lw.ffn_norm_weight, rms_eps);

  // SwiGLU MLP — fused or unfused
  struct ggml_tensor *gate, *up;
  if (lw.gate_up_weight) {
    struct ggml_tensor* gu =
        ggml_mul_mat(ctx, lw.gate_up_weight, hidden_states);
    int inter = lw.gate_up_weight->ne[1] / 2;
    gate = ggml_view_2d(ctx, gu, inter, seq_len, gu->nb[1], 0);
    up = ggml_view_2d(
        ctx, gu, inter, seq_len, gu->nb[1], inter * ggml_element_size(gu));
    gate = ggml_cont(ctx, gate);
    up = ggml_cont(ctx, up);
  } else {
    gate = smolvla_linear(ctx, hidden_states, lw.gate_proj_weight, nullptr);
    up = smolvla_linear(ctx, hidden_states, lw.up_proj_weight, nullptr);
  }
  // Fused SwiGLU: silu(gate) * up.
  struct ggml_tensor* mlp_out = ggml_swiglu_split(ctx, gate, up);
  mlp_out = smolvla_linear(ctx, mlp_out, lw.down_proj_weight, nullptr);

  // Residual
  hidden_states = ggml_add(ctx, mlp_out, residual);

  return hidden_states;
}

// ============================================================
// SmolLM2 Forward (build KV cache from prefix tokens)
// ============================================================

// Build computation graph for SmolLM2 forward pass
// Takes concatenated prefix tokens: visual_tokens + language_embeddings +
// state_embedding Outputs final hidden states and per-layer KV cache for the
// action expert
struct ggml_tensor* build_smollm2_graph(
    struct ggml_context* ctx, smolvla_model& model,
    struct ggml_tensor*
        prefix_embeddings,            // (prefix_len, 960) -- already embedded
    struct ggml_tensor* position_ids, // (prefix_len,)
    struct ggml_tensor* attn_mask,    // (prefix_len, prefix_len) or NULL
    std::vector<struct ggml_tensor*>& kv_keys_out, // output: per-layer keys
    std::vector<struct ggml_tensor*>& kv_vals_out, // output: per-layer values
    std::vector<struct ggml_tensor*>*
        layer_outputs) // optional: per-layer hidden states
{
  const auto& hp = model.hparams;
  const auto& tw = model.text;

  kv_keys_out.resize(hp.text_num_layers);
  kv_vals_out.resize(hp.text_num_layers);
  if (layer_outputs)
    layer_outputs->resize(hp.text_num_layers);

  struct ggml_tensor* x = prefix_embeddings;

  for (int i = 0; i < hp.text_num_layers; i++) {
    x = build_transformer_layer(
        ctx,
        x,
        tw.layers[i],
        position_ids,
        hp.text_num_heads,
        hp.text_num_kv_heads,
        hp.text_head_dim,
        hp.text_rms_norm_eps,
        attn_mask,
        &kv_keys_out[i],
        &kv_vals_out[i]);

    if (layer_outputs) {
      char name[32];
      snprintf(name, sizeof(name), "layer%02d", i);
      ggml_set_name(x, name);
      ggml_set_output(x);
      (*layer_outputs)[i] = x;
    }
  }

  // Final RMSNorm
  x = smolvla_rms_norm(ctx, x, tw.final_norm_weight, hp.text_rms_norm_eps);

  return x; // (prefix_len, 960)
}

// ============================================================
// Sinusoidal Time Embedding
// ============================================================

void compute_sinusoidal_time_embedding_cached(
    float timestep, const float* inv_periods, int dimension, float* out) {
  const int half_dim = dimension / 2;
  const float two_pi_t = 2.0f * std::numbers::pi_v<float> * timestep;
  for (int i = 0; i < half_dim; i++) {
    const float angle = inv_periods[i] * two_pi_t;
    out[i] = sinf(angle);
    out[half_dim + i] = cosf(angle);
  }
}

// ============================================================
// Action Expert: Full forward with ODE loop
// ============================================================

// Build graph for a single denoising step through the action expert
// x_t: (chunk_size, max_action_dim) - current noisy actions
// timestep: scalar
// vlm_kv: cached key/values from SmolLM2 (per layer)
// Returns: velocity v_t of shape (chunk_size, max_action_dim)
struct ggml_tensor* build_denoise_step_graph(
    struct ggml_context* ctx, smolvla_model& model,
    struct ggml_tensor* x_t,          // (chunk_size, max_action_dim=32)
    struct ggml_tensor* time_embed,   // (chunk_size, expert_hidden_size=720)
    struct ggml_tensor** vlm_kv_keys, // per-layer cached keys
    struct ggml_tensor** vlm_kv_vals, // per-layer cached values
    struct ggml_tensor*
        position_ids, // (chunk_size,) - self-attn positions (e.g. 198..247)
    struct ggml_tensor*
        cross_pos_ids, // (chunk_size,) - cross-attn positions (e.g. 0..49)
    struct ggml_tensor* cross_attn_mask, // (chunk_size, prefix_len)
    struct ggml_tensor* self_attn_mask)  // (chunk_size, prefix_len+chunk_size)
{
  const auto& hp = model.hparams;
  const auto& ew = model.expert;

  // 1. Project noisy actions to expert dim
  struct ggml_tensor* action_emb = smolvla_linear(
      ctx, x_t, model.action_in_proj_weight, model.action_in_proj_bias);
  // action_emb: (chunk_size, 720)

  // 2. Concatenate action_emb and time_embed, then MLP
  struct ggml_tensor* action_time = ggml_concat(ctx, action_emb, time_embed, 0);
  // action_time: (chunk_size, 1440)

  action_time = smolvla_linear(
      ctx,
      action_time,
      model.action_time_mlp_in_weight,
      model.action_time_mlp_in_bias);
  action_time = smolvla_silu(ctx, action_time);
  action_time = smolvla_linear(
      ctx,
      action_time,
      model.action_time_mlp_out_weight,
      model.action_time_mlp_out_bias);
  // action_time: (chunk_size, 720)

  // 3. Run through expert layers (interleaved self-attn / cross-attn)
  struct ggml_tensor* hidden = action_time;
  int chunk_size = hp.chunk_size;
  int head_dim = hp.expert_head_dim;
  int num_heads = hp.expert_num_heads;
  int num_kv_heads = hp.expert_num_kv_heads;
  int kv_groups = num_heads / num_kv_heads;

  for (int i = 0; i < hp.expert_num_layers; i++) {
    bool is_self_attn =
        (hp.self_attn_every_n > 0) && (i % hp.self_attn_every_n == 0);
    const auto& lw = ew.layers[i];

    // Pre-attention RMSNorm
    struct ggml_tensor* residual = hidden;
    struct ggml_tensor* normed = smolvla_rms_norm(
        ctx, hidden, lw.attn_norm_weight, hp.expert_rms_norm_eps);

    if (is_self_attn) {
      // SELF-ATTENTION: Q from expert, K/V = concat(VLM_cached, expert)
      struct ggml_tensor *q, *k_expert, *v_expert;
      int q_dim = num_heads * head_dim;
      int kv_dim_each = num_kv_heads * head_dim;

      if (lw.qkv_proj_weight) {
        struct ggml_tensor* qkv = ggml_mul_mat(ctx, lw.qkv_proj_weight, normed);
        q = ggml_cont(
            ctx, ggml_view_2d(ctx, qkv, q_dim, chunk_size, qkv->nb[1], 0));
        k_expert = ggml_cont(
            ctx,
            ggml_view_2d(
                ctx,
                qkv,
                kv_dim_each,
                chunk_size,
                qkv->nb[1],
                q_dim * ggml_element_size(qkv)));
        v_expert = ggml_cont(
            ctx,
            ggml_view_2d(
                ctx,
                qkv,
                kv_dim_each,
                chunk_size,
                qkv->nb[1],
                (q_dim + kv_dim_each) * ggml_element_size(qkv)));
      } else {
        q = smolvla_linear(ctx, normed, lw.q_proj_weight, nullptr);
        k_expert = smolvla_linear(ctx, normed, lw.k_proj_weight, nullptr);
        v_expert = smolvla_linear(ctx, normed, lw.v_proj_weight, nullptr);
      }

      // Reshape to multi-head
      q = ggml_reshape_3d(ctx, q, head_dim, num_heads, chunk_size);
      k_expert =
          ggml_reshape_3d(ctx, k_expert, head_dim, num_kv_heads, chunk_size);
      v_expert =
          ggml_reshape_3d(ctx, v_expert, head_dim, num_kv_heads, chunk_size);

      // Apply RoPE to expert Q and K
      q = ggml_rope(ctx, q, position_ids, head_dim, GGML_ROPE_TYPE_NEOX);
      k_expert =
          ggml_rope(ctx, k_expert, position_ids, head_dim, GGML_ROPE_TYPE_NEOX);

      // Concatenate VLM cached K/V with expert K/V
      // VLM cache: (head_dim, num_kv_heads, prefix_len) already post-RoPE
      struct ggml_tensor* k_full =
          ggml_concat(ctx, vlm_kv_keys[i], k_expert, 2); // concat on seq dim
      struct ggml_tensor* v_full =
          ggml_concat(ctx, vlm_kv_vals[i], v_expert, 2);

      int full_len = k_full->ne[2]; // prefix_len + chunk_size

      // GQA repeat
      struct ggml_tensor* k_exp = k_full;
      struct ggml_tensor* v_exp = v_full;
      if (kv_groups > 1) {
        k_exp =
            ggml_reshape_4d(ctx, k_full, head_dim, 1, num_kv_heads, full_len);
        k_exp = ggml_repeat(
            ctx,
            k_exp,
            ggml_new_tensor_4d(
                ctx,
                k_full->type,
                head_dim,
                kv_groups,
                num_kv_heads,
                full_len));
        k_exp = ggml_reshape_3d(ctx, k_exp, head_dim, num_heads, full_len);

        v_exp =
            ggml_reshape_4d(ctx, v_full, head_dim, 1, num_kv_heads, full_len);
        v_exp = ggml_repeat(
            ctx,
            v_exp,
            ggml_new_tensor_4d(
                ctx,
                v_full->type,
                head_dim,
                kv_groups,
                num_kv_heads,
                full_len));
        v_exp = ggml_reshape_3d(ctx, v_exp, head_dim, num_heads, full_len);
      }

      // Attention
      q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
      k_exp = ggml_cont(ctx, ggml_permute(ctx, k_exp, 0, 2, 1, 3));
      v_exp = ggml_cont(ctx, ggml_permute(ctx, v_exp, 0, 2, 1, 3));

      struct ggml_tensor* attn_weights = ggml_mul_mat(ctx, k_exp, q);
      // Fused scale + mask + softmax.
      attn_weights = ggml_soft_max_ext(
          ctx,
          attn_weights,
          self_attn_mask,
          1.0f / sqrtf((float)head_dim),
          0.0f);

      struct ggml_tensor* attn_out = ggml_mul_mat(
          ctx, ggml_cont(ctx, ggml_transpose(ctx, v_exp)), attn_weights);

      attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
      attn_out =
          ggml_reshape_2d(ctx, attn_out, num_heads * head_dim, chunk_size);

      // O projection + residual
      attn_out = smolvla_linear(ctx, attn_out, lw.o_proj_weight, nullptr);
      hidden = ggml_add(ctx, attn_out, residual);

    } else {
      // CROSS-ATTENTION: Q from expert; K/V arrive pre-projected.
      //
      // The action expert's per-layer `k_proj` / `v_proj` only depend on the
      // VLM KV cache, which is fixed across the 10 ODE denoise steps.
      // `smolvla_inference_with_timing` runs those projections once per
      // inference and overwrites `kv_keys_data[i]` / `kv_vals_data[i]`
      // for cross-attn layers, so here we use the input slot directly.
      struct ggml_tensor* q =
          smolvla_linear(ctx, normed, lw.q_proj_weight, nullptr);

      struct ggml_tensor* k = vlm_kv_keys[i];
      struct ggml_tensor* v = vlm_kv_vals[i];

      int kv_len = vlm_kv_keys[i]->ne[1]; // prefix_len

      // Reshape to multi-head
      q = ggml_reshape_3d(ctx, q, head_dim, num_heads, chunk_size);
      k = ggml_reshape_3d(ctx, k, head_dim, num_kv_heads, kv_len);
      v = ggml_reshape_3d(ctx, v, head_dim, num_kv_heads, kv_len);

      // RoPE only on Q, with positions starting from 0
      // PyTorch: expert_position_id = position_ids - min(position_ids) ->
      // [0,1,...,49]
      q = ggml_rope(ctx, q, cross_pos_ids, head_dim, GGML_ROPE_TYPE_NEOX);
      // NO RoPE on K (keys are projected fresh from VLM cache, not
      // position-dependent)

      // GQA repeat
      if (kv_groups > 1) {
        k = ggml_reshape_4d(ctx, k, head_dim, 1, num_kv_heads, kv_len);
        k = ggml_repeat(
            ctx,
            k,
            ggml_new_tensor_4d(
                ctx, k->type, head_dim, kv_groups, num_kv_heads, kv_len));
        k = ggml_reshape_3d(ctx, k, head_dim, num_heads, kv_len);

        v = ggml_reshape_4d(ctx, v, head_dim, 1, num_kv_heads, kv_len);
        v = ggml_repeat(
            ctx,
            v,
            ggml_new_tensor_4d(
                ctx, v->type, head_dim, kv_groups, num_kv_heads, kv_len));
        v = ggml_reshape_3d(ctx, v, head_dim, num_heads, kv_len);
      }

      // Attention
      q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
      k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
      v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

      struct ggml_tensor* attn_weights = ggml_mul_mat(ctx, k, q);
      // Fused scale + mask + softmax.
      attn_weights = ggml_soft_max_ext(
          ctx,
          attn_weights,
          cross_attn_mask,
          1.0f / sqrtf((float)head_dim),
          0.0f);

      struct ggml_tensor* attn_out = ggml_mul_mat(
          ctx, ggml_cont(ctx, ggml_transpose(ctx, v)), attn_weights);

      attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
      attn_out =
          ggml_reshape_2d(ctx, attn_out, num_heads * head_dim, chunk_size);

      // O projection + residual
      attn_out = smolvla_linear(ctx, attn_out, lw.o_proj_weight, nullptr);
      hidden = ggml_add(ctx, attn_out, residual);
    }

    // Post-attention RMSNorm + MLP (same for both types)
    residual = hidden;
    hidden = smolvla_rms_norm(
        ctx, hidden, lw.ffn_norm_weight, hp.expert_rms_norm_eps);

    struct ggml_tensor *e_gate, *e_up;
    if (lw.gate_up_weight) {
      struct ggml_tensor* gu = ggml_mul_mat(ctx, lw.gate_up_weight, hidden);
      int inter = lw.gate_up_weight->ne[1] / 2;
      e_gate = ggml_cont(
          ctx, ggml_view_2d(ctx, gu, inter, chunk_size, gu->nb[1], 0));
      e_up = ggml_cont(
          ctx,
          ggml_view_2d(
              ctx,
              gu,
              inter,
              chunk_size,
              gu->nb[1],
              inter * ggml_element_size(gu)));
    } else {
      e_gate = smolvla_linear(ctx, hidden, lw.gate_proj_weight, nullptr);
      e_up = smolvla_linear(ctx, hidden, lw.up_proj_weight, nullptr);
    }
    // Fused SwiGLU: silu(e_gate) * e_up.
    struct ggml_tensor* mlp_out = ggml_swiglu_split(ctx, e_gate, e_up);
    mlp_out = smolvla_linear(ctx, mlp_out, lw.down_proj_weight, nullptr);

    hidden = ggml_add(ctx, mlp_out, residual);
  }

  // 4. Final RMSNorm
  hidden = smolvla_rms_norm(
      ctx, hidden, ew.final_norm_weight, hp.expert_rms_norm_eps);

  // 5. Project back to action space
  struct ggml_tensor* v_t = smolvla_linear(
      ctx, hidden, model.action_out_proj_weight, model.action_out_proj_bias);
  // v_t: (chunk_size, max_action_dim=32)

  return v_t;
}

// ============================================================
// GGUF Loading
// ============================================================

// Helper to find a tensor by name in a GGUF context
static struct ggml_tensor*
get_tensor(struct ggml_context* ctx, const char* name) {
  struct ggml_tensor* t = ggml_get_tensor(ctx, name);
  if (!t) {
    QLOG_IF(
        Priority::WARNING,
        std::string("tensor '") + name + "' not found in GGUF");
  }
  return t;
}

// Helper to read a uint32 from GGUF metadata
static uint32_t
gguf_get_u32(struct gguf_context* gguf, const char* key, uint32_t default_val) {
  int64_t idx = gguf_find_key(gguf, key);
  if (idx < 0)
    return default_val;
  return gguf_get_val_u32(gguf, idx);
}

// Helper to assign a tensor pointer by name
static struct ggml_tensor*
gguf_get_tensor_by_name(struct ggml_context* ctx, const char* name) {
  struct ggml_tensor* t = ggml_get_tensor(ctx, name);
  if (!t) {
    QLOG_IF(
        Priority::WARNING, std::string("tensor '") + name + "' not found");
  }
  return t;
}

// RAII helpers used only inside smolvla_load_model. File-scope, not part of
// the public API: keeps the load function readable across its many error
// paths without leaking fds or gguf contexts when something goes wrong.

#ifndef _WIN32
namespace {
// Minimal close-on-scope-exit guard for a POSIX file descriptor. Used by the
// mmap fast path so every early-return branch releases `fd` automatically.
class FdGuard {
public:
  explicit FdGuard(int fd) : fd_(fd) {}
  ~FdGuard() {
    if (fd_ >= 0) {
      ::close(fd_);
    }
  }
  FdGuard(const FdGuard&) = delete;
  FdGuard& operator=(const FdGuard&) = delete;
  int get() const { return fd_; }
  // mmap(2) keeps a ref to the file as long as the mapping lives, so fast-path
  // callers want to close the fd as soon as the mapping is established. After
  // a manual close the destructor must not double-close.
  void release() { fd_ = -1; }

private:
  int fd_;
};
} // namespace
#endif

namespace {
struct gguf_deleter {
  void operator()(gguf_context* g) const {
    if (g) {
      gguf_free(g);
    }
  }
};
using gguf_unique_ptr = std::unique_ptr<gguf_context, gguf_deleter>;
} // namespace

// Discover ggml backend plugins (Vulkan / Metal / OpenCL / …) shipped next to
// the addon. Both `ggml_backend_load_all*` registrations are global state
// inside the ggml plugin loader; running them more than once is wasteful and,
// on some platforms (qvac-fabric Android OpenCL build), races the .so init.
// Wrapping the registration in std::call_once gives an explicit one-thread
// init contract instead of the previous read-act-update on a plain bool.
// backendsDir must be the absolute path to the prebuilds folder (the JS layer
// defaults it to path.join(__dirname, 'prebuilds')). BACKENDS_SUBDIR is then
// appended as a relative sub-path so dlopen resolves from an absolute base
// instead of the process CWD — critical on mobile where CWD is unpredictable.
static void load_backends_once(const std::string& backendsDir) {
  static std::once_flag s_backends_once;
  std::call_once(s_backends_once, [backendsDir]() {
    if (!backendsDir.empty()) {
      std::filesystem::path p(backendsDir);
#ifdef BACKENDS_SUBDIR
      p = (p / std::filesystem::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
      QLOG_IF(Priority::INFO, "Loading backends from: " + p.string());
      ggml_backend_load_all_from_path(p.string().c_str());
    } else {
      ggml_backend_load_all();
    }
  });
}

// Initialise the CPU backend — always required, both as a primary on
// CPU-only platforms and as a fallback target for ops the GPU backend
// rejects. Uses the device API so it works under Android's
// GGML_BACKEND_DL=ON build, where `ggml_backend_cpu_init` lives in a
// separately-loaded .so.
static bool init_cpu_backend(smolvla_model& model) {
  ggml_backend_dev_t cpu_dev =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  model.backend_cpu = cpu_dev ? ggml_backend_dev_init(cpu_dev, nullptr) : nullptr;
  if (!model.backend_cpu) {
    QLOG_IF(Priority::ERROR, "smolvla_load_model: failed to init CPU backend");
    return false;
  }
  model.backend = model.backend_cpu;
  model.has_gpu = false;
  return true;
}

// Try to upgrade `model.backend` to a GPU device. Failures here are
// non-fatal: we keep the CPU backend already wired by `init_cpu_backend`.
// Adreno GPUs are filtered out by `vla_backend_selection::pickBestGpuDevice`
// so older Snapdragon devices fall through to CPU rather than crash on
// `ggml_backend_dev_init`. `force_cpu=true` skips selection entirely so the
// integration test can run the same hardware both ways.
static void try_init_gpu_backend(smolvla_model& model, bool force_cpu) {
  if (force_cpu) {
    QLOG_IF(
        Priority::INFO,
        "smolvla_load_model: force_cpu=true — skipping GPU selection");
  }
  ggml_backend_dev_t gpu =
      force_cpu ? nullptr : vla_backend_selection::pickBestGpuDevice();
  if (!gpu) {
    return;
  }
  ggml_backend_t gpu_backend = ggml_backend_dev_init(gpu, nullptr);
  if (!gpu_backend) {
    return;
  }
  model.backend = gpu_backend;
  model.has_gpu = true;
  const char* bname = ggml_backend_name(gpu_backend);
  const char* ddesc = ggml_backend_dev_description(gpu);
  QLOG_IF(
      Priority::INFO,
      std::string("smolvla_load_model: using GPU backend: ") +
          (bname ? bname : "?") + " (" + (ddesc ? ddesc : "?") + ")");
}

// Read SmolVLA hyperparameters from GGUF metadata. All keys have defaults
// matching the production `smolvla_libero` shape so older fixtures missing
// a key still load. Caller is expected to validate the resulting hparams
// before any sizing arithmetic.
static void read_hparams_from_gguf(gguf_context* gguf, smolvla_hparams& hp) {
  hp.vision_hidden_size = gguf_get_u32(gguf, "smolvla.vision.hidden_size", 768);
  hp.vision_intermediate =
      gguf_get_u32(gguf, "smolvla.vision.intermediate_size", 3072);
  hp.vision_num_layers = gguf_get_u32(gguf, "smolvla.vision.num_layers", 12);
  hp.vision_num_heads = gguf_get_u32(gguf, "smolvla.vision.num_heads", 12);
  hp.vision_image_size = gguf_get_u32(gguf, "smolvla.vision.image_size", 512);
  hp.vision_patch_size = gguf_get_u32(gguf, "smolvla.vision.patch_size", 16);

  hp.connector_scale_factor =
      gguf_get_u32(gguf, "smolvla.connector.scale_factor", 4);

  hp.text_hidden_size = gguf_get_u32(gguf, "smolvla.text.hidden_size", 960);
  hp.text_intermediate =
      gguf_get_u32(gguf, "smolvla.text.intermediate_size", 2560);
  hp.text_num_layers = gguf_get_u32(gguf, "smolvla.text.num_layers", 16);
  hp.text_num_heads = gguf_get_u32(gguf, "smolvla.text.num_heads", 15);
  hp.text_num_kv_heads = gguf_get_u32(gguf, "smolvla.text.num_kv_heads", 5);
  hp.text_head_dim = gguf_get_u32(gguf, "smolvla.text.head_dim", 64);

  hp.expert_hidden_size = gguf_get_u32(gguf, "smolvla.expert.hidden_size", 720);
  hp.expert_intermediate =
      gguf_get_u32(gguf, "smolvla.expert.intermediate_size", 2048);
  hp.expert_num_layers = gguf_get_u32(gguf, "smolvla.expert.num_layers", 16);
  hp.expert_num_heads = gguf_get_u32(gguf, "smolvla.expert.num_heads", 15);
  hp.expert_num_kv_heads = gguf_get_u32(gguf, "smolvla.expert.num_kv_heads", 5);
  hp.self_attn_every_n =
      gguf_get_u32(gguf, "smolvla.expert.self_attn_every_n", 2);

  hp.num_ode_steps = gguf_get_u32(gguf, "smolvla.flow.num_ode_steps", 10);
  hp.chunk_size = gguf_get_u32(gguf, "smolvla.flow.chunk_size", 50);
  hp.max_action_dim = gguf_get_u32(gguf, "smolvla.flow.max_action_dim", 32);
  hp.max_state_dim = gguf_get_u32(gguf, "smolvla.flow.max_state_dim", 32);
  hp.action_dim = gguf_get_u32(gguf, "smolvla.flow.action_dim", 7);
}

// Sanity-check hparams loaded from GGUF before they feed any sizing
// arithmetic. gguf_get_u32 returns uint32; values >INT_MAX wrap to negative
// when assigned to int and would silently produce negative-sized vectors,
// huge tensor allocations, or division-by-zero in the derived helpers.
// Reject the file rather than allocate from a bad shape.
static bool validate_hparams(const smolvla_hparams& hp) {
  auto in_range = [](int v, int lo, int hi) { return v >= lo && v <= hi; };
  return in_range(hp.vision_hidden_size, 1, 65536) &&
         in_range(hp.vision_intermediate, 1, 1 << 20) &&
         in_range(hp.vision_num_layers, 1, 256) &&
         in_range(hp.vision_num_heads, 1, 1024) &&
         in_range(hp.vision_image_size, 1, 16384) &&
         in_range(hp.vision_patch_size, 1, 1024) &&
         in_range(hp.connector_scale_factor, 1, 256) &&
         in_range(hp.text_hidden_size, 1, 65536) &&
         in_range(hp.text_intermediate, 1, 1 << 20) &&
         in_range(hp.text_num_layers, 1, 256) &&
         in_range(hp.text_num_heads, 1, 1024) &&
         in_range(hp.text_num_kv_heads, 1, 1024) &&
         in_range(hp.text_head_dim, 1, 1024) &&
         // expert_hidden_size is divided by 2 for the time-embed half-dim
         // table; require >=2 so the table is non-empty.
         in_range(hp.expert_hidden_size, 2, 65536) &&
         in_range(hp.expert_intermediate, 1, 1 << 20) &&
         in_range(hp.expert_num_layers, 1, 256) &&
         in_range(hp.expert_num_heads, 1, 1024) &&
         in_range(hp.expert_num_kv_heads, 1, 1024) &&
         in_range(hp.self_attn_every_n, 1, 256) &&
         in_range(hp.num_ode_steps, 1, 1024) &&
         in_range(hp.chunk_size, 1, 1024) &&
         in_range(hp.max_action_dim, 1, 1024) &&
         in_range(hp.max_state_dim, 1, 1024) &&
         in_range(hp.action_dim, 1, hp.max_action_dim);
}

// Precompute the per-frequency `1/period` table used by the sinusoidal time
// embedding. Constant across all ODE steps so we pay the powf cost once at
// load instead of per-step on the inference hot path.
static void precompute_time_embedding(smolvla_model& model) {
  const auto& hp = model.hparams;
  const int half_dim = hp.expert_hidden_size / 2;
  model.time_embed_inv_periods.resize(half_dim);
  const float ratio = hp.max_period / hp.min_period;
  for (int i = 0; i < half_dim; i++) {
    const float fraction =
        (half_dim > 1) ? (float)i / (float)(half_dim - 1) : 0.0f;
    const float period = hp.min_period * powf(ratio, fraction);
    model.time_embed_inv_periods[i] = 1.0f / period;
  }
}

// Map every weight tensor referenced by the inference graph to its entry in
// the GGUF context. Missing tensors are left as nullptr — call
// `validate_required_tensors` afterwards to reject GGUFs whose required
// pointers didn't get filled in.
static void map_weight_tensors(struct ggml_context* ctx_data, smolvla_model& model) {
  const auto& hp = model.hparams;

  // Helper: probe-only lookup, no warning if missing (used for the fused/
  // unfused sibling pairs where one of the two is expected to be absent).
  auto try_tensor = [&](const char* name) -> struct ggml_tensor* {
    return ggml_get_tensor(ctx_data, name);
  };

  // Vision encoder
  model.vision.patch_embed_weight =
      gguf_get_tensor_by_name(ctx_data, "v.enc.patch_embd.weight");
  model.vision.patch_embed_bias =
      gguf_get_tensor_by_name(ctx_data, "v.enc.patch_embd.bias");
  model.vision.pos_embed =
      gguf_get_tensor_by_name(ctx_data, "v.enc.pos_embd.weight");
  model.vision.post_ln_weight =
      gguf_get_tensor_by_name(ctx_data, "v.enc.post_ln.weight");
  model.vision.post_ln_bias =
      gguf_get_tensor_by_name(ctx_data, "v.enc.post_ln.bias");

  model.vision.layers.resize(hp.vision_num_layers);
  for (int i = 0; i < hp.vision_num_layers; i++) {
    char buf[256];
    auto& l = model.vision.layers[i];
    memset(&l, 0, sizeof(l));

#define VG(field, fmt)                                                         \
  do {                                                                         \
    snprintf(buf, sizeof(buf), fmt, i);                                        \
    l.field = try_tensor(buf);                                                 \
  } while (0)
    VG(ln1_weight, "v.enc.blk.%d.ln1.weight");
    VG(ln1_bias, "v.enc.blk.%d.ln1.bias");
    VG(qkv_proj_w, "v.enc.blk.%d.attn_qkv.weight");
    VG(qkv_proj_b, "v.enc.blk.%d.attn_qkv.bias");
    VG(q_proj_w, "v.enc.blk.%d.attn_q.weight"); // fallback if not fused
    VG(q_proj_b, "v.enc.blk.%d.attn_q.bias");
    VG(k_proj_w, "v.enc.blk.%d.attn_k.weight");
    VG(k_proj_b, "v.enc.blk.%d.attn_k.bias");
    VG(v_proj_w, "v.enc.blk.%d.attn_v.weight");
    VG(v_proj_b, "v.enc.blk.%d.attn_v.bias");
    VG(out_proj_w, "v.enc.blk.%d.attn_out.weight");
    VG(out_proj_b, "v.enc.blk.%d.attn_out.bias");
    VG(ln2_weight, "v.enc.blk.%d.ln2.weight");
    VG(ln2_bias, "v.enc.blk.%d.ln2.bias");
    VG(fc1_weight, "v.enc.blk.%d.ffn_up.weight");
    VG(fc1_bias, "v.enc.blk.%d.ffn_up.bias");
    VG(fc2_weight, "v.enc.blk.%d.ffn_down.weight");
    VG(fc2_bias, "v.enc.blk.%d.ffn_down.bias");
#undef VG
  }

  // Connector
  model.connector.proj_weight =
      gguf_get_tensor_by_name(ctx_data, "v.connector.proj.weight");

  // Text model (SmolLM2)
  model.text.embed_tokens = gguf_get_tensor_by_name(ctx_data, "t.embed.weight");
  model.text.final_norm_weight =
      gguf_get_tensor_by_name(ctx_data, "t.final_norm.weight");

  auto load_transformer_layers =
      [&](const char* prefix,
          std::vector<transformer_layer_weights>& layers,
          int n_layers) {
        char buf[256];
        layers.resize(n_layers);
        for (int i = 0; i < n_layers; i++) {
          auto& l = layers[i];
          memset(&l, 0, sizeof(l));
#define TG(field, sfx)                                                         \
  do {                                                                         \
    snprintf(buf, sizeof(buf), "%s.%d." sfx, prefix, i);                       \
    l.field = try_tensor(buf);                                                 \
  } while (0)
          TG(attn_norm_weight, "attn_norm.weight");
          TG(qkv_proj_weight, "attn_qkv.weight"); // fused
          TG(q_proj_weight, "attn_q.weight");     // unfused fallback
          TG(k_proj_weight, "attn_k.weight");
          TG(v_proj_weight, "attn_v.weight");
          TG(o_proj_weight, "attn_out.weight");
          TG(ffn_norm_weight, "ffn_norm.weight");
          TG(gate_up_weight, "ffn_gate_up.weight"); // fused
          TG(gate_proj_weight, "ffn_gate.weight");  // unfused fallback
          TG(up_proj_weight, "ffn_up.weight");
          TG(down_proj_weight, "ffn_down.weight");
#undef TG
        }
      };

  load_transformer_layers("t.blk", model.text.layers, hp.text_num_layers);

  // Expert
  model.expert.final_norm_weight = try_tensor("e.final_norm.weight");
  load_transformer_layers("e.blk", model.expert.layers, hp.expert_num_layers);

  // Projections
  model.state_proj_weight =
      gguf_get_tensor_by_name(ctx_data, "proj.state.weight");
  model.state_proj_bias = gguf_get_tensor_by_name(ctx_data, "proj.state.bias");
  model.action_in_proj_weight =
      gguf_get_tensor_by_name(ctx_data, "proj.action_in.weight");
  model.action_in_proj_bias =
      gguf_get_tensor_by_name(ctx_data, "proj.action_in.bias");
  model.action_out_proj_weight =
      gguf_get_tensor_by_name(ctx_data, "proj.action_out.weight");
  model.action_out_proj_bias =
      gguf_get_tensor_by_name(ctx_data, "proj.action_out.bias");
  model.action_time_mlp_in_weight =
      gguf_get_tensor_by_name(ctx_data, "proj.time_mlp_in.weight");
  model.action_time_mlp_in_bias =
      gguf_get_tensor_by_name(ctx_data, "proj.time_mlp_in.bias");
  model.action_time_mlp_out_weight =
      gguf_get_tensor_by_name(ctx_data, "proj.time_mlp_out.weight");
  model.action_time_mlp_out_bias =
      gguf_get_tensor_by_name(ctx_data, "proj.time_mlp_out.bias");
}

// After `map_weight_tensors`, walk every tensor pointer the inference graph
// will read through and reject GGUFs that left a required slot at nullptr.
// Without this, `gguf_get_tensor_by_name` would log a warning and return
// nullptr, the load function would return true, and the first inference would
// dereference nullptr inside ggml.
static bool validate_required_tensors(const smolvla_model& model) {
  // First-failure-wins logger so the GGUF author sees the missing name list,
  // not just the first miss.
  bool ok = true;
  auto require = [&](const ggml_tensor* t, const char* name) {
    if (t == nullptr) {
      QLOG_IF(
          Priority::ERROR,
          std::string("smolvla_load_model: required tensor missing: '") +
              name + "'");
      ok = false;
    }
  };

  // Vision encoder — non-layer
  require(model.vision.patch_embed_weight, "v.enc.patch_embd.weight");
  require(model.vision.patch_embed_bias, "v.enc.patch_embd.bias");
  require(model.vision.pos_embed, "v.enc.pos_embd.weight");
  require(model.vision.post_ln_weight, "v.enc.post_ln.weight");
  require(model.vision.post_ln_bias, "v.enc.post_ln.bias");

  // Vision encoder — per layer. Each block needs ln1/ln2 norm pair, attn
  // out_proj, and feed-forward fc1/fc2; the QKV slot accepts either the fused
  // `attn_qkv.*` weight+bias or the three unfused `attn_{q,k,v}.*` triples.
  for (size_t i = 0; i < model.vision.layers.size(); i++) {
    const auto& l = model.vision.layers[i];
    auto idx = std::to_string(i);
    require(l.ln1_weight, ("v.enc.blk." + idx + ".ln1.weight").c_str());
    require(l.ln1_bias, ("v.enc.blk." + idx + ".ln1.bias").c_str());
    require(l.ln2_weight, ("v.enc.blk." + idx + ".ln2.weight").c_str());
    require(l.ln2_bias, ("v.enc.blk." + idx + ".ln2.bias").c_str());
    require(l.out_proj_w, ("v.enc.blk." + idx + ".attn_out.weight").c_str());
    require(l.out_proj_b, ("v.enc.blk." + idx + ".attn_out.bias").c_str());
    require(l.fc1_weight, ("v.enc.blk." + idx + ".ffn_up.weight").c_str());
    require(l.fc1_bias, ("v.enc.blk." + idx + ".ffn_up.bias").c_str());
    require(l.fc2_weight, ("v.enc.blk." + idx + ".ffn_down.weight").c_str());
    require(l.fc2_bias, ("v.enc.blk." + idx + ".ffn_down.bias").c_str());
    const bool has_fused_qkv = l.qkv_proj_w != nullptr && l.qkv_proj_b != nullptr;
    const bool has_unfused_qkv = l.q_proj_w != nullptr && l.q_proj_b != nullptr &&
                                 l.k_proj_w != nullptr && l.k_proj_b != nullptr &&
                                 l.v_proj_w != nullptr && l.v_proj_b != nullptr;
    if (!has_fused_qkv && !has_unfused_qkv) {
      QLOG_IF(
          Priority::ERROR,
          std::string("smolvla_load_model: vision layer ") + idx +
              " has neither fused 'attn_qkv.*' nor unfused 'attn_{q,k,v}.*' weights/biases");
      ok = false;
    }
  }

  // Connector
  require(model.connector.proj_weight, "v.connector.proj.weight");

  // Text + expert backbones share the transformer-layer schema. Each layer
  // requires its norms, the attention output projection, and the FFN down
  // projection. Attention QKV admits fused `attn_qkv.weight` or the three
  // unfused `attn_{q,k,v}.weight` slots; FFN gate/up admits fused
  // `ffn_gate_up.weight` or the unfused `ffn_gate.weight` + `ffn_up.weight`
  // pair.
  auto require_transformer_layers = [&](
      const char* prefix,
      const std::vector<transformer_layer_weights>& layers) {
    for (size_t i = 0; i < layers.size(); i++) {
      const auto& l = layers[i];
      const std::string base = std::string(prefix) + "." + std::to_string(i);
      require(l.attn_norm_weight, (base + ".attn_norm.weight").c_str());
      require(l.o_proj_weight, (base + ".attn_out.weight").c_str());
      require(l.ffn_norm_weight, (base + ".ffn_norm.weight").c_str());
      require(l.down_proj_weight, (base + ".ffn_down.weight").c_str());
      const bool has_fused_qkv = l.qkv_proj_weight != nullptr;
      const bool has_unfused_qkv = l.q_proj_weight != nullptr &&
                                   l.k_proj_weight != nullptr &&
                                   l.v_proj_weight != nullptr;
      if (!has_fused_qkv && !has_unfused_qkv) {
        QLOG_IF(
            Priority::ERROR,
            base +
                ": neither fused 'attn_qkv.weight' nor unfused 'attn_{q,k,v}.weight'");
        ok = false;
      }
      const bool has_fused_gu = l.gate_up_weight != nullptr;
      const bool has_unfused_gu =
          l.gate_proj_weight != nullptr && l.up_proj_weight != nullptr;
      if (!has_fused_gu && !has_unfused_gu) {
        QLOG_IF(
            Priority::ERROR,
            base +
                ": neither fused 'ffn_gate_up.weight' nor unfused 'ffn_gate.weight'+'ffn_up.weight'");
        ok = false;
      }
    }
  };
  require(model.text.embed_tokens, "t.embed.weight");
  require(model.text.final_norm_weight, "t.final_norm.weight");
  require_transformer_layers("t.blk", model.text.layers);

  require(model.expert.final_norm_weight, "e.final_norm.weight");
  require_transformer_layers("e.blk", model.expert.layers);

  // Projections (state, action_in, action_out, action_time_mlp_in/out)
  require(model.state_proj_weight, "proj.state.weight");
  require(model.state_proj_bias, "proj.state.bias");
  require(model.action_in_proj_weight, "proj.action_in.weight");
  require(model.action_in_proj_bias, "proj.action_in.bias");
  require(model.action_out_proj_weight, "proj.action_out.weight");
  require(model.action_out_proj_bias, "proj.action_out.bias");
  require(model.action_time_mlp_in_weight, "proj.time_mlp_in.weight");
  require(model.action_time_mlp_in_bias, "proj.time_mlp_in.bias");
  require(model.action_time_mlp_out_weight, "proj.time_mlp_out.weight");
  require(model.action_time_mlp_out_bias, "proj.time_mlp_out.bias");

  return ok;
}

// FAST PATH (Apple Metal, CPU): the device reports
// caps.buffer_from_host_ptr=true. mmap the GGUF file, wrap the tensor-data
// region in a backend buffer with `ggml_backend_dev_buffer_from_host_ptr()`,
// and wire each tensor to its position inside the mapping. The Metal backend
// internally slices that range into per-tensor sub-buffers each ≤
// max_tensor_size, so a 2.2 GB f32 model becomes many small Metal sub-buffers
// instead of one shared-mode allocation that iOS Metal cannot service.
//
// Returns true on success (model.bufs_w, model.mmap_addr, model.mmap_size all
// populated). Returns false if any step bailed; caller should fall back to the
// alloc+copy path. Never throws; cleans up any partial state itself.
#ifndef _WIN32
static bool try_load_weights_mmap(
    smolvla_model& model, const char* path, gguf_context* gguf,
    struct ggml_context* ctx_data, ggml_backend_dev_t dev,
    size_t data_offset, int64_t n_tensors_in_gguf) {
  FdGuard fd(open(path, O_RDONLY));
  if (fd.get() < 0) {
    QLOG_IF(
        Priority::WARNING,
        std::string("smolvla_load_model: open() failed for '") + path + "'");
    return false;
  }
  struct stat st {};
  if (fstat(fd.get(), &st) != 0 || st.st_size <= 0 ||
      // Reject malformed/truncated GGUF (data_offset past EOF) before the
      // unsigned subtraction below would wrap to a huge size.
      (uint64_t)data_offset >= (uint64_t)st.st_size ||
      // Guard against off_t→size_t truncation on 32-bit targets where the
      // 2 GB+ GGUF would otherwise alias to a smaller mapping.
      (uint64_t)st.st_size > (uint64_t)SIZE_MAX) {
    QLOG_IF(
        Priority::WARNING,
        std::string("smolvla_load_model: skipping mmap fast path for '") +
            path +
            "' (fstat failed, file empty, data_offset >= file_size, or "
            "file > SIZE_MAX)");
    return false;
  }
  size_t file_size = (size_t)st.st_size;
  void* addr = mmap(nullptr, file_size, PROT_READ, MAP_PRIVATE, fd.get(), 0);
  if (addr == MAP_FAILED) {
    QLOG_IF(
        Priority::WARNING,
        "smolvla_load_model: mmap failed (errno=" +
            std::to_string(errno) + ")");
    return false;
  }
  // The mapping holds a ref to the file, so the fd is no longer needed.
  // Close it explicitly and dismiss the guard so it doesn't double-close.
  ::close(fd.get());
  fd.release();

  void* tensor_data_base = (char*)addr + data_offset;
  size_t tensor_data_size = file_size - data_offset;
  size_t max_tensor_size = ggml_get_max_tensor_size(ctx_data);

  // Reject crafted GGUFs whose per-tensor (offset, nbytes) would point
  // outside the mapped region — a later read through such a tensor
  // would be an out-of-bounds memory access.
  for (int64_t i = 0; i < n_tensors_in_gguf; i++) {
    const char* name = gguf_get_tensor_name(gguf, i);
    struct ggml_tensor* t = ggml_get_tensor(ctx_data, name);
    if (!t) {
      continue;
    }
    size_t off = gguf_get_tensor_offset(gguf, i);
    size_t nbytes = ggml_nbytes(t);
    if (off > tensor_data_size || nbytes > tensor_data_size - off) {
      QLOG_IF(
          Priority::WARNING,
          std::string("smolvla_load_model: tensor '") + name +
              "' bounds exceed mapped region (off=" +
              std::to_string(off) +
              " nbytes=" + std::to_string(nbytes) +
              " region=" + std::to_string(tensor_data_size) +
              ") — falling back to alloc+copy");
      munmap(addr, file_size);
      return false;
    }
  }

  // Hint the OS to prefetch the file so the first inference doesn't
  // demand-page its way through 2+ GB of weights.
  madvise(addr, file_size, MADV_WILLNEED);

  ggml_backend_buffer_t buf = ggml_backend_dev_buffer_from_host_ptr(
      dev, tensor_data_base, tensor_data_size, max_tensor_size);

  if (!buf) {
    QLOG_IF(
        Priority::WARNING,
        "smolvla_load_model: buffer_from_host_ptr returned NULL — "
        "falling back to alloc+copy");
    munmap(addr, file_size);
    return false;
  }

  // Wire each tensor to its position inside the mmap'd region.
  int n_alloc_ok = 0;
  int n_alloc_fail = 0;
  for (int64_t i = 0; i < n_tensors_in_gguf; i++) {
    const char* name = gguf_get_tensor_name(gguf, i);
    struct ggml_tensor* t = ggml_get_tensor(ctx_data, name);
    if (!t) {
      continue;
    }
    size_t off = gguf_get_tensor_offset(gguf, i);
    void* tensor_addr = (char*)tensor_data_base + off;
    if (ggml_backend_tensor_alloc(buf, t, tensor_addr) ==
        GGML_STATUS_SUCCESS) {
      n_alloc_ok++;
    } else {
      n_alloc_fail++;
      QLOG_IF(
          Priority::WARNING,
          std::string("smolvla_load_model: tensor_alloc failed for '") +
              name + "'");
    }
  }

  if (n_alloc_fail > 0) {
    // A partially-wired buffer would leave some tensors with
    // unusable pointers; running inference against it is UB.
    // Tear down and fall through to the alloc+copy path.
    QLOG_IF(
        Priority::WARNING,
        "smolvla_load_model: " + std::to_string(n_alloc_fail) +
            " tensor_alloc calls failed — falling back to alloc+copy");
    ggml_backend_buffer_free(buf);
    munmap(addr, file_size);
    return false;
  }

  ggml_backend_buffer_set_usage(buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
  model.bufs_w.push_back(buf);
  model.mmap_addr = addr;
  model.mmap_size = file_size;
  QLOG_IF(
      Priority::INFO,
      "smolvla_load_model: mmap+host_ptr buffer ready, " +
          std::to_string(n_alloc_ok) + "/" +
          std::to_string(n_tensors_in_gguf) + " tensors wired");
  return true;
}
#endif

// FALLBACK (Vulkan / Android, Windows, or any device without
// buffer_from_host_ptr): allocate the buffer with
// `ggml_backend_alloc_ctx_tensors_from_buft()`, then read tensor data from
// the file and copy via `ggml_backend_tensor_set()`. Same path llama.cpp's
// `else` branch takes.
static bool load_weights_alloc_copy(
    smolvla_model& model, const char* path, gguf_context* gguf,
    struct ggml_context* ctx_data, ggml_backend_buffer_type_t buft,
    size_t data_offset, int64_t n_tensors_in_gguf) {
  size_t total_size = 0;
  for (struct ggml_tensor* t = ggml_get_first_tensor(ctx_data); t;
       t = ggml_get_next_tensor(ctx_data, t)) {
    total_size += ggml_nbytes(t);
  }
  QLOG_IF(
      Priority::INFO,
      "smolvla_load_model: alloc+copy path, total weights " +
          std::to_string((int)(total_size / (1024 * 1024))) + " MB");

  ggml_backend_buffer_t buf =
      ggml_backend_alloc_ctx_tensors_from_buft(ctx_data, buft);
  if (!buf) {
    const char* bname = ggml_backend_name(model.backend);
    QLOG_IF(
        Priority::ERROR,
        std::string(
            "smolvla_load_model: ggml_backend_alloc_ctx_tensors_from_buft "
            "FAILED for ") +
            std::to_string((int)(total_size / (1024 * 1024))) +
            " MB on backend '" + (bname ? bname : "?") + "'");
    return false;
  }
  ggml_backend_buffer_set_usage(buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
  model.bufs_w.push_back(buf);

  FILE* f = fopen(path, "rb");
  if (!f) {
    QLOG_IF(
        Priority::ERROR,
        std::string("smolvla_load_model: fopen failed for '") + path + "'");
    return false;
  }
  std::vector<uint8_t> read_buf;
  int n_copied = 0;
  for (int64_t i = 0; i < n_tensors_in_gguf; i++) {
    const char* name = gguf_get_tensor_name(gguf, i);
    struct ggml_tensor* t = ggml_get_tensor(ctx_data, name);
    if (!t) {
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
    int seek_err = fseeko(f, (off_t)off, SEEK_SET);
#endif
    if (seek_err != 0 || fread(read_buf.data(), 1, nbytes, f) != nbytes) {
      QLOG_IF(
          Priority::ERROR,
          std::string("smolvla_load_model: failed to read tensor '") + name +
              "' at offset " + std::to_string(off));
      fclose(f);
      return false;
    }
    ggml_backend_tensor_set(t, read_buf.data(), 0, nbytes);
    n_copied++;
  }
  fclose(f);
  {
    const char* bname = ggml_backend_name(model.backend);
    QLOG_IF(
        Priority::INFO,
        "smolvla_load_model: alloc+copy buffer ready, " +
            std::to_string(n_copied) + " tensors, backend='" +
            (bname ? bname : "?") + "'");
  }
  return true;
}

// Load a SmolVLA model from a GGUF file.
//
// Orchestrator only: every phase lives in a helper above so the flow and
// error-handling stays readable. Failure paths leave `model` in a partially-
// initialised state; the caller's `unique_ptr<smolvla_model>` (see
// VlaModel's ctor in `addon/AddonCpp.hpp`) unwinds to `~smolvla_model()`,
// which calls `smolvla_free_model` to release whatever was wired up before
// the bail-out.
//
// `model.ctx_w` is handed off to the model immediately after
// `gguf_init_from_file` succeeds so the destructor cleans it up on every
// later failure. The `gguf_context` itself is owned by an RAII
// `gguf_unique_ptr` for the duration of the load.
bool smolvla_load_model(
    const char* path,
    smolvla_model& model,
    bool force_cpu,
    const std::string& backendsDir) {
  QLOG_IF(
      Priority::INFO,
      std::string("smolvla_load_model: loading model from '") + path +
          "' (force_cpu=" + (force_cpu ? "true" : "false") + ")");

  load_backends_once(backendsDir);
  if (!init_cpu_backend(model)) {
    return false;
  }
  try_init_gpu_backend(model, force_cpu);
  if (!model.has_gpu) {
    QLOG_IF(Priority::INFO, "smolvla_load_model: using CPU backend");
  }

  // Open GGUF with no_alloc=true — creates a ggml_context with tensor metadata
  // only (data pointers stay NULL). Tensor data is wired up later either by
  // mmap+buffer_from_host_ptr (Apple Metal / CPU) or by alloc+copy from disk
  // (Vulkan / Android). Mirrors llama.cpp's model-loader pattern in
  // qvac-fabric src/llama-model.cpp:6648.
  struct ggml_context* ctx_data = nullptr;
  struct gguf_init_params gguf_params = {
      /*.no_alloc =*/true,
      /*.ctx      =*/&ctx_data,
  };
  gguf_unique_ptr gguf(gguf_init_from_file(path, gguf_params));
  if (!gguf) {
    QLOG_IF(Priority::ERROR, "smolvla_load_model: failed to open GGUF file");
    return false;
  }
  // Hand ownership of ctx_data to the model immediately so any subsequent
  // failure path leaks neither the ggml context nor the backends.
  model.ctx_w = ctx_data;

  const int64_t n_tensors = gguf_get_n_tensors(gguf.get());
  QLOG_IF(
      Priority::INFO,
      "smolvla_load_model: loaded " + std::to_string(n_tensors) + " tensors");

  read_hparams_from_gguf(gguf.get(), model.hparams);
  if (!validate_hparams(model.hparams)) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_load_model: hparams out of range — refusing to load");
    return false;
  }

  // The denoise step graph indexes VLM KV arrays (sized text_num_layers in
  // smolvla_inference_with_timing) using the expert layer loop bound, so the
  // two layer counts must match.
  if (model.hparams.text_num_layers != model.hparams.expert_num_layers) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_load_model: text_num_layers (" +
            std::to_string(model.hparams.text_num_layers) +
            ") must equal expert_num_layers (" +
            std::to_string(model.hparams.expert_num_layers) +
            ") — KV cache arrays are shared between text and expert");
    return false;
  }

  precompute_time_embedding(model);

  const auto& hp = model.hparams;
  QLOG_IF(
      Priority::INFO,
      "smolvla_load_model: hparams loaded — vision=" +
          std::to_string(hp.vision_num_layers) + "L/" +
          std::to_string(hp.vision_hidden_size) + "d text=" +
          std::to_string(hp.text_num_layers) + "L/" +
          std::to_string(hp.text_hidden_size) + "d expert=" +
          std::to_string(hp.expert_num_layers) + "L/" +
          std::to_string(hp.expert_hidden_size) + "d");

  map_weight_tensors(ctx_data, model);
  if (!validate_required_tensors(model)) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_load_model: GGUF is missing required tensors — refusing to load");
    return false;
  }

  QLOG_IF(Priority::INFO, "smolvla_load_model: all tensors mapped");

  // Allocate backend storage for weights. Two paths, mirroring qvac-fabric
  // src/llama-model.cpp:6648 (create_backend_buffers): mmap+host_ptr fast path
  // first when the device supports it, falling through to alloc+copy
  // otherwise.
  ggml_backend_buffer_type_t buft =
      ggml_backend_get_default_buffer_type(model.backend);
  ggml_backend_dev_t dev = ggml_backend_buft_get_device(buft);
  bool host_ptr_supported = false;
  bool is_default_buft = false;
  if (dev) {
    ggml_backend_dev_props props;
    ggml_backend_dev_get_props(dev, &props);
    host_ptr_supported = props.caps.buffer_from_host_ptr;
    is_default_buft = (buft == ggml_backend_dev_buffer_type(dev));
  }

  const size_t data_offset = gguf_get_data_offset(gguf.get());
  const int64_t n_tensors_in_gguf = gguf_get_n_tensors(gguf.get());

  bool used_mmap = false;
#ifndef _WIN32
  if (host_ptr_supported && is_default_buft) {
    used_mmap = try_load_weights_mmap(
        model, path, gguf.get(), ctx_data, dev, data_offset,
        n_tensors_in_gguf);
  }
#endif
  if (!used_mmap) {
    if (!load_weights_alloc_copy(
            model, path, gguf.get(), ctx_data, buft, data_offset,
            n_tensors_in_gguf)) {
      return false;
    }
  }

  // Tensors keep the same ggml_tensor* pointers from ctx_data; no remapping
  // needed because we never created a duplicate context.
  // (The gguf_context itself is released by gguf_unique_ptr at scope exit;
  // backend buffer(s) own the actual storage now.)

  QLOG_IF(Priority::INFO, "smolvla_load_model: model loaded successfully");
  return true;
}

void smolvla_free_model(smolvla_model& model) {
  // Free backend buffers BEFORE the underlying mmap so any tensor pointers
  // they hold remain valid through the free callback.
  for (ggml_backend_buffer_t buf : model.bufs_w) {
    if (buf) {
      ggml_backend_buffer_free(buf);
    }
  }
  model.bufs_w.clear();
#ifndef _WIN32
  if (model.mmap_addr) {
    munmap(model.mmap_addr, model.mmap_size);
    model.mmap_addr = nullptr;
    model.mmap_size = 0;
  }
#endif
  if (model.ctx_w) {
    ggml_free(model.ctx_w);
    model.ctx_w = nullptr;
  }
  if (model.backend && model.backend != model.backend_cpu) {
    ggml_backend_free(model.backend);
  }
  model.backend = nullptr;
  if (model.backend_cpu) {
    ggml_backend_free(model.backend_cpu);
    model.backend_cpu = nullptr;
  }
}

// Idempotent — safe to chain with VlaModel's explicit free.
smolvla_model::~smolvla_model() { smolvla_free_model(*this); }

// ============================================================
// Full Inference Pipeline
// ============================================================

// Helper: staged graph computation with scheduler support
struct staged_graph {
  struct ggml_context* ctx;
  struct ggml_cgraph* gf;
  // One of these is used depending on backend
  ggml_gallocr_t allocr;
  ggml_backend_sched_t sched;
};

static staged_graph
build_staged(ggml_backend_t backend, size_t ctx_bytes, int max_nodes) {
  staged_graph sg = {};
  struct ggml_init_params params = {ctx_bytes, nullptr, true};
  sg.ctx = ggml_init(params);
  sg.gf = ggml_new_graph_custom(sg.ctx, max_nodes, false);
  sg.allocr = nullptr;
  sg.sched = nullptr;
  return sg;
}

// Allocate graph for single-backend (CPU only). Returns false on
// allocator/reserve/alloc failure so the caller can bail before
// `compute_staged()` dereferences a partially-initialised graph.
static bool alloc_staged_simple(staged_graph& sg, ggml_backend_t backend) {
  sg.allocr = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend));
  if (!sg.allocr) {
    return false;
  }
  if (!ggml_gallocr_reserve(sg.allocr, sg.gf)) {
    return false;
  }
  return ggml_gallocr_alloc_graph(sg.allocr, sg.gf);
}

// Allocate graph for multi-backend (GPU + CPU with auto-fallback). Same
// failure semantics as `alloc_staged_simple`.
static bool
alloc_staged_sched(staged_graph& sg, ggml_backend_t gpu, ggml_backend_t cpu) {
  ggml_backend_t backends[] = {gpu, cpu};
  sg.sched = ggml_backend_sched_new(
      backends, nullptr, 2, GGML_DEFAULT_GRAPH_SIZE, false, true);
  if (!sg.sched) {
    return false;
  }
  return ggml_backend_sched_alloc_graph(sg.sched, sg.gf);
}

static void compute_staged(staged_graph& sg, ggml_backend_t backend) {
  if (sg.sched) {
    ggml_backend_sched_graph_compute(sg.sched, sg.gf);
  } else {
    ggml_backend_graph_compute(backend, sg.gf);
  }
}

static void free_staged(staged_graph& sg) {
  if (sg.sched)
    ggml_backend_sched_free(sg.sched);
  if (sg.allocr)
    ggml_gallocr_free(sg.allocr);
  if (sg.ctx)
    ggml_free(sg.ctx);
  sg = {};
}

bool smolvla_inference_with_timing(
    smolvla_model* model_ptr, const float** images, int n_images, int img_width,
    int img_height, const float* state, int state_dim,
    const int32_t* lang_tokens, const bool* lang_mask, int lang_len,
    const float* noise, float* actions_out, int* n_actions_out,
    smolvla_timing* timing_out) {
  const double t_total_start = now_ms();
  smolvla_model& model = *model_ptr;
  const auto& hp = model.hparams;

  // Validate caller-supplied counts before they feed into tensor sizing.
  // Without these, large/negative values would overflow int arithmetic in
  // n_visual_tokens and prefix_len, leading to under-sized tensor allocations
  // and out-of-bounds writes during graph build.
  constexpr int kMaxImages = 16;
  if (n_images <= 0 || n_images > kMaxImages) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_inference: invalid n_images=" + std::to_string(n_images) +
            " (expected 1.." + std::to_string(kMaxImages) + ")");
    return false;
  }
  if (lang_len < 0 || lang_len > hp.tokenizer_max_length) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_inference: invalid lang_len=" + std::to_string(lang_len) +
            " (expected 0.." + std::to_string(hp.tokenizer_max_length) + ")");
    return false;
  }
  if (state_dim < 0 || state_dim > hp.max_state_dim) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_inference: invalid state_dim=" + std::to_string(state_dim) +
            " (expected 0.." + std::to_string(hp.max_state_dim) + ")");
    return false;
  }
  // SigLIP's conv2d output sizes from runtime img_width/img_height, but the
  // downstream reshape to (n_patches, vision_hidden_size) sizes from
  // hp.vision_image_size — so a mismatch trips GGML_ASSERT inside ggml.c
  // (hard abort, not a thrown exception, so the JSCATCH layer can't recover
  // and the worker process dies). Reject mismatches up front so a buggy
  // caller gets a clean false return instead.
  if (img_width != hp.vision_image_size || img_height != hp.vision_image_size) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_inference: img dims (" + std::to_string(img_width) + "x" +
            std::to_string(img_height) + ") must equal vision_image_size (" +
            std::to_string(hp.vision_image_size) + "x" +
            std::to_string(hp.vision_image_size) + ")");
    return false;
  }

  int n_visual_tokens = n_images * hp.tokens_per_image();
  int prefix_len = n_visual_tokens + lang_len + 1; // +1 for state token
  int chunk_size = hp.chunk_size;
  int action_dim = hp.action_dim;
  int kv_dim = hp.text_num_kv_heads * hp.text_head_dim;

  // Count valid prefix tokens for attention mask
  int valid_prefix = n_visual_tokens; // all visual tokens are valid
  for (int i = 0; i < lang_len; i++) {
    if (lang_mask[i])
      valid_prefix++;
  }
  valid_prefix += 1; // state token
  QLOG_IF(
      Priority::DEBUG,
      "smolvla_inference: prefix_len=" + std::to_string(prefix_len) +
          " valid_prefix=" + std::to_string(valid_prefix) + " chunk_size=" +
          std::to_string(chunk_size) + " n_images=" + std::to_string(n_images));

  // ================================================================
  // STAGE 1: Vision encoding (per image) — SigLIP + Connector
  // ================================================================
  int C = hp.vision_num_channels;
  int tokens_per_img = hp.tokens_per_image();
  int hidden = hp.text_hidden_size;

  // Store visual tokens in a flat buffer
  std::vector<float> all_visual(
      static_cast<size_t>(n_visual_tokens) * hidden);

  double t_vision_start = now_ms();

  // Build full SigLIP+connector graph ONCE, reuse per image
  // Conv2d auto-falls back to CPU via scheduler; rest runs on GPU (Vulkan/Metal/OpenCL)
  staged_graph sg_vis = build_staged(model.backend, 256 * 1024 * 1024, 65536);

  struct ggml_tensor* g_pixels =
      ggml_new_tensor_3d(sg_vis.ctx, GGML_TYPE_F32, img_width, img_height, C);
  ggml_set_name(g_pixels, "pixels");
  ggml_set_input(g_pixels);

  struct ggml_tensor* vis = build_siglip_graph(sg_vis.ctx, model, g_pixels);
  struct ggml_tensor* conn = build_connector_graph(sg_vis.ctx, model, vis);
  conn = ggml_scale(sg_vis.ctx, conn, sqrtf((float)hidden));
  ggml_set_name(conn, "conn_out");
  ggml_set_output(conn);

  ggml_build_forward_expand(sg_vis.gf, conn);
  {
    const bool ok = model.has_gpu
                        ? alloc_staged_sched(sg_vis, model.backend, model.backend_cpu)
                        : alloc_staged_simple(sg_vis, model.backend_cpu);
    if (!ok) {
      QLOG_IF(
          Priority::ERROR,
          "smolvla_inference: failed to allocate vision graph");
      free_staged(sg_vis);
      return false;
    }
  }

  for (int img_idx = 0; img_idx < n_images; img_idx++) {
    ggml_backend_tensor_set(
        g_pixels,
        images[img_idx],
        0,
        C * img_width * img_height * sizeof(float));
    compute_staged(sg_vis, model.backend);
    ggml_backend_tensor_get(
        conn,
        all_visual.data() + img_idx * tokens_per_img * hidden,
        0,
        tokens_per_img * hidden * sizeof(float));

    QLOG_IF(
        Priority::DEBUG,
        "smolvla_inference: vision img " + std::to_string(img_idx + 1) + "/" +
            std::to_string(n_images) + " done");
  }
  free_staged(sg_vis);
  double t_vision_end = now_ms();

  // ================================================================
  // STAGE 2: Build prefix embeddings + SmolLM2 forward → KV cache
  // ================================================================
  double t_smollm2_start = now_ms();
  staged_graph sg2 = build_staged(model.backend, 512 * 1024 * 1024, 65536);

  // Inputs: visual tokens, language token IDs, state, masks
  struct ggml_tensor* g_visual =
      ggml_new_tensor_2d(sg2.ctx, GGML_TYPE_F32, hidden, n_visual_tokens);
  ggml_set_name(g_visual, "visual");
  ggml_set_input(g_visual);

  struct ggml_tensor* g_lang_ids =
      ggml_new_tensor_1d(sg2.ctx, GGML_TYPE_I32, lang_len);
  ggml_set_name(g_lang_ids, "lang_ids");
  ggml_set_input(g_lang_ids);

  struct ggml_tensor* g_state =
      ggml_new_tensor_1d(sg2.ctx, GGML_TYPE_F32, hp.max_state_dim);
  ggml_set_name(g_state, "state");
  ggml_set_input(g_state);

  struct ggml_tensor* g_prefix_pos =
      ggml_new_tensor_1d(sg2.ctx, GGML_TYPE_I32, prefix_len);
  ggml_set_name(g_prefix_pos, "prefix_pos");
  ggml_set_input(g_prefix_pos);

  // Language embedding + scale
  struct ggml_tensor* lang_emb =
      ggml_get_rows(sg2.ctx, model.text.embed_tokens, g_lang_ids);
  lang_emb = ggml_scale(sg2.ctx, lang_emb, sqrtf((float)hidden));

  // State projection
  struct ggml_tensor* state_emb = smolvla_linear(
      sg2.ctx, g_state, model.state_proj_weight, model.state_proj_bias);
  state_emb = ggml_reshape_2d(sg2.ctx, state_emb, hidden, 1);

  // Concatenate: visual + language + state
  struct ggml_tensor* prefix = ggml_concat(sg2.ctx, g_visual, lang_emb, 1);
  prefix = ggml_concat(sg2.ctx, prefix, state_emb, 1);
  ggml_set_name(prefix, "prefix_embs");
  ggml_set_output(prefix);

  // Prefix attention mask: (prefix_len, prefix_len) additive
  // Padded language tokens should not be attended to
  struct ggml_tensor* g_prefix_mask =
      ggml_new_tensor_2d(sg2.ctx, GGML_TYPE_F32, prefix_len, prefix_len);
  ggml_set_name(g_prefix_mask, "prefix_mask");
  ggml_set_input(g_prefix_mask);

  // SmolLM2 forward — with per-layer output dumps
  std::vector<struct ggml_tensor*> kv_keys_t, kv_vals_t;
  std::vector<struct ggml_tensor*> layer_outputs;
  struct ggml_tensor* smollm2_out = build_smollm2_graph(
      sg2.ctx,
      model,
      prefix,
      g_prefix_pos,
      g_prefix_mask,
      kv_keys_t,
      kv_vals_t,
      &layer_outputs);
  ggml_set_name(smollm2_out, "smollm2_out");
  ggml_set_output(smollm2_out);

  // Mark KV cache as outputs so gallocr preserves them
  for (int i = 0; i < hp.text_num_layers; i++) {
    char n[32];
    snprintf(n, sizeof(n), "kk%d", i);
    ggml_set_name(kv_keys_t[i], n);
    ggml_set_output(kv_keys_t[i]);
    snprintf(n, sizeof(n), "kv%d", i);
    ggml_set_name(kv_vals_t[i], n);
    ggml_set_output(kv_vals_t[i]);
  }

  ggml_build_forward_expand(sg2.gf, smollm2_out);
  // Also explicitly expand from KV cache tensors to ensure they're in the graph
  for (int i = 0; i < hp.text_num_layers; i++) {
    ggml_build_forward_expand(sg2.gf, kv_keys_t[i]);
    ggml_build_forward_expand(sg2.gf, kv_vals_t[i]);
  }
  // And layer outputs
  if (!layer_outputs.empty()) {
    for (auto* t : layer_outputs) {
      ggml_build_forward_expand(sg2.gf, t);
    }
  }

  {
    const bool ok = model.has_gpu
                        ? alloc_staged_sched(sg2, model.backend, model.backend_cpu)
                        : alloc_staged_simple(sg2, model.backend_cpu);
    if (!ok) {
      QLOG_IF(
          Priority::ERROR,
          "smolvla_inference: failed to allocate prefix graph");
      free_staged(sg2);
      return false;
    }
  }

  // Set inputs
  ggml_backend_tensor_set(
      g_visual, all_visual.data(), 0, n_visual_tokens * hidden * sizeof(float));
  ggml_backend_tensor_set(
      g_lang_ids, lang_tokens, 0, lang_len * sizeof(int32_t));

  std::vector<float> state_padded(hp.max_state_dim, 0.0f);
  memcpy(
      state_padded.data(),
      state,
      std::min(state_dim, hp.max_state_dim) * sizeof(float));
  ggml_backend_tensor_set(
      g_state, state_padded.data(), 0, hp.max_state_dim * sizeof(float));

  // Prefix attention mask:
  // Build pad_mask: True for valid tokens
  // att_mask: 0 for bidirectional, 1 for causal
  // PyTorch: make_att_2d_masks(pad_masks, att_masks) where
  //   visual: pad=True, att=0; language: pad=lang_mask, att=0; state: pad=True,
  //   att=1
  // Result: 2D mask where invalid (padding) tokens are masked out
  {
    // Build 1D pad mask
    std::vector<bool> pad(prefix_len, false);
    std::vector<int> att(prefix_len, 0);
    for (int i = 0; i < n_visual_tokens; i++) {
      pad[i] = true;
      att[i] = 0;
    }
    for (int i = 0; i < lang_len; i++) {
      pad[n_visual_tokens + i] = lang_mask[i];
      att[n_visual_tokens + i] = 0;
    }
    pad[prefix_len - 1] = true;
    att[prefix_len - 1] = 1;

    // Build 2D mask using cumsum logic from make_att_2d_masks
    std::vector<int> cumsum(prefix_len);
    cumsum[0] = att[0];
    for (int i = 1; i < prefix_len; i++)
      cumsum[i] = cumsum[i - 1] + att[i];

    std::vector<float> mask_data(
        static_cast<size_t>(prefix_len) * prefix_len);
    for (int qi = 0; qi < prefix_len; qi++) {
      for (int ki = 0; ki < prefix_len; ki++) {
        bool att_ok = cumsum[ki] <= cumsum[qi]; // attention mask
        bool pad_ok = pad[qi] && pad[ki];       // padding mask
        mask_data[qi * prefix_len + ki] = (att_ok && pad_ok) ? 0.0f : -1e9f;
      }
    }
    ggml_backend_tensor_set(
        g_prefix_mask, mask_data.data(), 0, mask_data.size() * sizeof(float));
  }

  // Position IDs = cumsum(pad_mask) - 1
  // Visual tokens: all valid. Language: some padding. State: valid.
  std::vector<int32_t> pos_ids(prefix_len);
  {
    int pos = 0;
    // Visual tokens (all valid)
    for (int i = 0; i < n_visual_tokens; i++) {
      pos_ids[i] = pos++;
    }
    // Language tokens (some may be padding)
    for (int i = 0; i < lang_len; i++) {
      if (lang_mask[i])
        pos++;
      pos_ids[n_visual_tokens + i] = pos - 1;
    }
    // State token (valid)
    pos_ids[prefix_len - 1] = pos;
  }
  ggml_backend_tensor_set(
      g_prefix_pos, pos_ids.data(), 0, prefix_len * sizeof(int32_t));

  compute_staged(sg2, model.backend);
  double t_smollm2_compute = now_ms();

  // Recompute KV cache from layer inputs
  // The graph allocator may reuse K/V buffers, so we recompute them in separate
  // mini-graphs. Layer i input = layer_outputs[i-1] (or prefix_embs for i=0) K
  // = RoPE(k_proj(RMSNorm(input))), V = v_proj(RMSNorm(input))
  std::vector<std::vector<float>> kv_keys_data(hp.text_num_layers);
  std::vector<std::vector<float>> kv_vals_data(hp.text_num_layers);
  int kv_total = kv_dim * prefix_len;

  {
    std::vector<float> prev_hidden(static_cast<size_t>(prefix_len) * hidden);
    ggml_backend_tensor_get(
        prefix, prev_hidden.data(), 0, prev_hidden.size() * sizeof(float));

    // Read position IDs (same as used in the main graph)
    // pos_ids is already computed above

    for (int i = 0; i < hp.text_num_layers; i++) {
      staged_graph sg_kv = build_staged(model.backend, 64 * 1024 * 1024, 512);

      struct ggml_tensor* g_h =
          ggml_new_tensor_2d(sg_kv.ctx, GGML_TYPE_F32, hidden, prefix_len);
      ggml_set_name(g_h, "h");
      ggml_set_input(g_h);

      struct ggml_tensor* g_pos =
          ggml_new_tensor_1d(sg_kv.ctx, GGML_TYPE_I32, prefix_len);
      ggml_set_name(g_pos, "pos");
      ggml_set_input(g_pos);

      struct ggml_tensor* normed = smolvla_rms_norm(
          sg_kv.ctx,
          g_h,
          model.text.layers[i].attn_norm_weight,
          hp.text_rms_norm_eps);

      int q_d = hp.text_num_heads * hp.text_head_dim;
      int kv_d = hp.text_num_kv_heads * hp.text_head_dim;

      struct ggml_tensor *k_out, *v_out;
      if (model.text.layers[i].v_proj_weight) {
        k_out = smolvla_linear(
            sg_kv.ctx, normed, model.text.layers[i].k_proj_weight, nullptr);
        v_out = smolvla_linear(
            sg_kv.ctx, normed, model.text.layers[i].v_proj_weight, nullptr);
      } else {
        struct ggml_tensor* qkv = ggml_mul_mat(
            sg_kv.ctx, model.text.layers[i].qkv_proj_weight, normed);
        k_out = ggml_view_2d(
            sg_kv.ctx,
            qkv,
            kv_d,
            prefix_len,
            qkv->nb[1],
            q_d * ggml_element_size(qkv));
        v_out = ggml_view_2d(
            sg_kv.ctx,
            qkv,
            kv_d,
            prefix_len,
            qkv->nb[1],
            (q_d + kv_d) * ggml_element_size(qkv));
        k_out = ggml_cont(sg_kv.ctx, k_out);
        v_out = ggml_cont(sg_kv.ctx, v_out);
      }

      // Reshape K to 3D and apply RoPE
      k_out = ggml_reshape_3d(
          sg_kv.ctx, k_out, hp.text_head_dim, hp.text_num_kv_heads, prefix_len);
      k_out = ggml_rope(
          sg_kv.ctx, k_out, g_pos, hp.text_head_dim, GGML_ROPE_TYPE_NEOX);

      ggml_set_name(k_out, "k");
      ggml_set_output(k_out);
      ggml_set_name(v_out, "v");
      ggml_set_output(v_out);
      ggml_build_forward_expand(sg_kv.gf, k_out);
      ggml_build_forward_expand(sg_kv.gf, v_out);
      {
        const bool ok = model.has_gpu
                            ? alloc_staged_sched(sg_kv, model.backend, model.backend_cpu)
                            : alloc_staged_simple(sg_kv, model.backend_cpu);
        if (!ok) {
          QLOG_IF(
              Priority::ERROR,
              "smolvla_inference: failed to allocate KV mini-graph at layer " +
                  std::to_string(i));
          free_staged(sg_kv);
          free_staged(sg2);
          return false;
        }
      }

      ggml_backend_tensor_set(
          g_h, prev_hidden.data(), 0, prev_hidden.size() * sizeof(float));
      ggml_backend_tensor_set(
          g_pos, pos_ids.data(), 0, prefix_len * sizeof(int32_t));
      compute_staged(sg_kv, model.backend);

      kv_keys_data[i].resize(kv_total);
      kv_vals_data[i].resize(kv_total);
      ggml_backend_tensor_get(
          k_out, kv_keys_data[i].data(), 0, kv_total * sizeof(float));
      ggml_backend_tensor_get(
          v_out, kv_vals_data[i].data(), 0, kv_total * sizeof(float));

      if (i < hp.text_num_layers - 1) {
        ggml_backend_tensor_get(
            layer_outputs[i],
            prev_hidden.data(),
            0,
            prev_hidden.size() * sizeof(float));
      }

      free_staged(sg_kv);
    }
  }

  // ----------------------------------------------------------------
  // Hoist cross-attention K/V projections out of the ODE loop.
  //
  // For each cross-attn expert layer (`i % self_attn_every_n != 0`),
  // the action expert applies its own k_proj / v_proj to the VLM
  // KV cache. The cache is invariant across the 10 ODE denoise
  // steps, so projecting once per inference replaces 9 redundant
  // matmul-pairs per cross-attn layer (~16 layers × 9 = 144
  // redundant matmul pairs eliminated).
  //
  // We overwrite kv_keys_data[i] / kv_vals_data[i] in place because
  // they are only consumed by the per-step upload below, and the
  // ODE input slots are already sized to match (kv_dim, prefix_len)
  // — the expert's kv_dim equals text's in stock SmolVLA.
  // ----------------------------------------------------------------
  {
    const int expert_kv_dim = hp.expert_num_kv_heads * hp.expert_head_dim;
    // The original cross-attn graph reshaped the projected K to
    // (expert_head_dim, expert_num_kv_heads, prefix_len); the input slot
    // was sized at text kv_dim, so the two were already implicitly
    // assumed equal. Assert it explicitly now that we rely on it for
    // the in-place overwrite below.
    assert(expert_kv_dim == kv_dim &&
           "cross-attn hoist requires expert kv_dim == text kv_dim");

    for (int i = 0; i < hp.expert_num_layers; i++) {
      const bool is_sa = (hp.self_attn_every_n > 0) &&
                         (i % hp.self_attn_every_n == 0);
      if (is_sa) continue;

      const auto& elw = model.expert.layers[i];
      if (!elw.k_proj_weight || !elw.v_proj_weight) continue;

      staged_graph sg_xp = build_staged(model.backend, 32 * 1024 * 1024, 256);

      struct ggml_tensor* g_kin = ggml_new_tensor_2d(
          sg_xp.ctx, GGML_TYPE_F32, kv_dim, prefix_len);
      ggml_set_name(g_kin, "kin");
      ggml_set_input(g_kin);
      struct ggml_tensor* g_vin = ggml_new_tensor_2d(
          sg_xp.ctx, GGML_TYPE_F32, kv_dim, prefix_len);
      ggml_set_name(g_vin, "vin");
      ggml_set_input(g_vin);

      struct ggml_tensor* k_proj =
          smolvla_linear(sg_xp.ctx, g_kin, elw.k_proj_weight, nullptr);
      struct ggml_tensor* v_proj =
          smolvla_linear(sg_xp.ctx, g_vin, elw.v_proj_weight, nullptr);
      ggml_set_name(k_proj, "kp");
      ggml_set_output(k_proj);
      ggml_set_name(v_proj, "vp");
      ggml_set_output(v_proj);

      ggml_build_forward_expand(sg_xp.gf, k_proj);
      ggml_build_forward_expand(sg_xp.gf, v_proj);

      {
        const bool ok = model.has_gpu
                            ? alloc_staged_sched(sg_xp, model.backend, model.backend_cpu)
                            : alloc_staged_simple(sg_xp, model.backend_cpu);
        if (!ok) {
          QLOG_IF(
              Priority::ERROR,
              "smolvla_inference: failed to allocate expert KV-projection graph at layer " +
                  std::to_string(i));
          free_staged(sg_xp);
          free_staged(sg2);
          return false;
        }
      }

      ggml_backend_tensor_set(
          g_kin, kv_keys_data[i].data(), 0, kv_total * sizeof(float));
      ggml_backend_tensor_set(
          g_vin, kv_vals_data[i].data(), 0, kv_total * sizeof(float));
      compute_staged(sg_xp, model.backend);

      ggml_backend_tensor_get(
          k_proj, kv_keys_data[i].data(), 0, kv_total * sizeof(float));
      ggml_backend_tensor_get(
          v_proj, kv_vals_data[i].data(), 0, kv_total * sizeof(float));

      free_staged(sg_xp);
    }
  }

  free_staged(sg2);
  double t_smollm2_end = now_ms();

  // ================================================================
  // STAGE 3: ODE loop — 10 denoise steps through action expert
  // ================================================================
  double t_ode_start = now_ms();

  // Initial noise
  std::vector<float> x_t(
      static_cast<size_t>(chunk_size) * hp.max_action_dim);
  if (noise) {
    memcpy(
        x_t.data(),
        noise,
        static_cast<size_t>(chunk_size) * hp.max_action_dim * sizeof(float));
  } else {
    std::mt19937 rng(42);
    std::normal_distribution<float> normal(0.0f, 1.0f);
    for (auto& v : x_t)
      v = normal(rng);
  }

  // Build self-attention mask: (full_len, chunk_size)
  // Prefix part: attend to all valid tokens; suffix part: causal
  int full_len = prefix_len + chunk_size;
  std::vector<float> sa_mask(static_cast<size_t>(full_len) * chunk_size);
  for (int qi = 0; qi < chunk_size; qi++) {
    // Prefix columns: attend to valid prefix tokens
    for (int ki = 0; ki < prefix_len; ki++) {
      bool valid = (ki < n_visual_tokens) || // visual tokens
                   (ki >= n_visual_tokens && ki < n_visual_tokens + lang_len &&
                    lang_mask[ki - n_visual_tokens]) || // language
                   (ki == prefix_len - 1);              // state token
      sa_mask[qi * full_len + ki] = valid ? 0.0f : -1e9f;
    }
    // Suffix columns: causal (attend to current and previous)
    for (int ki = 0; ki < chunk_size; ki++) {
      sa_mask[qi * full_len + prefix_len + ki] = (ki <= qi) ? 0.0f : -1e9f;
    }
  }

  float dt = -1.0f / hp.num_ode_steps;

  // Build expert graph ONCE, reuse for all 10 ODE steps
  staged_graph sg3 = build_staged(model.backend, 256 * 1024 * 1024, 65536);

  struct ggml_tensor* g_xt =
      ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, hp.max_action_dim, chunk_size);
  ggml_set_name(g_xt, "x_t");
  ggml_set_input(g_xt);

  struct ggml_tensor* g_te = ggml_new_tensor_2d(
      sg3.ctx, GGML_TYPE_F32, hp.expert_hidden_size, chunk_size);
  ggml_set_name(g_te, "time");
  ggml_set_input(g_te);

  struct ggml_tensor* g_pos =
      ggml_new_tensor_1d(sg3.ctx, GGML_TYPE_I32, chunk_size);
  ggml_set_name(g_pos, "pos");
  ggml_set_input(g_pos);

  struct ggml_tensor* g_cpos =
      ggml_new_tensor_1d(sg3.ctx, GGML_TYPE_I32, chunk_size);
  ggml_set_name(g_cpos, "cpos");
  ggml_set_input(g_cpos);

  struct ggml_tensor* g_samask =
      ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, full_len, chunk_size);
  ggml_set_name(g_samask, "samask");
  ggml_set_input(g_samask);

  std::vector<struct ggml_tensor*> g_kk(hp.text_num_layers),
      g_kv(hp.text_num_layers);
  for (int i = 0; i < hp.text_num_layers; i++) {
    bool is_sa = (hp.self_attn_every_n > 0) && (i % hp.self_attn_every_n == 0);
    char n[32];
    if (is_sa) {
      snprintf(n, sizeof(n), "kk%d", i);
      g_kk[i] = ggml_new_tensor_3d(
          sg3.ctx,
          GGML_TYPE_F32,
          hp.text_head_dim,
          hp.text_num_kv_heads,
          prefix_len);
      ggml_set_name(g_kk[i], n);
      ggml_set_input(g_kk[i]);
      snprintf(n, sizeof(n), "kv%d", i);
      g_kv[i] = ggml_new_tensor_3d(
          sg3.ctx,
          GGML_TYPE_F32,
          hp.text_head_dim,
          hp.text_num_kv_heads,
          prefix_len);
      ggml_set_name(g_kv[i], n);
      ggml_set_input(g_kv[i]);
    } else {
      snprintf(n, sizeof(n), "kk%d", i);
      g_kk[i] = ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, kv_dim, prefix_len);
      ggml_set_name(g_kk[i], n);
      ggml_set_input(g_kk[i]);
      snprintf(n, sizeof(n), "kv%d", i);
      g_kv[i] = ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, kv_dim, prefix_len);
      ggml_set_name(g_kv[i], n);
      ggml_set_input(g_kv[i]);
    }
  }

  // Cross-attention mask: (prefix_len, chunk_size) — mask out padding tokens
  struct ggml_tensor* g_camask =
      ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, prefix_len, chunk_size);
  ggml_set_name(g_camask, "camask");
  ggml_set_input(g_camask);

  struct ggml_tensor* v_t = build_denoise_step_graph(
      sg3.ctx,
      model,
      g_xt,
      g_te,
      g_kk.data(),
      g_kv.data(),
      g_pos,
      g_cpos,
      g_camask,
      g_samask);
  ggml_set_name(v_t, "v_t");
  ggml_set_output(v_t);

  ggml_build_forward_expand(sg3.gf, v_t);

  {
    const bool ok = model.has_gpu
                        ? alloc_staged_sched(sg3, model.backend, model.backend_cpu)
                        : alloc_staged_simple(sg3, model.backend_cpu);
    if (!ok) {
      QLOG_IF(
          Priority::ERROR,
          "smolvla_inference: failed to allocate ODE graph");
      free_staged(sg3);
      return false;
    }
  }

  // Set static inputs (don't change between steps)
  std::vector<int32_t> sa_pos(chunk_size), cr_pos(chunk_size);
  for (int j = 0; j < chunk_size; j++) {
    sa_pos[j] = valid_prefix + j;
    cr_pos[j] = j;
  }
  ggml_backend_tensor_set(
      g_pos, sa_pos.data(), 0, chunk_size * sizeof(int32_t));
  ggml_backend_tensor_set(
      g_cpos, cr_pos.data(), 0, chunk_size * sizeof(int32_t));
  ggml_backend_tensor_set(
      g_samask, sa_mask.data(), 0, sa_mask.size() * sizeof(float));

  // Cross-attention mask: mask out padding tokens in VLM prefix
  {
    std::vector<float> ca_mask(
        static_cast<size_t>(prefix_len) * chunk_size);
    for (int qi = 0; qi < chunk_size; qi++) {
      for (int ki = 0; ki < prefix_len; ki++) {
        bool valid =
            (ki < n_visual_tokens) ||
            (ki >= n_visual_tokens && ki < n_visual_tokens + lang_len &&
             lang_mask[ki - n_visual_tokens]) ||
            (ki == prefix_len - 1);
        ca_mask[qi * prefix_len + ki] = valid ? 0.0f : -1e9f;
      }
    }
    ggml_backend_tensor_set(
        g_camask, ca_mask.data(), 0, ca_mask.size() * sizeof(float));
  }

  for (int i = 0; i < hp.text_num_layers; i++) {
    if (g_kk[i]->buffer) {
      ggml_backend_tensor_set(
          g_kk[i], kv_keys_data[i].data(), 0, kv_total * sizeof(float));
    }
    if (g_kv[i]->buffer) {
      ggml_backend_tensor_set(
          g_kv[i], kv_vals_data[i].data(), 0, kv_total * sizeof(float));
    }
  }

  std::vector<float> vt_data(
      static_cast<size_t>(chunk_size) * hp.max_action_dim);
  std::vector<float> te_expanded(
      static_cast<size_t>(chunk_size) * hp.expert_hidden_size);
  // Hoist time-embedding scratch out of the ODE loop — one allocation reused
  // across 10 steps instead of `num_ode_steps` per-iteration heap churns.
  std::vector<float> te_single(hp.expert_hidden_size);

  // Run 10 ODE steps, reusing the same graph.
  //
  // Re-upload all inputs each step: the CPU path uses ggml_gallocr
  // (alloc_staged_simple) which reuses input slots between
  // ggml_backend_graph_compute calls, and Adreno Vulkan has similar
  // semantics in practice. Without the per-step upload the action chunks
  // diverge wildly from the PyTorch reference on those backends
  // (cos_sim ≈ 0.31, max|Δ| ≈ 1.65 vs 0.020 on a sched-managed Vulkan
  // path). Sched-managed multi-backend setups would tolerate skipping
  // this re-upload, but the conditional branch isn't worth the
  // correctness risk for ~80 MB of H2D traffic per inference.
  for (int step = 0; step < hp.num_ode_steps; step++) {
    float t_val = 1.0f + step * dt;

    ggml_backend_tensor_set(g_xt, x_t.data(), 0, x_t.size() * sizeof(float));
    for (int i = 0; i < hp.text_num_layers; i++) {
      if (g_kk[i]->buffer) {
        ggml_backend_tensor_set(
            g_kk[i], kv_keys_data[i].data(), 0, kv_total * sizeof(float));
      }
      if (g_kv[i]->buffer) {
        ggml_backend_tensor_set(
            g_kv[i], kv_vals_data[i].data(), 0, kv_total * sizeof(float));
      }
    }

    compute_sinusoidal_time_embedding_cached(
        t_val,
        model.time_embed_inv_periods.data(),
        hp.expert_hidden_size,
        te_single.data());
    // Broadcast `te_single` to all `chunk_size` rows using a doubling
    // pattern: ~log2(chunk_size) larger memcpys instead of `chunk_size`
    // small ones (50 → ~7 calls for chunk_size=50).
    if (chunk_size > 0) {
      const size_t row_floats = hp.expert_hidden_size;
      const size_t row_bytes = row_floats * sizeof(float);
      memcpy(te_expanded.data(), te_single.data(), row_bytes);
      size_t filled = 1;
      while (filled < (size_t)chunk_size) {
        const size_t take = std::min(filled, (size_t)chunk_size - filled);
        memcpy(
            te_expanded.data() + filled * row_floats,
            te_expanded.data(),
            take * row_bytes);
        filled += take;
      }
    }
    ggml_backend_tensor_set(
        g_te, te_expanded.data(), 0, te_expanded.size() * sizeof(float));

    // Compute (reuses same graph and allocations). compute_staged routes
    // through sg3.sched when present and falls back to model.backend
    // otherwise, matching the dispatch every other stage uses. Avoids the
    // foot-gun of hardcoding backend_cpu — if alloc_staged_sched ever
    // returned with sched==nullptr on a GPU build, the inline form would
    // silently fire CPU compute on GPU-allocated tensors.
    compute_staged(sg3, model.backend);

    // Read velocity and do Euler step
    ggml_backend_tensor_get(
        v_t, vt_data.data(), 0, vt_data.size() * sizeof(float));

    for (int j = 0; j < chunk_size * hp.max_action_dim; j++) {
      x_t[j] += vt_data[j] * dt;
    }

    QLOG_IF(
        Priority::DEBUG,
        "smolvla_inference: ODE step " + std::to_string(step + 1) + "/" +
            std::to_string(hp.num_ode_steps) + " done");
  }

  free_staged(sg3);

  double t_ode_end = now_ms();

  QLOG_IF(
      Priority::INFO,
      "smolvla_inference: TIMING vision=" +
          std::to_string((int)(t_vision_end - t_vision_start)) +
          "ms smollm2_compute=" +
          std::to_string((int)(t_smollm2_compute - t_smollm2_start)) +
          "ms smollm2_total=" +
          std::to_string((int)(t_smollm2_end - t_smollm2_start)) + "ms ode=" +
          std::to_string((int)(t_ode_end - t_ode_start)) + "ms");

  // ================================================================
  // STAGE 4: Extract actions
  // ================================================================
  for (int i = 0; i < chunk_size; i++) {
    for (int j = 0; j < action_dim; j++) {
      actions_out[i * action_dim + j] = x_t[i * hp.max_action_dim + j];
    }
  }
  *n_actions_out = chunk_size;

  if (timing_out) {
    timing_out->vision_ms = t_vision_end - t_vision_start;
    timing_out->smollm2_compute_ms = t_smollm2_compute - t_smollm2_start;
    timing_out->smollm2_total_ms = t_smollm2_end - t_smollm2_start;
    timing_out->ode_ms = t_ode_end - t_ode_start;
    timing_out->total_ms = now_ms() - t_total_start;
  }

  return true;
}
