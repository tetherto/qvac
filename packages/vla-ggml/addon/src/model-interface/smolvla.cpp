// Make off_t 64-bit on 32-bit POSIX targets so fseeko can address
// past 2 GB (smolvla GGUF is ~2.2 GB). Must precede any system header.
#ifndef _WIN32
#define _FILE_OFFSET_BITS 64
#endif

#include "smolvla.hpp"

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

#include "../utils/BackendSelection.hpp"
#include "../utils/LoggingMacros.hpp"
#include "gguf_helpers.hpp"

#ifndef _WIN32
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

static double nowMs() {
  return std::chrono::duration<double, std::milli>(
             std::chrono::high_resolution_clock::now().time_since_epoch())
      .count();
}

// ============================================================
// Utility: GGML graph helpers
// ============================================================

static struct ggml_tensor*
toF32(struct ggml_context* ctx, struct ggml_tensor* x) {
  if (x && x->type != GGML_TYPE_F32) {
    return ggml_cast(ctx, x, GGML_TYPE_F32);
  }
  return x;
}

static struct ggml_tensor* smolvlaLayerNorm(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    struct ggml_tensor* bias, float eps) {
  x = ggml_norm(ctx, x, eps);
  x = ggml_mul(ctx, x, toF32(ctx, weight));
  if (bias) {
    x = ggml_add(ctx, x, toF32(ctx, bias));
  }
  return x;
}

static struct ggml_tensor* smolvlaRmsNorm(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    float eps) {
  x = ggml_rms_norm(ctx, x, eps);
  x = ggml_mul(ctx, x, toF32(ctx, weight));
  return x;
}

static struct ggml_tensor*
smolvlaSilu(struct ggml_context* ctx, struct ggml_tensor* x) {
  return ggml_silu(ctx, x);
}

// GELU with tanh approximation
static struct ggml_tensor*
smolvlaGelu(struct ggml_context* ctx, struct ggml_tensor* x) {
  return ggml_gelu(ctx, x);
}

// Linear layer: y = x @ W^T + b
// x: (..., in_features)
// weight: (out_features, in_features)
// bias: (out_features,) or NULL
static struct ggml_tensor* smolvlaLinear(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* weight,
    struct ggml_tensor* bias) {
  struct ggml_tensor* out = ggml_mul_mat(ctx, weight, x);
  if (bias) {
    out = ggml_add(ctx, out, toF32(ctx, bias));
  }
  return out;
}

// ============================================================
// SigLIP Vision Encoder
// ============================================================

// Build patch embedding only (conv2d — CPU-only op)
// Returns: (n_patches, hidden_size) = (1024, 768)
static struct ggml_tensor* buildSiglipPatchEmbed(
    struct ggml_context* ctx, SmolvlaModel& model,
    struct ggml_tensor* pixelValues) {
  const auto& hp = model.hparams;
  const auto& vw = model.vision;

  struct ggml_tensor* x = ggml_conv_2d(
      ctx,
      vw.patch_embed_weight,
      pixelValues,
      hp.vision_patch_size,
      hp.vision_patch_size,
      0,
      0,
      1,
      1);

  int nPatches = hp.patchesPerImage();
  x = ggml_reshape_2d(ctx, x, nPatches, hp.vision_hidden_size);
  x = ggml_cont(ctx, ggml_transpose(ctx, x));

  if (vw.patch_embed_bias) {
    x = ggml_add(ctx, x, toF32(ctx, vw.patch_embed_bias));
  }
  if (vw.pos_embed) {
    x = ggml_add(ctx, x, toF32(ctx, vw.pos_embed));
  }

  return x;
}

// Build SigLIP transformer layers (no conv2d — Vulkan compatible)
// Input: (n_patches, hidden_size) = (1024, 768)
// Output: (n_patches, hidden_size) = (1024, 768)
static struct ggml_tensor* buildSiglipTransformer(
    struct ggml_context* ctx, SmolvlaModel& model, struct ggml_tensor* x) {
  const auto& hp = model.hparams;
  const auto& vw = model.vision;
  int nPatches = hp.patchesPerImage();

  // Transformer layers
  for (int i = 0; i < hp.vision_num_layers; i++) {
    const auto& layer = vw.layers[i];

    // Pre-norm (LayerNorm)
    struct ggml_tensor* residual = x;
    x = smolvlaLayerNorm(
        ctx, x, layer.ln1_weight, layer.ln1_bias, hp.vision_layer_norm_eps);

    // Multi-head self-attention
    int d = hp.vision_hidden_size;
    int h = hp.vision_num_heads;
    int dh = d / h;

    struct ggml_tensor *q, *k, *v;
    if (layer.qkv_proj_w) {
      struct ggml_tensor* qkv =
          smolvlaLinear(ctx, x, layer.qkv_proj_w, layer.qkv_proj_b);
      q = ggml_cont(ctx, ggml_view_2d(ctx, qkv, d, nPatches, qkv->nb[1], 0));
      k = ggml_cont(
          ctx,
          ggml_view_2d(
              ctx, qkv, d, nPatches, qkv->nb[1], d * ggml_element_size(qkv)));
      v = ggml_cont(
          ctx,
          ggml_view_2d(
              ctx,
              qkv,
              d,
              nPatches,
              qkv->nb[1],
              2 * d * ggml_element_size(qkv)));
    } else {
      q = smolvlaLinear(ctx, x, layer.q_proj_w, layer.q_proj_b);
      k = smolvlaLinear(ctx, x, layer.k_proj_w, layer.k_proj_b);
      v = smolvlaLinear(ctx, x, layer.v_proj_w, layer.v_proj_b);
    }

    // Reshape to (n_patches, n_heads, head_dim)
    q = ggml_reshape_3d(ctx, q, dh, h, nPatches);
    k = ggml_reshape_3d(ctx, k, dh, h, nPatches);
    v = ggml_reshape_3d(ctx, v, dh, h, nPatches);

    // Permute for attention: (head_dim, n_patches, n_heads) for GGML matmul
    q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3)); // (dh, L, H)
    k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
    v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

    // Attention: softmax(Q @ K^T / sqrt(d)) @ V — fused scale+softmax.
    struct ggml_tensor* attn = ggml_mul_mat(ctx, k, q); // (L, L, H)
    attn = ggml_soft_max_ext(ctx, attn, nullptr, 1.0f / sqrtf((float)dh), 0.0f);
    struct ggml_tensor* attnOut = ggml_mul_mat(
        ctx, ggml_cont(ctx, ggml_transpose(ctx, v)), attn); // (dh, L, H)

    // Reshape back to (n_patches, hidden_size)
    attnOut =
        ggml_cont(ctx, ggml_permute(ctx, attnOut, 0, 2, 1, 3)); // (dh, H, L)
    attnOut = ggml_reshape_2d(ctx, attnOut, d, nPatches);

    // Output projection
    x = smolvlaLinear(ctx, attnOut, layer.out_proj_w, layer.out_proj_b);

    // Residual
    x = ggml_add(ctx, x, residual);

    // Post-norm + MLP
    residual = x;
    x = smolvlaLayerNorm(
        ctx, x, layer.ln2_weight, layer.ln2_bias, hp.vision_layer_norm_eps);

    // MLP: fc1 -> GELU -> fc2
    x = smolvlaLinear(ctx, x, layer.fc1_weight, layer.fc1_bias);
    x = smolvlaGelu(ctx, x);
    x = smolvlaLinear(ctx, x, layer.fc2_weight, layer.fc2_bias);

    // Residual
    x = ggml_add(ctx, x, residual);
  }

  // Post-LayerNorm
  if (vw.post_ln_weight) {
    x = smolvlaLayerNorm(
        ctx, x, vw.post_ln_weight, vw.post_ln_bias, hp.vision_layer_norm_eps);
  }

  // x is now (1024, 768)
  return x;
}

// Full SigLIP: patch embed + transformer
struct ggml_tensor* buildSiglipGraph(
    struct ggml_context* ctx, SmolvlaModel& model,
    struct ggml_tensor* pixelValues) {
  struct ggml_tensor* patches = buildSiglipPatchEmbed(ctx, model, pixelValues);
  return buildSiglipTransformer(ctx, model, patches);
}

// ============================================================
// Connector: PixelShuffle + MLP projection
// ============================================================

struct ggml_tensor* buildConnectorGraph(
    struct ggml_context* ctx, SmolvlaModel& model,
    struct ggml_tensor* visionOutput) // (1024, 768)
{
  const auto& hp = model.hparams;
  int sf = hp.connector_scale_factor;     // 4
  int nPatches = hp.patchesPerImage();    // 1024
  int side = (int)sqrtf((float)nPatches); // 32
  int d = hp.vision_hidden_size;          // 768

  // PixelShuffle:
  // Input: (1024, 768) = (32*32, 768)
  // Step 1: reshape to (32, 32, 768)
  struct ggml_tensor* x = ggml_reshape_3d(ctx, visionOutput, d, side, side);

  // Step 2: reshape to (32, 8, 768*4) -- group width by scale_factor
  x = ggml_reshape_3d(ctx, x, d * sf, side / sf, side);

  // Step 3: permute to (8, 32, 768*4) -> (8, 8, 768*16)
  x = ggml_cont(ctx, ggml_permute(ctx, x, 0, 2, 1, 3));
  x = ggml_reshape_3d(ctx, x, d * sf * sf, side / sf, side / sf);

  // Step 4: permute back and reshape to (64, 12288)
  x = ggml_cont(ctx, ggml_permute(ctx, x, 0, 2, 1, 3));
  int nTokens = hp.tokensPerImage();                 // 64
  x = ggml_reshape_2d(ctx, x, d * sf * sf, nTokens); // (64, 12288)

  // MLP projection: Linear(12288, 960, bias=False)
  x = smolvlaLinear(ctx, x, model.connector.proj_weight, nullptr);

  return x; // (64, 960)
}

// ============================================================
// SmolLM2 Transformer Block (single layer)
// ============================================================

