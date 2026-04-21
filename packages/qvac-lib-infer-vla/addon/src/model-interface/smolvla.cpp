#include "smolvla.hpp"

#include <cassert>
#include <cstdlib>
#include <random>
#include <algorithm>
#include <chrono>

// Debug: dump tensor data to a raw file (no-op; set VLA_DUMP_TENSORS=1 in
// smolvla-ggml dev builds to enable file output for layer-by-layer comparisons
// against PyTorch).
static void dump_tensor(const char * /*name*/, const float * /*data*/, int /*n*/) {
}

static double now_ms() {
    return std::chrono::duration<double, std::milli>(
        std::chrono::high_resolution_clock::now().time_since_epoch()).count();
}

// ============================================================
// Utility: GGML graph helpers
// ============================================================

// Cast tensor to F32 if it's not already F32
static struct ggml_tensor * to_f32(struct ggml_context * ctx, struct ggml_tensor * x) {
    if (x && x->type != GGML_TYPE_F32) {
        return ggml_cast(ctx, x, GGML_TYPE_F32);
    }
    return x;
}

// Truncate F32 to BF16 precision (round to BF16 then back to F32)
// This matches PyTorch's hidden.to(bfloat16) behavior
static struct ggml_tensor * to_bf16_precision(struct ggml_context * ctx, struct ggml_tensor * x) {
    // Cast F32 -> BF16 -> F32: truncates mantissa to 7 bits
    struct ggml_tensor * bf16 = ggml_cast(ctx, x, GGML_TYPE_BF16);
    return ggml_cast(ctx, bf16, GGML_TYPE_F32);
}

static struct ggml_tensor * smolvla_layer_norm(
    struct ggml_context * ctx,
    struct ggml_tensor * x,
    struct ggml_tensor * weight,
    struct ggml_tensor * bias,
    float eps)
{
    x = ggml_norm(ctx, x, eps);
    x = ggml_mul(ctx, x, to_f32(ctx, weight));
    if (bias) {
        x = ggml_add(ctx, x, to_f32(ctx, bias));
    }
    return x;
}

static struct ggml_tensor * smolvla_rms_norm(
    struct ggml_context * ctx,
    struct ggml_tensor * x,
    struct ggml_tensor * weight,
    float eps)
{
    x = ggml_rms_norm(ctx, x, eps);
    x = ggml_mul(ctx, x, to_f32(ctx, weight));
    return x;
}

// SiLU activation: x * sigmoid(x)
static struct ggml_tensor * smolvla_silu(
    struct ggml_context * ctx,
    struct ggml_tensor * x)
{
    return ggml_silu(ctx, x);
}

// GELU with tanh approximation (used by SigLIP)
static struct ggml_tensor * smolvla_gelu(
    struct ggml_context * ctx,
    struct ggml_tensor * x)
{
    return ggml_gelu(ctx, x);
}

// Linear layer: y = x @ W^T + b
// x: (..., in_features)
// weight: (out_features, in_features)
// bias: (out_features,) or NULL
static struct ggml_tensor * smolvla_linear(
    struct ggml_context * ctx,
    struct ggml_tensor * x,
    struct ggml_tensor * weight,
    struct ggml_tensor * bias)
{
    struct ggml_tensor * out = ggml_mul_mat(ctx, weight, x);
    if (bias) {
        out = ggml_add(ctx, out, to_f32(ctx, bias));
    }
    return out;
}

// ============================================================
// RoPE: Rotary Position Embedding (split-half formulation)
// ============================================================

// Apply RoPE to tensor x of shape (B, L, H, D) given position_ids (B, L)
// SmolVLA uses split-half: [x1*cos - x2*sin, x2*cos + x1*sin]
// max_wavelength = 10000
static struct ggml_tensor * smolvla_rope(
    struct ggml_context * ctx,
    struct ggml_tensor * x,
    struct ggml_tensor * position_ids,
    int head_dim,
    float max_wavelength = 10000.0f)
{
    // GGML's ggml_rope implements the standard RoPE
    // We need mode=0 for the split-half (non-interleaved) formulation
    // n_dims = head_dim (apply to all dims)
    // In GGML: ggml_rope(ctx, x, positions, n_dims, mode)
    // mode 0 = standard, mode 2 = neox (interleaved)
    // SmolVLA uses split-half which is mode 0

    // x shape in GGML: (D, H, L, B) due to row-major convention
    // position_ids: (L, B)
    return ggml_rope(ctx, x, position_ids, head_dim, GGML_ROPE_TYPE_NEOX);
}

// ============================================================
// SigLIP Vision Encoder
// ============================================================

// Build patch embedding only (conv2d — CPU-only op)
// Returns: (n_patches, hidden_size) = (1024, 768)
static struct ggml_tensor * build_siglip_patch_embed(
    struct ggml_context * ctx,
    smolvla_model & model,
    struct ggml_tensor * pixel_values)
{
    const auto & hp = model.hparams;
    const auto & vw = model.vision;

    struct ggml_tensor * x = ggml_conv_2d(ctx,
        vw.patch_embed_weight, pixel_values,
        hp.vision_patch_size, hp.vision_patch_size,
        0, 0, 1, 1);

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
static struct ggml_tensor * build_siglip_transformer(
    struct ggml_context * ctx,
    smolvla_model & model,
    struct ggml_tensor * x)
{
    const auto & hp = model.hparams;
    const auto & vw = model.vision;
    int n_patches = hp.patches_per_image();

    // Transformer layers
    for (int i = 0; i < hp.vision_num_layers; i++) {
        const auto & layer = vw.layers[i];

        // Pre-norm (LayerNorm)
        struct ggml_tensor * residual = x;
        x = smolvla_layer_norm(ctx, x, layer.ln1_weight, layer.ln1_bias, hp.vision_layer_norm_eps);

        // Multi-head self-attention
        int d = hp.vision_hidden_size;
        int h = hp.vision_num_heads;
        int dh = d / h;

        struct ggml_tensor * q, * k, * v;
        if (layer.qkv_proj_w) {
            struct ggml_tensor * qkv = smolvla_linear(ctx, x, layer.qkv_proj_w, layer.qkv_proj_b);
            q = ggml_cont(ctx, ggml_view_2d(ctx, qkv, d, n_patches, qkv->nb[1], 0));
            k = ggml_cont(ctx, ggml_view_2d(ctx, qkv, d, n_patches, qkv->nb[1], d * ggml_element_size(qkv)));
            v = ggml_cont(ctx, ggml_view_2d(ctx, qkv, d, n_patches, qkv->nb[1], 2 * d * ggml_element_size(qkv)));
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

        // Attention: softmax(Q @ K^T / sqrt(d)) @ V
        struct ggml_tensor * attn = ggml_mul_mat(ctx, k, q); // (L, L, H)
        attn = ggml_scale(ctx, attn, 1.0f / sqrtf((float)dh));
        attn = ggml_soft_max(ctx, attn);
        struct ggml_tensor * attn_out = ggml_mul_mat(ctx,
            ggml_cont(ctx, ggml_transpose(ctx, v)), attn); // (dh, L, H)

        // Reshape back to (n_patches, hidden_size)
        attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3)); // (dh, H, L)
        attn_out = ggml_reshape_2d(ctx, attn_out, d, n_patches);

        // Output projection
        x = smolvla_linear(ctx, attn_out, layer.out_proj_w, layer.out_proj_b);

        // Residual
        x = ggml_add(ctx, x, residual);

        // Post-norm + MLP
        residual = x;
        x = smolvla_layer_norm(ctx, x, layer.ln2_weight, layer.ln2_bias, hp.vision_layer_norm_eps);

        // MLP: fc1 -> GELU -> fc2
        x = smolvla_linear(ctx, x, layer.fc1_weight, layer.fc1_bias);
        x = smolvla_gelu(ctx, x);
        x = smolvla_linear(ctx, x, layer.fc2_weight, layer.fc2_bias);

        // Residual
        x = ggml_add(ctx, x, residual);
    }

    // Post-LayerNorm
    if (vw.post_ln_weight) {
        x = smolvla_layer_norm(ctx, x, vw.post_ln_weight, vw.post_ln_bias, hp.vision_layer_norm_eps);
    }

    // x is now (1024, 768)
    return x;
}

// Full SigLIP: patch embed + transformer (single-backend, for backward compat)
struct ggml_tensor * build_siglip_graph(
    struct ggml_context * ctx,
    smolvla_model & model,
    struct ggml_tensor * pixel_values)
{
    struct ggml_tensor * patches = build_siglip_patch_embed(ctx, model, pixel_values);
    return build_siglip_transformer(ctx, model, patches);
}

// ============================================================
// Connector: PixelShuffle + MLP projection
// ============================================================

struct ggml_tensor * build_connector_graph(
    struct ggml_context * ctx,
    smolvla_model & model,
    struct ggml_tensor * vision_output) // (1024, 768)
{
    const auto & hp = model.hparams;
    int sf = hp.connector_scale_factor; // 4
    int n_patches = hp.patches_per_image(); // 1024
    int side = (int)sqrtf((float)n_patches); // 32
    int d = hp.vision_hidden_size; // 768

    // PixelShuffle:
    // Input: (1024, 768) = (32*32, 768)
    // Step 1: reshape to (32, 32, 768)
    struct ggml_tensor * x = ggml_reshape_3d(ctx, vision_output, d, side, side);

    // Step 2: reshape to (32, 8, 768*4) -- group width by scale_factor
    x = ggml_reshape_3d(ctx, x, d * sf, side / sf, side);

    // Step 3: permute to (8, 32, 768*4) -> (8, 8, 768*16)
    x = ggml_cont(ctx, ggml_permute(ctx, x, 0, 2, 1, 3));
    x = ggml_reshape_3d(ctx, x, d * sf * sf, side / sf, side / sf);

    // Step 4: permute back and reshape to (64, 12288)
    x = ggml_cont(ctx, ggml_permute(ctx, x, 0, 2, 1, 3));
    int n_tokens = hp.tokens_per_image(); // 64
    x = ggml_reshape_2d(ctx, x, d * sf * sf, n_tokens); // (64, 12288)

    // MLP projection: Linear(12288, 960, bias=False)
    x = smolvla_linear(ctx, x, model.connector.proj_weight, nullptr);

    return x; // (64, 960)
}

// ============================================================
// SmolLM2 Transformer Block (single layer)
// ============================================================

