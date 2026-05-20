#pragma once

// π₀.₅ model stub — Phase 1 wire-up only. The constructor throws
// std::runtime_error so the factory path is exercised by tests but no real
// loading or inference is attempted yet. Phase 3 fills in the implementation
// (SigLIP-So400m, Gemma-1 2B VLM, Gemma-1 300M action expert, joint
// attention, adaRMSNorm, …) per plan §4.

#include <string>
#include <vector>

#include <ggml.h>

#include "model-interface/vla_model.hpp"

namespace qvac_lib_infer_vla_ggml {

// ── Phase 3 milestone helpers ────────────────────────────────────────────
// Each milestone (M3.1 … M3.13) exposes a small C++ entry point so the
// matching GoogleTest can drive the sub-graph directly, without going
// through Pi05Model::infer. Mirrors the pattern in `smolvla.hpp` (e.g.
// `build_siglip_graph`). Implementations live in `pi05.cpp`; tests live
// next to test_model_factory.cpp under `test/unit/`.

// M3.1 — SigLIP patch embed + position embed.
//
// Builds the prefix of the SigLIP-So400m/14 forward up to (but excluding)
// the first transformer block, with both intermediate outputs exposed so
// the parity test can compare each against
// `vision.patch_embed_out[cam0]` and `vision.pos_embed_out[cam0]` from
// the Phase-0 PyTorch dump.
//
// Layout note: ggml tensors are dim-0-fastest, so for a (256-patch,
// 1152-channel) feature map both output tensors have ne=[1152, 256] —
// that's the same byte-layout as numpy's `(256, 1152)` row-major
// `[patch, channel]` array. The parity test compares the raw float
// buffers element-by-element under that equivalence.
struct Pi05PatchPosOutputs {
  // Conv2d(patch_size=14) output flattened to (patch, channel), with
  // patch_embed_bias added. Matches PyTorch's Conv2d output (which fuses
  // its bias).
  struct ggml_tensor* patch_embed_out;

  // patch_embed_out + pos_embed. Matches PyTorch's SiglipVisionEmbeddings
  // forward output (the sum of patch + learned position embeddings).
  struct ggml_tensor* pos_embed_out;
};

// Build the patch_embed + pos_embed sub-graph.
//   ctx              : graph-build context (call ggml_init separately).
//   pixel_values     : (3, image_size, image_size) f32 in [-1, 1].
//   patch_embed_w    : (out=1152, in=3, kh=14, kw=14) — Conv2d kernel.
//   patch_embed_b    : (out=1152,) — Conv2d bias, may be nullptr.
//   pos_embed        : (channel=1152, patch=num_patches) — learned
//                      position embeddings, stored in the GGUF as a numpy
//                      (num_patches, channel) tensor (so ggml sees ne=
//                      [channel, num_patches]).
//   patch_size       : Conv2d stride (14 for π₀.₅).
//
// Returns nullable pointers if any required weight is missing. Otherwise
// `patch_embed_out` and `pos_embed_out` are graph nodes — the caller is
// responsible for `ggml_build_forward_expand(&gf, p)` and running the
// backend.
Pi05PatchPosOutputs pi05_build_siglip_patch_pos_graph(
    struct ggml_context* ctx,
    struct ggml_tensor* pixel_values,
    struct ggml_tensor* patch_embed_w,
    struct ggml_tensor* patch_embed_b,
    struct ggml_tensor* pos_embed,
    int patch_size);

// M3.2 — one SigLIP transformer block.
//
// Standard pre-LN transformer block as implemented by HF's
// SiglipEncoderLayer: LayerNorm → MHSA → residual → LayerNorm → MLP
// (fc1 + GELU-tanh + fc2) → residual. Attention is *not* MQA for
// SigLIP — every block has the full per-head Q/K/V (16 heads × 72
// head_dim = 1152 for SigLIP-So400m/14). Mirrors the loop body of
// `smolvla.cpp::build_siglip_transformer` but pulled out as a single
// reusable per-block helper that the M3.2/M3.3 unit tests can drive
// directly.
struct Pi05SiglipBlockWeights {
  struct ggml_tensor* ln1_w;       // (hidden,)
  struct ggml_tensor* ln1_b;       // (hidden,)
  struct ggml_tensor* attn_q_w;    // (hidden, hidden)
  struct ggml_tensor* attn_q_b;    // (hidden,)
  struct ggml_tensor* attn_k_w;
  struct ggml_tensor* attn_k_b;
  struct ggml_tensor* attn_v_w;
  struct ggml_tensor* attn_v_b;
  struct ggml_tensor* attn_out_w;
  struct ggml_tensor* attn_out_b;
  struct ggml_tensor* ln2_w;
  struct ggml_tensor* ln2_b;
  struct ggml_tensor* fc1_w;       // (intermediate, hidden)
  struct ggml_tensor* fc1_b;       // (intermediate,)
  struct ggml_tensor* fc2_w;       // (hidden, intermediate)
  struct ggml_tensor* fc2_b;       // (hidden,)
};

// Build one SigLIP block on top of `x` (ne=[hidden, n_patches]; same
// byte layout as the M3.1 outputs). Returns the post-residual hidden
// state with the same ne — feedable straight into the next block.
//
// Returns nullptr if any required weight in `w` is missing.
struct ggml_tensor* pi05_build_siglip_block_graph(
    struct ggml_context* ctx,
    struct ggml_tensor* x,
    const Pi05SiglipBlockWeights& w,
    int n_patches,
    int hidden,
    int n_heads,
    float layer_norm_eps);

// M3.3 — full SigLIP-So400m/14 vision tower.
//
// Composition: patch_embed (M3.1) → pos_embed (M3.1) → N
// transformer blocks (M3.2) → post-LayerNorm → head Linear
// (hidden → proj_dim). For pi05 the head is the "connector" —
// `_siglip.Module(num_classes=2048, pool_type="none")` — that maps
// from SigLIP's 1152-channel patch tokens to the VLM's 2048-channel
// input width. No pixel-shuffle, no separate connector module
// (plan §2 row "Vision connector").
struct Pi05VisionTowerWeights {
  // M3.1 — patch + pos embed.
  struct ggml_tensor* patch_embed_w;  // (kw=14, kh=14, in=3, out=1152)
  struct ggml_tensor* patch_embed_b;  // (1152,)
  struct ggml_tensor* pos_embed;      // (1152, 256) in ggml = numpy (256, 1152)