// Single transformer layer (SmolLM2 or Expert)
// If kv_key_out / kv_val_out are non-null, stores post-RoPE K/V tensors (before
// GQA repeat)
static struct ggml_tensor* buildTransformerLayer(
    struct ggml_context* ctx,
    struct ggml_tensor* hiddenStates, // (seq_len, hidden_size)
    const TransformerLayerWeights& lw, struct ggml_tensor* positionIds,
    int numHeads, int numKvHeads, int headDim, float rmsEps,
    struct ggml_tensor* attnMask = nullptr,
    struct ggml_tensor** kvKeyOut = nullptr,
    struct ggml_tensor** kvValOut = nullptr) {
  int seqLen = hiddenStates->ne[1];

  // Pre-attention RMSNorm
  struct ggml_tensor* residual = hiddenStates;
  hiddenStates = smolvlaRmsNorm(ctx, hiddenStates, lw.attn_norm_weight, rmsEps);

  // QKV projections — fused or unfused
  struct ggml_tensor *q, *k, *v;
  int qDim = numHeads * headDim;
  int kvDimEach = numKvHeads * headDim;

  if (lw.qkv_proj_weight) {
    // Fused: one matmul, then split via views
    struct ggml_tensor* qkv =
        ggml_mul_mat(ctx, lw.qkv_proj_weight, hiddenStates);
    q = ggml_view_2d(ctx, qkv, qDim, seqLen, qkv->nb[1], 0);
    k = ggml_view_2d(
        ctx, qkv, kvDimEach, seqLen, qkv->nb[1], qDim * ggml_element_size(qkv));
    v = ggml_view_2d(
        ctx,
        qkv,
        kvDimEach,
        seqLen,
        qkv->nb[1],
        (qDim + kvDimEach) * ggml_element_size(qkv));
    q = ggml_cont(ctx, q);
    k = ggml_cont(ctx, k);
    v = ggml_cont(ctx, v);
  } else {
    q = smolvlaLinear(ctx, hiddenStates, lw.q_proj_weight, nullptr);
    k = smolvlaLinear(ctx, hiddenStates, lw.k_proj_weight, nullptr);
    v = smolvlaLinear(ctx, hiddenStates, lw.v_proj_weight, nullptr);
  }

  // Reshape to multi-head before RoPE
  q = ggml_reshape_3d(ctx, q, headDim, numHeads, seqLen);
  k = ggml_reshape_3d(ctx, k, headDim, numKvHeads, seqLen);
  v = ggml_reshape_3d(ctx, v, headDim, numKvHeads, seqLen);

  // Apply RoPE
  if (positionIds) {
    q = ggml_rope(ctx, q, positionIds, headDim, GGML_ROPE_TYPE_NEOX);
    k = ggml_rope(ctx, k, positionIds, headDim, GGML_ROPE_TYPE_NEOX);
  }

  // Store KV cache (post-RoPE, pre-GQA-repeat) if requested
  if (kvKeyOut)
    *kvKeyOut = k;
  if (kvValOut)
    *kvValOut = v;

  // GQA repeat for attention computation
  int kvGroups = numHeads / numKvHeads;
  struct ggml_tensor* kExpanded = k;
  struct ggml_tensor* vExpanded = v;
  if (kvGroups > 1) {
    kExpanded = ggml_reshape_4d(ctx, k, headDim, 1, numKvHeads, seqLen);
    kExpanded = ggml_repeat(
        ctx,
        kExpanded,
        ggml_new_tensor_4d(
            ctx, k->type, headDim, kvGroups, numKvHeads, seqLen));
    kExpanded = ggml_reshape_3d(ctx, kExpanded, headDim, numHeads, seqLen);

    vExpanded = ggml_reshape_4d(ctx, v, headDim, 1, numKvHeads, seqLen);
    vExpanded = ggml_repeat(
        ctx,
        vExpanded,
        ggml_new_tensor_4d(
            ctx, v->type, headDim, kvGroups, numKvHeads, seqLen));
    vExpanded = ggml_reshape_3d(ctx, vExpanded, headDim, numHeads, seqLen);
  }

  // Attention computation. ggml_flash_attn_ext was measured ~3× slower
  // per layer on Intel Iris Xe Vulkan (correct F16-mask + GGML_PREC_F32
  // recipe). Not yet benchmarked on Adreno OpenCL or Mali.
  q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
  kExpanded = ggml_cont(ctx, ggml_permute(ctx, kExpanded, 0, 2, 1, 3));
  vExpanded = ggml_cont(ctx, ggml_permute(ctx, vExpanded, 0, 2, 1, 3));

  struct ggml_tensor* attnWeights = ggml_mul_mat(ctx, kExpanded, q);
  // Fused scale + (optional) mask + softmax.
  attnWeights = ggml_soft_max_ext(
      ctx, attnWeights, attnMask, 1.0f / sqrtf((float)headDim), 0.0f);

  struct ggml_tensor* attnOut = ggml_mul_mat(
      ctx, ggml_cont(ctx, ggml_transpose(ctx, vExpanded)), attnWeights);

  attnOut = ggml_cont(ctx, ggml_permute(ctx, attnOut, 0, 2, 1, 3));
  attnOut = ggml_reshape_2d(ctx, attnOut, numHeads * headDim, seqLen);

  // Output projection
  attnOut = smolvlaLinear(ctx, attnOut, lw.o_proj_weight, nullptr);

  // Residual connection
  hiddenStates = ggml_add(ctx, attnOut, residual);

  // Post-attention RMSNorm + MLP
  residual = hiddenStates;
  hiddenStates = smolvlaRmsNorm(ctx, hiddenStates, lw.ffn_norm_weight, rmsEps);

  // SwiGLU MLP — fused or unfused
  struct ggml_tensor *gate, *up;
  if (lw.gate_up_weight) {
    struct ggml_tensor* gu = ggml_mul_mat(ctx, lw.gate_up_weight, hiddenStates);
    int inter = lw.gate_up_weight->ne[1] / 2;
    gate = ggml_view_2d(ctx, gu, inter, seqLen, gu->nb[1], 0);
    up = ggml_view_2d(
        ctx, gu, inter, seqLen, gu->nb[1], inter * ggml_element_size(gu));
    gate = ggml_cont(ctx, gate);
    up = ggml_cont(ctx, up);
  } else {
    gate = smolvlaLinear(ctx, hiddenStates, lw.gate_proj_weight, nullptr);
    up = smolvlaLinear(ctx, hiddenStates, lw.up_proj_weight, nullptr);
  }
  // Fused SwiGLU: silu(gate) * up.
  struct ggml_tensor* mlpOut = ggml_swiglu_split(ctx, gate, up);
  mlpOut = smolvlaLinear(ctx, mlpOut, lw.down_proj_weight, nullptr);

  // Residual
  hiddenStates = ggml_add(ctx, mlpOut, residual);

  return hiddenStates;
}

// ============================================================
// SmolLM2 Forward (build KV cache from prefix tokens)
// ============================================================

// Build computation graph for SmolLM2 forward pass
// Takes concatenated prefix tokens: visual_tokens + language_embeddings +
// state_embedding Outputs final hidden states and per-layer KV cache for the
// action expert
struct ggml_tensor* buildSmollm2Graph(
    struct ggml_context* ctx, SmolvlaModel& model,
    struct ggml_tensor*
        prefixEmbeddings,            // (prefix_len, 960) -- already embedded
    struct ggml_tensor* positionIds, // (prefix_len,)
    struct ggml_tensor* attnMask,    // (prefix_len, prefix_len) or NULL
    std::vector<struct ggml_tensor*>& kvKeysOut, // output: per-layer keys
    std::vector<struct ggml_tensor*>& kvValsOut, // output: per-layer values
    std::vector<struct ggml_tensor*>*
        layerOutputs) // optional: per-layer hidden states
{
  const auto& hp = model.hparams;
  const auto& tw = model.text;

  kvKeysOut.resize(hp.text_num_layers);
  kvValsOut.resize(hp.text_num_layers);
  if (layerOutputs)
    layerOutputs->resize(hp.text_num_layers);

  struct ggml_tensor* x = prefixEmbeddings;

  for (int i = 0; i < hp.text_num_layers; i++) {
    x = buildTransformerLayer(
        ctx,
        x,
        tw.layers[i],
        positionIds,
        hp.text_num_heads,
        hp.text_num_kv_heads,
        hp.text_head_dim,
        hp.text_rms_norm_eps,
        attnMask,
        &kvKeysOut[i],
        &kvValsOut[i]);

    if (layerOutputs) {
      char name[32];
      snprintf(name, sizeof(name), "layer%02d", i);
      ggml_set_name(x, name);
      ggml_set_output(x);
      (*layerOutputs)[i] = x;
    }
  }

  // Final RMSNorm
  x = smolvlaRmsNorm(ctx, x, tw.final_norm_weight, hp.text_rms_norm_eps);

  return x; // (prefix_len, 960)
}

// ============================================================
// Sinusoidal Time Embedding
// ============================================================

