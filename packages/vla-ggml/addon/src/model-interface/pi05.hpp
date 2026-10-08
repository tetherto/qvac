#pragma once

// π₀.₅ model implementation. SigLIP-So400m/14 vision encoder,
// Gemma-1 2B VLM prefill with KV-cache taps, Gemma-1 300M action expert with
// joint attention, adaRMSNorm conditioning, and 10-step ODE flow matching.

#include <memory>
#include <string>
#include <vector>

#include <ggml.h>

#include "model-interface/vla_model.hpp"

namespace qvac_lib_infer_vla_ggml {

// Forward-declared internal model struct — defined in pi05.cpp. Pi05Model
// holds it via a unique_ptr so the public header doesn't need to drag in
// all the per-section weight tables and backend handles. The destructor
// is intentionally out-of-line (defined in pi05.cpp where Pi05ModelInternal is
// complete) so unique_ptr<Pi05ModelInternal> compiles without leaking the type.
struct Pi05ModelInternal;

// ── Sub-graph helpers ────────────────────────────────────────────────────
// Each sub-graph exposes a small C++ entry point so the matching
// GoogleTest can drive it directly, without going through
// Pi05Model::infer. Mirrors the pattern in `smolvla.hpp` (e.g.
// `build_siglip_graph`). Implementations live in `pi05.cpp`; tests live
// next to test_model_factory.cpp under `test/unit/`.

// SigLIP patch embed + position embed.
//
// Builds the prefix of the SigLIP-So400m/14 forward up to (but excluding)
// the first transformer block, with both intermediate outputs exposed so
// the parity test can compare each against the PyTorch reference.
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
Pi05PatchPosOutputs pi05BuildSiglipPatchPosGraph(
    struct ggml_context* ctx, struct ggml_tensor* pixelValues,
    struct ggml_tensor* patchEmbedW, struct ggml_tensor* patchEmbedB,
    struct ggml_tensor* posEmbed, int patchSize);

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
  struct ggml_tensor* ln1_w;    // (hidden,)
  struct ggml_tensor* ln1_b;    // (hidden,)
  struct ggml_tensor* attn_q_w; // (hidden, hidden)
  struct ggml_tensor* attn_q_b; // (hidden,)
  struct ggml_tensor* attn_k_w;
  struct ggml_tensor* attn_k_b;
  struct ggml_tensor* attn_v_w;
  struct ggml_tensor* attn_v_b;
  struct ggml_tensor* attn_out_w;
  struct ggml_tensor* attn_out_b;
  struct ggml_tensor* ln2_w;
  struct ggml_tensor* ln2_b;
  struct ggml_tensor* fc1_w; // (intermediate, hidden)
  struct ggml_tensor* fc1_b; // (intermediate,)
  struct ggml_tensor* fc2_w; // (hidden, intermediate)
  struct ggml_tensor* fc2_b; // (hidden,)
};

// Build one SigLIP block on top of `x` (ne=[hidden, n_patches]; same
// byte layout as the M3.1 outputs). Returns the post-residual hidden
// state with the same ne — feedable straight into the next block.
//
// Returns nullptr if any required weight in `w` is missing.
struct ggml_tensor* pi05BuildSiglipBlockGraph(
    struct ggml_context* ctx, struct ggml_tensor* x,
    const Pi05SiglipBlockWeights& w, int nPatches, int hidden, int nHeads,
    float layerNormEps);

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
  struct ggml_tensor* patch_embed_w; // (kw=14, kh=14, in=3, out=1152)
  struct ggml_tensor* patch_embed_b; // (1152,)
  struct ggml_tensor* pos_embed;     // (1152, 256) in ggml = numpy (256, 1152)

  // M3.2 — per-block tensors. Caller fills 27 entries for pi05_base.
  std::vector<Pi05SiglipBlockWeights> blocks;

  // M3.3 — post-LN + head Linear.
  struct ggml_tensor* post_ln_w; // (hidden,)
  struct ggml_tensor* post_ln_b;
  struct ggml_tensor* head_w; // (hidden=1152, proj=2048)
  struct ggml_tensor* head_b; // (proj=2048,)
};

struct Pi05VisionTowerOutputs {
  // Final tower output: ne=[proj_dim=2048, n_patches=256]. Byte-equivalent
  // to numpy (n_patches, proj_dim) row-major.
  struct ggml_tensor* head_out;
};

