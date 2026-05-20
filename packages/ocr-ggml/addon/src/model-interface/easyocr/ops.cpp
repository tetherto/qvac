#include "ops.hpp"

#include "ggml.h"

namespace easyocr::ggml::ops {

namespace {

// Add a [OC] bias to a [W, H, OC, N] activation map. We explicitly broadcast
// via ggml_repeat (matching the pattern used in ggml's own yolo example) to
// avoid relying on implicit broadcast semantics in ggml_add.
::ggml_tensor* add_channel_bias(::ggml_context* ctx,
                                ::ggml_tensor* x,
                                ::ggml_tensor* bias) {
    const int64_t oc = bias->ne[0];
    auto* b4 = ggml_reshape_4d(ctx, bias, 1, 1, oc, 1);
    return ggml_add(ctx, x, ggml_repeat(ctx, b4, x));
}

}  // namespace

::ggml_tensor* conv_2d_bias(::ggml_context* ctx,
                            ::ggml_tensor* x,
                            ::ggml_tensor* kernel,
                            ::ggml_tensor* bias,
                            int s0, int s1,
                            int p0, int p1,
                            int d0, int d1) {
    auto* y = ggml_conv_2d(ctx, kernel, x, s0, s1, p0, p1, d0, d1);
    return add_channel_bias(ctx, y, bias);
}

::ggml_tensor* conv_2d_bias_relu(::ggml_context* ctx,
                                 ::ggml_tensor* x,
                                 ::ggml_tensor* kernel,
                                 ::ggml_tensor* bias,
                                 int s0, int s1,
                                 int p0, int p1,
                                 int d0, int d1) {
    return ggml_relu(ctx, conv_2d_bias(ctx, x, kernel, bias,
                                       s0, s1, p0, p1, d0, d1));
}

::ggml_tensor* bilinear_to(::ggml_context* ctx,
                           ::ggml_tensor* x,
                           int64_t W_target,
                           int64_t H_target) {
    // PyTorch's `F.interpolate(..., mode='bilinear', align_corners=False)`
    // (the CRAFT U-net default) corresponds to ggml's BILINEAR mode WITHOUT
    // the ALIGN_CORNERS flag.  ggml's flag-driven coord formula matches
    // PyTorch's `align_corners=False`:
    //     src = (dst + 0.5) * (src_size / dst_size) - 0.5
    return ggml_interpolate(ctx, x,
                            W_target, H_target, x->ne[2], x->ne[3],
                            static_cast<uint32_t>(GGML_SCALE_MODE_BILINEAR));
}

}  // namespace easyocr::ggml::ops