void computeSinusoidalTimeEmbeddingCached(
    float timestep, const float* invPeriods, int dimension, float* out) {
  const int halfDim = dimension / 2;
  const float twoPiT = 2.0f * std::numbers::pi_v<float> * timestep;
  for (int i = 0; i < halfDim; i++) {
    const float angle = invPeriods[i] * twoPiT;
    out[i] = sinf(angle);
    out[halfDim + i] = cosf(angle);
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
struct ggml_tensor* buildDenoiseStepGraph(
    struct ggml_context* ctx, SmolvlaModel& model,
    struct ggml_tensor* xT,         // (chunk_size, max_action_dim=32)
    struct ggml_tensor* timeEmbed,  // (chunk_size, expert_hidden_size=720)
    struct ggml_tensor** vlmKvKeys, // per-layer cached keys
    struct ggml_tensor** vlmKvVals, // per-layer cached values
    struct ggml_tensor*
        positionIds, // (chunk_size,) - self-attn positions (e.g. 198..247)
    struct ggml_tensor*
        crossPosIds, // (chunk_size,) - cross-attn positions (e.g. 0..49)
    struct ggml_tensor* crossAttnMask, // (chunk_size, prefix_len)
    struct ggml_tensor* selfAttnMask)  // (chunk_size, prefix_len+chunk_size)
{
  const auto& hp = model.hparams;
  const auto& ew = model.expert;

  // 1. Project noisy actions to expert dim
  struct ggml_tensor* actionEmb = smolvlaLinear(
      ctx, xT, model.action_in_proj_weight, model.action_in_proj_bias);
  // action_emb: (chunk_size, 720)

  // 2. Concatenate action_emb and time_embed, then MLP
  struct ggml_tensor* actionTime = ggml_concat(ctx, actionEmb, timeEmbed, 0);
  // action_time: (chunk_size, 1440)

  actionTime = smolvlaLinear(
      ctx,
      actionTime,
      model.action_time_mlp_in_weight,
      model.action_time_mlp_in_bias);
  actionTime = smolvlaSilu(ctx, actionTime);
  actionTime = smolvlaLinear(
      ctx,
      actionTime,
      model.action_time_mlp_out_weight,
      model.action_time_mlp_out_bias);
  // action_time: (chunk_size, 720)

  // 3. Run through expert layers (interleaved self-attn / cross-attn)
  struct ggml_tensor* hidden = actionTime;
  int chunkSize = hp.chunk_size;
  int headDim = hp.expert_head_dim;
  int numHeads = hp.expert_num_heads;
  int numKvHeads = hp.expert_num_kv_heads;
  int kvGroups = numHeads / numKvHeads;

  for (int i = 0; i < hp.expert_num_layers; i++) {
    bool isSelfAttn =
        (hp.self_attn_every_n > 0) && (i % hp.self_attn_every_n == 0);
    const auto& lw = ew.layers[i];

    // Pre-attention RMSNorm
    struct ggml_tensor* residual = hidden;
    struct ggml_tensor* normed = smolvlaRmsNorm(
        ctx, hidden, lw.attn_norm_weight, hp.expert_rms_norm_eps);

    if (isSelfAttn) {
      // SELF-ATTENTION: Q from expert, K/V = concat(VLM_cached, expert)
      struct ggml_tensor *q, *kExpert, *vExpert;
      int qDim = numHeads * headDim;
      int kvDimEach = numKvHeads * headDim;

      if (lw.qkv_proj_weight) {
        struct ggml_tensor* qkv = ggml_mul_mat(ctx, lw.qkv_proj_weight, normed);
        q = ggml_cont(
            ctx, ggml_view_2d(ctx, qkv, qDim, chunkSize, qkv->nb[1], 0));
        kExpert = ggml_cont(
            ctx,
            ggml_view_2d(
                ctx,
                qkv,
                kvDimEach,
                chunkSize,
                qkv->nb[1],
                qDim * ggml_element_size(qkv)));
        vExpert = ggml_cont(
            ctx,
            ggml_view_2d(
                ctx,
                qkv,
                kvDimEach,
                chunkSize,
                qkv->nb[1],
                (qDim + kvDimEach) * ggml_element_size(qkv)));
      } else {
        q = smolvlaLinear(ctx, normed, lw.q_proj_weight, nullptr);
        kExpert = smolvlaLinear(ctx, normed, lw.k_proj_weight, nullptr);
        vExpert = smolvlaLinear(ctx, normed, lw.v_proj_weight, nullptr);
      }

      // Reshape to multi-head
      q = ggml_reshape_3d(ctx, q, headDim, numHeads, chunkSize);
      kExpert = ggml_reshape_3d(ctx, kExpert, headDim, numKvHeads, chunkSize);
      vExpert = ggml_reshape_3d(ctx, vExpert, headDim, numKvHeads, chunkSize);

      // Apply RoPE to expert Q and K
      q = ggml_rope(ctx, q, positionIds, headDim, GGML_ROPE_TYPE_NEOX);
      kExpert =
          ggml_rope(ctx, kExpert, positionIds, headDim, GGML_ROPE_TYPE_NEOX);

      // Concatenate VLM cached K/V with expert K/V
      // VLM cache: (head_dim, num_kv_heads, prefix_len) already post-RoPE
      struct ggml_tensor* kFull =
          ggml_concat(ctx, vlmKvKeys[i], kExpert, 2); // concat on seq dim
      struct ggml_tensor* vFull = ggml_concat(ctx, vlmKvVals[i], vExpert, 2);

      int fullLen = kFull->ne[2]; // prefix_len + chunk_size

      // GQA repeat
      struct ggml_tensor* kExp = kFull;
      struct ggml_tensor* vExp = vFull;
      if (kvGroups > 1) {
        kExp = ggml_reshape_4d(ctx, kFull, headDim, 1, numKvHeads, fullLen);
        kExp = ggml_repeat(
            ctx,
            kExp,
            ggml_new_tensor_4d(
                ctx, kFull->type, headDim, kvGroups, numKvHeads, fullLen));
        kExp = ggml_reshape_3d(ctx, kExp, headDim, numHeads, fullLen);

        vExp = ggml_reshape_4d(ctx, vFull, headDim, 1, numKvHeads, fullLen);
        vExp = ggml_repeat(
            ctx,
            vExp,
            ggml_new_tensor_4d(
                ctx, vFull->type, headDim, kvGroups, numKvHeads, fullLen));
        vExp = ggml_reshape_3d(ctx, vExp, headDim, numHeads, fullLen);
      }

      // Attention
      q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
      kExp = ggml_cont(ctx, ggml_permute(ctx, kExp, 0, 2, 1, 3));
      vExp = ggml_cont(ctx, ggml_permute(ctx, vExp, 0, 2, 1, 3));

      struct ggml_tensor* attnWeights = ggml_mul_mat(ctx, kExp, q);
      // Fused scale + mask + softmax.
      attnWeights = ggml_soft_max_ext(
          ctx, attnWeights, selfAttnMask, 1.0f / sqrtf((float)headDim), 0.0f);

      struct ggml_tensor* attnOut = ggml_mul_mat(
          ctx, ggml_cont(ctx, ggml_transpose(ctx, vExp)), attnWeights);

      attnOut = ggml_cont(ctx, ggml_permute(ctx, attnOut, 0, 2, 1, 3));
      attnOut = ggml_reshape_2d(ctx, attnOut, numHeads * headDim, chunkSize);

      // O projection + residual
      attnOut = smolvlaLinear(ctx, attnOut, lw.o_proj_weight, nullptr);
      hidden = ggml_add(ctx, attnOut, residual);

    } else {
      // CROSS-ATTENTION: Q from expert; K/V arrive pre-projected.
      //
      // The action expert's per-layer `k_proj` / `v_proj` only depend on the
      // VLM KV cache, which is fixed across the 10 ODE denoise steps.
      // `smolvla_inference_with_timing` runs those projections once per
      // inference and overwrites `kv_keys_data[i]` / `kv_vals_data[i]`
      // for cross-attn layers, so here we use the input slot directly.
      struct ggml_tensor* q =
          smolvlaLinear(ctx, normed, lw.q_proj_weight, nullptr);

      struct ggml_tensor* k = vlmKvKeys[i];
      struct ggml_tensor* v = vlmKvVals[i];

      int kvLen = vlmKvKeys[i]->ne[1]; // prefix_len

      // Reshape to multi-head
      q = ggml_reshape_3d(ctx, q, headDim, numHeads, chunkSize);
      k = ggml_reshape_3d(ctx, k, headDim, numKvHeads, kvLen);
      v = ggml_reshape_3d(ctx, v, headDim, numKvHeads, kvLen);

      // RoPE only on Q, with positions starting from 0
      // PyTorch: expert_position_id = position_ids - min(position_ids) ->
      // [0,1,...,49]
      q = ggml_rope(ctx, q, crossPosIds, headDim, GGML_ROPE_TYPE_NEOX);
      // NO RoPE on K (keys are projected fresh from VLM cache, not
      // position-dependent)

      // GQA repeat
      if (kvGroups > 1) {
        k = ggml_reshape_4d(ctx, k, headDim, 1, numKvHeads, kvLen);
        k = ggml_repeat(
            ctx,
            k,
            ggml_new_tensor_4d(
                ctx, k->type, headDim, kvGroups, numKvHeads, kvLen));
        k = ggml_reshape_3d(ctx, k, headDim, numHeads, kvLen);

        v = ggml_reshape_4d(ctx, v, headDim, 1, numKvHeads, kvLen);
        v = ggml_repeat(
            ctx,
            v,
            ggml_new_tensor_4d(
                ctx, v->type, headDim, kvGroups, numKvHeads, kvLen));
        v = ggml_reshape_3d(ctx, v, headDim, numHeads, kvLen);
      }

      // Attention
      q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
      k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
      v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

      struct ggml_tensor* attnWeights = ggml_mul_mat(ctx, k, q);
      // Fused scale + mask + softmax.
      attnWeights = ggml_soft_max_ext(
          ctx, attnWeights, crossAttnMask, 1.0f / sqrtf((float)headDim), 0.0f);

      struct ggml_tensor* attnOut = ggml_mul_mat(
          ctx, ggml_cont(ctx, ggml_transpose(ctx, v)), attnWeights);

      attnOut = ggml_cont(ctx, ggml_permute(ctx, attnOut, 0, 2, 1, 3));
      attnOut = ggml_reshape_2d(ctx, attnOut, numHeads * headDim, chunkSize);

      // O projection + residual
      attnOut = smolvlaLinear(ctx, attnOut, lw.o_proj_weight, nullptr);
      hidden = ggml_add(ctx, attnOut, residual);
    }

    // Post-attention RMSNorm + MLP (same for both types)
    residual = hidden;
    hidden =
        smolvlaRmsNorm(ctx, hidden, lw.ffn_norm_weight, hp.expert_rms_norm_eps);

    struct ggml_tensor *eGate, *eUp;
    if (lw.gate_up_weight) {
      struct ggml_tensor* gu = ggml_mul_mat(ctx, lw.gate_up_weight, hidden);
      int inter = lw.gate_up_weight->ne[1] / 2;
      eGate =
          ggml_cont(ctx, ggml_view_2d(ctx, gu, inter, chunkSize, gu->nb[1], 0));
      eUp = ggml_cont(
          ctx,
          ggml_view_2d(
              ctx,
              gu,
              inter,
              chunkSize,
              gu->nb[1],
              inter * ggml_element_size(gu)));
    } else {
      eGate = smolvlaLinear(ctx, hidden, lw.gate_proj_weight, nullptr);
      eUp = smolvlaLinear(ctx, hidden, lw.up_proj_weight, nullptr);
    }
    // Fused SwiGLU: silu(e_gate) * e_up.
    struct ggml_tensor* mlpOut = ggml_swiglu_split(ctx, eGate, eUp);
    mlpOut = smolvlaLinear(ctx, mlpOut, lw.down_proj_weight, nullptr);

    hidden = ggml_add(ctx, mlpOut, residual);
  }

  // 4. Final RMSNorm
  hidden =
      smolvlaRmsNorm(ctx, hidden, ew.final_norm_weight, hp.expert_rms_norm_eps);

  // 5. Project back to action space
  struct ggml_tensor* vT = smolvlaLinear(
      ctx, hidden, model.action_out_proj_weight, model.action_out_proj_bias);
  // v_t: (chunk_size, max_action_dim=32)

  return vT;
}

// ============================================================
// GGUF Loading
// ============================================================

// Helper to find a tensor by name in a GGUF context
static struct ggml_tensor*
getTensor(struct ggml_context* ctx, const char* name) {
  struct ggml_tensor* t = ggml_get_tensor(ctx, name);
  if (!t) {
    QLOG_IF(
        Priority::WARNING,
        std::string("tensor '") + name + "' not found in GGUF");
  }
  return t;
}

using qvac_lib_infer_vla_ggml::ggufGetU32Or;

// Helper to assign a tensor pointer by name
static struct ggml_tensor*
ggufGetTensorByName(struct ggml_context* ctx, const char* name) {
  struct ggml_tensor* t = ggml_get_tensor(ctx, name);
  if (!t) {
    QLOG_IF(Priority::WARNING, std::string("tensor '") + name + "' not found");
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
struct GgufDeleter {
  void operator()(gguf_context* g) const {
    if (g) {
      gguf_free(g);
    }
  }
};
using gguf_unique_ptr = std::unique_ptr<gguf_context, GgufDeleter>;
} // namespace

// Initialise the CPU backend — always required, both as a primary on
// CPU-only platforms and as a fallback target for ops the GPU backend
// rejects. Uses the device API so it works under Android's
// GGML_BACKEND_DL=ON build, where `ggml_backend_cpu_init` lives in a
// separately-loaded .so.
static bool initCpuBackend(SmolvlaModel& model) {
  ggml_backend_dev_t cpuDev =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  model.backend_cpu = cpuDev ? ggml_backend_dev_init(cpuDev, nullptr) : nullptr;
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
static void tryInitGpuBackend(SmolvlaModel& model, bool forceCpu) {
  if (forceCpu) {
    QLOG_IF(
        Priority::INFO,
        "smolvla_load_model: force_cpu=true — skipping GPU selection");
  }
  ggml_backend_dev_t gpu =
      forceCpu ? nullptr : vla_backend_selection::pickBestGpuDevice();
  if (!gpu) {
    return;
  }
  ggml_backend_t gpuBackend = ggml_backend_dev_init(gpu, nullptr);
  if (!gpuBackend) {
    return;
  }
  model.backend = gpuBackend;
  model.has_gpu = true;
  const char* bname = ggml_backend_name(gpuBackend);
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
static void readHparamsFromGguf(gguf_context* gguf, SmolvlaHparams& hp) {
  hp.vision_hidden_size = ggufGetU32Or(gguf, "smolvla.vision.hidden_size", 768);
  hp.vision_intermediate =
      ggufGetU32Or(gguf, "smolvla.vision.intermediate_size", 3072);
  hp.vision_num_layers = ggufGetU32Or(gguf, "smolvla.vision.num_layers", 12);
  hp.vision_num_heads = ggufGetU32Or(gguf, "smolvla.vision.num_heads", 12);
  hp.vision_image_size = ggufGetU32Or(gguf, "smolvla.vision.image_size", 512);
  hp.vision_patch_size = ggufGetU32Or(gguf, "smolvla.vision.patch_size", 16);

  hp.connector_scale_factor =
      ggufGetU32Or(gguf, "smolvla.connector.scale_factor", 4);

  hp.text_hidden_size = ggufGetU32Or(gguf, "smolvla.text.hidden_size", 960);
  hp.text_intermediate =
      ggufGetU32Or(gguf, "smolvla.text.intermediate_size", 2560);
  hp.text_num_layers = ggufGetU32Or(gguf, "smolvla.text.num_layers", 16);
  hp.text_num_heads = ggufGetU32Or(gguf, "smolvla.text.num_heads", 15);
  hp.text_num_kv_heads = ggufGetU32Or(gguf, "smolvla.text.num_kv_heads", 5);
  hp.text_head_dim = ggufGetU32Or(gguf, "smolvla.text.head_dim", 64);

  hp.expert_hidden_size = ggufGetU32Or(gguf, "smolvla.expert.hidden_size", 720);
  hp.expert_intermediate =
      ggufGetU32Or(gguf, "smolvla.expert.intermediate_size", 2048);
  hp.expert_num_layers = ggufGetU32Or(gguf, "smolvla.expert.num_layers", 16);
  hp.expert_num_heads = ggufGetU32Or(gguf, "smolvla.expert.num_heads", 15);
  hp.expert_num_kv_heads = ggufGetU32Or(gguf, "smolvla.expert.num_kv_heads", 5);
  hp.self_attn_every_n =
      ggufGetU32Or(gguf, "smolvla.expert.self_attn_every_n", 2);

  hp.num_ode_steps = ggufGetU32Or(gguf, "smolvla.flow.num_ode_steps", 10);
  hp.chunk_size = ggufGetU32Or(gguf, "smolvla.flow.chunk_size", 50);
  hp.max_action_dim = ggufGetU32Or(gguf, "smolvla.flow.max_action_dim", 32);
  hp.max_state_dim = ggufGetU32Or(gguf, "smolvla.flow.max_state_dim", 32);
  hp.action_dim = ggufGetU32Or(gguf, "smolvla.flow.action_dim", 7);
}

// Sanity-check hparams loaded from GGUF before they feed any sizing
// arithmetic. gguf_get_u32 returns uint32; values >INT_MAX wrap to negative
// when assigned to int and would silently produce negative-sized vectors,
// huge tensor allocations, or division-by-zero in the derived helpers.
// Reject the file rather than allocate from a bad shape.
static bool validateHparams(const SmolvlaHparams& hp) {
  auto inRange = [](int v, int lo, int hi) { return v >= lo && v <= hi; };
  return inRange(hp.vision_hidden_size, 1, 65536) &&
         inRange(hp.vision_intermediate, 1, 1 << 20) &&
         inRange(hp.vision_num_layers, 1, 256) &&
         inRange(hp.vision_num_heads, 1, 1024) &&
         inRange(hp.vision_image_size, 1, 16384) &&
         inRange(hp.vision_patch_size, 1, 1024) &&
         inRange(hp.connector_scale_factor, 1, 256) &&
         inRange(hp.text_hidden_size, 1, 65536) &&
         inRange(hp.text_intermediate, 1, 1 << 20) &&
         inRange(hp.text_num_layers, 1, 256) &&
         inRange(hp.text_num_heads, 1, 1024) &&
         inRange(hp.text_num_kv_heads, 1, 1024) &&
         inRange(hp.text_head_dim, 1, 1024) &&
         // expert_hidden_size is divided by 2 for the time-embed half-dim
         // table; require >=2 so the table is non-empty.
         inRange(hp.expert_hidden_size, 2, 65536) &&
         inRange(hp.expert_intermediate, 1, 1 << 20) &&
         inRange(hp.expert_num_layers, 1, 256) &&
         inRange(hp.expert_num_heads, 1, 1024) &&
         inRange(hp.expert_num_kv_heads, 1, 1024) &&
         inRange(hp.self_attn_every_n, 1, 256) &&
         inRange(hp.num_ode_steps, 1, 1024) &&
         inRange(hp.chunk_size, 1, 1024) &&
         inRange(hp.max_action_dim, 1, 1024) &&
         inRange(hp.max_state_dim, 1, 1024) &&
         inRange(hp.action_dim, 1, hp.max_action_dim);
}

// Precompute the per-frequency `1/period` table used by the sinusoidal time
// embedding. Constant across all ODE steps so we pay the powf cost once at
// load instead of per-step on the inference hot path.
static void precomputeTimeEmbedding(SmolvlaModel& model) {
  const auto& hp = model.hparams;
  const int halfDim = hp.expert_hidden_size / 2;
  model.time_embed_inv_periods.resize(halfDim);
  const float ratio = hp.max_period / hp.min_period;
  for (int i = 0; i < halfDim; i++) {
    const float fraction =
        (halfDim > 1) ? (float)i / (float)(halfDim - 1) : 0.0f;
    const float period = hp.min_period * powf(ratio, fraction);
    model.time_embed_inv_periods[i] = 1.0f / period;
  }
}

// Map every weight tensor referenced by the inference graph to its entry in
// the GGUF context. Missing tensors are left as nullptr — call
// `validate_required_tensors` afterwards to reject GGUFs whose required
// pointers didn't get filled in.
static void
mapWeightTensors(struct ggml_context* ctxData, SmolvlaModel& model) {
  const auto& hp = model.hparams;

  // Helper: probe-only lookup, no warning if missing (used for the fused/
  // unfused sibling pairs where one of the two is expected to be absent).
  auto try_tensor = [&](const char* name) -> struct ggml_tensor* {
    return ggml_get_tensor(ctxData, name);
  };

  // Vision encoder
  model.vision.patch_embed_weight =
      ggufGetTensorByName(ctxData, "v.enc.patch_embd.weight");
  model.vision.patch_embed_bias =
      ggufGetTensorByName(ctxData, "v.enc.patch_embd.bias");
  model.vision.pos_embed =
      ggufGetTensorByName(ctxData, "v.enc.pos_embd.weight");
  model.vision.post_ln_weight =
      ggufGetTensorByName(ctxData, "v.enc.post_ln.weight");
  model.vision.post_ln_bias =
      ggufGetTensorByName(ctxData, "v.enc.post_ln.bias");

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
      ggufGetTensorByName(ctxData, "v.connector.proj.weight");

  // Text model (SmolLM2)
  model.text.embed_tokens = ggufGetTensorByName(ctxData, "t.embed.weight");
  model.text.final_norm_weight =
      ggufGetTensorByName(ctxData, "t.final_norm.weight");

  auto loadTransformerLayers = [&](const char* prefix,
                                   std::vector<TransformerLayerWeights>& layers,
                                   int nLayers) {
    char buf[256];
    layers.resize(nLayers);
    for (int i = 0; i < nLayers; i++) {
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

  loadTransformerLayers("t.blk", model.text.layers, hp.text_num_layers);

  // Expert
  model.expert.final_norm_weight = try_tensor("e.final_norm.weight");
  loadTransformerLayers("e.blk", model.expert.layers, hp.expert_num_layers);

  // Projections
  model.state_proj_weight = ggufGetTensorByName(ctxData, "proj.state.weight");
  model.state_proj_bias = ggufGetTensorByName(ctxData, "proj.state.bias");
  model.action_in_proj_weight =
      ggufGetTensorByName(ctxData, "proj.action_in.weight");
  model.action_in_proj_bias =
      ggufGetTensorByName(ctxData, "proj.action_in.bias");
  model.action_out_proj_weight =
      ggufGetTensorByName(ctxData, "proj.action_out.weight");
  model.action_out_proj_bias =
      ggufGetTensorByName(ctxData, "proj.action_out.bias");
  model.action_time_mlp_in_weight =
      ggufGetTensorByName(ctxData, "proj.time_mlp_in.weight");
  model.action_time_mlp_in_bias =
      ggufGetTensorByName(ctxData, "proj.time_mlp_in.bias");
  model.action_time_mlp_out_weight =
      ggufGetTensorByName(ctxData, "proj.time_mlp_out.weight");
  model.action_time_mlp_out_bias =
      ggufGetTensorByName(ctxData, "proj.time_mlp_out.bias");
}

// After `map_weight_tensors`, walk every tensor pointer the inference graph
// will read through and reject GGUFs that left a required slot at nullptr.
// Without this, `gguf_get_tensor_by_name` would log a warning and return
// nullptr, the load function would return true, and the first inference would
// dereference nullptr inside ggml.
static bool validateRequiredTensors(const SmolvlaModel& model) {
  // First-failure-wins logger so the GGUF author sees the missing name list,
  // not just the first miss.
  bool ok = true;
  auto require = [&](const ggml_tensor* t, const char* name) {
    if (t == nullptr) {
      QLOG_IF(
          Priority::ERROR,
          std::string("smolvla_load_model: required tensor missing: '") + name +
              "'");
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
    const bool hasFusedQkv = l.qkv_proj_w != nullptr && l.qkv_proj_b != nullptr;
    const bool hasUnfusedQkv = l.q_proj_w != nullptr && l.q_proj_b != nullptr &&
                               l.k_proj_w != nullptr && l.k_proj_b != nullptr &&
                               l.v_proj_w != nullptr && l.v_proj_b != nullptr;
    if (!hasFusedQkv && !hasUnfusedQkv) {
      QLOG_IF(
          Priority::ERROR,
          std::string("smolvla_load_model: vision layer ") + idx +
              " has neither fused 'attn_qkv.*' nor unfused 'attn_{q,k,v}.*' "
              "weights/biases");
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
  auto requireTransformerLayers =
      [&](const char* prefix,
          const std::vector<TransformerLayerWeights>& layers) {
        for (size_t i = 0; i < layers.size(); i++) {
          const auto& l = layers[i];
          const std::string base =
              std::string(prefix) + "." + std::to_string(i);
          require(l.attn_norm_weight, (base + ".attn_norm.weight").c_str());
          require(l.o_proj_weight, (base + ".attn_out.weight").c_str());
          require(l.ffn_norm_weight, (base + ".ffn_norm.weight").c_str());
          require(l.down_proj_weight, (base + ".ffn_down.weight").c_str());
          const bool hasFusedQkv = l.qkv_proj_weight != nullptr;
          const bool hasUnfusedQkv = l.q_proj_weight != nullptr &&
                                     l.k_proj_weight != nullptr &&
                                     l.v_proj_weight != nullptr;
          if (!hasFusedQkv && !hasUnfusedQkv) {
            QLOG_IF(
                Priority::ERROR,
                base + ": neither fused 'attn_qkv.weight' nor unfused "
                       "'attn_{q,k,v}.weight'");
            ok = false;
          }
          const bool hasFusedGu = l.gate_up_weight != nullptr;
          const bool hasUnfusedGu =
              l.gate_proj_weight != nullptr && l.up_proj_weight != nullptr;
          if (!hasFusedGu && !hasUnfusedGu) {
            QLOG_IF(
                Priority::ERROR,
                base + ": neither fused 'ffn_gate_up.weight' nor unfused "
                       "'ffn_gate.weight'+'ffn_up.weight'");
            ok = false;
          }
        }
      };
  require(model.text.embed_tokens, "t.embed.weight");
  require(model.text.final_norm_weight, "t.final_norm.weight");
  requireTransformerLayers("t.blk", model.text.layers);

  require(model.expert.final_norm_weight, "e.final_norm.weight");
  requireTransformerLayers("e.blk", model.expert.layers);

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
static bool tryLoadWeightsMmap(
    SmolvlaModel& model, const char* path, gguf_context* gguf,
    struct ggml_context* ctxData, ggml_backend_dev_t dev, size_t dataOffset,
    int64_t nTensorsInGguf) {
  FdGuard fd(open(path, O_RDONLY));
  if (fd.get() < 0) {
    QLOG_IF(
        Priority::WARNING,
        std::string("smolvla_load_model: open() failed for '") + path + "'");
    return false;
  }
  struct stat st{};
  if (fstat(fd.get(), &st) != 0 || st.st_size <= 0 ||
      // Reject malformed/truncated GGUF (data_offset past EOF) before the
      // unsigned subtraction below would wrap to a huge size.
      (uint64_t)dataOffset >= (uint64_t)st.st_size ||
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
  size_t fileSize = (size_t)st.st_size;
  void* addr = mmap(nullptr, fileSize, PROT_READ, MAP_PRIVATE, fd.get(), 0);
  if (addr == MAP_FAILED) {
    QLOG_IF(
        Priority::WARNING,
        "smolvla_load_model: mmap failed (errno=" + std::to_string(errno) +
            ")");
    return false;
  }
  // The mapping holds a ref to the file, so the fd is no longer needed.
  // Close it explicitly and dismiss the guard so it doesn't double-close.
  ::close(fd.get());
  fd.release();

  void* tensorDataBase = (char*)addr + dataOffset;
  size_t tensorDataSize = fileSize - dataOffset;
  size_t maxTensorSize = ggml_get_max_tensor_size(ctxData);

  // Reject crafted GGUFs whose per-tensor (offset, nbytes) would point
  // outside the mapped region — a later read through such a tensor
  // would be an out-of-bounds memory access.
  for (int64_t i = 0; i < nTensorsInGguf; i++) {
    const char* name = gguf_get_tensor_name(gguf, i);
    struct ggml_tensor* t = ggml_get_tensor(ctxData, name);
    if (!t) {
      continue;
    }
    size_t off = gguf_get_tensor_offset(gguf, i);
    size_t nbytes = ggml_nbytes(t);
    if (off > tensorDataSize || nbytes > tensorDataSize - off) {
      QLOG_IF(
          Priority::WARNING,
          std::string("smolvla_load_model: tensor '") + name +
              "' bounds exceed mapped region (off=" + std::to_string(off) +
              " nbytes=" + std::to_string(nbytes) +
              " region=" + std::to_string(tensorDataSize) +
              ") — falling back to alloc+copy");
      munmap(addr, fileSize);
      return false;
    }
  }

  // Hint the OS to prefetch the file so the first inference doesn't
  // demand-page its way through 2+ GB of weights.
  madvise(addr, fileSize, MADV_WILLNEED);

  ggml_backend_buffer_t buf = ggml_backend_dev_buffer_from_host_ptr(
      dev, tensorDataBase, tensorDataSize, maxTensorSize);

  if (!buf) {
    QLOG_IF(
        Priority::WARNING,
        "smolvla_load_model: buffer_from_host_ptr returned NULL — "
        "falling back to alloc+copy");
    munmap(addr, fileSize);
    return false;
  }

  // Wire each tensor to its position inside the mmap'd region.
  int nAllocOk = 0;
  int nAllocFail = 0;
  for (int64_t i = 0; i < nTensorsInGguf; i++) {
    const char* name = gguf_get_tensor_name(gguf, i);
    struct ggml_tensor* t = ggml_get_tensor(ctxData, name);
    if (!t) {
      continue;
    }
    size_t off = gguf_get_tensor_offset(gguf, i);
    void* tensorAddr = (char*)tensorDataBase + off;
    if (ggml_backend_tensor_alloc(buf, t, tensorAddr) == GGML_STATUS_SUCCESS) {
      nAllocOk++;
    } else {
      nAllocFail++;
      QLOG_IF(
          Priority::WARNING,
          std::string("smolvla_load_model: tensor_alloc failed for '") + name +
              "'");
    }
  }

  if (nAllocFail > 0) {
    // A partially-wired buffer would leave some tensors with
    // unusable pointers; running inference against it is UB.
    // Tear down and fall through to the alloc+copy path.
    QLOG_IF(
        Priority::WARNING,
        "smolvla_load_model: " + std::to_string(nAllocFail) +
            " tensor_alloc calls failed — falling back to alloc+copy");
    ggml_backend_buffer_free(buf);
    munmap(addr, fileSize);
    return false;
  }

  ggml_backend_buffer_set_usage(buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
  model.bufs_w.push_back(buf);
  model.mmap_addr = addr;
  model.mmap_size = fileSize;
  QLOG_IF(
      Priority::INFO,
      "smolvla_load_model: mmap+host_ptr buffer ready, " +
          std::to_string(nAllocOk) + "/" + std::to_string(nTensorsInGguf) +
          " tensors wired");
  return true;
}
#endif

// FALLBACK (Vulkan / Android, Windows, or any device without
// buffer_from_host_ptr): allocate the buffer with
// `ggml_backend_alloc_ctx_tensors_from_buft()`, then read tensor data from
// the file and copy via `ggml_backend_tensor_set()`. Same path llama.cpp's
// `else` branch takes.
static bool loadWeightsAllocCopy(
    SmolvlaModel& model, const char* path, gguf_context* gguf,
    struct ggml_context* ctxData, ggml_backend_buffer_type_t buft,
    size_t dataOffset, int64_t nTensorsInGguf) {
  size_t totalSize = 0;
  for (struct ggml_tensor* t = ggml_get_first_tensor(ctxData); t;
       t = ggml_get_next_tensor(ctxData, t)) {
    totalSize += ggml_nbytes(t);
  }
  QLOG_IF(
      Priority::INFO,
      "smolvla_load_model: alloc+copy path, total weights " +
          std::to_string((int)(totalSize / (1024 * 1024))) + " MB");

  ggml_backend_buffer_t buf =
      ggml_backend_alloc_ctx_tensors_from_buft(ctxData, buft);
  if (!buf) {
    const char* bname = ggml_backend_name(model.backend);
    QLOG_IF(
        Priority::ERROR,
        std::string(
            "smolvla_load_model: ggml_backend_alloc_ctx_tensors_from_buft "
            "FAILED for ") +
            std::to_string((int)(totalSize / (1024 * 1024))) +
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
  std::vector<uint8_t> readBuf;
  int nCopied = 0;
  for (int64_t i = 0; i < nTensorsInGguf; i++) {
    const char* name = gguf_get_tensor_name(gguf, i);
    struct ggml_tensor* t = ggml_get_tensor(ctxData, name);
    if (!t) {
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
    int seekErr = fseeko(f, (off_t)off, SEEK_SET);
#endif
    if (seekErr != 0 || fread(readBuf.data(), 1, nbytes, f) != nbytes) {
      QLOG_IF(
          Priority::ERROR,
          std::string("smolvla_load_model: failed to read tensor '") + name +
              "' at offset " + std::to_string(off));
      fclose(f);
      return false;
    }
    ggml_backend_tensor_set(t, readBuf.data(), 0, nbytes);
    nCopied++;
  }
  fclose(f);
  {
    const char* bname = ggml_backend_name(model.backend);
    QLOG_IF(
        Priority::INFO,
        "smolvla_load_model: alloc+copy buffer ready, " +
            std::to_string(nCopied) + " tensors, backend='" +
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
bool smolvlaLoadModel(
    const char* path, SmolvlaModel& model, bool forceCpu,
    const std::string& backendsDir) {
  QLOG_IF(
      Priority::INFO,
      std::string("smolvla_load_model: loading model from '") + path +
          "' (force_cpu=" + (forceCpu ? "true" : "false") + ")");

  vla_backend_selection::loadBackendsOnce(backendsDir);
  if (!initCpuBackend(model)) {
    return false;
  }
  tryInitGpuBackend(model, forceCpu);
  if (!model.has_gpu) {
    QLOG_IF(Priority::INFO, "smolvla_load_model: using CPU backend");
  }

  // Open GGUF with no_alloc=true — creates a ggml_context with tensor metadata
  // only (data pointers stay NULL). Tensor data is wired up later either by
  // mmap+buffer_from_host_ptr (Apple Metal / CPU) or by alloc+copy from disk
  // (Vulkan / Android). Mirrors llama.cpp's model-loader pattern in
  // qvac-fabric src/llama-model.cpp:6648.
  struct ggml_context* ctxData = nullptr;
  struct gguf_init_params ggufParams = {
      /*.no_alloc =*/true,
      /*.ctx      =*/&ctxData,
  };
  gguf_unique_ptr gguf(gguf_init_from_file(path, ggufParams));
  if (!gguf) {
    QLOG_IF(Priority::ERROR, "smolvla_load_model: failed to open GGUF file");
    return false;
  }
  // Hand ownership of ctx_data to the model immediately so any subsequent
  // failure path leaks neither the ggml context nor the backends.
  model.ctx_w = ctxData;

  const int64_t nTensors = gguf_get_n_tensors(gguf.get());
  QLOG_IF(
      Priority::INFO,
      "smolvla_load_model: loaded " + std::to_string(nTensors) + " tensors");

  readHparamsFromGguf(gguf.get(), model.hparams);
  if (!validateHparams(model.hparams)) {
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

  precomputeTimeEmbedding(model);

  const auto& hp = model.hparams;
  QLOG_IF(
      Priority::INFO,
      "smolvla_load_model: hparams loaded — vision=" +
          std::to_string(hp.vision_num_layers) + "L/" +
          std::to_string(hp.vision_hidden_size) +
          "d text=" + std::to_string(hp.text_num_layers) + "L/" +
          std::to_string(hp.text_hidden_size) +
          "d expert=" + std::to_string(hp.expert_num_layers) + "L/" +
          std::to_string(hp.expert_hidden_size) + "d");

  mapWeightTensors(ctxData, model);
  if (!validateRequiredTensors(model)) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_load_model: GGUF is missing required tensors — refusing to "
        "load");
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
  bool hostPtrSupported = false;
  bool isDefaultBuft = false;
  if (dev) {
    ggml_backend_dev_props props;
    ggml_backend_dev_get_props(dev, &props);
    hostPtrSupported = props.caps.buffer_from_host_ptr;
    isDefaultBuft = (buft == ggml_backend_dev_buffer_type(dev));
  }

  const size_t dataOffset = gguf_get_data_offset(gguf.get());
  const int64_t nTensorsInGguf = gguf_get_n_tensors(gguf.get());

  bool usedMmap = false;
#ifndef _WIN32
  if (hostPtrSupported && isDefaultBuft) {
    usedMmap = tryLoadWeightsMmap(
        model, path, gguf.get(), ctxData, dev, dataOffset, nTensorsInGguf);
  }
#endif
  if (!usedMmap) {
    if (!loadWeightsAllocCopy(
            model,
            path,
            gguf.get(),
            ctxData,
            buft,
            dataOffset,
            nTensorsInGguf)) {
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

void smolvlaFreeModel(SmolvlaModel& model) {
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
SmolvlaModel::~SmolvlaModel() { smolvlaFreeModel(*this); }

// ============================================================
// Full Inference Pipeline
// ============================================================

// Helper: staged graph computation with scheduler support
struct StagedGraph {
  struct ggml_context* ctx;
  struct ggml_cgraph* gf;
  // One of these is used depending on backend
  ggml_gallocr_t allocr;
  ggml_backend_sched_t sched;
};

static StagedGraph
buildStaged(ggml_backend_t backend, size_t ctxBytes, int maxNodes) {
  StagedGraph sg = {};
  struct ggml_init_params params = {ctxBytes, nullptr, true};
  sg.ctx = ggml_init(params);
  sg.gf = ggml_new_graph_custom(sg.ctx, maxNodes, false);
  sg.allocr = nullptr;
  sg.sched = nullptr;
  return sg;
}

// Allocate graph for single-backend (CPU only). Returns false on
// allocator/reserve/alloc failure so the caller can bail before
// `compute_staged()` dereferences a partially-initialised graph.
static bool allocStagedSimple(StagedGraph& sg, ggml_backend_t backend) {
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
allocStagedSched(StagedGraph& sg, ggml_backend_t gpu, ggml_backend_t cpu) {
  ggml_backend_t backends[] = {gpu, cpu};
  sg.sched = ggml_backend_sched_new(
      backends, nullptr, 2, GGML_DEFAULT_GRAPH_SIZE, false, true);
  if (!sg.sched) {
    return false;
  }
  return ggml_backend_sched_alloc_graph(sg.sched, sg.gf);
}

static void computeStaged(StagedGraph& sg, ggml_backend_t backend) {
  if (sg.sched) {
    ggml_backend_sched_graph_compute(sg.sched, sg.gf);
  } else {
    ggml_backend_graph_compute(backend, sg.gf);
  }
}

static void freeStaged(StagedGraph& sg) {
  if (sg.sched)
    ggml_backend_sched_free(sg.sched);
  if (sg.allocr)
    ggml_gallocr_free(sg.allocr);
  if (sg.ctx)
    ggml_free(sg.ctx);
  sg = {};
}

bool smolvlaInferenceWithTiming(
    SmolvlaModel* modelPtr, const float** images, int nImages, int imgWidth,
    int imgHeight, const float* state, int stateDim, const int32_t* langTokens,
    const bool* langMask, int langLen, const float* noise, float* actionsOut,
    int* nActionsOut, SmolvlaTiming* timingOut) {
  const double tTotalStart = nowMs();
  SmolvlaModel& model = *modelPtr;
  const auto& hp = model.hparams;

  // Validate caller-supplied counts before they feed into tensor sizing.
  // Without these, large/negative values would overflow int arithmetic in
  // n_visual_tokens and prefix_len, leading to under-sized tensor allocations
  // and out-of-bounds writes during graph build.
  constexpr int kMaxImages = 16;
  if (nImages <= 0 || nImages > kMaxImages) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_inference: invalid n_images=" + std::to_string(nImages) +
            " (expected 1.." + std::to_string(kMaxImages) + ")");
    return false;
  }
  if (langLen < 0 || langLen > hp.tokenizer_max_length) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_inference: invalid lang_len=" + std::to_string(langLen) +
            " (expected 0.." + std::to_string(hp.tokenizer_max_length) + ")");
    return false;
  }
  if (stateDim < 0 || stateDim > hp.max_state_dim) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_inference: invalid state_dim=" + std::to_string(stateDim) +
            " (expected 0.." + std::to_string(hp.max_state_dim) + ")");
    return false;
  }
  // SigLIP's conv2d output sizes from runtime img_width/img_height, but the
  // downstream reshape to (n_patches, vision_hidden_size) sizes from
  // hp.vision_image_size — so a mismatch trips GGML_ASSERT inside ggml.c
  // (hard abort, not a thrown exception, so the JSCATCH layer can't recover
  // and the worker process dies). Reject mismatches up front so a buggy
  // caller gets a clean false return instead.
  if (imgWidth != hp.vision_image_size || imgHeight != hp.vision_image_size) {
    QLOG_IF(
        Priority::ERROR,
        "smolvla_inference: img dims (" + std::to_string(imgWidth) + "x" +
            std::to_string(imgHeight) + ") must equal vision_image_size (" +
            std::to_string(hp.vision_image_size) + "x" +
            std::to_string(hp.vision_image_size) + ")");
    return false;
  }

  int nVisualTokens = nImages * hp.tokensPerImage();
  int prefixLen = nVisualTokens + langLen + 1; // +1 for state token
  int chunkSize = hp.chunk_size;
  int actionDim = hp.action_dim;
  int kvDim = hp.text_num_kv_heads * hp.text_head_dim;

  // Count valid prefix tokens for attention mask
  int validPrefix = nVisualTokens; // all visual tokens are valid
  for (int i = 0; i < langLen; i++) {
    if (langMask[i])
      validPrefix++;
  }
  validPrefix += 1; // state token
  QLOG_IF(
      Priority::DEBUG,
      "smolvla_inference: prefix_len=" + std::to_string(prefixLen) +
          " valid_prefix=" + std::to_string(validPrefix) + " chunk_size=" +
          std::to_string(chunkSize) + " n_images=" + std::to_string(nImages));

  // ================================================================
  // STAGE 1: Vision encoding (per image) — SigLIP + Connector
  // ================================================================
  int c = hp.vision_num_channels;
  int tokensPerImg = hp.tokensPerImage();
  int hidden = hp.text_hidden_size;

  // Store visual tokens in a flat buffer
  std::vector<float> allVisual(static_cast<size_t>(nVisualTokens) * hidden);

  double tVisionStart = nowMs();

  // Build full SigLIP+connector graph ONCE, reuse per image
  // Conv2d auto-falls back to CPU via scheduler; rest runs on GPU
  // (Vulkan/Metal/OpenCL)
  StagedGraph sgVis = buildStaged(model.backend, 256 * 1024 * 1024, 65536);

  struct ggml_tensor* gPixels =
      ggml_new_tensor_3d(sgVis.ctx, GGML_TYPE_F32, imgWidth, imgHeight, c);
  ggml_set_name(gPixels, "pixels");
  ggml_set_input(gPixels);

  struct ggml_tensor* vis = buildSiglipGraph(sgVis.ctx, model, gPixels);
  struct ggml_tensor* conn = buildConnectorGraph(sgVis.ctx, model, vis);
  conn = ggml_scale(sgVis.ctx, conn, sqrtf((float)hidden));
  ggml_set_name(conn, "conn_out");
  ggml_set_output(conn);

  ggml_build_forward_expand(sgVis.gf, conn);
  {
    const bool ok =
        model.has_gpu
            ? allocStagedSched(sgVis, model.backend, model.backend_cpu)
            : allocStagedSimple(sgVis, model.backend_cpu);
    if (!ok) {
      QLOG_IF(
          Priority::ERROR,
          "smolvla_inference: failed to allocate vision graph");
      freeStaged(sgVis);
      return false;
    }
  }

  for (int imgIdx = 0; imgIdx < nImages; imgIdx++) {
    ggml_backend_tensor_set(
        gPixels, images[imgIdx], 0, c * imgWidth * imgHeight * sizeof(float));
    computeStaged(sgVis, model.backend);
    ggml_backend_tensor_get(
        conn,
        allVisual.data() + imgIdx * tokensPerImg * hidden,
        0,
        tokensPerImg * hidden * sizeof(float));

    QLOG_IF(
        Priority::DEBUG,
        "smolvla_inference: vision img " + std::to_string(imgIdx + 1) + "/" +
            std::to_string(nImages) + " done");
  }
  freeStaged(sgVis);
  double tVisionEnd = nowMs();

  // ================================================================
  // STAGE 2: Build prefix embeddings + SmolLM2 forward → KV cache
  // ================================================================
  double tSmollm2Start = nowMs();
  StagedGraph sg2 = buildStaged(model.backend, 512 * 1024 * 1024, 65536);

  // Inputs: visual tokens, language token IDs, state, masks
  struct ggml_tensor* gVisual =
      ggml_new_tensor_2d(sg2.ctx, GGML_TYPE_F32, hidden, nVisualTokens);
  ggml_set_name(gVisual, "visual");
  ggml_set_input(gVisual);

  struct ggml_tensor* gLangIds =
      ggml_new_tensor_1d(sg2.ctx, GGML_TYPE_I32, langLen);
  ggml_set_name(gLangIds, "lang_ids");
  ggml_set_input(gLangIds);

  struct ggml_tensor* gState =
      ggml_new_tensor_1d(sg2.ctx, GGML_TYPE_F32, hp.max_state_dim);
  ggml_set_name(gState, "state");
  ggml_set_input(gState);

  struct ggml_tensor* gPrefixPos =
      ggml_new_tensor_1d(sg2.ctx, GGML_TYPE_I32, prefixLen);
  ggml_set_name(gPrefixPos, "prefix_pos");
  ggml_set_input(gPrefixPos);

  // Language embedding + scale
  struct ggml_tensor* langEmb =
      ggml_get_rows(sg2.ctx, model.text.embed_tokens, gLangIds);
  langEmb = ggml_scale(sg2.ctx, langEmb, sqrtf((float)hidden));

  // State projection
  struct ggml_tensor* stateEmb = smolvlaLinear(
      sg2.ctx, gState, model.state_proj_weight, model.state_proj_bias);
  stateEmb = ggml_reshape_2d(sg2.ctx, stateEmb, hidden, 1);

  // Concatenate: visual + language + state
  struct ggml_tensor* prefix = ggml_concat(sg2.ctx, gVisual, langEmb, 1);
  prefix = ggml_concat(sg2.ctx, prefix, stateEmb, 1);
  ggml_set_name(prefix, "prefix_embs");
  ggml_set_output(prefix);

  // Prefix attention mask: (prefix_len, prefix_len) additive
  // Padded language tokens should not be attended to
  struct ggml_tensor* gPrefixMask =
      ggml_new_tensor_2d(sg2.ctx, GGML_TYPE_F32, prefixLen, prefixLen);
  ggml_set_name(gPrefixMask, "prefix_mask");
  ggml_set_input(gPrefixMask);

  // SmolLM2 forward — with per-layer output dumps
  std::vector<struct ggml_tensor*> kvKeysT, kvValsT;
  std::vector<struct ggml_tensor*> layerOutputs;
  struct ggml_tensor* smollm2Out = buildSmollm2Graph(
      sg2.ctx,
      model,
      prefix,
      gPrefixPos,
      gPrefixMask,
      kvKeysT,
      kvValsT,
      &layerOutputs);
  ggml_set_name(smollm2Out, "smollm2_out");
  ggml_set_output(smollm2Out);

  // Mark KV cache as outputs so gallocr preserves them
  for (int i = 0; i < hp.text_num_layers; i++) {
    char n[32];
    snprintf(n, sizeof(n), "kk%d", i);
    ggml_set_name(kvKeysT[i], n);
    ggml_set_output(kvKeysT[i]);
    snprintf(n, sizeof(n), "kv%d", i);
    ggml_set_name(kvValsT[i], n);
    ggml_set_output(kvValsT[i]);
  }

  ggml_build_forward_expand(sg2.gf, smollm2Out);
  // Also explicitly expand from KV cache tensors to ensure they're in the graph
  for (int i = 0; i < hp.text_num_layers; i++) {
    ggml_build_forward_expand(sg2.gf, kvKeysT[i]);
    ggml_build_forward_expand(sg2.gf, kvValsT[i]);
  }
  // And layer outputs
  if (!layerOutputs.empty()) {
    for (auto* t : layerOutputs) {
      ggml_build_forward_expand(sg2.gf, t);
    }
  }

  {
    const bool ok =
        model.has_gpu ? allocStagedSched(sg2, model.backend, model.backend_cpu)
                      : allocStagedSimple(sg2, model.backend_cpu);
    if (!ok) {
      QLOG_IF(
          Priority::ERROR,
          "smolvla_inference: failed to allocate prefix graph");
      freeStaged(sg2);
      return false;
    }
  }

  // Set inputs
  ggml_backend_tensor_set(
      gVisual, allVisual.data(), 0, nVisualTokens * hidden * sizeof(float));
  ggml_backend_tensor_set(gLangIds, langTokens, 0, langLen * sizeof(int32_t));

  std::vector<float> statePadded(hp.max_state_dim, 0.0f);
  memcpy(
      statePadded.data(),
      state,
      std::min(stateDim, hp.max_state_dim) * sizeof(float));
  ggml_backend_tensor_set(
      gState, statePadded.data(), 0, hp.max_state_dim * sizeof(float));

  // Prefix attention mask:
  // Build pad_mask: True for valid tokens
  // att_mask: 0 for bidirectional, 1 for causal
  // PyTorch: make_att_2d_masks(pad_masks, att_masks) where
  //   visual: pad=True, att=0; language: pad=lang_mask, att=0; state: pad=True,
  //   att=1
  // Result: 2D mask where invalid (padding) tokens are masked out
  {
    // Build 1D pad mask
    std::vector<bool> pad(prefixLen, false);
    std::vector<int> att(prefixLen, 0);
    for (int i = 0; i < nVisualTokens; i++) {
      pad[i] = true;
      att[i] = 0;
    }
    for (int i = 0; i < langLen; i++) {
      pad[nVisualTokens + i] = langMask[i];
      att[nVisualTokens + i] = 0;
    }
    pad[prefixLen - 1] = true;
    att[prefixLen - 1] = 1;

    // Build 2D mask using cumsum logic from make_att_2d_masks
    std::vector<int> cumsum(prefixLen);
    cumsum[0] = att[0];
    for (int i = 1; i < prefixLen; i++)
      cumsum[i] = cumsum[i - 1] + att[i];

    std::vector<float> maskData(static_cast<size_t>(prefixLen) * prefixLen);
    for (int qi = 0; qi < prefixLen; qi++) {
      for (int ki = 0; ki < prefixLen; ki++) {
        bool attOk = cumsum[ki] <= cumsum[qi]; // attention mask
        bool padOk = pad[qi] && pad[ki];       // padding mask
        maskData[qi * prefixLen + ki] = (attOk && padOk) ? 0.0f : -1e9f;
      }
    }
    ggml_backend_tensor_set(
        gPrefixMask, maskData.data(), 0, maskData.size() * sizeof(float));
  }

  // Position IDs = cumsum(pad_mask) - 1
  // Visual tokens: all valid. Language: some padding. State: valid.
  std::vector<int32_t> posIds(prefixLen);
  {
    int pos = 0;
    // Visual tokens (all valid)
    for (int i = 0; i < nVisualTokens; i++) {
      posIds[i] = pos++;
    }
    // Language tokens (some may be padding)
    for (int i = 0; i < langLen; i++) {
      if (langMask[i])
        pos++;
      posIds[nVisualTokens + i] = pos - 1;
    }
    // State token (valid)
    posIds[prefixLen - 1] = pos;
  }
  ggml_backend_tensor_set(
      gPrefixPos, posIds.data(), 0, prefixLen * sizeof(int32_t));

  computeStaged(sg2, model.backend);
  double tSmollm2Compute = nowMs();

  // Recompute KV cache from layer inputs
  // The graph allocator may reuse K/V buffers, so we recompute them in separate
  // mini-graphs. Layer i input = layer_outputs[i-1] (or prefix_embs for i=0) K
  // = RoPE(k_proj(RMSNorm(input))), V = v_proj(RMSNorm(input))
  std::vector<std::vector<float>> kvKeysData(hp.text_num_layers);
  std::vector<std::vector<float>> kvValsData(hp.text_num_layers);
  int kvTotal = kvDim * prefixLen;

  {
    std::vector<float> prevHidden(static_cast<size_t>(prefixLen) * hidden);
    ggml_backend_tensor_get(
        prefix, prevHidden.data(), 0, prevHidden.size() * sizeof(float));

    // Read position IDs (same as used in the main graph)
    // pos_ids is already computed above

    for (int i = 0; i < hp.text_num_layers; i++) {
      StagedGraph sgKv = buildStaged(model.backend, 64 * 1024 * 1024, 512);

      struct ggml_tensor* gH =
          ggml_new_tensor_2d(sgKv.ctx, GGML_TYPE_F32, hidden, prefixLen);
      ggml_set_name(gH, "h");
      ggml_set_input(gH);

      struct ggml_tensor* gPos =
          ggml_new_tensor_1d(sgKv.ctx, GGML_TYPE_I32, prefixLen);
      ggml_set_name(gPos, "pos");
      ggml_set_input(gPos);

      struct ggml_tensor* normed = smolvlaRmsNorm(
          sgKv.ctx,
          gH,
          model.text.layers[i].attn_norm_weight,
          hp.text_rms_norm_eps);

      int qD = hp.text_num_heads * hp.text_head_dim;
      int kvD = hp.text_num_kv_heads * hp.text_head_dim;

      struct ggml_tensor *kOut, *vOut;
      if (model.text.layers[i].v_proj_weight) {
        kOut = smolvlaLinear(
            sgKv.ctx, normed, model.text.layers[i].k_proj_weight, nullptr);
        vOut = smolvlaLinear(
            sgKv.ctx, normed, model.text.layers[i].v_proj_weight, nullptr);
      } else {
        struct ggml_tensor* qkv = ggml_mul_mat(
            sgKv.ctx, model.text.layers[i].qkv_proj_weight, normed);
        kOut = ggml_view_2d(
            sgKv.ctx,
            qkv,
            kvD,
            prefixLen,
            qkv->nb[1],
            qD * ggml_element_size(qkv));
        vOut = ggml_view_2d(
            sgKv.ctx,
            qkv,
            kvD,
            prefixLen,
            qkv->nb[1],
            (qD + kvD) * ggml_element_size(qkv));
        kOut = ggml_cont(sgKv.ctx, kOut);
        vOut = ggml_cont(sgKv.ctx, vOut);
      }

      // Reshape K to 3D and apply RoPE
      kOut = ggml_reshape_3d(
          sgKv.ctx, kOut, hp.text_head_dim, hp.text_num_kv_heads, prefixLen);
      kOut = ggml_rope(
          sgKv.ctx, kOut, gPos, hp.text_head_dim, GGML_ROPE_TYPE_NEOX);

      ggml_set_name(kOut, "k");
      ggml_set_output(kOut);
      ggml_set_name(vOut, "v");
      ggml_set_output(vOut);
      ggml_build_forward_expand(sgKv.gf, kOut);
      ggml_build_forward_expand(sgKv.gf, vOut);
      {
        const bool ok =
            model.has_gpu
                ? allocStagedSched(sgKv, model.backend, model.backend_cpu)
                : allocStagedSimple(sgKv, model.backend_cpu);
        if (!ok) {
          QLOG_IF(
              Priority::ERROR,
              "smolvla_inference: failed to allocate KV mini-graph at layer " +
                  std::to_string(i));
          freeStaged(sgKv);
          freeStaged(sg2);
          return false;
        }
      }

      ggml_backend_tensor_set(
          gH, prevHidden.data(), 0, prevHidden.size() * sizeof(float));
      ggml_backend_tensor_set(
          gPos, posIds.data(), 0, prefixLen * sizeof(int32_t));
      computeStaged(sgKv, model.backend);

      kvKeysData[i].resize(kvTotal);
      kvValsData[i].resize(kvTotal);
      ggml_backend_tensor_get(
          kOut, kvKeysData[i].data(), 0, kvTotal * sizeof(float));
      ggml_backend_tensor_get(
          vOut, kvValsData[i].data(), 0, kvTotal * sizeof(float));

      if (i < hp.text_num_layers - 1) {
        ggml_backend_tensor_get(
            layerOutputs[i],
            prevHidden.data(),
            0,
            prevHidden.size() * sizeof(float));
      }

      freeStaged(sgKv);
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
    const int expertKvDim = hp.expert_num_kv_heads * hp.expert_head_dim;
    // The original cross-attn graph reshaped the projected K to
    // (expert_head_dim, expert_num_kv_heads, prefix_len); the input slot
    // was sized at text kv_dim, so the two were already implicitly
    // assumed equal. Assert it explicitly now that we rely on it for
    // the in-place overwrite below.
    assert(
        expert_kv_dim == kv_dim &&
        "cross-attn hoist requires expert kv_dim == text kv_dim");

    for (int i = 0; i < hp.expert_num_layers; i++) {
      const bool isSa =
          (hp.self_attn_every_n > 0) && (i % hp.self_attn_every_n == 0);
      if (isSa)
        continue;

      const auto& elw = model.expert.layers[i];
      if (!elw.k_proj_weight || !elw.v_proj_weight)
        continue;

      StagedGraph sgXp = buildStaged(model.backend, 32 * 1024 * 1024, 256);

      struct ggml_tensor* gKin =
          ggml_new_tensor_2d(sgXp.ctx, GGML_TYPE_F32, kvDim, prefixLen);
      ggml_set_name(gKin, "kin");
      ggml_set_input(gKin);
      struct ggml_tensor* gVin =
          ggml_new_tensor_2d(sgXp.ctx, GGML_TYPE_F32, kvDim, prefixLen);
      ggml_set_name(gVin, "vin");
      ggml_set_input(gVin);

      struct ggml_tensor* kProj =
          smolvlaLinear(sgXp.ctx, gKin, elw.k_proj_weight, nullptr);
      struct ggml_tensor* vProj =
          smolvlaLinear(sgXp.ctx, gVin, elw.v_proj_weight, nullptr);
      ggml_set_name(kProj, "kp");
      ggml_set_output(kProj);
      ggml_set_name(vProj, "vp");
      ggml_set_output(vProj);

      ggml_build_forward_expand(sgXp.gf, kProj);
      ggml_build_forward_expand(sgXp.gf, vProj);

      {
        const bool ok =
            model.has_gpu
                ? allocStagedSched(sgXp, model.backend, model.backend_cpu)
                : allocStagedSimple(sgXp, model.backend_cpu);
        if (!ok) {
          QLOG_IF(
              Priority::ERROR,
              "smolvla_inference: failed to allocate expert KV-projection "
              "graph at layer " +
                  std::to_string(i));
          freeStaged(sgXp);
          freeStaged(sg2);
          return false;
        }
      }

      ggml_backend_tensor_set(
          gKin, kvKeysData[i].data(), 0, kvTotal * sizeof(float));
      ggml_backend_tensor_set(
          gVin, kvValsData[i].data(), 0, kvTotal * sizeof(float));
      computeStaged(sgXp, model.backend);

      ggml_backend_tensor_get(
          kProj, kvKeysData[i].data(), 0, kvTotal * sizeof(float));
      ggml_backend_tensor_get(
          vProj, kvValsData[i].data(), 0, kvTotal * sizeof(float));

      freeStaged(sgXp);
    }
  }

  freeStaged(sg2);
  double tSmollm2End = nowMs();

  // ================================================================
  // STAGE 3: ODE loop — 10 denoise steps through action expert
  // ================================================================
  double tOdeStart = nowMs();

  // Initial noise
  std::vector<float> xT(static_cast<size_t>(chunkSize) * hp.max_action_dim);
  if (noise) {
    memcpy(
        xT.data(),
        noise,
        static_cast<size_t>(chunkSize) * hp.max_action_dim * sizeof(float));
  } else {
    std::mt19937 rng(42);
    std::normal_distribution<float> normal(0.0f, 1.0f);
    for (auto& v : xT)
      v = normal(rng);
  }

  // Build self-attention mask: (full_len, chunk_size)
  // Prefix part: attend to all valid tokens; suffix part: causal
  int fullLen = prefixLen + chunkSize;
  std::vector<float> saMask(static_cast<size_t>(fullLen) * chunkSize);
  for (int qi = 0; qi < chunkSize; qi++) {
    // Prefix columns: attend to valid prefix tokens
    for (int ki = 0; ki < prefixLen; ki++) {
      bool valid = (ki < nVisualTokens) || // visual tokens
                   (ki >= nVisualTokens && ki < nVisualTokens + langLen &&
                    langMask[ki - nVisualTokens]) || // language
                   (ki == prefixLen - 1);            // state token
      saMask[qi * fullLen + ki] = valid ? 0.0f : -1e9f;
    }
    // Suffix columns: causal (attend to current and previous)
    for (int ki = 0; ki < chunkSize; ki++) {
      saMask[qi * fullLen + prefixLen + ki] = (ki <= qi) ? 0.0f : -1e9f;
    }
  }

  float dt = -1.0f / hp.num_ode_steps;

  // Build expert graph ONCE, reuse for all 10 ODE steps
  StagedGraph sg3 = buildStaged(model.backend, 256 * 1024 * 1024, 65536);

  struct ggml_tensor* gXt =
      ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, hp.max_action_dim, chunkSize);
  ggml_set_name(gXt, "x_t");
  ggml_set_input(gXt);

  struct ggml_tensor* gTe = ggml_new_tensor_2d(
      sg3.ctx, GGML_TYPE_F32, hp.expert_hidden_size, chunkSize);
  ggml_set_name(gTe, "time");
  ggml_set_input(gTe);

  struct ggml_tensor* gPos =
      ggml_new_tensor_1d(sg3.ctx, GGML_TYPE_I32, chunkSize);
  ggml_set_name(gPos, "pos");
  ggml_set_input(gPos);

  struct ggml_tensor* gCpos =
      ggml_new_tensor_1d(sg3.ctx, GGML_TYPE_I32, chunkSize);
  ggml_set_name(gCpos, "cpos");
  ggml_set_input(gCpos);

  struct ggml_tensor* gSamask =
      ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, fullLen, chunkSize);
  ggml_set_name(gSamask, "samask");
  ggml_set_input(gSamask);

  std::vector<struct ggml_tensor*> gKk(hp.text_num_layers),
      gKv(hp.text_num_layers);
  for (int i = 0; i < hp.text_num_layers; i++) {
    bool isSa = (hp.self_attn_every_n > 0) && (i % hp.self_attn_every_n == 0);
    char n[32];
    if (isSa) {
      snprintf(n, sizeof(n), "kk%d", i);
      gKk[i] = ggml_new_tensor_3d(
          sg3.ctx,
          GGML_TYPE_F32,
          hp.text_head_dim,
          hp.text_num_kv_heads,
          prefixLen);
      ggml_set_name(gKk[i], n);
      ggml_set_input(gKk[i]);
      snprintf(n, sizeof(n), "kv%d", i);
      gKv[i] = ggml_new_tensor_3d(
          sg3.ctx,
          GGML_TYPE_F32,
          hp.text_head_dim,
          hp.text_num_kv_heads,
          prefixLen);
      ggml_set_name(gKv[i], n);
      ggml_set_input(gKv[i]);
    } else {
      snprintf(n, sizeof(n), "kk%d", i);
      gKk[i] = ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, kvDim, prefixLen);
      ggml_set_name(gKk[i], n);
      ggml_set_input(gKk[i]);
      snprintf(n, sizeof(n), "kv%d", i);
      gKv[i] = ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, kvDim, prefixLen);
      ggml_set_name(gKv[i], n);
      ggml_set_input(gKv[i]);
    }
  }

  // Cross-attention mask: (prefix_len, chunk_size) — mask out padding tokens
  struct ggml_tensor* gCamask =
      ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, prefixLen, chunkSize);
  ggml_set_name(gCamask, "camask");
  ggml_set_input(gCamask);

  struct ggml_tensor* vT = buildDenoiseStepGraph(
      sg3.ctx,
      model,
      gXt,
      gTe,
      gKk.data(),
      gKv.data(),
      gPos,
      gCpos,
      gCamask,
      gSamask);
  ggml_set_name(vT, "v_t");
  ggml_set_output(vT);

  ggml_build_forward_expand(sg3.gf, vT);

  {
    const bool ok =
        model.has_gpu ? allocStagedSched(sg3, model.backend, model.backend_cpu)
                      : allocStagedSimple(sg3, model.backend_cpu);
    if (!ok) {
      QLOG_IF(
          Priority::ERROR, "smolvla_inference: failed to allocate ODE graph");
      freeStaged(sg3);
      return false;
    }
  }

  // Set static inputs (don't change between steps)
  std::vector<int32_t> saPos(chunkSize), crPos(chunkSize);
  for (int j = 0; j < chunkSize; j++) {
    saPos[j] = validPrefix + j;
    crPos[j] = j;
  }
  ggml_backend_tensor_set(gPos, saPos.data(), 0, chunkSize * sizeof(int32_t));
  ggml_backend_tensor_set(gCpos, crPos.data(), 0, chunkSize * sizeof(int32_t));
  ggml_backend_tensor_set(
      gSamask, saMask.data(), 0, saMask.size() * sizeof(float));

  // Cross-attention mask: mask out padding tokens in VLM prefix
  {
    std::vector<float> caMask(static_cast<size_t>(prefixLen) * chunkSize);
    for (int qi = 0; qi < chunkSize; qi++) {
      for (int ki = 0; ki < prefixLen; ki++) {
        bool valid = (ki < nVisualTokens) ||
                     (ki >= nVisualTokens && ki < nVisualTokens + langLen &&
                      langMask[ki - nVisualTokens]) ||
                     (ki == prefixLen - 1);
        caMask[qi * prefixLen + ki] = valid ? 0.0f : -1e9f;
      }
    }
    ggml_backend_tensor_set(
        gCamask, caMask.data(), 0, caMask.size() * sizeof(float));
  }

  for (int i = 0; i < hp.text_num_layers; i++) {
    if (gKk[i]->buffer) {
      ggml_backend_tensor_set(
          gKk[i], kvKeysData[i].data(), 0, kvTotal * sizeof(float));
    }
    if (gKv[i]->buffer) {
      ggml_backend_tensor_set(
          gKv[i], kvValsData[i].data(), 0, kvTotal * sizeof(float));
    }
  }

  std::vector<float> vtData(static_cast<size_t>(chunkSize) * hp.max_action_dim);
  std::vector<float> teExpanded(
      static_cast<size_t>(chunkSize) * hp.expert_hidden_size);
  // Hoist time-embedding scratch out of the ODE loop — one allocation reused
  // across 10 steps instead of `num_ode_steps` per-iteration heap churns.
  std::vector<float> teSingle(hp.expert_hidden_size);

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
    float tVal = 1.0f + step * dt;

    ggml_backend_tensor_set(gXt, xT.data(), 0, xT.size() * sizeof(float));
    for (int i = 0; i < hp.text_num_layers; i++) {
      if (gKk[i]->buffer) {
        ggml_backend_tensor_set(
            gKk[i], kvKeysData[i].data(), 0, kvTotal * sizeof(float));
      }
      if (gKv[i]->buffer) {
        ggml_backend_tensor_set(
            gKv[i], kvValsData[i].data(), 0, kvTotal * sizeof(float));
      }
    }

    computeSinusoidalTimeEmbeddingCached(
        tVal,
        model.time_embed_inv_periods.data(),
        hp.expert_hidden_size,
        teSingle.data());
    // Broadcast `te_single` to all `chunk_size` rows using a doubling
    // pattern: ~log2(chunk_size) larger memcpys instead of `chunk_size`
    // small ones (50 → ~7 calls for chunk_size=50).
    if (chunkSize > 0) {
      const size_t rowFloats = hp.expert_hidden_size;
      const size_t rowBytes = rowFloats * sizeof(float);
      memcpy(teExpanded.data(), teSingle.data(), rowBytes);
      size_t filled = 1;
      while (filled < (size_t)chunkSize) {
        const size_t take = std::min(filled, (size_t)chunkSize - filled);
        memcpy(
            teExpanded.data() + filled * rowFloats,
            teExpanded.data(),
            take * rowBytes);
        filled += take;
      }
    }
    ggml_backend_tensor_set(
        gTe, teExpanded.data(), 0, teExpanded.size() * sizeof(float));

    // Compute (reuses same graph and allocations). compute_staged routes
    // through sg3.sched when present and falls back to model.backend
    // otherwise, matching the dispatch every other stage uses. Avoids the
    // foot-gun of hardcoding backend_cpu — if alloc_staged_sched ever
    // returned with sched==nullptr on a GPU build, the inline form would
    // silently fire CPU compute on GPU-allocated tensors.
    computeStaged(sg3, model.backend);

    // Read velocity and do Euler step
    ggml_backend_tensor_get(
        vT, vtData.data(), 0, vtData.size() * sizeof(float));

    for (int j = 0; j < chunkSize * hp.max_action_dim; j++) {
      xT[j] += vtData[j] * dt;
    }

    QLOG_IF(
        Priority::DEBUG,
        "smolvla_inference: ODE step " + std::to_string(step + 1) + "/" +
            std::to_string(hp.num_ode_steps) + " done");
  }

  freeStaged(sg3);

  double tOdeEnd = nowMs();

  QLOG_IF(
      Priority::INFO,
      "smolvla_inference: TIMING vision=" +
          std::to_string((int)(tVisionEnd - tVisionStart)) +
          "ms smollm2_compute=" +
          std::to_string((int)(tSmollm2Compute - tSmollm2Start)) +
          "ms smollm2_total=" +
          std::to_string((int)(tSmollm2End - tSmollm2Start)) +
          "ms ode=" + std::to_string((int)(tOdeEnd - tOdeStart)) + "ms");

  // ================================================================
  // STAGE 4: Extract actions
  // ================================================================
  for (int i = 0; i < chunkSize; i++) {
    for (int j = 0; j < actionDim; j++) {
      actionsOut[i * actionDim + j] = xT[i * hp.max_action_dim + j];
    }
  }
  *nActionsOut = chunkSize;

  if (timingOut) {
    timingOut->vision_ms = tVisionEnd - tVisionStart;
    timingOut->smollm2_compute_ms = tSmollm2Compute - tSmollm2Start;
    timingOut->smollm2_total_ms = tSmollm2End - tSmollm2Start;
    timingOut->ode_ms = tOdeEnd - tOdeStart;
    timingOut->total_ms = nowMs() - tTotalStart;
  }

  return true;
}