// Build the SigLIP tower on top of a (3, image_size, image_size) F32
// pixel tensor. `w.blocks.size()` determines depth (27 for SigLIP-
// So400m). Returns `{nullptr}` if any required weight is missing or
// the block list is empty.
Pi05VisionTowerOutputs pi05BuildSiglipTowerGraph(
    struct ggml_context* ctx, struct ggml_tensor* pixelValues,
    const Pi05VisionTowerWeights& w, int nPatches, int hidden, int projDim,
    int nHeads, int patchSize, float layerNormEps);

// M3.4 — PaliGemma token embedder + Gemma-style scale.
//
// Looks up each token id in the (hidden, vocab) embedding matrix and
// scales the result by `sqrt(hidden)`. The sqrt scale is a Gemma-1
// convention (see `openpi/src/openpi/models/gemma.py:150` and
// llama.cpp's `llm_build_gemma`); without it every downstream
// LayerNorm/RMSNorm sees inputs that are too small by ~45×.
//
// Returns ne=[hidden, n_tokens] — byte-equivalent to numpy
// (n_tokens, hidden) row-major.
//
// `tokens` must be a GGML_TYPE_I32 tensor of shape (n_tokens,) and
// `embed_tokens` must have ne[0] == hidden. Returns nullptr on
// missing weights.
struct ggml_tensor* pi05BuildVlmEmbedGraph(
    struct ggml_context* ctx, struct ggml_tensor* tokens,
    struct ggml_tensor* embedTokens, int hidden);

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
//     The GGUF converter copies the raw PyTorch tensor, so we apply
//     the `+1` at graph-build time.
//   * Hidden activation is GELU with the tanh approximation
//     (lerobot/pi05's `hidden_activation = "gelu_pytorch_tanh"`).
//   * RoPE freq_base is the Gemma-1 default 10000, NEOX-style (llama-
//     model.cpp:9309).
//
// `attn_mask` may be nullptr — in which case no positions are masked
// out (slice the input to its valid range instead).
struct Pi05GemmaBlockWeights {
  struct ggml_tensor* pre_attn_norm_scale; // (hidden,)
  struct ggml_tensor* attn_q_w;            // (hidden, n_heads * head_dim)
  struct ggml_tensor* attn_k_w;            // (hidden, n_kv_heads * head_dim)
  struct ggml_tensor* attn_v_w;
  struct ggml_tensor* attn_o_w; // (n_heads * head_dim, hidden)
  struct ggml_tensor* pre_ffw_norm_scale;
  struct ggml_tensor* mlp_gate_w; // (hidden, intermediate)
  struct ggml_tensor* mlp_up_w;
  struct ggml_tensor* mlp_down_w; // (intermediate, hidden)
};

// Optional out parameters `out_k_post_rope` and `out_v` let M3.13's
// end-to-end path tap the post-RoPE per-layer K/V cache (ne=
// [head_dim, seq_len, n_kv_heads]) for downstream joint attention.
// They default to nullptr so M3.5/M3.6's tests don't pay anything.
struct ggml_tensor* pi05BuildGemmaVlmBlockGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* x,         // ne=[hidden, seq_len]
    struct ggml_tensor* positions, // I32 (seq_len,) — RoPE indices
    struct ggml_tensor* attnMask,  // F32 (seq_k, seq_q) or nullptr
    const Pi05GemmaBlockWeights& w, int hidden, int nHeads, int nKvHeads,
    int headDim, int seqLen, float rmsNormEps, float ropeFreqBase,
    struct ggml_tensor** outKPostRope = nullptr,
    struct ggml_tensor** outV = nullptr);

// M3.7 — time-step → adaRMSNorm conditioning vector.
//
// Two pieces:
//   * `pi05ComputeTimeSincos`: plain C++ that fills a `(dim,)`
//     float buffer with `[sin(2π·t/period_0), ..., sin(2π·t/period_{N-1}),
//                          cos(2π·t/period_0), ..., cos(2π·t/period_{N-1})]`
//     where `period_i = min_period · (max_period/min_period)^(i/(N-1))`
//     and `N = dim/2`. Exact port of openpi's
//     `create_sinusoidal_pos_embedding` (lerobot/pi05/modeling_pi05.py:81)
//     including the float64 internal precision.
//   * `pi05BuildTimeMlpGraph`: ggml graph for
//     `silu(Linear(silu(Linear(time_emb))))`, producing the (dim,)
//     vector the expert path uses as `adarms_cond`.
//
// Splitting them keeps the graph helper portable across backends — the
// sin-cos table is tiny (1024 floats per ODE step) and trivially
// computed CPU-side once per step. For pi05_base, `dim` is 1024 and
// `min_period`/`max_period` are 4e-3 and 4.0 (plan §2).
void pi05ComputeTimeSincos(
    float t, int dim, float minPeriod, float maxPeriod, float* out);