  // M3.2 — per-block tensors. Caller fills 27 entries for pi05_base.
  std::vector<Pi05SiglipBlockWeights> blocks;

  // M3.3 — post-LN + head Linear.
  struct ggml_tensor* post_ln_w;      // (hidden,)
  struct ggml_tensor* post_ln_b;
  struct ggml_tensor* head_w;         // (hidden=1152, proj=2048)
  struct ggml_tensor* head_b;         // (proj=2048,)
};

struct Pi05VisionTowerOutputs {
  // Final tower output: ne=[proj_dim=2048, n_patches=256]. Byte-equivalent
  // to numpy (n_patches, proj_dim) row-major, which is how the Phase-0
  // dump stores `vision.head_out[cam_i]`.
  struct ggml_tensor* head_out;
};

// Build the SigLIP tower on top of a (3, image_size, image_size) F32
// pixel tensor. `w.blocks.size()` determines depth (27 for SigLIP-
// So400m). Returns `{nullptr}` if any required weight is missing or
// the block list is empty.
Pi05VisionTowerOutputs pi05_build_siglip_tower_graph(
    struct ggml_context* ctx,
    struct ggml_tensor* pixel_values,
    const Pi05VisionTowerWeights& w,
    int n_patches,
    int hidden,
    int proj_dim,
    int n_heads,
    int patch_size,
    float layer_norm_eps);

// M3.4 — PaliGemma token embedder + Gemma-style scale.
//
// Looks up each token id in the (hidden, vocab) embedding matrix and
// scales the result by `sqrt(hidden)`. The sqrt scale is a Gemma-1
// convention (see `openpi/src/openpi/models/gemma.py:150` and
// llama.cpp's `llm_build_gemma`); without it every downstream
// LayerNorm/RMSNorm sees inputs that are too small by ~45×.
//
// Returns ne=[hidden, n_tokens] — byte-equivalent to numpy
// (n_tokens, hidden) row-major, which is how the Phase-0 dump stores
// `vlm.embed_out`.
//
// `tokens` must be a GGML_TYPE_I32 tensor of shape (n_tokens,) and
// `embed_tokens` must have ne[0] == hidden. Returns nullptr on
// missing weights.
struct ggml_tensor* pi05_build_vlm_embed_graph(
    struct ggml_context* ctx,
    struct ggml_tensor* tokens,
    struct ggml_tensor* embed_tokens,
    int hidden);

// M3.5 — one Gemma-1 transformer block on the VLM side.
//
// Standard pre-RMSNorm Gemma block: RMSNorm((1+scale)·x) → MQA
// (n_heads × head_dim Q, n_kv_heads × head_dim K/V) with NEOX-style
// RoPE on Q and K → softmax(Q·K^T / sqrt(head_dim) + mask) ·V → o_proj
// → residual → RMSNorm → GeGLU MLP (gate, up, gelu-tanh, down) →
// residual.
//
// Implementation choices come from cross-referencing llama.cpp's
// `llm_build_gemma` (gemma.cpp) and openpi's `gemma.py`. Specifically:
//   * RMSNorm scale is applied as `(1 + scale)` (openpi/gemma.py:122).
//     The Phase-2 converter copies the raw PyTorch tensor, so we apply
//     the `+1` at graph-build time.
//   * Hidden activation is GELU with the tanh approximation
//     (lerobot/pi05's `hidden_activation = "gelu_pytorch_tanh"`).
//   * RoPE freq_base is the Gemma-1 default 10000, NEOX-style (llama-
//     model.cpp:9309).
//
// `attn_mask` may be nullptr — in which case no positions are masked
// out (slice the input to its valid range instead).
struct Pi05GemmaBlockWeights {
  struct ggml_tensor* pre_attn_norm_scale;  // (hidden,)
  struct ggml_tensor* attn_q_w;             // (hidden, n_heads * head_dim)
  struct ggml_tensor* attn_k_w;             // (hidden, n_kv_heads * head_dim)
  struct ggml_tensor* attn_v_w;
  struct ggml_tensor* attn_o_w;             // (n_heads * head_dim, hidden)
  struct ggml_tensor* pre_ffw_norm_scale;
  struct ggml_tensor* mlp_gate_w;           // (hidden, intermediate)
  struct ggml_tensor* mlp_up_w;
  struct ggml_tensor* mlp_down_w;           // (intermediate, hidden)
};

struct ggml_tensor* pi05_build_gemma_vlm_block_graph(
    struct ggml_context* ctx,
    struct ggml_tensor* x,            // ne=[hidden, seq_len]
    struct ggml_tensor* positions,    // I32 (seq_len,) — RoPE indices
    struct ggml_tensor* attn_mask,    // F32 (seq_k, seq_q) or nullptr
    const Pi05GemmaBlockWeights& w,
    int hidden,
    int n_heads,
    int n_kv_heads,
    int head_dim,
    int seq_len,
    float rms_norm_eps,
    float rope_freq_base);

// M3.6 — full VLM prefill stack.
//
// Chains N Gemma-1 blocks (M3.5) and applies the model's final
// `(1+scale)` RMSNorm. Used during prefill to produce
// `vlm.final_out`; the per-layer K/V is produced as a side-effect of
// each block but not surfaced here (callers that need the cache for
// the ODE step build their own version with KV taps, M3.9+).
//
// `blocks.size()` determines depth (18 for pi05_base). Returns
// nullptr if any required weight is missing or the block list is
// empty.
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
    float rope_freq_base);


