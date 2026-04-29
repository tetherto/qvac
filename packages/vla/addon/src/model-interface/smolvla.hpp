#pragma once

// SmolVLA GGML inference engine — ported from
// https://github.com/olyasir/smolvla-ggml (Apache-2.0).
//
// Backend selection is deferred to qvac-fabric's ggml plugin loader: the
// translation unit does not include any backend-specific headers; instead
// smolvla_load_model() calls ggml_backend_load_all_from_path(BACKENDS_SUBDIR)
// and picks the best device (Vulkan on Linux/Windows/Android, Metal on
// macOS/iOS, CPU everywhere).

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <ggml.h>
#include <gguf.h>

// ============================================================
// Model hyperparameters (from SmolVLA config)
// ============================================================

struct smolvla_hparams {
  // Vision encoder (SigLIP)
  int vision_hidden_size = 768;
  int vision_intermediate = 3072;
  int vision_num_layers = 12;
  int vision_num_heads = 12;
  int vision_image_size = 512;
  int vision_patch_size = 16;
  int vision_num_channels = 3;
  float vision_layer_norm_eps = 1e-6f;

  // Connector
  int connector_scale_factor = 4;
  // After pixel_shuffle: patches_per_image = (512/16)^2 / 4^2 = 64
  // connector_in_features = 768 * 4^2 = 12288

  // Language backbone (SmolLM2, first 16 layers)
  int text_hidden_size = 960;
  int text_intermediate = 2560;
  int text_num_layers = 16;
  int text_num_heads = 15;
  int text_num_kv_heads = 5;
  int text_head_dim = 64;
  int text_vocab_size = 49280; // SmolLM2
  float text_rms_norm_eps = 1e-5f;

  // Action expert (LlamaModel)
  int expert_hidden_size = 720;
  int expert_intermediate = 2048;
  int expert_num_layers = 16;
  int expert_num_heads = 15;
  int expert_num_kv_heads = 5;
  int expert_head_dim = 64;
  float expert_rms_norm_eps = 1e-5f;
  int self_attn_every_n = 2; // even layers = self-attn, odd = cross-attn

  // Flow matching
  int num_ode_steps = 10;
  int chunk_size = 50;
  int max_action_dim = 32;
  int max_state_dim = 32;
  int action_dim = 6; // actual action DOF
  float min_period = 4e-3f;
  float max_period = 4.0f;

  // Tokenizer
  int tokenizer_max_length = 48;

  // Derived
  int patches_per_image() const {
    int s = vision_image_size / vision_patch_size;
    return s * s; // 1024
  }
  int tokens_per_image() const {
    return patches_per_image() /
           (connector_scale_factor * connector_scale_factor); // 64
  }
  int connector_in_features() const {
    return vision_hidden_size * connector_scale_factor *
           connector_scale_factor; // 12288
  }
};

// ============================================================
// GGUF tensor name helpers
// ============================================================

// Naming convention for tensors in the GGUF file
// Vision: v.enc.blk.{i}.{component}
// Text:   t.blk.{i}.{component}
// Expert: e.blk.{i}.{component}
// Connector: v.connector.{component}
// Projections: proj.{name}

// ============================================================
// Model weight structures
// ============================================================

struct siglip_layer_weights {
  struct ggml_tensor* ln1_weight;
  struct ggml_tensor* ln1_bias;
  struct ggml_tensor* qkv_proj_w; // fused Q+K+V weight
  struct ggml_tensor* qkv_proj_b; // fused Q+K+V bias
  struct ggml_tensor* q_proj_w;   // unfused (fallback, NULL if fused)
  struct ggml_tensor* q_proj_b;
  struct ggml_tensor* k_proj_w;
  struct ggml_tensor* k_proj_b;
  struct ggml_tensor* v_proj_w;
  struct ggml_tensor* v_proj_b;
  struct ggml_tensor* out_proj_w;
  struct ggml_tensor* out_proj_b;
  struct ggml_tensor* ln2_weight;
  struct ggml_tensor* ln2_bias;
  struct ggml_tensor* fc1_weight;
  struct ggml_tensor* fc1_bias;
  struct ggml_tensor* fc2_weight;
  struct ggml_tensor* fc2_bias;
};

struct siglip_weights {
  struct ggml_tensor* patch_embed_weight; // Conv2d weight
  struct ggml_tensor* patch_embed_bias;
  struct ggml_tensor* pos_embed; // position embedding
  std::vector<siglip_layer_weights> layers;
  struct ggml_tensor* post_ln_weight; // final LayerNorm
  struct ggml_tensor* post_ln_bias;
};