struct ggml_tensor* pi05BuildTimeMlpGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* timeEmb,      // (dim,) F32
    struct ggml_tensor* timeMlpInW,   // (dim, dim)
    struct ggml_tensor* timeMlpInB,   // (dim,)
    struct ggml_tensor* timeMlpOutW,  // (dim, dim)
    struct ggml_tensor* timeMlpOutB); // (dim,)

// M3.8 — adaRMSNorm modulation split.
//
// Per-block expert path uses a learned `Dense(cond_dim → 3·hidden)`
// driven by the M3.7 cond vector to produce the (scale, shift, gate)
// modulation triple. See openpi/gemma.py:128 — `nn.Dense(3·hidden, …)
// (cond)` followed by `chunk(3)`. For pi05 cond_dim == hidden == 1024
// (i.e. expert hidden = expert adarms cond dim = 1024).
//
// Returns three (hidden,) tensors aliasing slices of the (3·hidden,)
// modulation output. The caller wires them into the expert block:
//   * scale: applied as `normed * (1 + scale) + shift`
//             (combined with the base `pre_*_norm.scale` weight,
//              which the converter materialises as zeros for the
//              expert path — see _optional_pt_keys_with_shape).
//   * shift: same.
//   * gate:  applied to the block's residual as `x + gate * out`.
struct Pi05AdaSplit {
  struct ggml_tensor* scale; // (hidden,)
  struct ggml_tensor* shift;
  struct ggml_tensor* gate;
};

Pi05AdaSplit pi05BuildAdarmsSplitGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* cond,      // (cond_dim,) F32
    struct ggml_tensor* adaDenseW, // (cond_dim, 3·hidden)
    struct ggml_tensor* adaDenseB, // (3·hidden,)
    int hidden);

// M3.9 — one Gemma-1 300M expert block with joint attention.
//
// The expert path differs from the VLM block (M3.5) in three ways:
//   * Each RMSNorm is an adaRMSNorm — modulated by `cond` via a
//     per-block Dense (M3.8 split). The pre_*_norm.scale weights
//     stored alongside are zero on `pi05_base` (the converter
//     materialises them so the GGUF schema stays uniform with the
//     VLM side; the openpi adaRMSNorm formula doesn't actually use
//     a base scale, so we ignore them — see plan §2 RMSNorm row).
//   * Attention concatenates the expert's freshly-computed K/V with
//     the cached prefix K/V from the VLM at the same layer. Same
//     head_dim (256) and same n_kv_heads (1, MQA), so the concat
//     is a straight glue on the seq axis. Each expert query
//     attends to (prefix_len + n_act) keys in one softmax.
//   * Residuals are *gated*: `x + ada_gate * out` rather than
//     `x + out`. The gate slice of the ada split rides each
//     residual add. With the dense initialised to zero (training
//     start) the expert path is identity, so the model is born
//     learning the action expert from scratch on top of a frozen
//     VLM — which is exactly the openpi design.
//
// The cached prefix K/V layout matches the dump's
// `vlm.kv_cache_full.{keys,values}` per-layer slice:
// ne=[head_dim, prefix_len, n_kv_heads]. They are *already RoPE-
// rotated* — the VLM applied RoPE at prefill time. Expert K still
// needs RoPE applied here (with positions starting at
// `prefix_offset`).
struct Pi05ExpertBlockWeights {
  // ada modulator densities (M3.8 reuses these as `ada_dense_*`)
  struct ggml_tensor* pre_attn_ada_w; // (cond_dim, 3·hidden)
  struct ggml_tensor* pre_attn_ada_b; // (3·hidden,)
  struct ggml_tensor* pre_ffw_ada_w;
  struct ggml_tensor* pre_ffw_ada_b;
  // attn projections
  struct ggml_tensor* attn_q_w; // (hidden, n_heads*head_dim)
  struct ggml_tensor* attn_k_w; // (hidden, n_kv_heads*head_dim)
  struct ggml_tensor* attn_v_w;
  struct ggml_tensor* attn_o_w; // (n_heads*head_dim, hidden)
  // GeGLU MLP
  struct ggml_tensor* mlp_gate_w; // (hidden, intermediate)
  struct ggml_tensor* mlp_up_w;
  struct ggml_tensor* mlp_down_w; // (intermediate, hidden)
};

