#pragma once

// GR00T N1.7-3B model (v1: single embodiment, baked in at conversion time —
// see scripts/convert_groot_dit_to_gguf.py).
//
// Backbone: Qwen3-VL (Cosmos-Reason2-2B), vision tower + text decoder
// truncated to 16 layers (GR00T's `select_layer`). Graph logic ported from
// qvac-fabric-llm.cpp's tools/mtmd/models/qwen3vl.cpp (vision) and
// src/models/qwen3vl.cpp (text). Backbone GGUF tensor names are fabric's own,
// unprefixed (`v.*`/`blk.*`/`token_embd`/etc), copied byte-identical from
// fabric's convert_hf_to_gguf.py.
//
// VL fusion + action head: `AlternateVLDiT` (32-layer AdaLayerNorm diffusion
// transformer, alternating self-/cross-attention every
// `attend_text_every_n_blocks`) and a 4-layer plain-LayerNorm
// `SelfAttentionTransformer` — new graph work, no upstream reference. Tensor
// names `dit.*`/`vlfusion.*`/`embodiment.*` (this package's own convention).
//
// Embodiment conditioning (`CategorySpecificLinear`/`CategorySpecificMLP`) is
// sliced to ONE embodiment at conversion time — the `embodiment.*` tensors are
// plain dense weights, no runtime embodiment-ID input.

#include <memory>
#include <string>
#include <vector>

#include <ggml.h>

#include "model-interface/vla_model.hpp"