// GQA attention for SmolLM2 / Expert
// q: (seq_len, num_heads * head_dim)
// k: (seq_len, num_kv_heads * head_dim)
// v: (seq_len, num_kv_heads * head_dim)
// Returns: (seq_len, num_heads * head_dim)
static struct ggml_tensor * build_gqa_attention(
    struct ggml_context * ctx,
    struct ggml_tensor * q, struct ggml_tensor * k, struct ggml_tensor * v,
    struct ggml_tensor * position_ids,
    int num_heads, int num_kv_heads, int head_dim,
    int seq_len,
    struct ggml_tensor * attn_mask, // optional (seq_len, kv_len) boolean-like
    bool apply_rope_flag = true)
{
    int kv_groups = num_heads / num_kv_heads;
    int kv_len = k->ne[1]; // may differ from seq_len for cross-attention

    // Reshape Q, K, V to multi-head format
    q = ggml_reshape_3d(ctx, q, head_dim, num_heads, seq_len);
    k = ggml_reshape_3d(ctx, k, head_dim, num_kv_heads, kv_len);
    v = ggml_reshape_3d(ctx, v, head_dim, num_kv_heads, kv_len);

    // Apply RoPE
    if (apply_rope_flag && position_ids) {
        q = ggml_rope(ctx, q, position_ids, head_dim, GGML_ROPE_TYPE_NEOX);
        k = ggml_rope(ctx, k, position_ids, head_dim, GGML_ROPE_TYPE_NEOX);
    }

    // Repeat KV heads for GQA
    if (kv_groups > 1) {
        // k: (head_dim, num_kv_heads, kv_len) -> (head_dim, num_heads, kv_len)
        k = ggml_reshape_4d(ctx, k, head_dim, 1, num_kv_heads, kv_len);
        k = ggml_repeat(ctx, k, ggml_new_tensor_4d(ctx, k->type, head_dim, kv_groups, num_kv_heads, kv_len));
        k = ggml_reshape_3d(ctx, k, head_dim, num_heads, kv_len);

        v = ggml_reshape_4d(ctx, v, head_dim, 1, num_kv_heads, kv_len);
        v = ggml_repeat(ctx, v, ggml_new_tensor_4d(ctx, v->type, head_dim, kv_groups, num_kv_heads, kv_len));
        v = ggml_reshape_3d(ctx, v, head_dim, num_heads, kv_len);
    }

    // Permute for matmul: (head_dim, seq_len, num_heads)
    q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
    k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
    v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

    // Q @ K^T -> (kv_len, seq_len, num_heads)
    struct ggml_tensor * attn_weights = ggml_mul_mat(ctx, k, q);
    attn_weights = ggml_scale(ctx, attn_weights, 1.0f / sqrtf((float)head_dim));

    // Apply attention mask if provided
    if (attn_mask) {
        attn_weights = ggml_add(ctx, attn_weights, attn_mask);
    }

    attn_weights = ggml_soft_max(ctx, attn_weights);

    // Attn @ V -> (head_dim, seq_len, num_heads)
    struct ggml_tensor * attn_out = ggml_mul_mat(ctx,
        ggml_cont(ctx, ggml_transpose(ctx, v)), attn_weights);

    // Permute back: (head_dim, num_heads, seq_len) -> reshape to (num_heads*head_dim, seq_len)
    attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
    attn_out = ggml_reshape_2d(ctx, attn_out, num_heads * head_dim, seq_len);

    return attn_out;
}

// Single transformer layer (SmolLM2 or Expert)
// If kv_key_out / kv_val_out are non-null, stores post-RoPE K/V tensors (before GQA repeat)
static struct ggml_tensor * build_transformer_layer(
    struct ggml_context * ctx,
    struct ggml_tensor * hidden_states, // (seq_len, hidden_size)
    const transformer_layer_weights & lw,
    struct ggml_tensor * position_ids,
    int num_heads, int num_kv_heads, int head_dim,
    float rms_eps,
    struct ggml_tensor * attn_mask = nullptr,
    struct ggml_tensor ** kv_key_out = nullptr,
    struct ggml_tensor ** kv_val_out = nullptr)
{
    int seq_len = hidden_states->ne[1];

    // Pre-attention RMSNorm
    struct ggml_tensor * residual = hidden_states;
    hidden_states = smolvla_rms_norm(ctx, hidden_states, lw.attn_norm_weight, rms_eps);

    // QKV projections — fused or unfused
    struct ggml_tensor * q, * k, * v;
    int q_dim = num_heads * head_dim;
    int kv_dim_each = num_kv_heads * head_dim;