struct connector_weights {
  struct ggml_tensor* proj_weight; // Linear(12288, 960, bias=False)
};

struct transformer_layer_weights {
  struct ggml_tensor* attn_norm_weight;
  struct ggml_tensor* qkv_proj_weight; // fused Q+K+V (NULL if not fused)
  struct ggml_tensor* q_proj_weight;   // unfused (NULL if fused)
  struct ggml_tensor* k_proj_weight;
  struct ggml_tensor* v_proj_weight;
  struct ggml_tensor* o_proj_weight;
  struct ggml_tensor* ffn_norm_weight;
  struct ggml_tensor* gate_up_weight;   // fused gate+up (NULL if not fused)
  struct ggml_tensor* gate_proj_weight; // unfused (NULL if fused)
  struct ggml_tensor* up_proj_weight;
  struct ggml_tensor* down_proj_weight;
};

struct smolllm2_weights {
  struct ggml_tensor* embed_tokens; // token embedding
  std::vector<transformer_layer_weights> layers;
  struct ggml_tensor* final_norm_weight; // final RMSNorm
};

struct expert_weights {
  std::vector<transformer_layer_weights> layers;
  struct ggml_tensor* final_norm_weight; // final RMSNorm
};

struct smolvla_model {
  smolvla_hparams hparams;

  // Component weights
  siglip_weights vision;
  connector_weights connector;
  smolllm2_weights text;
  expert_weights expert;

  // Projection weights
  struct ggml_tensor* state_proj_weight; // Linear(32, 960)
  struct ggml_tensor* state_proj_bias;
  struct ggml_tensor* action_in_proj_weight; // Linear(32, 720)
  struct ggml_tensor* action_in_proj_bias;
  struct ggml_tensor* action_out_proj_weight; // Linear(720, 32)
  struct ggml_tensor* action_out_proj_bias;
  struct ggml_tensor* action_time_mlp_in_weight; // Linear(1440, 720)
  struct ggml_tensor* action_time_mlp_in_bias;
  struct ggml_tensor* action_time_mlp_out_weight; // Linear(720, 720)
  struct ggml_tensor* action_time_mlp_out_bias;

  // GGML context for weights
  struct ggml_context* ctx_w;

  // Backend buffer(s) for weights. Multiple buffers when the backend's
  // buffer_from_host_ptr path slices a large mmap range into several
  // sub-buffers (matches llama.cpp's pattern); single buffer for the
  // alloc+copy fallback used by Vulkan/CPU.
  std::vector<ggml_backend_buffer_t> bufs_w;

  // mmap of the GGUF file when the zero-copy path is used (Apple Metal,
  // CPU). nullptr when we fell back to alloc+copy. Owned by the model;
  // released in smolvla_free_model.
  void* mmap_addr = nullptr;
  size_t mmap_size = 0;

  // Backends
  ggml_backend_t backend;     // primary (Vulkan if available)
  ggml_backend_t backend_cpu; // CPU fallback for unsupported ops
  bool has_gpu;               // true if Vulkan/GPU backend is active
};

// ============================================================
// KV cache
// ============================================================

struct smolvla_kv_cache {
  // VLM KV cache: 16 layers, each with key and value tensors
  // key:   (B, prefix_len, num_kv_heads, head_dim)
  // value: (B, prefix_len, num_kv_heads, head_dim)
  std::vector<struct ggml_tensor*> keys; // one per layer
  std::vector<struct ggml_tensor*> values;

  struct ggml_context* ctx;
  ggml_backend_buffer_t buf;
};

// ============================================================
// API
// ============================================================

// Utility functions exposed for checkpoint verification

// Build SigLIP vision encoder graph for a single image
struct ggml_tensor* build_siglip_graph(
    struct ggml_context* ctx, smolvla_model& model,
    struct ggml_tensor* pixel_values);

// Build connector (PixelShuffle + projection) graph
struct ggml_tensor* build_connector_graph(
    struct ggml_context* ctx, smolvla_model& model,
    struct ggml_tensor* vision_output);

// Build SmolLM2 forward pass graph (16 layers), outputs KV cache per layer
struct ggml_tensor* build_smollm2_graph(
    struct ggml_context* ctx, smolvla_model& model,
    struct ggml_tensor* prefix_embeddings, struct ggml_tensor* position_ids,
    struct ggml_tensor* attn_mask,
    std::vector<struct ggml_tensor*>& kv_keys_out,
    std::vector<struct ggml_tensor*>& kv_vals_out,
    std::vector<struct ggml_tensor*>* layer_outputs = nullptr);

