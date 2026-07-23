#include "ops.hpp"

#include <cstdlib>
#include <cstring>

#include "ggml.h"

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length)
// Op helpers use math-style parameter names (x, OC, s0..s1, p0..p1, d0..d1,
// W_target, H_target) that mirror the ggml C-API documentation.

namespace easyocr::ggml::ops {

namespace {

// Escape hatch (OCR_GGML_CRAFT_BIAS_REPEAT=1): fall back to the legacy
// ggml_repeat broadcast for the channel bias. The default adds the [1,1,OC,1]
// bias via ggml_add's implicit broadcast (ggml_can_repeat), which the
// CPU/Vulkan/Metal kernels all implement — numerically identical to the repeat
// path while saving a materialised [W,H,OC,N] buffer + an op per conv (verified
// equal on CPU, NVIDIA Vulkan, and Apple Metal; ~8-15% faster on CPU). The
// lever exists only to recover without a code change if some backend's
// broadcast-add ever misbehaves. Read via getenv at graph-build time (not a hot
// path) so a single-process test can toggle it.
bool bias_use_repeat() {
  const char* v = std::getenv("OCR_GGML_CRAFT_BIAS_REPEAT");
  return v != nullptr && std::strcmp(v, "1") == 0;
}

// Add a [OC] bias to a [W, H, OC, N] activation map. By default we rely on
// ggml_add's implicit broadcast (no ggml_repeat); the escape-hatch env forces
// the legacy materialised-repeat path.
::ggml_tensor* add_channel_bias(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    ::ggml_context* ctx, ::ggml_tensor* x, ::ggml_tensor* bias) {
  const int64_t oc = bias->ne[0];
  auto* b4 = ggml_reshape_4d(ctx, bias, 1, 1, oc, 1);
  if (bias_use_repeat()) {
    return ggml_add(ctx, x, ggml_repeat(ctx, b4, x));
  }
  return ggml_add(ctx, x, b4);
}

// True for a pointwise (1x1) conv with unit stride/dilation and no padding —
// the only case where the mul_mat rewrite is exactly equivalent to conv_2d.
bool is_pointwise_conv(
    const ::ggml_tensor* kernel, int s0, int s1, int p0, int p1, int d0,
    int d1) {
  return kernel->ne[0] == 1 && kernel->ne[1] == 1 && s0 == 1 && s1 == 1 &&
         p0 == 0 && p1 == 0 && d0 == 1 && d1 == 1;
}

// 1x1 convolution as a matmul. x [W,H,IC,N], kernel [1,1,IC,OC] -> [W,H,OC,N].
// Channels are moved to dim 0 (mul_mat contracts dim 0), the spatial+batch dims
// ride along as the matmul's column/batch axes, and the result is permuted back
// to ggml's [W,H,C,N] layout. Works with F16 kernels (mul_mat upcasts).
::ggml_tensor*
pointwise_conv(::ggml_context* ctx, ::ggml_tensor* x, ::ggml_tensor* kernel) {
  const int64_t w = x->ne[0];
  const int64_t h = x->ne[1];
  const int64_t ic = x->ne[2];
  const int64_t n = x->ne[3];
  const int64_t oc = kernel->ne[3];
  auto* k2 = ggml_reshape_2d(ctx, kernel, ic, oc);             // [IC, OC]
  auto* xt = ggml_cont(ctx, ggml_permute(ctx, x, 1, 2, 0, 3)); // [IC, W, H, N]
  auto* x2 = ggml_reshape_3d(ctx, xt, ic, w * h, n);           // [IC, W*H, N]
  auto* y = ggml_mul_mat(ctx, k2, x2);                         // [OC, W*H, N]
  auto* y4 = ggml_reshape_4d(ctx, y, oc, w, h, n);             // [OC, W, H, N]
  return ggml_cont(ctx, ggml_permute(ctx, y4, 2, 0, 1, 3));    // [W, H, OC, N]
}

} // namespace

// NOLINTBEGIN(bugprone-easily-swappable-parameters)
::ggml_tensor* conv_2d_bias(
    ::ggml_context* ctx, ::ggml_tensor* x, ::ggml_tensor* kernel,
    ::ggml_tensor* bias, int s0, int s1, int p0, int p1, int d0, int d1,
    bool conv1x1_mulmat, bool use_direct_conv) {
  // NOLINTEND(bugprone-easily-swappable-parameters)
  ::ggml_tensor* y = nullptr;
  if (conv1x1_mulmat && is_pointwise_conv(kernel, s0, s1, p0, p1, d0, d1)) {
    // 1x1 stride-1 conv as a plain matmul (skips im2col).
    y = pointwise_conv(ctx, x, kernel);
  } else if (use_direct_conv) {
    // Fused GGML_OP_CONV_2D — faster than im2col on OpenCL/Adreno.
    y = ggml_conv_2d_direct(ctx, kernel, x, s0, s1, p0, p1, d0, d1);
  } else {
    // Default: im2col + mul_mat (best on CPU/Vulkan/Metal).
    y = ggml_conv_2d(ctx, kernel, x, s0, s1, p0, p1, d0, d1);
  }
  return add_channel_bias(ctx, y, bias);
}

::ggml_tensor* conv_2d_bias_relu(
    ::ggml_context* ctx, ::ggml_tensor* x, ::ggml_tensor* kernel,
    ::ggml_tensor* bias, int s0, int s1, int p0, int p1, int d0, int d1,
    bool conv1x1_mulmat, bool use_direct_conv) {
  return ggml_relu(
      ctx,
      conv_2d_bias(
          ctx,
          x,
          kernel,
          bias,
          s0,
          s1,
          p0,
          p1,
          d0,
          d1,
          conv1x1_mulmat,
          use_direct_conv));
}

::ggml_tensor* bilinear_to(
    ::ggml_context* ctx, ::ggml_tensor* x, int64_t W_target, int64_t H_target) {
  // PyTorch's `F.interpolate(..., mode='bilinear', align_corners=False)`
  // (the CRAFT U-net default) corresponds to ggml's BILINEAR mode WITHOUT
  // the ALIGN_CORNERS flag.  ggml's flag-driven coord formula matches
  // PyTorch's `align_corners=False`:
  //     src = (dst + 0.5) * (src_size / dst_size) - 0.5
  return ggml_interpolate(
      ctx,
      x,
      W_target,
      H_target,
      x->ne[2],
      x->ne[3],
      static_cast<uint32_t>(GGML_SCALE_MODE_BILINEAR));
}

} // namespace easyocr::ggml::ops

// NOLINTEND(readability-identifier-naming,readability-identifier-length)
