#pragma once

// Small, reusable op helpers used to build the CRAFT compute graph.  Every
// helper takes a graph-building ggml_context and returns a new ggml_tensor
// node.  Tensors live in the caller's context; callers should drive
// allocation/compute via a backend scheduler.

#include <cstdint>

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length)
struct ggml_context;
struct ggml_tensor;
// Op helpers use math-style parameter names (x, kernel, bias, KW, KH, IC,
// OC) that mirror the ggml C-API documentation.

namespace easyocr::ggml::ops {

// 2D convolution + bias add + (optional) ReLU.
//
// Input layout follows ggml's NCHW-with-W-innermost convention:
//   x      [W,  H,  IC, N]   — input feature map
//   kernel [KW, KH, IC, OC]  — already in ggml order (== PyTorch shape
//   reversed) bias   [OC]              — per-output-channel offset (folded into
//   pre-bn
//                              when the source layer was `Conv -> BN`)
//
// Returns a tensor of shape [W_out, H_out, OC, N].
//
// Conv-path selection (both flags resolved backend-aware at model-load time;
// see kernel_precision.hpp):
//   - `conv1x1_mulmat` true: a pointwise (1x1, stride-1, no-pad) conv is
//     rewritten as a direct ggml_mul_mat (skips im2col).
//   - else `use_direct_conv` true: the conv runs through ggml_conv_2d_direct
//     (fused GGML_OP_CONV_2D) — faster than im2col on OpenCL/Adreno.
//   - else: ggml_conv_2d (im2col + mul_mat), the default on CPU/Vulkan/Metal.
::ggml_tensor* conv_2d_bias(
    ::ggml_context* ctx, ::ggml_tensor* x, ::ggml_tensor* kernel,
    ::ggml_tensor* bias, int s0, int s1, int p0, int p1, int d0, int d1,
    bool conv1x1_mulmat, bool use_direct_conv);

::ggml_tensor* conv_2d_bias_relu(
    ::ggml_context* ctx, ::ggml_tensor* x, ::ggml_tensor* kernel,
    ::ggml_tensor* bias, int s0, int s1, int p0, int p1, int d0, int d1,
    bool conv1x1_mulmat, bool use_direct_conv);

// Bilinear interpolation to the spatial size (W_target, H_target), preserving
// channels and batch.  Mirrors `F.interpolate(..., mode="bilinear",
// align_corners=False)` — the default in CRAFT's U-net.
::ggml_tensor* bilinear_to(
    ::ggml_context* ctx, ::ggml_tensor* x, int64_t W_target, int64_t H_target);

} // namespace easyocr::ggml::ops

// NOLINTEND(readability-identifier-naming,readability-identifier-length)
