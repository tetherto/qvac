#include "model-interface/pi05.hpp"

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