namespace qvac_lib_infer_vla_ggml {

// ── Backbone: Qwen3-VL vision tower ─────────────────────────────────────
// Tensor names match fabric's convert_hf_to_gguf.py Qwen3VLVisionModel output
// exactly (ported graph uses the same literal string lookups).

struct GrootVisionBlockWeights {
  struct ggml_tensor* ln1_w; // v.blk.N.ln1.weight
  struct ggml_tensor* ln1_b;
  struct ggml_tensor* attn_qkv_w; // v.blk.N.attn_qkv.weight — fused QKV
  struct ggml_tensor* attn_qkv_b;
  struct ggml_tensor* attn_out_w; // v.blk.N.attn_out.weight
  struct ggml_tensor* attn_out_b;
  struct ggml_tensor* ln2_w;
  struct ggml_tensor* ln2_b;
  struct ggml_tensor*
      ffn_up_w; // v.blk.N.ffn_up.weight — (hidden -> intermediate)
  struct ggml_tensor* ffn_up_b;
  struct ggml_tensor*
      ffn_down_w; // v.blk.N.ffn_down.weight — (intermediate -> hidden)
  struct ggml_tensor* ffn_down_b;
};

// One of 3 deepstack mergers (at vision layers 5/11/17 per
// deepstack_visual_indexes) that project intermediate vision hidden states
// to out_hidden_size for later injection into the text decoder.
struct GrootDeepstackMergerWeights {
  struct ggml_tensor* norm_w; // v.deepstack.N.norm.weight
  struct ggml_tensor* norm_b;
  struct ggml_tensor* fc1_w; // v.deepstack.N.fc1.weight
  struct ggml_tensor* fc1_b;
  struct ggml_tensor* fc2_w; // v.deepstack.N.fc2.weight
  struct ggml_tensor* fc2_b;
};

struct GrootVisionWeights {
  struct ggml_tensor*
      patch_embd_w; // v.patch_embd.weight — first temporal half of Conv3D
  struct ggml_tensor*
      patch_embd_w1; // v.patch_embd.weight.1 — second temporal half
  struct ggml_tensor* patch_embd_b;  // v.patch_embd.bias
  struct ggml_tensor* position_embd; // v.position_embd.weight — (hidden,
                                     // num_position_embeddings)
  std::vector<GrootVisionBlockWeights> blocks; // 24 entries
  std::vector<GrootDeepstackMergerWeights>
      deepstack_mergers;         // 3 entries, indices [5,11,17]
  struct ggml_tensor* post_ln_w; // v.post_ln.weight
  struct ggml_tensor* post_ln_b;
  struct ggml_tensor* mm_0_w; // mm.0.weight — merger projection 1
  struct ggml_tensor* mm_0_b;
  struct ggml_tensor* mm_2_w; // mm.2.weight — merger projection 2
  struct ggml_tensor* mm_2_b;
};

// ── Backbone: Qwen3-VL text decoder (truncated to 16 layers) ────────────
// No biases anywhere (Qwen3 convention); per-head Q/K RMSNorm before RoPE.

struct GrootTextBlockWeights {
  struct ggml_tensor* attn_norm_w;   // blk.N.attn_norm.weight
  struct ggml_tensor* attn_q_w;      // blk.N.attn_q.weight
  struct ggml_tensor* attn_k_w;      // blk.N.attn_k.weight
  struct ggml_tensor* attn_v_w;      // blk.N.attn_v.weight
  struct ggml_tensor* attn_output_w; // blk.N.attn_output.weight
  struct ggml_tensor* attn_q_norm_w; // blk.N.attn_q_norm.weight — per-head
                                     // RMSNorm, width=head_dim
  struct ggml_tensor* attn_k_norm_w; // blk.N.attn_k_norm.weight
  struct ggml_tensor* ffn_norm_w;    // blk.N.ffn_norm.weight
  struct ggml_tensor* ffn_gate_w;    // blk.N.ffn_gate.weight
  struct ggml_tensor* ffn_up_w;      // blk.N.ffn_up.weight
  struct ggml_tensor* ffn_down_w;    // blk.N.ffn_down.weight
};

struct GrootTextWeights {
  struct ggml_tensor* token_embd_w;          // token_embd.weight
  struct ggml_tensor* output_norm_w;         // output_norm.weight
  std::vector<GrootTextBlockWeights> blocks; // 16 entries
  // `output.weight` (lm_head) exists in the GGUF but is never loaded —
  // GR00T only consumes hidden_states, never generates text.
};

// ── VL fusion: 4-layer plain-LayerNorm SelfAttentionTransformer ─────────

struct GrootVlfusionBlockWeights {
  struct ggml_tensor* norm1_w; // vlfusion.blk.N.norm1.weight
  struct ggml_tensor* norm1_b;
  struct ggml_tensor* norm3_w; // vlfusion.blk.N.norm3.weight
  struct ggml_tensor* norm3_b;
  struct ggml_tensor* attn_q_w;
  struct ggml_tensor* attn_q_b;
  struct ggml_tensor* attn_k_w;
  struct ggml_tensor* attn_k_b;
  struct ggml_tensor* attn_v_w;
  struct ggml_tensor* attn_v_b;
  struct ggml_tensor* attn_out_w;
  struct ggml_tensor* attn_out_b;
  struct ggml_tensor* ffn_in_w; // net.0.proj — single (non-gated)
                                // GELU-approximate, dim -> 4*dim
  struct ggml_tensor* ffn_in_b;
  struct ggml_tensor* ffn_out_w; // net.2 — 4*dim -> dim
  struct ggml_tensor* ffn_out_b;
};

struct GrootVlfusionWeights {
  struct ggml_tensor* vlln_w; // vlfusion.vlln.weight — plain LayerNorm on
                              // backbone_embedding_dim
  struct ggml_tensor* vlln_b;
  std::vector<GrootVlfusionBlockWeights> blocks; // 4 entries
};

// ── DiT (AlternateVLDiT): 32 alternating self-/cross-attention blocks ───
// Even blocks (0,2,4,...) cross-attend to backbone(+vlfusion) features,
// alternating between text-token-only and image-token-only attention masks
// every `attend_text_every_n_blocks` cross-attn blocks. Odd blocks are
// plain self-attention. All blocks use AdaLayerNorm (timestep-conditioned).

struct GrootDitBlockWeights {
  struct ggml_tensor* norm1_linear_w; // dit.blk.N.norm1_linear.weight —
                                      // AdaLayerNorm's SiLU+Linear -> (2*dim,)
  struct ggml_tensor* norm1_linear_b;
  struct ggml_tensor* attn_q_w;
  struct ggml_tensor* attn_q_b;
  struct ggml_tensor*
      attn_k_w; // cross-attn blocks: (dim, backbone_embedding_dim); self-attn:
                // (dim, dim)
  struct ggml_tensor* attn_k_b;
  struct ggml_tensor* attn_v_w;
  struct ggml_tensor* attn_v_b;
  struct ggml_tensor* attn_out_w;
  struct ggml_tensor* attn_out_b;
  struct ggml_tensor* ffn_in_w;
  struct ggml_tensor* ffn_in_b;
  struct ggml_tensor* ffn_out_w;
  struct ggml_tensor* ffn_out_b;
};

struct GrootDitWeights {
  struct ggml_tensor*
      timestep_embedder_l1_w; // dit.timestep_embedder.linear_1.weight
                              // — (256 -> dim)
  struct ggml_tensor* timestep_embedder_l1_b;
  struct ggml_tensor*
      timestep_embedder_l2_w; // dit.timestep_embedder.linear_2.weight
                              // — (dim -> dim)
  struct ggml_tensor* timestep_embedder_l2_b;
  std::vector<GrootDitBlockWeights> blocks; // 32 entries
  struct ggml_tensor* proj_out_1_w; // dit.proj_out_1.weight — (dim -> 2*dim),
                                    // final AdaLN shift/scale
  struct ggml_tensor* proj_out_1_b;
  struct ggml_tensor*
      proj_out_2_w; // dit.proj_out_2.weight — (dim -> output_dim)
  struct ggml_tensor* proj_out_2_b;
  struct ggml_tensor*
      position_embedding_w; // dit.position_embedding.weight —
                            // (input_embedding_dim, max_seq_len)
};

// ── Embodiment-conditioned encode/decode, sliced to one embodiment ──────
// Each is a plain 2-layer MLP now (category dim already indexed out at
// conversion time) — no runtime embodiment-ID branching.

struct GrootLinearWeights {
  struct ggml_tensor* weight; // [in, out] layout (CategorySpecificLinear does x
                              // @ W, not nn.Linear's W @ x)
  struct ggml_tensor* bias;
};

struct GrootEmbodimentWeights {
  GrootLinearWeights state_encoder_layer1; // embodiment.state_encoder.layer1 —
                                           // (max_state_dim -> hidden_size)
  GrootLinearWeights
      state_encoder_layer2; // embodiment.state_encoder.layer2 — (hidden_size ->
                            // input_embedding_dim)
  GrootLinearWeights
      action_encoder_w1; // embodiment.action_encoder.w1 — (max_action_dim ->
                         // input_embedding_dim)
  GrootLinearWeights
      action_encoder_w2; // embodiment.action_encoder.w2 —
                         // (2*input_embedding_dim -> input_embedding_dim)
  GrootLinearWeights
      action_encoder_w3; // embodiment.action_encoder.w3 — (input_embedding_dim
                         // -> input_embedding_dim)
  GrootLinearWeights action_decoder_layer1; // embodiment.action_decoder.layer1
                                            // — (dit_output_dim -> hidden_size)
  GrootLinearWeights action_decoder_layer2; // embodiment.action_decoder.layer2
                                            // — (hidden_size -> max_action_dim)
};

// ── Sub-graph helpers (milestone-testable) ─────────────────────────────
// Each graph builder has a standalone entry point so the matching GoogleTest
// can drive it against Phase 0 oracle activations without going through
// GrootModel::infer. Implementations in groot.cpp; tests
// test/unit/test_groot_m*.

// M4.1 — VL fusion: vlln (plain LayerNorm) then a 4-layer plain-LayerNorm
// SelfAttentionTransformer (diffusers BasicTransformerBlock, self-attn only,
// GELU-approx FFN; no cross-attn/AdaLN/pos-embeds). Bidirectional (unmasked).
//
// `backboneFeatures` ne=[dim=2048, nTokens=280], byte-equivalent to oracle
// numpy (280, 2048) `backbone_features`. Outputs match `vlln_output` and
// `vl_self_attention_output`.
struct GrootVlfusionOutputs {
  struct ggml_tensor* vlln_out;   // LayerNorm(backboneFeatures)
  struct ggml_tensor* fusion_out; // 4-block transformer over vlln_out
};

GrootVlfusionOutputs grootBuildVlfusionGraph(
    struct ggml_context* ctx, struct ggml_tensor* backboneFeatures,
    const GrootVlfusionWeights& w, int nTokens, int dim, int nHeads,
    int headDim, float layerNormEps);

// M4.2 — timestep encoder + embodiment-conditioned MLPs.
//
// Timestep encoder (DiT.timestep_encoder): diffusers Timesteps(256,
// flip_sin_to_cos=True, downscale_freq_shift=1) → TimestepEmbedding
// (Linear 256→1536, SiLU, Linear 1536→1536). Sinusoidal projection is a fixed
// function of the integer-bucket timestep, so computed CPU-side; learned MLP
// runs in the graph.
//
// `t` = discretized bucket `int((step/num_inference_timesteps) *
// num_timestep_buckets)`. Fills `out[channels]` (channels=256) in diffusers
// layout [cos block | sin block] (flip_sin_to_cos), freqs = t ·
// exp(-ln(10000)·i/(channels/2 − 1)).
void grootComputeTimestepProj(float t, int channels, float* out);

// TimestepEmbedding is Linear→SiLU→Linear (no activation on the input
// projection). Produces ne=[embedding_dim=1536].
struct ggml_tensor* grootBuildTimestepMlpGraph(
    struct ggml_context* ctx, struct ggml_tensor* proj, struct ggml_tensor* l1W,
    struct ggml_tensor* l1B, struct ggml_tensor* l2W, struct ggml_tensor* l2B);

// SinusoidalPositionalEncoding for the action encoder's timestep term
// (embodiment_conditioned_mlp.py): half_dim = dim/2, freqs = t · exp(-ln(10000)
// · i/half_dim), out = [sin block | cos block]. Same integer bucket `t`,
// broadcast across all action tokens (so it's one `dim`-vector). Distinct from
// the DiT timestep encoder above (different freq denominator and sin/cos
// order).
void grootComputeActionTauEnc(float t, int dim, float* out);

// CategorySpecificMLP: Linear1 → ReLU → Linear2. The `x @ W` weight layout
// (see grootBuildEmbodimentLinear) is handled internally. Input ne=[inDim,
// nTokens]; output ne=[outDim, nTokens].
// weightsPreTransposed: the layer weights are already stored [in,out] (see
// grootMaterializeTransposedWeights), so skip grootLinearXW's runtime
// transpose.
struct ggml_tensor* grootBuildCategoryMlpGraph(
    struct ggml_context* ctx, struct ggml_tensor* x,
    const GrootLinearWeights& layer1, const GrootLinearWeights& layer2,
    bool weightsPreTransposed = false);

// MultiEmbodimentActionEncoder: a=W1(actions); x=swish(W2(cat[a, tauEnc]));
// out=W3(x). `tauEnc` is the precomputed action-tau sinusoidal (ne=[hidden])
// broadcast across tokens. Input `actions` ne=[actionDim, nTokens]; output
// ne=[hidden, nTokens].
struct ggml_tensor* grootBuildActionEncoderGraph(
    struct ggml_context* ctx, struct ggml_tensor* actions,
    struct ggml_tensor* tauEnc, const GrootLinearWeights& w1,
    const GrootLinearWeights& w2, const GrootLinearWeights& w3, int hidden,
    int nTokens, bool weightsPreTransposed = false);

// M4.3 — DiT (AlternateVLDiT) block + full stack.
//
// One diffusers BasicTransformerBlock with AdaLayerNorm (norm_type=ada_norm,
// norm_elementwise_affine=False → both the AdaLN inner norm and norm3 have NO
// learnable affine; norm3 gets only its eps). Structure (dit.py):
//   temb_proj = norm1_linear(silu(temb)); scale, shift = temb_proj.chunk(2)
//   nh   = layernorm_noaffine(x) * (1 + scale) + shift        # AdaLayerNorm
//   attn = attn1(nh, encoder_hidden_states|None, key_mask|None)
//   h    = attn + x
//   nh3  = layernorm_noaffine(h)
//   h    = ff(nh3) + h                                         # GELU-approx
//   FFN
// Even blocks cross-attend to `encoder` (280-token VL features,
// cross_attention_dim=2048) under `keyMask`; odd blocks self-attend. Attention
// is unfused F32 (41 queries × ≤280 keys is tiny, key-mask applies via
// soft_max_ext). scale = 1/sqrt(headDim).
//
// `x` ne=[dim, T]; `temb` ne=[dim] (the timestep embedding); `encoder`
// ne=[crossDim, S] or null; `keyMask` ne=[S, T] additive (0 attend / −inf
// masked) or null. Returns ne=[dim, T].
struct ggml_tensor* grootBuildDitBlockGraph(
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* temb,
    struct ggml_tensor* encoder, struct ggml_tensor* keyMask,
    const GrootDitBlockWeights& w, int nHeads, int headDim, int dim,
    int crossDim, int ffnInner, float eps);

// Full DiT: 32 alternating blocks (M4.3) then the output head — norm_out
// (LayerNorm no-affine, eps 1e-6) modulated by AdaLN from
// `proj_out_1(silu(temb))` then `proj_out_2`. Even/odd alternation and the
// text/image cross-attn key-mask flipping per `attendTextEveryN` are handled
// internally. `imageKeyMask` / `textKeyMask` are the two prebuilt additive
// masks (ne=[S, T]); even blocks use text on `idx % (2*attendTextEveryN) == 0`
// else image.
//
// `hidden` ne=[dim, T]; `temb` ne=[dim]; `encoder` ne=[crossDim, S]. If
// `outBlocks` is non-null it's filled with the T-per-block hidden states (for
// the milestone test). Returns the model output ne=[outputDim, T].
struct ggml_tensor* grootBuildDitGraph(
    struct ggml_context* ctx, struct ggml_tensor* hidden,
    struct ggml_tensor* temb, struct ggml_tensor* encoder,
    struct ggml_tensor* imageKeyMask, struct ggml_tensor* textKeyMask,
    const GrootDitWeights& w, int nLayers, int nHeads, int headDim, int dim,
    int crossDim, int ffnInner, int outputDim, int attendTextEveryN, float eps,
    std::vector<struct ggml_tensor*>* outBlocks);

// M4.5 — Qwen3-VL text decoder (backbone language side), truncated to 16
// layers. Ported from qvac-fabric-llm.cpp/src/models/qwen3vl.cpp: RMSNorm,
// per-head Q/K RMSNorm before RoPE, interleaved M-RoPE (GGML_ROPE_TYPE_IMROPE,
// rope_sections=[24,20,20,0]), GQA (nHead/nHeadKv), causal attention, SwiGLU
// FFN. `backbone_features` (GR00T's Qwen3Backbone output, select_layer=16) is
// the RAW residual stream after all 16 layers — NO final output_norm applied
// (verified: the oracle's post-norm hidden_states.16 diverges cos 0.11 from
// backbone_features, whereas the pre-norm residual matches). So output_norm_w
// is intentionally unused here.
//
// `inputsEmbeds` ne=[dim=2048, T=280] — text token embeds with the 256 image
// embeds already spliced in (matches oracle text_model_input.inputs_embeds).
// `positions` ne=[T*4] i32 — the 4 M-RoPE position blocks [axis0|axis1|axis2|
// axis3] (axis3 unused, width-0 section). `mask` ne=[T, T] additive causal
// (0 attend / −inf). `deepstack` holds 3 tensors ne=[dim, T] (deepstack visual
// features scattered to image-token positions, zero elsewhere) added to the
// residual after layers 0/1/2; entries may be null to skip. Returns ne=[dim,
// T].
struct ggml_tensor* grootBuildTextDecoderGraph(
    struct ggml_context* ctx, struct ggml_tensor* inputsEmbeds,
    struct ggml_tensor* positions, struct ggml_tensor* mask,
    const std::vector<struct ggml_tensor*>& deepstack,
    const GrootTextWeights& w, int nLayers, int nTokens, int nHead, int nHeadKv,
    int headDim, int ffnLen, float ropeFreqBase, const int ropeSections[4],
    float rmsEps);

// M4.5 (vision) — reconstruct the Qwen3-VL patch embedding as a plain Linear
// weight ne=[inFlat, nEmbd] from the two temporal-split Conv2D halves the
// converter emitted (v.patch_embd.weight / v.patch_embd.weight.1). GR00T's
// processor feeds already-flattened patches ([nPatches, inFlat] with inFlat =
// inChannels·temporalPatch·patchSize²), so the Conv3D patch embed collapses to
// a matmul. Flatten order is HF's `view(-1, C, T, ph, pw)` → index
// ((c·T + t)·P + ph)·P + pw. Allocates the result in `ctx` (needs data, i.e.
// no_alloc=false). Returns nullptr on shape mismatch.
struct ggml_tensor* grootBuildPatchEmbedLinear(
    struct ggml_context* ctx, const struct ggml_tensor* conv0,
    const struct ggml_tensor* conv1, int nEmbd, int inChannels,
    int temporalPatch, int patchSize);

// M4.5 (vision) — Qwen3-VL vision tower. Ported from qvac-fabric-llm.cpp/
// tools/mtmd/models/qwen3vl.cpp, adapted for GR00T's fixed multi-image fixture
// (flattened patch input instead of raw-pixel Conv2D; nImages processed in one
// graph with block-diagonal per-image attention instead of one image per
// graph). LayerNorm (weight+bias) blocks, fused QKV, vision M-RoPE
// (GGML_ROPE_TYPE_VISION), single (non-gated) GELU FFN. Learned position
// embeddings are bilinear-interpolated from the √numPosEmbd base grid to the
// actual grid, reordered into 2×2-merge sequence order, and tiled per image.
//
// `patchInput` ne=[inFlat, nPatches]; `patchWLin` from
// grootBuildPatchEmbedLinear; `positionEmbd` = raw v.position_embd.weight
// ne=[nEmbd, numPosEmbd]; `positions` ne=[nPatches*4] i32 vision M-RoPE ids;
// `mask` ne=[nPatches, nPatches] additive (0/−inf) block-diagonal per image.
// Returns the merged image embeds ne=[outHidden, nPatches/merge²] (== oracle
// vision_output.0). If `outDeepstack` is non-null it's filled with the 3
// deepstack feature maps (== vision_output.1.*).
//
// `hostCtx` is where the host-computed position-embedding leaf (needs its data
// written at build time) is allocated; when null it falls back to `ctx`. Pass
// a separate no_alloc=false ctx so `ctx` itself can be a no_alloc=true graph
// context fed to `ggml_gallocr` (lifetime-reuse of the transformer
// intermediates — the mobile memory lever). Tests pass a single no_alloc=false
// ctx and leave `hostCtx` null.
struct ggml_tensor* grootBuildVisionGraph(
    struct ggml_context* ctx, struct ggml_tensor* patchInput,
    struct ggml_tensor* patchWLin, struct ggml_tensor* patchBias,
    struct ggml_tensor* positionEmbd, struct ggml_tensor* positions,
    struct ggml_tensor* mask, const GrootVisionWeights& w, int nImages,
    int gridH, int gridW, int nEmbd, int nHead, int headDim, int mergeSize,
    int numPosEmbd, int outHidden, float eps, float ropeFreqBase,
    const std::vector<int>& deepstackIndexes,
    std::vector<struct ggml_tensor*>* outDeepstack,
    std::vector<struct ggml_tensor*>* outBlocks = nullptr,
    struct ggml_context* hostCtx = nullptr,
    struct ggml_tensor* precomputedPe = nullptr);

// Test hook — run a single vision block in isolation (feed an oracle block
// input, compare against the next block's oracle output) to separate per-block
// error from cross-layer accumulation of the bf16-reference noise.
struct ggml_tensor* grootBuildVisionBlockGraph(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* positions, struct ggml_tensor* mask,
    const GrootVisionBlockWeights& w, int nPos, int nEmbd, int nHead,
    int headDim, float eps, float ropeFreqBase);

// Derive Qwen3-VL 3-axis M-RoPE position ids C++-side for the fixed GR00T
// fixture (option b — no IVlaModel extension). `tokens` is the length-`nTokens`
// prompt; contiguous runs of `imageTokenId` are treated as `gh`×`gw` merged-
// patch image grids. Fills `out` (length `nTokens*4`, axis-major
// [axis0|axis1|axis2|axis3]) following HF `get_rope_index`: text tokens advance
// all axes by one from the running max; image tokens share a temporal id and
// fan out spatially. axis3 (unused width-0 rope section) is left zero. Verified
// against oracle text_model_input.position_ids (test_groot_m4_7_positions.cpp).
void grootDeriveMRopePositions(
    const int32_t* tokens, int nTokens, int imageTokenId, int gh, int gw,
    int32_t* out);

// Forward-declared PIMPL (defined in groot.cpp) so the public header doesn't
// drag in backend handles / ggml contexts. Out-of-line dtor, as in Pi05Model.
struct GrootModelInternal;

class GrootModel final : public IVlaModel {
public:
  // Throws std::runtime_error if the GGUF is missing required tensors, the
  // architecture key isn't `groot`, or hparams fail validation. `forceCpu`
  // skips GPU device selection; `backendsDir` is the absolute path to the
  // prebuild directory containing the ggml backend plugin shared libs.
  GrootModel(
      const std::string& ggufPath, bool forceCpu,
      const std::string& backendsDir);

  ~GrootModel() override;

  GrootModel(const GrootModel&) = delete;
  GrootModel& operator=(const GrootModel&) = delete;

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
  std::unique_ptr<GrootModelInternal> impl_;
};

} // namespace qvac_lib_infer_vla_ggml