// Build one expert block on top of `x_exp` (ne=[expert_hidden, n_act]).
//
// `kBuf` / `vBuf` are this layer's ONE persistent unified F16 KV buffer
// each — ne=[head_dim, prefix_len + n_act, n_kv_heads] (llama.cpp-style).
// The caller must have written the VLM prefix into the [0:prefix_len]
// head slice (F16) before compute; this block writes the step's fresh
// action K/V into the [prefix_len:] tail in-graph and flash-attends over
// the WHOLE buffer (MQA, n_kv_heads==1, so the prefix is contiguous at 0).
//
// `modPreAttn` / `modPreFfw` are PRECOMPUTED F32 adaRMSNorm modulation
// vectors, ne[0] == 3*expert_hidden, laid out `[scalePlus1 | shift | gate]`
// (each expert_hidden wide) — i.e. `Linear(cond, ada_w, ada_b)` with the
// adaRMSNorm `+1` already folded into the scale third. The block slices
// them via `pi05AdaViewsFromMod` and applies `rms_norm(x)*scalePlus1+shift`.
// `act_positions` is the I32 RoPE position vector for the action tokens,
// typically `[prefix_offset, prefix_offset+1, ..., prefix_offset+n_act-1]`.
//
// `kvWrites` is an out-param: the in-graph action-K/V copy nodes are pushed
// onto it. The caller MUST `ggml_build_forward_expand` every entry BEFORE
// expanding the final output, so each tail write is ordered before the FA
// read that consumes it (there is no DAG edge enforcing this — see the
// invariant comment at the push site in pi05.cpp).
//
// Returns nullptr on missing weights. Shape of the returned tensor
// is ne=[expert_hidden, n_act] — feedable straight into the next
// expert block (M3.10) or `action_out_proj` (M3.10).
struct ggml_tensor* pi05BuildExpertBlockGraph(
    struct ggml_context* ctx, struct ggml_tensor* xExp,
    struct ggml_tensor* actPositions, struct ggml_tensor* kBuf,
    struct ggml_tensor* vBuf, struct ggml_tensor* modPreAttn,
    struct ggml_tensor* modPreFfw,
    std::vector<struct ggml_tensor*>& kvWrites,
    const Pi05ExpertBlockWeights& w, int expertHidden, int nHeads, int nKvHeads,
    int headDim, int prefixLen, int nAct, float rmsNormEps, float ropeFreqBase);

// M3.10 — full expert pass for one ODE step.
//
// Chains N expert blocks (M3.9) over the per-layer unified F16 KV buffers,
// applies the final adaRMSNorm (driven by the precomputed `modFinal`
// modulation — the expert's `expert.final_norm.ada.{weight,bias}` plays
// the same role as the per-block ada densities), then runs
// `action_out_proj` to produce `v_t` — the flow-matching velocity
// prediction for the current timestep.
//
// `kBufs[i]` / `vBufs[i]` are the per-layer persistent unified F16 KV
// buffers, ne=[head_dim, prefix_len + n_act, n_kv_heads], with the VLM
// prefix already written into the [0:prefix_len] slice (see M3.9).
// `modsPreAttn[i]` / `modsPreFfw[i]` and `modFinal` are the precomputed
// `[scalePlus1 | shift | gate]` modulation vectors (3*expert_hidden wide,
// `+1` pre-folded into the scale third). All four vectors must have
// `blocks.size()` entries. `kvWrites` collects the in-graph action-K/V
// copy nodes across all layers; the caller must expand them before the
// final output (same ordering invariant as M3.9). `blocks.size()`
// determines depth (18 for pi05_base).
struct Pi05ExpertODEStepOutputs {
  // ne=[expert_hidden, n_act] — post-final-norm hidden state.
  // Same byte layout as numpy (n_act, expert_hidden), matching the
  // dump's `expert.final_out[t=...]`.
  struct ggml_tensor* final_out;
  // ne=[action_dim, n_act] — flow-matching velocity. Same byte
  // layout as numpy (n_act, action_dim), matching `expert.v_t[t=...]`.
  struct ggml_tensor* v_t;
};