// Build single denoise step graph (action expert forward)
struct ggml_tensor* build_denoise_step_graph(
    struct ggml_context* ctx, smolvla_model& model, struct ggml_tensor* x_t,
    struct ggml_tensor* time_embed, struct ggml_tensor** vlm_kv_keys,
    struct ggml_tensor** vlm_kv_vals, struct ggml_tensor* position_ids,
    struct ggml_tensor* cross_pos_ids, struct ggml_tensor* cross_attn_mask,
    struct ggml_tensor* self_attn_mask);

// Sinusoidal time embedding (exposed for testing)
void compute_sinusoidal_time_embedding(
    float timestep, int dimension, float min_period, float max_period,
    float* out);

#ifdef __cplusplus
extern "C" {
#endif

// Opaque handle for use from C/Python
typedef void* smolvla_handle_t;

// Create and load model, return opaque handle
smolvla_handle_t smolvla_create(const char* model_path);

// Run inference using opaque handle
bool smolvla_run(
    smolvla_handle_t handle, const float** images, int n_images, int img_width,
    int img_height, const float* state, int state_dim,
    const int32_t* lang_tokens, const bool* lang_mask, int lang_len,
    const float*
        noise, // ODE initial noise (chunk_size*max_action_dim), NULL=random
    float* actions_out, int* n_actions_out);

// Free model using opaque handle
void smolvla_destroy(smolvla_handle_t handle);

// Load model from GGUF file (C++ API).
// `force_cpu`: when true, skip GPU device selection and run on the CPU backend
// only. Used by the integration test to compare CPU vs GPU on the same runner.
bool smolvla_load_model(const char* path, smolvla_model* model, bool force_cpu);

// Free model resources
void smolvla_free_model(smolvla_model* model);

// Run SigLIP vision encoder on a single image
// image_data: RGB float pixels [0,1], shape (3, H, W)
// output: (tokens_per_image, text_hidden_size) = (64, 960)
struct ggml_tensor* siglip_encode(
    smolvla_model& model, const float* image_data, int width, int height,
    struct ggml_context* ctx_compute);

// Run SmolLM2 forward pass (first 16 layers)
// Builds KV cache from visual + language + state tokens
void smollm2_forward(
    smolvla_model& model,
    struct ggml_tensor* visual_tokens, // (B, n_visual, 960)
    const int32_t* lang_token_ids,     // (B, seq_len)
    const bool* lang_mask,             // (B, seq_len)
    const float* state,                // (B, state_dim)
    int batch_size, smolvla_kv_cache& kv_cache,
    struct ggml_context* ctx_compute);

// Run action expert with flow matching (10 ODE steps)
// Returns action predictions
// output: (B, chunk_size, action_dim) = (1, 50, 6)
void action_expert_forward(
    smolvla_model& model, smolvla_kv_cache& kv_cache, int prefix_len,
    int batch_size,
    float* actions_out, // output buffer (B * chunk_size * action_dim)
    struct ggml_context* ctx_compute);

// Full pipeline: image(s) + state + instruction -> actions
// This is the main entry point
bool smolvla_inference(
    smolvla_model* model,
    const float** images, // array of N_IMAGES pointers to RGB float data
    int n_images, int img_width, int img_height,
    const float* state, // state vector (state_dim,)
    int state_dim,
    const int32_t* lang_tokens, // tokenized instruction
    const bool* lang_mask, int lang_len,
    const float* noise,  // ODE initial noise, NULL=random
    float* actions_out,  // output: (chunk_size * action_dim)
    int* n_actions_out); // output: number of action steps

#ifdef __cplusplus
}

// Per-stage wall-clock timing captured during a single `smolvla_inference`
// call. All values are milliseconds.
struct smolvla_timing {
  double vision_ms = 0.0;
  double smollm2_compute_ms = 0.0;
  double smollm2_total_ms = 0.0;
  double ode_ms = 0.0;
  double total_ms = 0.0;
};

// Same as `smolvla_inference` but populates `timing_out` (if non-null) with
// per-stage timings.  C++-only; keeps the extern "C" ABI stable for the
// ctypes-based Python wrapper in smolvla-ggml.
bool smolvla_inference_with_timing(
    smolvla_model* model, const float** images, int n_images, int img_width,
    int img_height, const float* state, int state_dim,
    const int32_t* lang_tokens, const bool* lang_mask, int lang_len,
    const float* noise, float* actions_out, int* n_actions_out,
    smolvla_timing* timing_out);
#endif