class Pi05Model final : public IVlaModel {
public:
  // Phase 1 stub: constructing a Pi05Model immediately throws so callers
  // who try to use the factory against a `general.architecture=pi05` GGUF
  // get a clear, early failure rather than a corrupt half-loaded model.
  // Phase 3 will replace this with `pi05_load_model(...)`.
  Pi05Model(
      const std::string& ggufPath,
      bool forceCpu,
      const std::string& backendsDir);

  ~Pi05Model() override = default;

  Pi05Model(const Pi05Model&) = delete;
  Pi05Model& operator=(const Pi05Model&) = delete;

  // IVlaModel — these are unreachable in Phase 1 because the constructor
  // throws, but they exist so the symbol table is complete and Phase 3
  // can fill them in without churning the addon layer.
  const VlaHparamsGeneric& hparams() const override { return hparams_; }
  std::string backendName() const override { return "none"; }
  bool hasGpu() const override { return false; }

  bool infer(
      const float** images,
      int n_images,
      int img_width,
      int img_height,
      const float* state,
      int state_dim,
      const int32_t* lang_tokens,
      const bool* lang_mask,
      int lang_len,
      const float* noise,
      float* actions_out,
      int* n_actions_out,
      VlaTimingGeneric* timing_out) override;

private:
  VlaHparamsGeneric hparams_{};
};

} // namespace qvac_lib_infer_vla_ggml
