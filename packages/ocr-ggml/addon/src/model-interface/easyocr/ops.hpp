#pragma once

// Small, reusable op helpers used to build the CRAFT compute graph.  Every
// helper takes a graph-building ggml_context and returns a new ggml_tensor
// node.  Tensors live in the caller's context; callers should drive
// allocation/compute via a backend scheduler.

#include <cstdint>

struct ggml_context;
struct ggml_tensor;

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
::ggml_tensor* conv_2d_bias(
    ::ggml_context* ctx, ::ggml_tensor* x, ::ggml_tensor* kernel,
    ::ggml_tensor* bias, int s0, int s1, int p0, int p1, int d0, int d1);

::ggml_tensor* conv_2d_bias_relu(
    ::ggml_context* ctx, ::ggml_tensor* x, ::ggml_tensor* kernel,
    ::ggml_tensor* bias, int s0, int s1, int p0, int p1, int d0, int d1);

// Bilinear interpolation to the spatial size (W_target, H_target), preserving
// channels and batch.  Mirrors `F.interpolate(..., mode="bilinear",
// align_corners=False)` — the default in CRAFT's U-net.
::ggml_tensor* bilinear_to(
    ::ggml_context* ctx, ::ggml_tensor* x, int64_t W_target, int64_t H_target);

} // namespace easyocr::ggml::ops