    if (lw.qkv_proj_weight) {
        // Fused: one matmul, then split via views
        struct ggml_tensor * qkv = ggml_mul_mat(ctx, lw.qkv_proj_weight, hidden_states);
        q = ggml_view_2d(ctx, qkv, q_dim, seq_len, qkv->nb[1], 0);
        k = ggml_view_2d(ctx, qkv, kv_dim_each, seq_len, qkv->nb[1], q_dim * ggml_element_size(qkv));
        v = ggml_view_2d(ctx, qkv, kv_dim_each, seq_len, qkv->nb[1], (q_dim + kv_dim_each) * ggml_element_size(qkv));
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
    if (kv_key_out) *kv_key_out = k;
    if (kv_val_out) *kv_val_out = v;

    // GQA repeat for attention computation
    int kv_groups = num_heads / num_kv_heads;
    struct ggml_tensor * k_expanded = k;
    struct ggml_tensor * v_expanded = v;
    if (kv_groups > 1) {
        k_expanded = ggml_reshape_4d(ctx, k, head_dim, 1, num_kv_heads, seq_len);
        k_expanded = ggml_repeat(ctx, k_expanded, ggml_new_tensor_4d(ctx, k->type, head_dim, kv_groups, num_kv_heads, seq_len));
        k_expanded = ggml_reshape_3d(ctx, k_expanded, head_dim, num_heads, seq_len);

        v_expanded = ggml_reshape_4d(ctx, v, head_dim, 1, num_kv_heads, seq_len);
        v_expanded = ggml_repeat(ctx, v_expanded, ggml_new_tensor_4d(ctx, v->type, head_dim, kv_groups, num_kv_heads, seq_len));
        v_expanded = ggml_reshape_3d(ctx, v_expanded, head_dim, num_heads, seq_len);
    }

    // Attention computation
    q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
    k_expanded = ggml_cont(ctx, ggml_permute(ctx, k_expanded, 0, 2, 1, 3));
    v_expanded = ggml_cont(ctx, ggml_permute(ctx, v_expanded, 0, 2, 1, 3));

    struct ggml_tensor * attn_weights = ggml_mul_mat(ctx, k_expanded, q);
    attn_weights = ggml_scale(ctx, attn_weights, 1.0f / sqrtf((float)head_dim));

    if (attn_mask) {
        attn_weights = ggml_add(ctx, attn_weights, attn_mask);
    }

    attn_weights = ggml_soft_max(ctx, attn_weights);

    struct ggml_tensor * attn_out = ggml_mul_mat(ctx,
        ggml_cont(ctx, ggml_transpose(ctx, v_expanded)), attn_weights);

    attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
    attn_out = ggml_reshape_2d(ctx, attn_out, num_heads * head_dim, seq_len);

    // Output projection
    attn_out = smolvla_linear(ctx, attn_out, lw.o_proj_weight, nullptr);

    // Residual connection
    hidden_states = ggml_add(ctx, attn_out, residual);

    // Post-attention RMSNorm + MLP
    residual = hidden_states;
    hidden_states = smolvla_rms_norm(ctx, hidden_states, lw.ffn_norm_weight, rms_eps);

    // SwiGLU MLP — fused or unfused
    struct ggml_tensor * gate, * up;
    if (lw.gate_up_weight) {
        struct ggml_tensor * gu = ggml_mul_mat(ctx, lw.gate_up_weight, hidden_states);
        int inter = lw.gate_up_weight->ne[1] / 2;
        gate = ggml_view_2d(ctx, gu, inter, seq_len, gu->nb[1], 0);
        up   = ggml_view_2d(ctx, gu, inter, seq_len, gu->nb[1], inter * ggml_element_size(gu));
        gate = ggml_cont(ctx, gate);
        up   = ggml_cont(ctx, up);
    } else {
        gate = smolvla_linear(ctx, hidden_states, lw.gate_proj_weight, nullptr);
        up   = smolvla_linear(ctx, hidden_states, lw.up_proj_weight, nullptr);
    }
    gate = smolvla_silu(ctx, gate);
    struct ggml_tensor * mlp_out = ggml_mul(ctx, gate, up);
    mlp_out = smolvla_linear(ctx, mlp_out, lw.down_proj_weight, nullptr);

    // Residual
    hidden_states = ggml_add(ctx, mlp_out, residual);

    return hidden_states;
}

// ============================================================
// SmolLM2 Forward (build KV cache from prefix tokens)
// ============================================================

// Build computation graph for SmolLM2 forward pass
// Takes concatenated prefix tokens: visual_tokens + language_embeddings + state_embedding
// Outputs final hidden states and per-layer KV cache for the action expert
struct ggml_tensor * build_smollm2_graph(
    struct ggml_context * ctx,
    smolvla_model & model,
    struct ggml_tensor * prefix_embeddings, // (prefix_len, 960) -- already embedded
    struct ggml_tensor * position_ids,       // (prefix_len,)
    struct ggml_tensor * attn_mask,          // (prefix_len, prefix_len) or NULL
    std::vector<struct ggml_tensor *> & kv_keys_out,   // output: per-layer keys
    std::vector<struct ggml_tensor *> & kv_vals_out,   // output: per-layer values
    std::vector<struct ggml_tensor *> * layer_outputs) // optional: per-layer hidden states
{
    const auto & hp = model.hparams;
    const auto & tw = model.text;

    kv_keys_out.resize(hp.text_num_layers);
    kv_vals_out.resize(hp.text_num_layers);
    if (layer_outputs) layer_outputs->resize(hp.text_num_layers);

    struct ggml_tensor * x = prefix_embeddings;

    for (int i = 0; i < hp.text_num_layers; i++) {
        x = build_transformer_layer(
            ctx, x, tw.layers[i], position_ids,
            hp.text_num_heads, hp.text_num_kv_heads, hp.text_head_dim,
            hp.text_rms_norm_eps, attn_mask,
            &kv_keys_out[i], &kv_vals_out[i]);

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
// Action Expert: Cross-attention layer
// ============================================================

// Expert cross-attention layer: expert queries attend to VLM KV cache
static struct ggml_tensor * build_expert_cross_attn_layer(
    struct ggml_context * ctx,
    struct ggml_tensor * expert_hidden, // (expert_seq, expert_hidden_size=720)
    const transformer_layer_weights & lw,
    struct ggml_tensor * vlm_kv_keys,   // (prefix_len, num_kv_heads * head_dim = 320) from VLM cache
    struct ggml_tensor * vlm_kv_values, // (prefix_len, 320)
    struct ggml_tensor * position_ids,  // (expert_seq,)
    int num_heads, int num_kv_heads, int head_dim,
    float rms_eps,
    struct ggml_tensor * cross_attn_mask) // (expert_seq, prefix_len)
{
    int expert_seq = expert_hidden->ne[1];

    // Pre-attention RMSNorm
    struct ggml_tensor * residual = expert_hidden;
    struct ggml_tensor * normed = smolvla_rms_norm(ctx, expert_hidden, lw.attn_norm_weight, rms_eps);

    // Expert Q projection
    struct ggml_tensor * q = smolvla_linear(ctx, normed, lw.q_proj_weight, nullptr);

    // Project VLM KV cache through expert k_proj / v_proj
    // Cross-attn layers: k_proj input is 320 (VLM KV dim), not 720 (expert dim)
    struct ggml_tensor * k = smolvla_linear(ctx, vlm_kv_keys, lw.k_proj_weight, nullptr);
    struct ggml_tensor * v = smolvla_linear(ctx, vlm_kv_values, lw.v_proj_weight, nullptr);

    // GQA attention (RoPE on queries only for cross-attention)
    int kv_len = vlm_kv_keys->ne[1];

    q = ggml_reshape_3d(ctx, q, head_dim, num_heads, expert_seq);
    k = ggml_reshape_3d(ctx, k, head_dim, num_kv_heads, kv_len);
    v = ggml_reshape_3d(ctx, v, head_dim, num_kv_heads, kv_len);

    // Apply RoPE to queries only
    if (position_ids) {
        q = ggml_rope(ctx, q, position_ids, head_dim, GGML_ROPE_TYPE_NEOX);
    }

    // Repeat KV heads for GQA
    int kv_groups = num_heads / num_kv_heads;
    if (kv_groups > 1) {
        k = ggml_reshape_4d(ctx, k, head_dim, 1, num_kv_heads, kv_len);
        k = ggml_repeat(ctx, k, ggml_new_tensor_4d(ctx, k->type, head_dim, kv_groups, num_kv_heads, kv_len));
        k = ggml_reshape_3d(ctx, k, head_dim, num_heads, kv_len);

        v = ggml_reshape_4d(ctx, v, head_dim, 1, num_kv_heads, kv_len);
        v = ggml_repeat(ctx, v, ggml_new_tensor_4d(ctx, v->type, head_dim, kv_groups, num_kv_heads, kv_len));
        v = ggml_reshape_3d(ctx, v, head_dim, num_heads, kv_len);
    }

    // Attention computation
    q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
    k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
    v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

    struct ggml_tensor * attn_weights = ggml_mul_mat(ctx, k, q);
    attn_weights = ggml_scale(ctx, attn_weights, 1.0f / sqrtf((float)head_dim));

    if (cross_attn_mask) {
        attn_weights = ggml_add(ctx, attn_weights, cross_attn_mask);
    }

    attn_weights = ggml_soft_max(ctx, attn_weights);

    struct ggml_tensor * attn_out = ggml_mul_mat(ctx,
        ggml_cont(ctx, ggml_transpose(ctx, v)), attn_weights);

    attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
    attn_out = ggml_reshape_2d(ctx, attn_out, num_heads * head_dim, expert_seq);

    // Output projection
    attn_out = smolvla_linear(ctx, attn_out, lw.o_proj_weight, nullptr);

    // Residual
    expert_hidden = ggml_add(ctx, attn_out, residual);

    // Post-attention RMSNorm + MLP
    residual = expert_hidden;
    expert_hidden = smolvla_rms_norm(ctx, expert_hidden, lw.ffn_norm_weight, rms_eps);

    struct ggml_tensor * gate = smolvla_linear(ctx, expert_hidden, lw.gate_proj_weight, nullptr);
    struct ggml_tensor * up   = smolvla_linear(ctx, expert_hidden, lw.up_proj_weight, nullptr);
    gate = smolvla_silu(ctx, gate);
    struct ggml_tensor * mlp_out = ggml_mul(ctx, gate, up);
    mlp_out = smolvla_linear(ctx, mlp_out, lw.down_proj_weight, nullptr);

    expert_hidden = ggml_add(ctx, mlp_out, residual);

    return expert_hidden;
}

// ============================================================
// Sinusoidal Time Embedding
// ============================================================

// Create sinusoidal positional embedding for a scalar timestep
// Returns: (1, dimension) tensor
void compute_sinusoidal_time_embedding(
    float timestep,
    int dimension,
    float min_period,
    float max_period,
    float * out) // buffer of size `dimension`
{
    int half_dim = dimension / 2;
    for (int i = 0; i < half_dim; i++) {
        float fraction = (float)i / (float)(half_dim - 1);
        float period = min_period * powf(max_period / min_period, fraction);
        float angle = (1.0f / period) * 2.0f * M_PI * timestep;
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
struct ggml_tensor * build_denoise_step_graph(
    struct ggml_context * ctx,
    smolvla_model & model,
    struct ggml_tensor * x_t,           // (chunk_size, max_action_dim=32)
    struct ggml_tensor * time_embed,    // (chunk_size, expert_hidden_size=720)
    struct ggml_tensor ** vlm_kv_keys,  // per-layer cached keys
    struct ggml_tensor ** vlm_kv_vals,  // per-layer cached values
    struct ggml_tensor * position_ids,  // (chunk_size,) - self-attn positions (e.g. 198..247)
    struct ggml_tensor * cross_pos_ids, // (chunk_size,) - cross-attn positions (e.g. 0..49)
    struct ggml_tensor * cross_attn_mask, // (chunk_size, prefix_len)
    struct ggml_tensor * self_attn_mask)  // (chunk_size, prefix_len+chunk_size)
{
    const auto & hp = model.hparams;
    const auto & ew = model.expert;

    // 1. Project noisy actions to expert dim
    struct ggml_tensor * action_emb = smolvla_linear(ctx, x_t,
        model.action_in_proj_weight, model.action_in_proj_bias);
    // action_emb: (chunk_size, 720)

    // 2. Concatenate action_emb and time_embed, then MLP
    struct ggml_tensor * action_time = ggml_concat(ctx, action_emb, time_embed, 0);
    // action_time: (chunk_size, 1440)

    action_time = smolvla_linear(ctx, action_time,
        model.action_time_mlp_in_weight, model.action_time_mlp_in_bias);
    action_time = smolvla_silu(ctx, action_time);
    action_time = smolvla_linear(ctx, action_time,
        model.action_time_mlp_out_weight, model.action_time_mlp_out_bias);
    // action_time: (chunk_size, 720)

    // Mark suffix embedding as output for debugging
    ggml_set_name(action_emb, "dbg_action_emb"); ggml_set_output(action_emb);
    ggml_set_name(action_time, "dbg_suffix_emb"); ggml_set_output(action_time);

    // 3. Run through expert layers (interleaved self-attn / cross-attn)
    struct ggml_tensor * hidden = action_time;
    int chunk_size = hp.chunk_size;
    int head_dim = hp.expert_head_dim;
    int num_heads = hp.expert_num_heads;
    int num_kv_heads = hp.expert_num_kv_heads;
    int kv_groups = num_heads / num_kv_heads;

    for (int i = 0; i < hp.expert_num_layers; i++) {
        bool is_self_attn = (hp.self_attn_every_n > 0) && (i % hp.self_attn_every_n == 0);
        const auto & lw = ew.layers[i];

        // Mark hidden state before each layer for debugging
        {
            char name[32];
            snprintf(name, sizeof(name), "dbg_expert_pre_%02d", i);
            ggml_set_name(hidden, name); ggml_set_output(hidden);
        }

        // Pre-attention RMSNorm
        struct ggml_tensor * residual = hidden;
        struct ggml_tensor * normed = smolvla_rms_norm(ctx, hidden, lw.attn_norm_weight, hp.expert_rms_norm_eps);

        if (is_self_attn) {
            // SELF-ATTENTION: Q from expert, K/V = concat(VLM_cached, expert)
            struct ggml_tensor * q, * k_expert, * v_expert;
            int q_dim = num_heads * head_dim;
            int kv_dim_each = num_kv_heads * head_dim;

            if (lw.qkv_proj_weight) {
                struct ggml_tensor * qkv = ggml_mul_mat(ctx, lw.qkv_proj_weight, normed);
                q = ggml_cont(ctx, ggml_view_2d(ctx, qkv, q_dim, chunk_size, qkv->nb[1], 0));
                k_expert = ggml_cont(ctx, ggml_view_2d(ctx, qkv, kv_dim_each, chunk_size,
                    qkv->nb[1], q_dim * ggml_element_size(qkv)));
                v_expert = ggml_cont(ctx, ggml_view_2d(ctx, qkv, kv_dim_each, chunk_size,
                    qkv->nb[1], (q_dim + kv_dim_each) * ggml_element_size(qkv)));
            } else {
                q = smolvla_linear(ctx, normed, lw.q_proj_weight, nullptr);
                k_expert = smolvla_linear(ctx, normed, lw.k_proj_weight, nullptr);
                v_expert = smolvla_linear(ctx, normed, lw.v_proj_weight, nullptr);
            }

            // Reshape to multi-head
            q = ggml_reshape_3d(ctx, q, head_dim, num_heads, chunk_size);
            k_expert = ggml_reshape_3d(ctx, k_expert, head_dim, num_kv_heads, chunk_size);
            v_expert = ggml_reshape_3d(ctx, v_expert, head_dim, num_kv_heads, chunk_size);

            // Apply RoPE to expert Q and K
            q = ggml_rope(ctx, q, position_ids, head_dim, GGML_ROPE_TYPE_NEOX);
            k_expert = ggml_rope(ctx, k_expert, position_ids, head_dim, GGML_ROPE_TYPE_NEOX);

            // Concatenate VLM cached K/V with expert K/V
            // VLM cache: (head_dim, num_kv_heads, prefix_len) already post-RoPE
            struct ggml_tensor * k_full = ggml_concat(ctx, vlm_kv_keys[i], k_expert, 2); // concat on seq dim
            struct ggml_tensor * v_full = ggml_concat(ctx, vlm_kv_vals[i], v_expert, 2);

            int full_len = k_full->ne[2]; // prefix_len + chunk_size

            // GQA repeat
            struct ggml_tensor * k_exp = k_full;
            struct ggml_tensor * v_exp = v_full;
            if (kv_groups > 1) {
                k_exp = ggml_reshape_4d(ctx, k_full, head_dim, 1, num_kv_heads, full_len);
                k_exp = ggml_repeat(ctx, k_exp, ggml_new_tensor_4d(ctx, k_full->type, head_dim, kv_groups, num_kv_heads, full_len));
                k_exp = ggml_reshape_3d(ctx, k_exp, head_dim, num_heads, full_len);

                v_exp = ggml_reshape_4d(ctx, v_full, head_dim, 1, num_kv_heads, full_len);
                v_exp = ggml_repeat(ctx, v_exp, ggml_new_tensor_4d(ctx, v_full->type, head_dim, kv_groups, num_kv_heads, full_len));
                v_exp = ggml_reshape_3d(ctx, v_exp, head_dim, num_heads, full_len);
            }

            // Attention
            q     = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
            k_exp = ggml_cont(ctx, ggml_permute(ctx, k_exp, 0, 2, 1, 3));
            v_exp = ggml_cont(ctx, ggml_permute(ctx, v_exp, 0, 2, 1, 3));

            struct ggml_tensor * attn_weights = ggml_mul_mat(ctx, k_exp, q);
            attn_weights = ggml_scale(ctx, attn_weights, 1.0f / sqrtf((float)head_dim));

            if (self_attn_mask) {
                attn_weights = ggml_add(ctx, attn_weights, self_attn_mask);
            }

            attn_weights = ggml_soft_max(ctx, attn_weights);

            struct ggml_tensor * attn_out = ggml_mul_mat(ctx,
                ggml_cont(ctx, ggml_transpose(ctx, v_exp)), attn_weights);

            attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
            attn_out = ggml_reshape_2d(ctx, attn_out, num_heads * head_dim, chunk_size);

            // O projection + residual
            attn_out = smolvla_linear(ctx, attn_out, lw.o_proj_weight, nullptr);
            hidden = ggml_add(ctx, attn_out, residual);

        } else {
            // CROSS-ATTENTION: Q from expert, K/V from VLM cache (projected)
            // Q projection
            struct ggml_tensor * q = smolvla_linear(ctx, normed, lw.q_proj_weight, nullptr);

            // K/V: project VLM cache through expert k/v_proj
            struct ggml_tensor * k = smolvla_linear(ctx, vlm_kv_keys[i], lw.k_proj_weight, nullptr);
            struct ggml_tensor * v = smolvla_linear(ctx, vlm_kv_vals[i], lw.v_proj_weight, nullptr);

            int kv_len = vlm_kv_keys[i]->ne[1]; // prefix_len

            // Reshape to multi-head
            q = ggml_reshape_3d(ctx, q, head_dim, num_heads, chunk_size);
            k = ggml_reshape_3d(ctx, k, head_dim, num_kv_heads, kv_len);
            v = ggml_reshape_3d(ctx, v, head_dim, num_kv_heads, kv_len);

            // RoPE only on Q, with positions starting from 0
            // PyTorch: expert_position_id = position_ids - min(position_ids) -> [0,1,...,49]
            q = ggml_rope(ctx, q, cross_pos_ids, head_dim, GGML_ROPE_TYPE_NEOX);
            // NO RoPE on K (keys are projected fresh from VLM cache, not position-dependent)

            // GQA repeat
            if (kv_groups > 1) {
                k = ggml_reshape_4d(ctx, k, head_dim, 1, num_kv_heads, kv_len);
                k = ggml_repeat(ctx, k, ggml_new_tensor_4d(ctx, k->type, head_dim, kv_groups, num_kv_heads, kv_len));
                k = ggml_reshape_3d(ctx, k, head_dim, num_heads, kv_len);

                v = ggml_reshape_4d(ctx, v, head_dim, 1, num_kv_heads, kv_len);
                v = ggml_repeat(ctx, v, ggml_new_tensor_4d(ctx, v->type, head_dim, kv_groups, num_kv_heads, kv_len));
                v = ggml_reshape_3d(ctx, v, head_dim, num_heads, kv_len);
            }

            // Attention
            q = ggml_cont(ctx, ggml_permute(ctx, q, 0, 2, 1, 3));
            k = ggml_cont(ctx, ggml_permute(ctx, k, 0, 2, 1, 3));
            v = ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));

            struct ggml_tensor * attn_weights = ggml_mul_mat(ctx, k, q);
            attn_weights = ggml_scale(ctx, attn_weights, 1.0f / sqrtf((float)head_dim));

            if (cross_attn_mask) {
                attn_weights = ggml_add(ctx, attn_weights, cross_attn_mask);
            }

            attn_weights = ggml_soft_max(ctx, attn_weights);

            struct ggml_tensor * attn_out = ggml_mul_mat(ctx,
                ggml_cont(ctx, ggml_transpose(ctx, v)), attn_weights);

            attn_out = ggml_cont(ctx, ggml_permute(ctx, attn_out, 0, 2, 1, 3));
            attn_out = ggml_reshape_2d(ctx, attn_out, num_heads * head_dim, chunk_size);

            // O projection + residual
            attn_out = smolvla_linear(ctx, attn_out, lw.o_proj_weight, nullptr);
            hidden = ggml_add(ctx, attn_out, residual);
        }

        // Post-attention RMSNorm + MLP (same for both types)
        residual = hidden;
        hidden = smolvla_rms_norm(ctx, hidden, lw.ffn_norm_weight, hp.expert_rms_norm_eps);

        struct ggml_tensor * e_gate, * e_up;
        if (lw.gate_up_weight) {
            struct ggml_tensor * gu = ggml_mul_mat(ctx, lw.gate_up_weight, hidden);
            int inter = lw.gate_up_weight->ne[1] / 2;
            e_gate = ggml_cont(ctx, ggml_view_2d(ctx, gu, inter, chunk_size, gu->nb[1], 0));
            e_up = ggml_cont(ctx, ggml_view_2d(ctx, gu, inter, chunk_size,
                gu->nb[1], inter * ggml_element_size(gu)));
        } else {
            e_gate = smolvla_linear(ctx, hidden, lw.gate_proj_weight, nullptr);
            e_up = smolvla_linear(ctx, hidden, lw.up_proj_weight, nullptr);
        }
        e_gate = smolvla_silu(ctx, e_gate);
        struct ggml_tensor * mlp_out = ggml_mul(ctx, e_gate, e_up);
        mlp_out = smolvla_linear(ctx, mlp_out, lw.down_proj_weight, nullptr);

        hidden = ggml_add(ctx, mlp_out, residual);
    }

    // 4. Final RMSNorm
    hidden = smolvla_rms_norm(ctx, hidden, ew.final_norm_weight, hp.expert_rms_norm_eps);

    // 5. Project back to action space
    struct ggml_tensor * v_t = smolvla_linear(ctx, hidden,
        model.action_out_proj_weight, model.action_out_proj_bias);
    // v_t: (chunk_size, max_action_dim=32)

    return v_t;
}

// ============================================================
// GGUF Loading
// ============================================================

// Helper to find a tensor by name in a GGUF context
static struct ggml_tensor * get_tensor(struct ggml_context * ctx, const char * name) {
    struct ggml_tensor * t = ggml_get_tensor(ctx, name);
    if (!t) {
        fprintf(stderr, "WARNING: tensor '%s' not found in GGUF\n", name);
    }
    return t;
}

// Helper to read a uint32 from GGUF metadata
static uint32_t gguf_get_u32(struct gguf_context * gguf, const char * key, uint32_t default_val) {
    int64_t idx = gguf_find_key(gguf, key);
    if (idx < 0) return default_val;
    return gguf_get_val_u32(gguf, idx);
}

// Helper to assign a tensor pointer by name
static struct ggml_tensor * gguf_get_tensor_by_name(struct ggml_context * ctx, const char * name) {
    struct ggml_tensor * t = ggml_get_tensor(ctx, name);
    if (!t) {
        fprintf(stderr, "  WARN: tensor '%s' not found\n", name);
    }
    return t;
}

// ============================================================
// Opaque handle API (for ctypes / FFI)
// ============================================================

extern "C" smolvla_handle_t smolvla_create(const char * model_path) {
    auto * model = new smolvla_model();
    if (!smolvla_load_model(model_path, model)) {
        delete model;
        return nullptr;
    }
    return (smolvla_handle_t)model;
}

extern "C" bool smolvla_run(
    smolvla_handle_t handle,
    const float ** images, int n_images, int img_width, int img_height,
    const float * state, int state_dim,
    const int32_t * lang_tokens, const bool * lang_mask, int lang_len,
    const float * noise,
    float * actions_out, int * n_actions_out)
{
    if (!handle) return false;
    return smolvla_inference((smolvla_model *)handle, images, n_images, img_width, img_height,
        state, state_dim, lang_tokens, lang_mask, lang_len, noise, actions_out, n_actions_out);
}

extern "C" void smolvla_destroy(smolvla_handle_t handle) {
    if (!handle) return;
    smolvla_free_model((smolvla_model *)handle);
    delete (smolvla_model *)handle;
}

// ============================================================

extern "C" bool smolvla_load_model(const char * path, smolvla_model * model_ptr) {
    smolvla_model & model = *model_ptr;
    fprintf(stderr, "%s: loading model from '%s'\n", __func__, path);

    // Load all backend plugins (Vulkan, Metal, CUDA, …) shipped next to the addon.
    // The qvac-fabric ggml port installs each backend as a shared library and
    // exposes them via GGML_AVAILABLE_BACKENDS; at runtime we discover them via
    // ggml_backend_load_all_from_path(BACKENDS_SUBDIR) and pick the best
    // available device.
    {
        static bool backends_loaded = false;
        if (!backends_loaded) {
#ifdef BACKENDS_SUBDIR
            ggml_backend_load_all_from_path(BACKENDS_SUBDIR);
#else
            ggml_backend_load_all();
#endif
            backends_loaded = true;
        }
    }

    // Always init CPU backend (fallback for unsupported ops, and primary on
    // platforms with no GPU).
    model.backend_cpu = ggml_backend_cpu_init();
    if (!model.backend_cpu) {
        fprintf(stderr, "%s: failed to init CPU backend\n", __func__);
        return false;
    }
    model.backend = model.backend_cpu;
    model.has_gpu = false;

    // Prefer a GPU device if the plugin loader registered one
    // (Vulkan on Linux/Windows/Android, Metal on macOS/iOS).
    {
        ggml_backend_dev_t gpu = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
        if (gpu) {
            ggml_backend_t gpu_backend = ggml_backend_dev_init(gpu, nullptr);
            if (gpu_backend) {
                model.backend = gpu_backend;
                model.has_gpu = true;
                fprintf(stderr, "%s: using GPU backend: %s (%s)\n", __func__,
                        ggml_backend_name(gpu_backend),
                        ggml_backend_dev_description(gpu));
            }
        }
    }
    if (!model.has_gpu) {
        fprintf(stderr, "%s: using CPU backend\n", __func__);
    }

    // 1. Open GGUF file — let it create a ggml_context and load tensor data
    struct ggml_context * ctx_data = nullptr;
    struct gguf_init_params gguf_params = {
        /*.no_alloc =*/ false,
        /*.ctx      =*/ &ctx_data,
    };

    struct gguf_context * gguf = gguf_init_from_file(path, gguf_params);
    if (!gguf) {
        fprintf(stderr, "%s: failed to open GGUF file\n", __func__);
        return false;
    }

    int64_t n_tensors = gguf_get_n_tensors(gguf);
    fprintf(stderr, "%s: loaded %lld tensors\n", __func__, (long long)n_tensors);

    // 2. Read hyperparameters from metadata
    auto & hp = model.hparams;
    hp.vision_hidden_size    = gguf_get_u32(gguf, "smolvla.vision.hidden_size", 768);
    hp.vision_intermediate   = gguf_get_u32(gguf, "smolvla.vision.intermediate_size", 3072);
    hp.vision_num_layers     = gguf_get_u32(gguf, "smolvla.vision.num_layers", 12);
    hp.vision_num_heads      = gguf_get_u32(gguf, "smolvla.vision.num_heads", 12);
    hp.vision_image_size     = gguf_get_u32(gguf, "smolvla.vision.image_size", 512);
    hp.vision_patch_size     = gguf_get_u32(gguf, "smolvla.vision.patch_size", 16);

    hp.connector_scale_factor = gguf_get_u32(gguf, "smolvla.connector.scale_factor", 4);

    hp.text_hidden_size      = gguf_get_u32(gguf, "smolvla.text.hidden_size", 960);
    hp.text_intermediate     = gguf_get_u32(gguf, "smolvla.text.intermediate_size", 2560);
    hp.text_num_layers       = gguf_get_u32(gguf, "smolvla.text.num_layers", 16);
    hp.text_num_heads        = gguf_get_u32(gguf, "smolvla.text.num_heads", 15);
    hp.text_num_kv_heads     = gguf_get_u32(gguf, "smolvla.text.num_kv_heads", 5);
    hp.text_head_dim         = gguf_get_u32(gguf, "smolvla.text.head_dim", 64);

    hp.expert_hidden_size    = gguf_get_u32(gguf, "smolvla.expert.hidden_size", 720);
    hp.expert_intermediate   = gguf_get_u32(gguf, "smolvla.expert.intermediate_size", 2048);
    hp.expert_num_layers     = gguf_get_u32(gguf, "smolvla.expert.num_layers", 16);
    hp.expert_num_heads      = gguf_get_u32(gguf, "smolvla.expert.num_heads", 15);
    hp.expert_num_kv_heads   = gguf_get_u32(gguf, "smolvla.expert.num_kv_heads", 5);
    hp.self_attn_every_n     = gguf_get_u32(gguf, "smolvla.expert.self_attn_every_n", 2);

    hp.num_ode_steps         = gguf_get_u32(gguf, "smolvla.flow.num_ode_steps", 10);
    hp.chunk_size            = gguf_get_u32(gguf, "smolvla.flow.chunk_size", 50);
    hp.max_action_dim        = gguf_get_u32(gguf, "smolvla.flow.max_action_dim", 32);
    hp.max_state_dim         = gguf_get_u32(gguf, "smolvla.flow.max_state_dim", 32);
    hp.action_dim            = gguf_get_u32(gguf, "smolvla.flow.action_dim", 6);

    fprintf(stderr, "%s: hparams loaded\n", __func__);
    fprintf(stderr, "  vision: %d layers, %d-dim\n", hp.vision_num_layers, hp.vision_hidden_size);
    fprintf(stderr, "  text:   %d layers, %d-dim\n", hp.text_num_layers, hp.text_hidden_size);
    fprintf(stderr, "  expert: %d layers, %d-dim\n", hp.expert_num_layers, hp.expert_hidden_size);

    // 3. Map tensor names to model struct fields
    model.ctx_w = ctx_data;

    // Vision encoder
    model.vision.patch_embed_weight = gguf_get_tensor_by_name(ctx_data, "v.enc.patch_embd.weight");
    model.vision.patch_embed_bias   = gguf_get_tensor_by_name(ctx_data, "v.enc.patch_embd.bias");
    model.vision.pos_embed          = gguf_get_tensor_by_name(ctx_data, "v.enc.pos_embd.weight");
    model.vision.post_ln_weight     = gguf_get_tensor_by_name(ctx_data, "v.enc.post_ln.weight");
    model.vision.post_ln_bias       = gguf_get_tensor_by_name(ctx_data, "v.enc.post_ln.bias");

    // Helper: try to get tensor, return nullptr if not found (no warning)
    auto try_tensor = [&](const char * name) -> struct ggml_tensor * {
        return ggml_get_tensor(ctx_data, name);
    };

    model.vision.layers.resize(hp.vision_num_layers);
    for (int i = 0; i < hp.vision_num_layers; i++) {
        char buf[256];
        auto & l = model.vision.layers[i];
        memset(&l, 0, sizeof(l));

        #define VG(field, fmt) do { snprintf(buf, sizeof(buf), fmt, i); l.field = try_tensor(buf); } while(0)
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
    model.connector.proj_weight = gguf_get_tensor_by_name(ctx_data, "v.connector.proj.weight");

    // Text model (SmolLM2)
    model.text.embed_tokens     = gguf_get_tensor_by_name(ctx_data, "t.embed.weight");
    model.text.final_norm_weight = gguf_get_tensor_by_name(ctx_data, "t.final_norm.weight");

    auto load_transformer_layers = [&](const char * prefix, std::vector<transformer_layer_weights> & layers, int n_layers) {
        char buf[256];
        layers.resize(n_layers);
        for (int i = 0; i < n_layers; i++) {
            auto & l = layers[i];
            memset(&l, 0, sizeof(l));
            #define TG(field, sfx) do { snprintf(buf, sizeof(buf), "%s.%d." sfx, prefix, i); l.field = try_tensor(buf); } while(0)
            TG(attn_norm_weight, "attn_norm.weight");
            TG(qkv_proj_weight, "attn_qkv.weight");    // fused
            TG(q_proj_weight, "attn_q.weight");         // unfused fallback
            TG(k_proj_weight, "attn_k.weight");
            TG(v_proj_weight, "attn_v.weight");
            TG(o_proj_weight, "attn_out.weight");
            TG(ffn_norm_weight, "ffn_norm.weight");
            TG(gate_up_weight, "ffn_gate_up.weight");   // fused
            TG(gate_proj_weight, "ffn_gate.weight");    // unfused fallback
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
    model.state_proj_weight        = gguf_get_tensor_by_name(ctx_data, "proj.state.weight");
    model.state_proj_bias          = gguf_get_tensor_by_name(ctx_data, "proj.state.bias");
    model.action_in_proj_weight    = gguf_get_tensor_by_name(ctx_data, "proj.action_in.weight");
    model.action_in_proj_bias      = gguf_get_tensor_by_name(ctx_data, "proj.action_in.bias");
    model.action_out_proj_weight   = gguf_get_tensor_by_name(ctx_data, "proj.action_out.weight");
    model.action_out_proj_bias     = gguf_get_tensor_by_name(ctx_data, "proj.action_out.bias");
    model.action_time_mlp_in_weight  = gguf_get_tensor_by_name(ctx_data, "proj.time_mlp_in.weight");
    model.action_time_mlp_in_bias    = gguf_get_tensor_by_name(ctx_data, "proj.time_mlp_in.bias");
    model.action_time_mlp_out_weight = gguf_get_tensor_by_name(ctx_data, "proj.time_mlp_out.weight");
    model.action_time_mlp_out_bias   = gguf_get_tensor_by_name(ctx_data, "proj.time_mlp_out.bias");

    fprintf(stderr, "%s: all tensors mapped\n", __func__);

    // Clean up GGUF context (keeps the ggml_context with tensor data)
    gguf_free(gguf);

    // If GPU backend available, create a duplicate context on GPU and copy weights
    if (model.has_gpu) {
        fprintf(stderr, "%s: copying weights to GPU...\n", __func__);

        // Count tensors and total size
        size_t total_size = 0;
        int n_tensors_total = 0;
        for (struct ggml_tensor * t = ggml_get_first_tensor(ctx_data); t; t = ggml_get_next_tensor(ctx_data, t)) {
            total_size += ggml_nbytes(t);
            n_tensors_total++;
        }

        // Create a new ggml_context with same tensor metadata but no_alloc=true
        size_t meta_size = n_tensors_total * ggml_tensor_overhead() + 1024 * 1024;
        struct ggml_init_params gpu_params = {meta_size, nullptr, true};
        struct ggml_context * ctx_gpu = ggml_init(gpu_params);

        if (ctx_gpu) {
            // Duplicate all tensors (metadata only, no data)
            for (struct ggml_tensor * t = ggml_get_first_tensor(ctx_data); t; t = ggml_get_next_tensor(ctx_data, t)) {
                struct ggml_tensor * gpu_t = ggml_dup_tensor(ctx_gpu, t);
                ggml_set_name(gpu_t, ggml_get_name(t));
            }

            // Allocate all tensors on GPU
            ggml_backend_buffer_t gpu_buf = ggml_backend_alloc_ctx_tensors(ctx_gpu, model.backend);

            if (gpu_buf) {
                ggml_backend_buffer_set_usage(gpu_buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);

                // Copy data from CPU to GPU tensors, matched by name
                int n_copied = 0;
                for (struct ggml_tensor * gpu_t = ggml_get_first_tensor(ctx_gpu); gpu_t; gpu_t = ggml_get_next_tensor(ctx_gpu, gpu_t)) {
                    struct ggml_tensor * cpu_t = ggml_get_tensor(ctx_data, ggml_get_name(gpu_t));
                    if (cpu_t) {
                        ggml_backend_tensor_set(gpu_t, cpu_t->data, 0, ggml_nbytes(cpu_t));
                        n_copied++;
                    } else {
                        fprintf(stderr, "  COPY MISS: %s\n", ggml_get_name(gpu_t));
                    }
                }

                // Remap model pointers to GPU tensors
                // The tensor names match, so look up each one
                int remap_ok = 0, remap_fail = 0;
                auto remap = [&](struct ggml_tensor *& ptr) {
                    if (ptr) {
                        struct ggml_tensor * gpu = ggml_get_tensor(ctx_gpu, ggml_get_name(ptr));
                        if (gpu) { ptr = gpu; remap_ok++; }
                        else { fprintf(stderr, "  REMAP FAIL: %s\n", ggml_get_name(ptr)); remap_fail++; }
                    }
                };

                // Vision
                remap(model.vision.patch_embed_weight);
                remap(model.vision.patch_embed_bias);
                remap(model.vision.pos_embed);
                remap(model.vision.post_ln_weight);
                remap(model.vision.post_ln_bias);
                for (auto & l : model.vision.layers) {
                    remap(l.ln1_weight); remap(l.ln1_bias);
                    remap(l.qkv_proj_w); remap(l.qkv_proj_b);
                    remap(l.q_proj_w); remap(l.q_proj_b);
                    remap(l.k_proj_w); remap(l.k_proj_b);
                    remap(l.v_proj_w); remap(l.v_proj_b);
                    remap(l.out_proj_w); remap(l.out_proj_b);
                    remap(l.ln2_weight); remap(l.ln2_bias);
                    remap(l.fc1_weight); remap(l.fc1_bias);
                    remap(l.fc2_weight); remap(l.fc2_bias);
                }
                remap(model.connector.proj_weight);

                // Text + Expert (same struct)
                remap(model.text.embed_tokens);
                remap(model.text.final_norm_weight);
                remap(model.expert.final_norm_weight);
                auto remap_transformer = [&](std::vector<transformer_layer_weights> & layers) {
                    for (auto & l : layers) {
                        remap(l.attn_norm_weight);
                        remap(l.qkv_proj_weight);
                        remap(l.q_proj_weight); remap(l.k_proj_weight); remap(l.v_proj_weight);
                        remap(l.o_proj_weight); remap(l.ffn_norm_weight);
                        remap(l.gate_up_weight);
                        remap(l.gate_proj_weight); remap(l.up_proj_weight);
                        remap(l.down_proj_weight);
                    }
                };
                remap_transformer(model.text.layers);
                remap_transformer(model.expert.layers);

                // Projections
                remap(model.state_proj_weight); remap(model.state_proj_bias);
                remap(model.action_in_proj_weight); remap(model.action_in_proj_bias);
                remap(model.action_out_proj_weight); remap(model.action_out_proj_bias);
                remap(model.action_time_mlp_in_weight); remap(model.action_time_mlp_in_bias);
                remap(model.action_time_mlp_out_weight); remap(model.action_time_mlp_out_bias);

                model.buf_w = gpu_buf;
                fprintf(stderr, "%s: copied %d tensors (%.1f MB) to GPU\n",
                        __func__, n_copied, total_size / (1024.0 * 1024.0));
                fprintf(stderr, "%s: remapped %d OK, %d failed\n", __func__, remap_ok, remap_fail);

                // Verify a weight: read back from GPU and compare with CPU
                {
                    struct ggml_tensor * cpu_t = ggml_get_tensor(ctx_data, "t.blk.0.attn_q.weight");
                    struct ggml_tensor * gpu_t = ggml_get_tensor(ctx_gpu, "t.blk.0.attn_q.weight");
                    if (cpu_t && gpu_t) {
                        size_t nbytes = ggml_nbytes(cpu_t);
                        std::vector<uint8_t> gpu_data(nbytes);
                        ggml_backend_tensor_get(gpu_t, gpu_data.data(), 0, nbytes);
                        int mismatches = 0;
                        for (size_t i = 0; i < std::min(nbytes, (size_t)100); i++) {
                            if (((uint8_t*)cpu_t->data)[i] != gpu_data[i]) mismatches++;
                        }
                        fprintf(stderr, "%s: weight verify: %d mismatches in first 100 bytes (type=%d)\n",
                                __func__, mismatches, cpu_t->type);
                    }
                }
            } else {
                fprintf(stderr, "%s: failed to alloc GPU buffer, using CPU\n", __func__);
                ggml_free(ctx_gpu);
                model.has_gpu = false;
                model.backend = model.backend_cpu;
            }
        }
    }

    fprintf(stderr, "%s: model loaded successfully\n", __func__);
    return true;
}

extern "C" void smolvla_free_model(smolvla_model * model_ptr) {
    smolvla_model & model = *model_ptr;
    if (model.buf_w) {
        ggml_backend_buffer_free(model.buf_w);
        model.buf_w = nullptr;
    }
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

// ============================================================
// Full Inference Pipeline
// ============================================================

// Helper: staged graph computation with scheduler support
struct staged_graph {
    struct ggml_context * ctx;
    struct ggml_cgraph * gf;
    // One of these is used depending on backend
    ggml_gallocr_t allocr;
    ggml_backend_sched_t sched;
};

static staged_graph build_staged(ggml_backend_t backend, size_t ctx_bytes, int max_nodes) {
    staged_graph sg = {};
    struct ggml_init_params params = {ctx_bytes, nullptr, true};
    sg.ctx = ggml_init(params);
    sg.gf = ggml_new_graph_custom(sg.ctx, max_nodes, false);
    sg.allocr = nullptr;
    sg.sched = nullptr;
    return sg;
}

// Allocate graph for single-backend (CPU only)
static bool alloc_staged_simple(staged_graph & sg, ggml_backend_t backend) {
    sg.allocr = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend));
    ggml_gallocr_reserve(sg.allocr, sg.gf);
    ggml_gallocr_alloc_graph(sg.allocr, sg.gf);
    return true;
}

// Allocate graph for multi-backend (GPU + CPU with auto-fallback)
static bool alloc_staged_sched(staged_graph & sg, ggml_backend_t gpu, ggml_backend_t cpu) {
    ggml_backend_t backends[] = {gpu, cpu};
    sg.sched = ggml_backend_sched_new(backends, nullptr, 2, GGML_DEFAULT_GRAPH_SIZE, false, true);
    ggml_backend_sched_alloc_graph(sg.sched, sg.gf);
    return true;
}

static void compute_staged(staged_graph & sg, ggml_backend_t backend) {
    if (sg.sched) {
        ggml_backend_sched_graph_compute(sg.sched, sg.gf);
    } else {
        ggml_backend_graph_compute(backend, sg.gf);
    }
}

static void free_staged(staged_graph & sg) {
    if (sg.sched) ggml_backend_sched_free(sg.sched);
    if (sg.allocr) ggml_gallocr_free(sg.allocr);
    if (sg.ctx) ggml_free(sg.ctx);
    sg = {};
}

extern "C" bool smolvla_inference(
    smolvla_model * model_ptr,
    const float ** images,
    int n_images,
    int img_width, int img_height,
    const float * state,
    int state_dim,
    const int32_t * lang_tokens,
    const bool * lang_mask,
    int lang_len,
    const float * noise,
    float * actions_out,
    int * n_actions_out)
{
    smolvla_model & model = *model_ptr;
    const auto & hp = model.hparams;

    int n_visual_tokens = n_images * hp.tokens_per_image();
    int prefix_len = n_visual_tokens + lang_len + 1; // +1 for state token
    int chunk_size = hp.chunk_size;
    int action_dim = hp.action_dim;
    int kv_dim = hp.text_num_kv_heads * hp.text_head_dim;

    fprintf(stderr, "%s: prefix_len=%d, chunk_size=%d, n_images=%d\n",
            __func__, prefix_len, chunk_size, n_images);

    // Count valid prefix tokens for attention mask
    int valid_prefix = n_visual_tokens; // all visual tokens are valid
    for (int i = 0; i < lang_len; i++) {
        if (lang_mask[i]) valid_prefix++;
    }
    valid_prefix += 1; // state token
    fprintf(stderr, "%s: valid_prefix=%d / %d\n", __func__, valid_prefix, prefix_len);

    // ================================================================
    // STAGE 1: Vision encoding (per image) — SigLIP + Connector
    // ================================================================
    int C = hp.vision_num_channels;
    int tokens_per_img = hp.tokens_per_image();
    int hidden = hp.text_hidden_size;

    // Store visual tokens in a flat buffer
    std::vector<float> all_visual(n_visual_tokens * hidden);

    double t_vision_start = now_ms();

    // Build full SigLIP+connector graph ONCE, reuse per image
    // Conv2d auto-falls back to CPU via scheduler; rest runs on Vulkan
    staged_graph sg_vis = build_staged(model.backend, 256*1024*1024, 65536);

    struct ggml_tensor * g_pixels = ggml_new_tensor_3d(sg_vis.ctx, GGML_TYPE_F32, img_width, img_height, C);
    ggml_set_name(g_pixels, "pixels"); ggml_set_input(g_pixels);

    struct ggml_tensor * vis = build_siglip_graph(sg_vis.ctx, model, g_pixels);
    struct ggml_tensor * conn = build_connector_graph(sg_vis.ctx, model, vis);
    conn = ggml_scale(sg_vis.ctx, conn, sqrtf((float)hidden));
    ggml_set_name(conn, "conn_out"); ggml_set_output(conn);

    ggml_build_forward_expand(sg_vis.gf, conn);
    if (model.has_gpu) {
        alloc_staged_sched(sg_vis, model.backend, model.backend_cpu);
    } else {
        alloc_staged_simple(sg_vis, model.backend_cpu);
    }

    for (int img_idx = 0; img_idx < n_images; img_idx++) {
        ggml_backend_tensor_set(g_pixels, images[img_idx], 0, C * img_width * img_height * sizeof(float));
        compute_staged(sg_vis, model.backend);
        ggml_backend_tensor_get(conn, all_visual.data() + img_idx * tokens_per_img * hidden, 0,
            tokens_per_img * hidden * sizeof(float));

        // Dump vision output for debugging
        if (img_idx == 0) {
            dump_tensor("vis0", all_visual.data(), tokens_per_img * hidden);
        }
        fprintf(stderr, "%s: vision img %d/%d done\n", __func__, img_idx + 1, n_images);
    }
    free_staged(sg_vis);
    double t_vision_end = now_ms();

    // ================================================================
    // STAGE 2: Build prefix embeddings + SmolLM2 forward → KV cache
    // ================================================================
    double t_smollm2_start = now_ms();
    staged_graph sg2 = build_staged(model.backend, 512*1024*1024, 65536);

    // Inputs: visual tokens, language token IDs, state, masks
    struct ggml_tensor * g_visual = ggml_new_tensor_2d(sg2.ctx, GGML_TYPE_F32, hidden, n_visual_tokens);
    ggml_set_name(g_visual, "visual"); ggml_set_input(g_visual);

    struct ggml_tensor * g_lang_ids = ggml_new_tensor_1d(sg2.ctx, GGML_TYPE_I32, lang_len);
    ggml_set_name(g_lang_ids, "lang_ids"); ggml_set_input(g_lang_ids);

    struct ggml_tensor * g_state = ggml_new_tensor_1d(sg2.ctx, GGML_TYPE_F32, hp.max_state_dim);
    ggml_set_name(g_state, "state"); ggml_set_input(g_state);

    struct ggml_tensor * g_prefix_pos = ggml_new_tensor_1d(sg2.ctx, GGML_TYPE_I32, prefix_len);
    ggml_set_name(g_prefix_pos, "prefix_pos"); ggml_set_input(g_prefix_pos);

    // Language embedding + scale
    struct ggml_tensor * lang_emb = ggml_get_rows(sg2.ctx, model.text.embed_tokens, g_lang_ids);
    lang_emb = ggml_scale(sg2.ctx, lang_emb, sqrtf((float)hidden));

    // State projection
    struct ggml_tensor * state_emb = smolvla_linear(sg2.ctx, g_state, model.state_proj_weight, model.state_proj_bias);
    state_emb = ggml_reshape_2d(sg2.ctx, state_emb, hidden, 1);

    // Concatenate: visual + language + state
    struct ggml_tensor * prefix = ggml_concat(sg2.ctx, g_visual, lang_emb, 1);
    prefix = ggml_concat(sg2.ctx, prefix, state_emb, 1);
    ggml_set_name(prefix, "prefix_embs"); ggml_set_output(prefix);

    // Prefix attention mask: (prefix_len, prefix_len) additive
    // Padded language tokens should not be attended to
    struct ggml_tensor * g_prefix_mask = ggml_new_tensor_2d(sg2.ctx, GGML_TYPE_F32, prefix_len, prefix_len);
    ggml_set_name(g_prefix_mask, "prefix_mask"); ggml_set_input(g_prefix_mask);

    // SmolLM2 forward — with per-layer output dumps
    std::vector<struct ggml_tensor *> kv_keys_t, kv_vals_t;
    std::vector<struct ggml_tensor *> layer_outputs;
    struct ggml_tensor * smollm2_out = build_smollm2_graph(sg2.ctx, model, prefix, g_prefix_pos, g_prefix_mask,
        kv_keys_t, kv_vals_t, &layer_outputs);
    ggml_set_name(smollm2_out, "smollm2_out"); ggml_set_output(smollm2_out);

    // Mark KV cache as outputs so gallocr preserves them
    for (int i = 0; i < hp.text_num_layers; i++) {
        char n[32];
        snprintf(n, sizeof(n), "kk%d", i);
        ggml_set_name(kv_keys_t[i], n); ggml_set_output(kv_keys_t[i]);
        snprintf(n, sizeof(n), "kv%d", i);
        ggml_set_name(kv_vals_t[i], n); ggml_set_output(kv_vals_t[i]);
    }

    ggml_build_forward_expand(sg2.gf, smollm2_out);
    // Also explicitly expand from KV cache tensors to ensure they're in the graph
    for (int i = 0; i < hp.text_num_layers; i++) {
        ggml_build_forward_expand(sg2.gf, kv_keys_t[i]);
        ggml_build_forward_expand(sg2.gf, kv_vals_t[i]);
    }
    // And layer outputs
    if (!layer_outputs.empty()) {
        for (auto * t : layer_outputs) {
            ggml_build_forward_expand(sg2.gf, t);
        }
    }

    if (model.has_gpu) {
        alloc_staged_sched(sg2, model.backend, model.backend_cpu);
    } else {
        alloc_staged_simple(sg2, model.backend_cpu);
    }

    // Dump visual tokens (already scaled by sqrt(hidden))
    dump_tensor("all_visual", all_visual.data(), n_visual_tokens * hidden);

    // Set inputs
    ggml_backend_tensor_set(g_visual, all_visual.data(), 0, n_visual_tokens * hidden * sizeof(float));
    ggml_backend_tensor_set(g_lang_ids, lang_tokens, 0, lang_len * sizeof(int32_t));

    std::vector<float> state_padded(hp.max_state_dim, 0.0f);
    memcpy(state_padded.data(), state, std::min(state_dim, hp.max_state_dim) * sizeof(float));
    ggml_backend_tensor_set(g_state, state_padded.data(), 0, hp.max_state_dim * sizeof(float));

    // Prefix attention mask:
    // Build pad_mask: True for valid tokens
    // att_mask: 0 for bidirectional, 1 for causal
    // PyTorch: make_att_2d_masks(pad_masks, att_masks) where
    //   visual: pad=True, att=0; language: pad=lang_mask, att=0; state: pad=True, att=1
    // Result: 2D mask where invalid (padding) tokens are masked out
    {
        // Build 1D pad mask
        std::vector<bool> pad(prefix_len, false);
        std::vector<int> att(prefix_len, 0);
        for (int i = 0; i < n_visual_tokens; i++) { pad[i] = true; att[i] = 0; }
        for (int i = 0; i < lang_len; i++) { pad[n_visual_tokens + i] = lang_mask[i]; att[n_visual_tokens + i] = 0; }
        pad[prefix_len - 1] = true; att[prefix_len - 1] = 1;

        // Build 2D mask using cumsum logic from make_att_2d_masks
        std::vector<int> cumsum(prefix_len);
        cumsum[0] = att[0];
        for (int i = 1; i < prefix_len; i++) cumsum[i] = cumsum[i-1] + att[i];

        std::vector<float> mask_data(prefix_len * prefix_len);
        for (int qi = 0; qi < prefix_len; qi++) {
            for (int ki = 0; ki < prefix_len; ki++) {
                bool att_ok = cumsum[ki] <= cumsum[qi]; // attention mask
                bool pad_ok = pad[qi] && pad[ki]; // padding mask
                mask_data[qi * prefix_len + ki] = (att_ok && pad_ok) ? 0.0f : -1e9f;
            }
        }
        ggml_backend_tensor_set(g_prefix_mask, mask_data.data(), 0, mask_data.size() * sizeof(float));
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
            if (lang_mask[i]) pos++;
            pos_ids[n_visual_tokens + i] = pos - 1;
        }
        // State token (valid)
        pos_ids[prefix_len - 1] = pos;
    }
    ggml_backend_tensor_set(g_prefix_pos, pos_ids.data(), 0, prefix_len * sizeof(int32_t));

    compute_staged(sg2, model.backend);
    double t_smollm2_compute = now_ms();

    // Dump SmolLM2 output
    {
        std::vector<float> vlm_out(prefix_len * hidden);
        ggml_backend_tensor_get(smollm2_out, vlm_out.data(), 0, vlm_out.size() * sizeof(float));
        dump_tensor("vlm_out", vlm_out.data(), prefix_len * hidden);
    }

    // Dump prefix embeddings
    {
        std::vector<float> prefix_data(prefix_len * hidden);
        ggml_backend_tensor_get(prefix, prefix_data.data(), 0, prefix_data.size() * sizeof(float));
        dump_tensor("prefix_embs", prefix_data.data(), prefix_len * hidden);
    }

    // Dump per-layer hidden states
    {
        std::vector<float> layer_data(prefix_len * hidden);
        for (int i = 0; i < hp.text_num_layers; i++) {
            ggml_backend_tensor_get(layer_outputs[i], layer_data.data(), 0, layer_data.size() * sizeof(float));
            char name[64];
            snprintf(name, sizeof(name), "smollm2_layer%02d", i);
            dump_tensor(name, layer_data.data(), prefix_len * hidden);
        }
    }

    // Recompute KV cache from layer inputs
    // The graph allocator may reuse K/V buffers, so we recompute them in separate mini-graphs.
    // Layer i input = layer_outputs[i-1] (or prefix_embs for i=0)
    // K = RoPE(k_proj(RMSNorm(input))), V = v_proj(RMSNorm(input))
    std::vector<std::vector<float>> kv_keys_data(hp.text_num_layers);
    std::vector<std::vector<float>> kv_vals_data(hp.text_num_layers);
    int kv_total = kv_dim * prefix_len;

    {
        std::vector<float> prev_hidden(prefix_len * hidden);
        ggml_backend_tensor_get(prefix, prev_hidden.data(), 0, prev_hidden.size() * sizeof(float));

        // Read position IDs (same as used in the main graph)
        // pos_ids is already computed above

        for (int i = 0; i < hp.text_num_layers; i++) {
            staged_graph sg_kv = build_staged(model.backend, 64*1024*1024, 512);

            struct ggml_tensor * g_h = ggml_new_tensor_2d(sg_kv.ctx, GGML_TYPE_F32, hidden, prefix_len);
            ggml_set_name(g_h, "h"); ggml_set_input(g_h);

            struct ggml_tensor * g_pos = ggml_new_tensor_1d(sg_kv.ctx, GGML_TYPE_I32, prefix_len);
            ggml_set_name(g_pos, "pos"); ggml_set_input(g_pos);

            struct ggml_tensor * normed = smolvla_rms_norm(sg_kv.ctx, g_h,
                model.text.layers[i].attn_norm_weight, hp.text_rms_norm_eps);

            int q_d = hp.text_num_heads * hp.text_head_dim;
            int kv_d = hp.text_num_kv_heads * hp.text_head_dim;

            struct ggml_tensor * k_out, * v_out;
            if (model.text.layers[i].v_proj_weight) {
                k_out = smolvla_linear(sg_kv.ctx, normed, model.text.layers[i].k_proj_weight, nullptr);
                v_out = smolvla_linear(sg_kv.ctx, normed, model.text.layers[i].v_proj_weight, nullptr);
            } else {
                struct ggml_tensor * qkv = ggml_mul_mat(sg_kv.ctx, model.text.layers[i].qkv_proj_weight, normed);
                k_out = ggml_view_2d(sg_kv.ctx, qkv, kv_d, prefix_len, qkv->nb[1], q_d * ggml_element_size(qkv));
                v_out = ggml_view_2d(sg_kv.ctx, qkv, kv_d, prefix_len, qkv->nb[1], (q_d + kv_d) * ggml_element_size(qkv));
                k_out = ggml_cont(sg_kv.ctx, k_out);
                v_out = ggml_cont(sg_kv.ctx, v_out);
            }

            // Reshape K to 3D and apply RoPE
            k_out = ggml_reshape_3d(sg_kv.ctx, k_out, hp.text_head_dim, hp.text_num_kv_heads, prefix_len);
            k_out = ggml_rope(sg_kv.ctx, k_out, g_pos, hp.text_head_dim, GGML_ROPE_TYPE_NEOX);

            ggml_set_name(k_out, "k"); ggml_set_output(k_out);
            ggml_set_name(v_out, "v"); ggml_set_output(v_out);
            ggml_build_forward_expand(sg_kv.gf, k_out);
            ggml_build_forward_expand(sg_kv.gf, v_out);
            if (model.has_gpu) {
                alloc_staged_sched(sg_kv, model.backend, model.backend_cpu);
            } else {
                alloc_staged_simple(sg_kv, model.backend_cpu);
            }

            ggml_backend_tensor_set(g_h, prev_hidden.data(), 0, prev_hidden.size() * sizeof(float));
            ggml_backend_tensor_set(g_pos, pos_ids.data(), 0, prefix_len * sizeof(int32_t));
            compute_staged(sg_kv, model.backend);

            kv_keys_data[i].resize(kv_total);
            kv_vals_data[i].resize(kv_total);
            ggml_backend_tensor_get(k_out, kv_keys_data[i].data(), 0, kv_total * sizeof(float));
            ggml_backend_tensor_get(v_out, kv_vals_data[i].data(), 0, kv_total * sizeof(float));

            if (i < hp.text_num_layers - 1) {
                ggml_backend_tensor_get(layer_outputs[i], prev_hidden.data(), 0, prev_hidden.size() * sizeof(float));
            }

            free_staged(sg_kv);
        }
    }

    // Dump KV cache layer 0 for debugging
    dump_tensor("kv_key_layer00", kv_keys_data[0].data(), kv_total);
    dump_tensor("kv_val_layer00", kv_vals_data[0].data(), kv_total);

    free_staged(sg2);
    double t_smollm2_end = now_ms();

    // ================================================================
    // STAGE 3: ODE loop — 10 denoise steps through action expert
    // ================================================================
    double t_ode_start = now_ms();

    // Initial noise
    std::vector<float> x_t(chunk_size * hp.max_action_dim);
    if (noise) {
        memcpy(x_t.data(), noise, chunk_size * hp.max_action_dim * sizeof(float));
    } else {
        std::mt19937 rng(42);
        std::normal_distribution<float> normal(0.0f, 1.0f);
        for (auto & v : x_t) v = normal(rng);
    }

    // Build self-attention mask: (full_len, chunk_size)
    // Prefix part: attend to all valid tokens; suffix part: causal
    int full_len = prefix_len + chunk_size;
    std::vector<float> sa_mask(full_len * chunk_size);
    for (int qi = 0; qi < chunk_size; qi++) {
        // Prefix columns: attend to valid prefix tokens
        for (int ki = 0; ki < prefix_len; ki++) {
            bool valid = (ki < n_visual_tokens) || // visual tokens
                         (ki >= n_visual_tokens && ki < n_visual_tokens + lang_len && lang_mask[ki - n_visual_tokens]) || // language
                         (ki == prefix_len - 1); // state token
            sa_mask[qi * full_len + ki] = valid ? 0.0f : -1e9f;
        }
        // Suffix columns: causal (attend to current and previous)
        for (int ki = 0; ki < chunk_size; ki++) {
            sa_mask[qi * full_len + prefix_len + ki] = (ki <= qi) ? 0.0f : -1e9f;
        }
    }

    float dt = -1.0f / hp.num_ode_steps;

    // Build expert graph ONCE, reuse for all 10 ODE steps
    staged_graph sg3 = build_staged(model.backend, 256*1024*1024, 65536);

    struct ggml_tensor * g_xt = ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, hp.max_action_dim, chunk_size);
    ggml_set_name(g_xt, "x_t"); ggml_set_input(g_xt);

    struct ggml_tensor * g_te = ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, hp.expert_hidden_size, chunk_size);
    ggml_set_name(g_te, "time"); ggml_set_input(g_te);

    struct ggml_tensor * g_pos = ggml_new_tensor_1d(sg3.ctx, GGML_TYPE_I32, chunk_size);
    ggml_set_name(g_pos, "pos"); ggml_set_input(g_pos);

    struct ggml_tensor * g_cpos = ggml_new_tensor_1d(sg3.ctx, GGML_TYPE_I32, chunk_size);
    ggml_set_name(g_cpos, "cpos"); ggml_set_input(g_cpos);

    struct ggml_tensor * g_samask = ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, full_len, chunk_size);
    ggml_set_name(g_samask, "samask"); ggml_set_input(g_samask);

    std::vector<struct ggml_tensor *> g_kk(hp.text_num_layers), g_kv(hp.text_num_layers);
    for (int i = 0; i < hp.text_num_layers; i++) {
        bool is_sa = (hp.self_attn_every_n > 0) && (i % hp.self_attn_every_n == 0);
        char n[32];
        if (is_sa) {
            snprintf(n, sizeof(n), "kk%d", i);
            g_kk[i] = ggml_new_tensor_3d(sg3.ctx, GGML_TYPE_F32, hp.text_head_dim, hp.text_num_kv_heads, prefix_len);
            ggml_set_name(g_kk[i], n); ggml_set_input(g_kk[i]);
            snprintf(n, sizeof(n), "kv%d", i);
            g_kv[i] = ggml_new_tensor_3d(sg3.ctx, GGML_TYPE_F32, hp.text_head_dim, hp.text_num_kv_heads, prefix_len);
            ggml_set_name(g_kv[i], n); ggml_set_input(g_kv[i]);
        } else {
            snprintf(n, sizeof(n), "kk%d", i);
            g_kk[i] = ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, kv_dim, prefix_len);
            ggml_set_name(g_kk[i], n); ggml_set_input(g_kk[i]);
            snprintf(n, sizeof(n), "kv%d", i);
            g_kv[i] = ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, kv_dim, prefix_len);
            ggml_set_name(g_kv[i], n); ggml_set_input(g_kv[i]);
        }
    }

    // Cross-attention mask: (prefix_len, chunk_size) — mask out padding tokens
    struct ggml_tensor * g_camask = ggml_new_tensor_2d(sg3.ctx, GGML_TYPE_F32, prefix_len, chunk_size);
    ggml_set_name(g_camask, "camask"); ggml_set_input(g_camask);

    struct ggml_tensor * v_t = build_denoise_step_graph(sg3.ctx, model, g_xt, g_te,
        g_kk.data(), g_kv.data(), g_pos, g_cpos, g_camask, g_samask);
    ggml_set_name(v_t, "v_t"); ggml_set_output(v_t);

    ggml_build_forward_expand(sg3.gf, v_t);

    if (model.has_gpu) {
        alloc_staged_sched(sg3, model.backend, model.backend_cpu);
    } else {
        alloc_staged_simple(sg3, model.backend_cpu);
    }

    // Set static inputs (don't change between steps)
    std::vector<int32_t> sa_pos(chunk_size), cr_pos(chunk_size);
    for (int j = 0; j < chunk_size; j++) { sa_pos[j] = valid_prefix + j; cr_pos[j] = j; }
    ggml_backend_tensor_set(g_pos, sa_pos.data(), 0, chunk_size * sizeof(int32_t));
    ggml_backend_tensor_set(g_cpos, cr_pos.data(), 0, chunk_size * sizeof(int32_t));
    ggml_backend_tensor_set(g_samask, sa_mask.data(), 0, sa_mask.size() * sizeof(float));

    // Cross-attention mask: mask out padding tokens in VLM prefix
    {
        std::vector<float> ca_mask(prefix_len * chunk_size);
        for (int qi = 0; qi < chunk_size; qi++) {
            for (int ki = 0; ki < prefix_len; ki++) {
                bool valid = (ki < n_visual_tokens) ||
                             (ki >= n_visual_tokens && ki < n_visual_tokens + lang_len && lang_mask[ki - n_visual_tokens]) ||
                             (ki == prefix_len - 1);
                ca_mask[qi * prefix_len + ki] = valid ? 0.0f : -1e9f;
            }
        }
        ggml_backend_tensor_set(g_camask, ca_mask.data(), 0, ca_mask.size() * sizeof(float));
    }

    for (int i = 0; i < hp.text_num_layers; i++) {
        if (g_kk[i]->buffer) {
            ggml_backend_tensor_set(g_kk[i], kv_keys_data[i].data(), 0, kv_total * sizeof(float));
        }
        if (g_kv[i]->buffer) {
            ggml_backend_tensor_set(g_kv[i], kv_vals_data[i].data(), 0, kv_total * sizeof(float));
        }
    }

    std::vector<float> vt_data(chunk_size * hp.max_action_dim);
    std::vector<float> te_expanded(chunk_size * hp.expert_hidden_size);

    // Run 10 ODE steps, reusing the same graph
    for (int step = 0; step < hp.num_ode_steps; step++) {
        float t_val = 1.0f + step * dt;

        // Re-set ALL inputs each step (KV cache may be overwritten by allocator)
        ggml_backend_tensor_set(g_xt, x_t.data(), 0, x_t.size() * sizeof(float));
        for (int i = 0; i < hp.text_num_layers; i++) {
            if (g_kk[i]->buffer) {
                ggml_backend_tensor_set(g_kk[i], kv_keys_data[i].data(), 0, kv_total * sizeof(float));
            }
            if (g_kv[i]->buffer) {
                ggml_backend_tensor_set(g_kv[i], kv_vals_data[i].data(), 0, kv_total * sizeof(float));
            }
        }

        std::vector<float> te_single(hp.expert_hidden_size);
        compute_sinusoidal_time_embedding(t_val, hp.expert_hidden_size, hp.min_period, hp.max_period, te_single.data());
        for (int j = 0; j < chunk_size; j++)
            memcpy(te_expanded.data() + j * hp.expert_hidden_size, te_single.data(), hp.expert_hidden_size * sizeof(float));
        ggml_backend_tensor_set(g_te, te_expanded.data(), 0, te_expanded.size() * sizeof(float));

        // Compute (reuses same graph and allocations)
        if (sg3.sched) {
            ggml_backend_sched_graph_compute(sg3.sched, sg3.gf);
        } else {
            ggml_backend_graph_compute(model.backend_cpu, sg3.gf);
        }

        // Read velocity and do Euler step
        ggml_backend_tensor_get(v_t, vt_data.data(), 0, vt_data.size() * sizeof(float));

        // Dump ODE intermediates
        {
            char name[64];
            snprintf(name, sizeof(name), "ode_xt_pre_%02d", step);
            dump_tensor(name, x_t.data(), chunk_size * hp.max_action_dim);
            snprintf(name, sizeof(name), "ode_vt_%02d", step);
            dump_tensor(name, vt_data.data(), chunk_size * hp.max_action_dim);
            if (step == 0) {
                dump_tensor("ode_time_emb_0", te_expanded.data(), chunk_size * hp.expert_hidden_size);
                // Dump suffix embedding intermediates
                struct ggml_tensor * dbg_ae = ggml_get_tensor(sg3.ctx, "dbg_action_emb");
                struct ggml_tensor * dbg_se = ggml_get_tensor(sg3.ctx, "dbg_suffix_emb");
                if (dbg_ae) {
                    std::vector<float> tmp(ggml_nelements(dbg_ae));
                    ggml_backend_tensor_get(dbg_ae, tmp.data(), 0, tmp.size() * sizeof(float));
                    dump_tensor("ode_action_emb_0", tmp.data(), tmp.size());
                }
                if (dbg_se) {
                    std::vector<float> tmp(ggml_nelements(dbg_se));
                    ggml_backend_tensor_get(dbg_se, tmp.data(), 0, tmp.size() * sizeof(float));
                    dump_tensor("ode_suffix_emb_0", tmp.data(), tmp.size());
                }
                // Dump per-expert-layer hidden states
                for (int el = 0; el < hp.expert_num_layers; el++) {
                    char name[32];
                    snprintf(name, sizeof(name), "dbg_expert_pre_%02d", el);
                    struct ggml_tensor * dbg = ggml_get_tensor(sg3.ctx, name);
                    if (dbg) {
                        std::vector<float> tmp(ggml_nelements(dbg));
                        ggml_backend_tensor_get(dbg, tmp.data(), 0, tmp.size() * sizeof(float));
                        char dname[64];
                        snprintf(dname, sizeof(dname), "ode0_expert_pre_%02d", el);
                        dump_tensor(dname, tmp.data(), tmp.size());
                    }
                }
            }
        }

        for (int j = 0; j < chunk_size * hp.max_action_dim; j++) {
            x_t[j] += vt_data[j] * dt;
        }

        fprintf(stderr, "%s: ODE step %d/%d (t=%.2f) done\n", __func__, step + 1, hp.num_ode_steps, t_val);
    }

    free_staged(sg3);

    double t_ode_end = now_ms();

    fprintf(stderr, "%s: TIMING: vision=%.0fms smollm2_compute=%.0fms smollm2_total=%.0fms ode=%.0fms\n",
            __func__,
            t_vision_end - t_vision_start,
            t_smollm2_compute - t_smollm2_start,
            t_smollm2_end - t_smollm2_start,
            t_ode_end - t_ode_start);

    // ================================================================
    // STAGE 4: Extract actions
    // ================================================================
    for (int i = 0; i < chunk_size; i++) {
        for (int j = 0; j < action_dim; j++) {
            actions_out[i * action_dim + j] = x_t[i * hp.max_action_dim + j];
        }
    }
    *n_actions_out = chunk_size;

    return true;
}
