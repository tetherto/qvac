#include "craft.hpp"

#include "craft_weights.hpp"
#include "ggml.h"
#include "ops.hpp"

// NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,readability-identifier-naming,readability-identifier-length)
// CRAFT graph builder uses snake_case identifiers matching upstream
// PyTorch state-dict (basenet, conv_cls, upconv) and single-letter math
// identifiers (x, t, W, b).

namespace easyocr::ggml {

namespace {

inline ::ggml_tensor* relu(::ggml_context* ctx, ::ggml_tensor* x) {
  return ggml_relu(ctx, x);
}

inline ::ggml_tensor* maxpool_2x2(::ggml_context* ctx, ::ggml_tensor* x) {
  // kernel=2, stride=2, padding=0 (PyTorch nn.MaxPool2d(2, 2))
  return ggml_pool_2d(
      ctx,
      x,
      GGML_OP_POOL_MAX,
      /*k0=*/2,
      /*k1=*/2,
      /*s0=*/2,
      /*s1=*/2,
      /*p0=*/0.0F,
      /*p1=*/0.0F);
}

void tap(
    std::unordered_map<std::string, ::ggml_tensor*>* taps, const char* name,
    ::ggml_tensor* t) {
  if (taps != nullptr) {
    ggml_set_name(t, name);
    (*taps)[name] = t;
  }
}

// Apply a Conv -> (folded BN) -> ReLU triple from CRAFT's vgg16_bn backbone.
::ggml_tensor* conv_bn_relu(
    ::ggml_context* ctx, const CraftWeights& W, ::ggml_tensor* x,
    const char* path, int s, int p, int d) {
  return ops::conv_2d_bias_relu(
      ctx,
      x,
      W.w(path),
      W.b(path),
      s,
      s,
      p,
      p,
      d,
      d,
      W.conv1x1_mulmat(),
      W.use_direct_conv());
}

// Apply a Conv (no activation, no BN) — used in slice5 and conv_cls.
::ggml_tensor* conv_only(
    ::ggml_context* ctx, const CraftWeights& W, ::ggml_tensor* x,
    const char* path, int s, int p, int d) {
  return ops::conv_2d_bias(
      ctx,
      x,
      W.w(path),
      W.b(path),
      s,
      s,
      p,
      p,
      d,
      d,
      W.conv1x1_mulmat(),
      W.use_direct_conv());
}

// CRAFT's `double_conv(in, mid, out)`:
//   1x1 conv (in+mid -> mid) + folded BN + ReLU
//   3x3 conv (mid -> out)    + folded BN + ReLU
// `prefix` is e.g. "upconv1.conv".
::ggml_tensor* double_conv(
    ::ggml_context* ctx, const CraftWeights& W, ::ggml_tensor* x,
    const char* prefix0,   // ".0" — 1x1 conv
    const char* prefix3) { // ".3" — 3x3 conv
  auto* y = conv_bn_relu(ctx, W, x, prefix0, /*s=*/1, /*p=*/0, /*d=*/1);
  return conv_bn_relu(ctx, W, y, prefix3, /*s=*/1, /*p=*/1, /*d=*/1);
}

// Concatenate two NCHW maps along the channel axis.  In ggml's [W, H, C, N]
// layout that is ne[2] => dim 2.
::ggml_tensor*
cat_channels(::ggml_context* ctx, ::ggml_tensor* a, ::ggml_tensor* b) {
  return ggml_concat(ctx, a, b, /*dim=*/2);
}

} // namespace

::ggml_tensor* build_craft(
    ::ggml_context* ctx, const CraftWeights& W, ::ggml_tensor* x,
    std::unordered_map<std::string, ::ggml_tensor*>* taps) {

  // === basenet.slice1 ====================================================
  // Conv 3->64 + BN + ReLU
  auto* h = conv_bn_relu(ctx, W, x, "basenet.slice1.0", 1, 1, 1);
  // Conv 64->64 + BN + ReLU
  h = conv_bn_relu(ctx, W, h, "basenet.slice1.3", 1, 1, 1);
  // MaxPool 2x2
  h = maxpool_2x2(ctx, h);
  // Conv 64->128 + BN + ReLU
  h = conv_bn_relu(ctx, W, h, "basenet.slice1.7", 1, 1, 1);
  // Conv 128->128 + BN  (no trailing ReLU — slice1 ends at the BN; the
  // following ReLU is in slice2 at index 12)
  h = ops::conv_2d_bias(
      ctx,
      h,
      W.w("basenet.slice1.10"),
      W.b("basenet.slice1.10"),
      1,
      1,
      1,
      1,
      1,
      1,
      W.conv1x1_mulmat(),
      W.use_direct_conv());
  auto* sources_4 = h; // h_relu2_2 in PyTorch (post-BN, pre-ReLU)
  tap(taps, craft_taps::kBasenetSlice1, sources_4);

  // === basenet.slice2 ====================================================
  h = relu(ctx, h);        // slice2 idx 12: ReLU
  h = maxpool_2x2(ctx, h); // slice2 idx 13: MaxPool2d(2,2)
  h = conv_bn_relu(ctx, W, h, "basenet.slice2.14", 1, 1, 1);
  h = ops::conv_2d_bias(
      ctx,
      h,
      W.w("basenet.slice2.17"),
      W.b("basenet.slice2.17"),
      1,
      1,
      1,
      1,
      1,
      1,
      W.conv1x1_mulmat(),
      W.use_direct_conv());
  auto* sources_3 = h; // h_relu3_2
  tap(taps, craft_taps::kBasenetSlice2, sources_3);

  // === basenet.slice3 ====================================================
  h = relu(ctx, h);
  h = conv_bn_relu(ctx, W, h, "basenet.slice3.20", 1, 1, 1);
  h = maxpool_2x2(ctx, h);
  h = conv_bn_relu(ctx, W, h, "basenet.slice3.24", 1, 1, 1);
  h = ops::conv_2d_bias(
      ctx,
      h,
      W.w("basenet.slice3.27"),
      W.b("basenet.slice3.27"),
      1,
      1,
      1,
      1,
      1,
      1,
      W.conv1x1_mulmat(),
      W.use_direct_conv());
  auto* sources_2 = h; // h_relu4_3
  tap(taps, craft_taps::kBasenetSlice3, sources_2);

  // === basenet.slice4 ====================================================
  h = relu(ctx, h);
  h = conv_bn_relu(ctx, W, h, "basenet.slice4.30", 1, 1, 1);
  h = maxpool_2x2(ctx, h);
  h = conv_bn_relu(ctx, W, h, "basenet.slice4.34", 1, 1, 1);
  h = ops::conv_2d_bias(
      ctx,
      h,
      W.w("basenet.slice4.37"),
      W.b("basenet.slice4.37"),
      1,
      1,
      1,
      1,
      1,
      1,
      W.conv1x1_mulmat(),
      W.use_direct_conv());
  auto* sources_1 = h; // h_relu5_3
  tap(taps, craft_taps::kBasenetSlice4, sources_1);

  // === basenet.slice5 ====================================================
  // Special: nn.Sequential of (MaxPool k=3 s=1 p=1) -> Conv 512->1024 (k=3 d=6
  // p=6)
  //                          -> Conv 1024->1024 (k=1).  No BN, no ReLU.
  //
  // Important: there is NO ReLU between slice4's final BN (at idx 38) and
  // slice5's opening MaxPool.  The python `forward` calls
  // `h = self.slice5(self.slice4(...))` directly; slice5's nn.Sequential
  // starts with MaxPool. We feed slice4's output (post-BN, pre-ReLU) into
  // slice5's MaxPool unchanged.
  h = sources_1;
  h = ggml_pool_2d(
      ctx,
      h,
      GGML_OP_POOL_MAX,
      /*k0=*/3,
      /*k1=*/3,
      /*s0=*/1,
      /*s1=*/1,
      /*p0=*/1.0F,
      /*p1=*/1.0F);
  // Dilated Conv 512 -> 1024, k=3, p=6, d=6 (dilation 6 is part of the CRAFT
  // basenet.slice5.1 architecture spec; padding matches dilation to preserve
  // spatial resolution).
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
  h = conv_only(ctx, W, h, "basenet.slice5.1", /*s=*/1, /*p=*/6, /*d=*/6);
  // Conv 1024 -> 1024, k=1
  h = conv_only(ctx, W, h, "basenet.slice5.2", /*s=*/1, /*p=*/0, /*d=*/1);
  auto* sources_0 = h; // h_fc7
  tap(taps, craft_taps::kBasenetSlice5, sources_0);

  // === U-network =========================================================
  // Subtle PyTorch behaviour worth pinning here: in `vgg16_bn.forward` the
  // outputs `h_relu2_2`, `h_relu3_2`, `h_relu4_3` are aliases to buffers
  // that the *next* slice's opening `nn.ReLU(inplace=True)` mutates in
  // place.  By the time CRAFT's U-net runs, sources[2..4] are therefore
  // post-ReLU.  Sources[0] (h_fc7) and sources[1] (h_relu5_3) are NOT
  // mutated (slice5 starts with a non-in-place MaxPool) and stay pre-ReLU.
  //
  // We faithfully reproduce that here by applying ReLU to sources_4
  // (slice1), sources_3 (slice2) and sources_2 (slice3) before they enter
  // the cat ops, but leaving sources_1 (slice4) and sources_0 (slice5) as
  // they came out of the backbone.
  auto* s4_relu = relu(ctx, sources_4); // post slice2 in-place relu
  auto* s3_relu = relu(ctx, sources_3); // post slice3 in-place relu
  auto* s2_relu = relu(ctx, sources_2); // post slice4 in-place relu

  // Stage 1: cat(s0, s1) -> upconv1 (in=1024+512=1536, mid=512, out=256)
  auto* y = cat_channels(ctx, sources_0, sources_1);
  y = double_conv(ctx, W, y, "upconv1.conv.0", "upconv1.conv.3");
  tap(taps, craft_taps::kUpconv1, y);

  // Stage 2: interp(y, size=s2.spatial) -> cat(., relu(s2)) -> upconv2
  y = ops::bilinear_to(ctx, y, s2_relu->ne[0], s2_relu->ne[1]);
  tap(taps, craft_taps::kInterp2, y);
  y = cat_channels(ctx, y, s2_relu);
  tap(taps, craft_taps::kCat2, y);
  y = double_conv(ctx, W, y, "upconv2.conv.0", "upconv2.conv.3");
  tap(taps, craft_taps::kUpconv2, y);

  // Stage 3: interp -> cat(., relu(s3)) -> upconv3
  y = ops::bilinear_to(ctx, y, s3_relu->ne[0], s3_relu->ne[1]);
  y = cat_channels(ctx, y, s3_relu);
  y = double_conv(ctx, W, y, "upconv3.conv.0", "upconv3.conv.3");
  tap(taps, craft_taps::kUpconv3, y);

  // Stage 4: interp -> cat(., relu(s4)) -> upconv4 (== feature)
  y = ops::bilinear_to(ctx, y, s4_relu->ne[0], s4_relu->ne[1]);
  y = cat_channels(ctx, y, s4_relu);
  y = double_conv(ctx, W, y, "upconv4.conv.0", "upconv4.conv.3");
  auto* feature = y;
  tap(taps, craft_taps::kUpconv4, feature);

  // === conv_cls head =====================================================
  // Conv 32 -> 32, 3x3 + ReLU
  y = relu(ctx, conv_only(ctx, W, feature, "conv_cls.0", 1, 1, 1));
  // Conv 32 -> 32, 3x3 + ReLU
  y = relu(ctx, conv_only(ctx, W, y, "conv_cls.2", 1, 1, 1));
  // Conv 32 -> 16, 3x3 + ReLU
  y = relu(ctx, conv_only(ctx, W, y, "conv_cls.4", 1, 1, 1));
  // Conv 16 -> 16, 1x1 + ReLU
  y = relu(ctx, conv_only(ctx, W, y, "conv_cls.6", 1, 0, 1));
  // Conv 16 -> 2,  1x1 (no activation)
  y = conv_only(ctx, W, y, "conv_cls.8", 1, 0, 1);
  tap(taps, craft_taps::kConvCls, y);

  // === Permute NCHW -> NHWC (PyTorch: y.permute(0, 2, 3, 1)) =============
  // Input  ggml ne = [W, H, C=2, N=1]   (PyTorch [N, C, H, W])
  // Output ggml ne = [C=2, W, H, N=1]   (PyTorch [N, H, W, C])
  //
  // ggml_permute's contract: result.ne[axis[i]] = a.ne[i]. So for each
  // input axis i we say where it lands in the output.
  //   input axis 0 (W) -> output axis 1
  //   input axis 1 (H) -> output axis 2
  //   input axis 2 (C) -> output axis 0
  //   input axis 3 (N) -> output axis 3
  auto* nhwc =
      ggml_permute(ctx, y, /*axis0=*/1, /*axis1=*/2, /*axis2=*/0, /*axis3=*/3);
  // ggml_permute returns a non-contiguous view; the test harness reading
  // this back will need contiguous memory.
  nhwc = ggml_cont(ctx, nhwc);
  tap(taps, craft_taps::kOutputNhwc, nhwc);

  return nhwc;
}

} // namespace easyocr::ggml

// NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,readability-identifier-naming,readability-identifier-length)