// M3.11 — one explicit-Euler ODE step.
//
//   x ← x + dt · v_t
//
// Trivial scalar update, factored out as its own helper so the
// caller (M3.12's loop) reads as `x = pi05BuildEulerStepGraph
// (ctx, x, v_t, dt)` rather than open-coding two ggml ops inline.
// `dt` is typically `-1/N_steps` (negative — integrating from the
// noise side `t=1` down to the action side `t=0`).
struct ggml_tensor* pi05BuildEulerStepGraph(
    struct ggml_context* ctx, struct ggml_tensor* xT, struct ggml_tensor* vT,
    float dt);

Pi05ExpertODEStepOutputs pi05BuildExpertOdeStepGraph(
    struct ggml_context* ctx,
    struct ggml_tensor* xExp,                        // (expert_hidden, n_act)
    struct ggml_tensor* actPositions,              // I32 (n_act,)
    const std::vector<struct ggml_tensor*>& kBufs, // per-layer unified F16 KV
    const std::vector<struct ggml_tensor*>& vBufs, // [head_dim, prefix+act, kv]
    // Per-layer precomputed adaRMSNorm modulations for this ODE step —
    // each (3·hidden,). Computed once for all steps in a batched matmul.
    const std::vector<struct ggml_tensor*>& modsPreAttn,
    const std::vector<struct ggml_tensor*>& modsPreFfw,
    struct ggml_tensor* modFinal, // (3·hidden,) — final-norm modulation
    // Out: the in-graph action-K/V copy nodes; caller must expand them.
    std::vector<struct ggml_tensor*>& kvWrites,
    const std::vector<Pi05ExpertBlockWeights>& blocks,
    struct ggml_tensor* actionOutProjW, // (expert_hidden, action_dim)
    struct ggml_tensor* actionOutProjB, // (action_dim,)
    int expertHidden, int nHeads, int nKvHeads, int headDim, int prefixLen,
    int nAct, float rmsNormEps, float ropeFreqBase);

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
// `out_keys` / `out_values`, if non-null, are populated with per-layer
// post-RoPE K/V tensor pointers — exactly the shape and layout the
// expert-side ODE step's joint attention consumes
// (ne=[head_dim, seq_len, n_kv_heads]).
struct ggml_tensor* pi05BuildVlmPrefillGraph(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* positions, struct ggml_tensor* attnMask,
    const std::vector<Pi05GemmaBlockWeights>& blocks,
    struct ggml_tensor* finalNormScale, int hidden, int nHeads, int nKvHeads,
    int headDim, int seqLen, float rmsNormEps, float ropeFreqBase,
    std::vector<struct ggml_tensor*>* outKeys = nullptr,
    std::vector<struct ggml_tensor*>* outValues = nullptr);

// Production π₀.₅ implementation. The constructor opens the GGUF,
// allocates backends, maps all 848 weight tensor pointers, and
// populates `hparams_` from `pi05.*` metadata keys. `infer()` runs
// the full SigLIP-tower + VLM-prefill + 10-step-ODE pipeline using
// the sub-graph helpers as building blocks.
class Pi05Model final : public IVlaModel {
public:
  // Throws std::runtime_error if the GGUF is missing required
  // tensors or the architecture key isn't `pi05`. `forceCpu` skips
  // GPU device selection (always uses the CPU backend); `backendsDir`
  // is the absolute path to the prebuild directory containing the
  // ggml backend plugin shared libs (.so/.dylib/.dll).
  Pi05Model(
      const std::string& ggufPath, bool forceCpu,
      const std::string& backendsDir);

  // Out-of-line because `Pi05ModelInternal` is forward-declared above;
  // unique_ptr's destructor needs the complete type, which lives in
  // pi05.cpp.
  ~Pi05Model() override;

  Pi05Model(const Pi05Model&) = delete;
  Pi05Model& operator=(const Pi05Model&) = delete;

  const VlaHparamsGeneric& hparams() const override { return hparams_; }
  std::string backendName() const override;
  bool hasGpu() const override;

  bool infer(
      const float** images, int nImages, int imgWidth, int imgHeight,
      const float* state, int stateDim, const int32_t* langTokens,
      const bool* langMask, int langLen, const float* noise, float* actionsOut,
      int* nActionsOut, VlaTimingGeneric* timingOut) override;

private:
  VlaHparamsGeneric hparams_{};
  std::unique_ptr<Pi05ModelInternal> impl_;
};

} // namespace qvac_lib_infer_vla_ggml
