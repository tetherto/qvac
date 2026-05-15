#pragma once

// SmolVLA GGML inference engine — ported from
// https://github.com/olyasir/smolvla-ggml (Apache-2.0).
//
// Backend selection is deferred to qvac-fabric's ggml plugin loader: the
// translation unit does not include any backend-specific headers; instead
// smolvla_load_model() resolves backendsDir/BACKENDS_SUBDIR to an absolute
// path and loads plugins from there, then picks the best device (Vulkan on
// Linux/Windows/Android, Metal on macOS/iOS, CPU everywhere).

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
  int action_dim = 7; // actual action DOF
  float min_period = 4e-3f;
  float max_period = 4.0f;

  // Tokenizer
  int tokenizer_max_length = 48;

  // Derived. Guard against zero divisors so a malformed GGUF that slips a
  // zero past the load-time hparam validation cannot trigger SIGFPE here.
  int patches_per_image() const {
    if (vision_patch_size <= 0) return 0;
    int s = vision_image_size / vision_patch_size;
    return s * s; // 1024
  }
  int tokens_per_image() const {
    if (connector_scale_factor <= 0) return 0;
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

  // Precomputed `1/period` table for the sinusoidal time embedding. Sized
  // to `expert_hidden_size / 2` and populated once at load time so the
  // per-ODE-step embedding only needs sinf/cosf, not powf.
  std::vector<float> time_embed_inv_periods;

  // Backends
  ggml_backend_t backend = nullptr;     // primary (Vulkan if available)
  ggml_backend_t backend_cpu = nullptr; // CPU fallback for unsupported ops
  bool has_gpu = false;                 // true if Vulkan/GPU backend is active

  // Cleans up backends, mmap, weight context, and buffers via
  // smolvla_free_model. Defined out-of-line in smolvla.cpp because
  // smolvla_free_model is forward-declared below. Required so a partially
  // initialised model is freed when smolvla_load_model fails and the
  // owning unique_ptr unwinds (e.g. VlaModel constructor throws).
  ~smolvla_model();
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

// Sinusoidal time embedding using a precomputed `1/period` table
// (size = dimension/2). `out` must be sized `dimension`. Used on the
// ODE hot path.
void compute_sinusoidal_time_embedding_cached(
    float timestep, const float* inv_periods, int dimension, float* out);

// Load model from GGUF file. `force_cpu`: skip GPU device selection.
// `backendsDir`: absolute path to the prebuilds folder; BACKENDS_SUBDIR is
// appended before calling ggml_backend_load_all_from_path so dlopen works
// regardless of process CWD (critical on mobile). Pass empty string to fall
// back to ggml_backend_load_all() (static builds / desktop dev).
bool smolvla_load_model(
    const char* path,
    smolvla_model& model,
    bool force_cpu,
    const std::string& backendsDir);

// Free model resources. Idempotent — also called from `smolvla_model::~smolvla_model`.
void smolvla_free_model(smolvla_model& model);

// Per-stage wall-clock timing captured during a single inference call.
// All values are milliseconds.
struct smolvla_timing {
  double vision_ms = 0.0;
  double smollm2_compute_ms = 0.0;
  double smollm2_total_ms = 0.0;
  double ode_ms = 0.0;
  double total_ms = 0.0;
};

// Full pipeline: image(s) + state + instruction -> actions. If
// `timing_out` is non-null, populates it with per-stage timings.
bool smolvla_inference_with_timing(
    smolvla_model* model, const float** images, int n_images, int img_width,
    int img_height, const float* state, int state_dim,
    const int32_t* lang_tokens, const bool* lang_mask, int lang_len,
    const float* noise, float* actions_out, int* n_actions_out,
    smolvla_timing* timing_out);
