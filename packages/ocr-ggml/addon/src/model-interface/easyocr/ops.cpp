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

} // namespace

// NOLINTBEGIN(bugprone-easily-swappable-parameters)
::ggml_tensor* conv_2d_bias(
    ::ggml_context* ctx, ::ggml_tensor* x, ::ggml_tensor* kernel,
    ::ggml_tensor* bias, int s0, int s1, int p0, int p1, int d0, int d1) {
  // NOLINTEND(bugprone-easily-swappable-parameters)
  auto* y = ggml_conv_2d(ctx, kernel, x, s0, s1, p0, p1, d0, d1);
  return add_channel_bias(ctx, y, bias);
}

::ggml_tensor* conv_2d_bias_relu(
    ::ggml_context* ctx, ::ggml_tensor* x, ::ggml_tensor* kernel,
    ::ggml_tensor* bias, int s0, int s1, int p0, int p1, int d0, int d1) {
  return ggml_relu(
      ctx, conv_2d_bias(ctx, x, kernel, bias, s0, s1, p0, p1, d0, d1));
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
