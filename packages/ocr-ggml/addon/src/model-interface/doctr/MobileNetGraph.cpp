#include "MobileNetGraph.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml.h>
#include <gguf.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/easyocr/pipeline/qlog.hpp"

// NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,readability-identifier-naming,readability-identifier-length)
// MobileNet weight loaders and graph builders use single-letter math
// identifiers, snake_case state-dict paths mirroring upstream PyTorch,
// architecture-defined layer-dim magic numbers, and raw pointer/array
// access on ggml tensor `ne[]` dimension arrays and float buffers.

namespace qvac_lib_infer_ggml_classification::graph {

namespace {

using qvac_errors::StatusError;
using qvac_errors::general_error::InternalError;
using qvac_errors::general_error::InvalidArgument;

[[noreturn]] void raise(const std::string& msg) {
  throw StatusError(InternalError, msg);
}

[[noreturn]] void raiseInvalid(const std::string& msg) {
  throw StatusError(InvalidArgument, msg);
}

// Sizing constants for the weights / graph ggml contexts and the upper
// bound passed to ggml_new_graph_custom. Deliberately oversized; the real
// MobileNet+FPN footprint stays well below them.
constexpr int kCtxTensorOverhead = 4096;
constexpr int kMaxGraphNodes = 8192;

// FPN feature-tap indices: blocks 3, 6, 12 produce the three lateral inputs
// to the FPN (matches torchvision's MobileNetV3-Large feature-extractor).
constexpr int kFpnFeatureTap1 = 3;
constexpr int kFpnFeatureTap2 = 6;
constexpr int kFpnFeatureTap3 = 12;

void printGgufMetadataKeys(const gguf_context* gguf) {
  if (gguf == nullptr) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "[MobileNetGraph] GGUF context is null; cannot print metadata keys");
    return;
  }

  const int64_t metadataCount = gguf_get_n_kv(gguf);
  std::ostringstream os;
  os << "[MobileNetGraph] GGUF metadata keys (" << metadataCount << "):";
  for (int64_t i = 0; i < metadataCount; ++i) {
    const char* key = gguf_get_key(gguf, i);
    os << ' ' << (key != nullptr ? key : "<null>");
  }
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, os.str());
}

/// Tensors whose first dim is F16 are treated as storage-only; everything
/// used in runtime math (BN-folded scale/shift, FC weights) is kept as F32
/// to avoid per-layer cast operations inside the compute graph.

/// Convert a raw FP16 weight buffer to FP32 into `out`.
void fp16ToFp32(const void* src, float* out, size_t count) {
  const auto* halfPtr = static_cast<const ggml_fp16_t*>(src);
  for (size_t i = 0; i < count; ++i) {
    out[i] = ggml_fp16_to_fp32(halfPtr[i]);
  }
}

/// Copy a GGUF tensor's bytes into a freshly allocated ggml tensor attached
/// to `bundleCtx`, reusing the original dtype and shape. Returns the new
/// tensor pointer.
struct ggml_tensor* cloneRaw(
    struct ggml_context* bundleCtx, const gguf_context* ggufCtx,
    struct ggml_context* ggmlCtx, const char* name) {
  const int64_t idx = gguf_find_tensor(ggufCtx, name);
  if (idx < 0) {
    raise(std::string("Missing tensor in GGUF: ") + name);
  }
  struct ggml_tensor* src = ggml_get_tensor(ggmlCtx, name);
  if (src == nullptr) {
    raise(std::string("Cannot resolve tensor from ggml ctx: ") + name);
  }
  struct ggml_tensor* dst = ggml_new_tensor(
      bundleCtx,
      src->type,
      ggml_n_dims(src),
      src->ne); // NOLINT(hicpp-no-array-decay) - ggml struct member is C array
  ggml_set_name(dst, name);
  return dst;
}

/// Same as cloneRaw but forces the destination dtype to F32 (used for BN
/// scale/shift and classifier weights promoted at load time).
struct ggml_tensor* cloneAsFp32(
    struct ggml_context* bundleCtx, const char* name, int n_dims,
    const int64_t* ne) {
  struct ggml_tensor* dst =
      ggml_new_tensor(bundleCtx, GGML_TYPE_F32, n_dims, ne);
  ggml_set_name(dst, name);
  return dst;
}

struct ggml_tensor* cloneAsFp16(
    struct ggml_context* bundleCtx, const char* name, int n_dims,
    const int64_t* ne) {
  struct ggml_tensor* dst =
      ggml_new_tensor(bundleCtx, GGML_TYPE_F16, n_dims, ne);
  ggml_set_name(dst, name);
  return dst;
}

/// Same kernel-parity padding as torchvision: p = (k - 1) / 2 keeps same-size
/// output when stride=1 and reduces by floor(H/s) when stride=2.
constexpr int samePadding(int kernel) { return (kernel - 1) / 2; }

/// Load a 1D FP32 vector from a GGUF tensor (which can be FP16 or FP32).
std::vector<float> loadVector1d(
    const gguf_context* gguf, struct ggml_context* ggufCtx,
    const std::string& name) {
  (void)gguf;
  struct ggml_tensor* t = ggml_get_tensor(ggufCtx, name.c_str());
  if (t == nullptr) {
    raise("Missing BN tensor: " + name);
  }
  const size_t count = ggml_nelements(t);
  std::vector<float> out(count);
  if (t->type == GGML_TYPE_F32) {
    std::memcpy(out.data(), t->data, count * sizeof(float));
  } else if (t->type == GGML_TYPE_F16) {
    fp16ToFp32(t->data, out.data(), count);
  } else {
    raise("Unsupported BN tensor dtype for: " + name);
  }
  return out;
}

/// Applies folded BatchNorm inline: `x * scale + shift` with pre-reshaped
/// [1, 1, C, 1] scale/shift broadcasted across [W, H, C, 1].
struct ggml_tensor* applyFoldedBn(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    struct ggml_context* ctx, struct ggml_tensor* x, struct ggml_tensor* scale,
    struct ggml_tensor* shift) {
  struct ggml_tensor* scaled = ggml_mul(ctx, x, scale);
  return ggml_add(ctx, scaled, shift);
}

struct GraphBuilder {
  struct ggml_context* ctx;
  // GraphBuilder is a stateless one-shot helper that never outlives its
  // caller; storing the weight map by reference avoids a deep copy on every
  // graph build.
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-const-or-ref-data-members)
  const std::unordered_map<std::string, struct ggml_tensor*>& w;

  [[nodiscard]] struct ggml_tensor* t(const std::string& name) const {
    auto it = w.find(name);
    if (it == w.end()) {
      raise("Missing weight tensor at graph build time: " + name);
    }
    return it->second;
  }

  /// Activation selection: HardSwish for later blocks, ReLU for early
  /// layers, matching torchvision's MobileNetV3-Large config.
  struct ggml_tensor* activate(struct ggml_tensor* x, bool useHardswish) const {
    return useHardswish ? ggml_hardswish(ctx, x) : ggml_relu(ctx, x);
  }

  /// Conv2d + folded BN, optionally followed by an activation.
  struct ggml_tensor* convBnAct(
      struct ggml_tensor* x, const std::string& convPrefix,
      // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
      const std::string& bnPrefix, int stride, int kernel, bool activate,
      bool useHardswish) const {
    struct ggml_tensor* kernelT = t(convPrefix + ".weight");
    const int pad = samePadding(kernel);
    // NOTE: ggml_conv_2d_direct (fused GGML_OP_CONV_2D) measured ~2x SLOWER
    // than im2col + mul_mat on Metal — the matmul path rides the tuned GEMM
    // kernel.
    struct ggml_tensor* conv =
        ggml_conv_2d(ctx, kernelT, x, stride, stride, pad, pad, 1, 1);
    // BN scale folded into the conv weights at load time; `.shift` carries the
    // combined (conv bias + BN shift) offset. One add instead of add+mul+add.
    conv = ggml_add(ctx, conv, t(bnPrefix + ".shift"));
    if (!activate) {
      return conv;
    }
    return this->activate(conv, useHardswish);
  }

  struct ggml_tensor*
  fpnInBranch(struct ggml_tensor* input, int branchIndex) const {
    const std::string base =
        "dbnet.fpn.in_branches." + std::to_string(branchIndex);
    return convBnAct(
        input,
        base + ".0",
        base + ".1",
        /*stride=*/1,
        /*kernel=*/1,
        /*activate=*/true,
        /*useHardswish=*/false);
  }

  struct ggml_tensor* fpnUpsampleAdd(
      struct ggml_tensor* topDown, struct ggml_tensor* lateral) const {
    constexpr uint32_t upsampleMode =
        static_cast<uint32_t>(GGML_SCALE_MODE_BILINEAR) |
        static_cast<uint32_t>(GGML_SCALE_FLAG_ALIGN_CORNERS);
    struct ggml_tensor* upsampled = ggml_interpolate(
        ctx,
        topDown,
        lateral->ne[0],
        lateral->ne[1],
        lateral->ne[2],
        lateral->ne[3],
        upsampleMode);
    return ggml_add(ctx, upsampled, lateral);
  }

  struct ggml_tensor*
  fpnOutBranch(struct ggml_tensor* input, int branchIndex) const {
    constexpr std::array<int, 4> upsampleScaleFactors = {1, 2, 4, 8};
    const int upsampleScaleFactor =
        upsampleScaleFactors.at(static_cast<size_t>(branchIndex));
    const std::string base =
        "dbnet.fpn.out_branches." + std::to_string(branchIndex);
    struct ggml_tensor* output = convBnAct(
        input,
        base + ".0",
        base + ".1",
        /*stride=*/1,
        /*kernel=*/3,
        /*activate=*/true,
        /*useHardswish=*/false);

    constexpr uint32_t upsampleMode =
        static_cast<uint32_t>(GGML_SCALE_MODE_BILINEAR) |
        static_cast<uint32_t>(GGML_SCALE_FLAG_ALIGN_CORNERS);
    return ggml_interpolate(
        ctx,
        output,
        output->ne[0] * upsampleScaleFactor,
        output->ne[1] * upsampleScaleFactor,
        output->ne[2],
        output->ne[3],
        upsampleMode);
  }

  /// Sub-pixel (pixel-shuffle) equivalent of a 2x2 / stride-2 / pad-0
  /// transposed convolution.
  ///
  /// ggml's Metal `kernel_conv_transpose_2d` is pathologically slow — it
  /// launches one tiny (KW*KH-thread) threadgroup per output element and does a
  /// serial per-threadgroup reduction, so the two deconvs in the DocTR prob
  /// head dominate detection latency on Metal (~16s of a ~17s run on an M4).
  ///
  /// A 2x2/stride-2/pad-0 deconv is mathematically identical to a 1x1
  /// convolution that produces `OC*4` channels followed by a depth-to-space
  /// (pixel shuffle) with block size 2. Concretely:
  ///   out[2x+kw, 2y+kh, oc] = sum_ic W[kw, kh, oc, ic] * in[x, y, ic]
  /// so each input pixel maps to a 2x2 output block, one weight matrix per
  /// (kw, kh) sub-position. This runs as im2col + mul_mat on Metal (fast) and
  /// is numerically equivalent.
  ///
  /// The deconv weight is ggml-shaped [KW=2, KH=2, OC, IC] (memory index
  /// kw + 2*kh + 4*oc + 4*OC*ic). Reshaping/transposing it into a 1x1 conv
  /// kernel [1, 1, IC, P] with P = 4*OC and channel index p = kw + 2*kh + 4*oc
  /// makes conv output channel p at (x, y) equal the deconv contribution for
  /// sub-position (kw, kh) of output pixel (2x+kw, 2y+kh), channel oc. The
  /// pixel shuffle then scatters those P channels into the 2x2 blocks in that
  /// exact (kw, kh, oc) order.
  struct ggml_tensor* subPixelConvTranspose2x2(
      struct ggml_tensor* input, struct ggml_tensor* deconvWeight) const {
    if (deconvWeight->ne[0] != 2 || deconvWeight->ne[1] != 2) {
      raise("subPixelConvTranspose2x2 requires a 2x2 kernel");
    }
    const int64_t oc = deconvWeight->ne[2];
    const int64_t ic = deconvWeight->ne[3];
    const int64_t p = 4 * oc;

    // Reshape the deconv weight into a 1x1 conv kernel [1, 1, IC, P].
    struct ggml_tensor* wr = ggml_reshape_2d(ctx, deconvWeight, p, ic);
    struct ggml_tensor* wt = ggml_cont(ctx, ggml_transpose(ctx, wr)); // [IC,P]
    struct ggml_tensor* w1 = ggml_reshape_4d(ctx, wt, 1, 1, ic, p);

    // 1x1 conv: [W, H, IC] -> [W, H, P].
    struct ggml_tensor* conv = ggml_conv_2d(ctx, w1, input, 1, 1, 0, 0, 1, 1);

    const int64_t cw = conv->ne[0];
    const int64_t ch = conv->ne[1];

    // Depth-to-space (block 2), channel order p = kw + 2*kh + 4*oc.
    //
    // A naive width interleave produces a tensor with ne0 == 2 (the doubled
    // width axis innermost), which makes the ggml_cont write 2-element rows —
    // pathologically uncoalesced on Metal (~100ms for a 16M-element copy). To
    // avoid that, the width pass is fused with a W<->H transpose so every cont
    // keeps a large innermost dimension.
    struct ggml_tensor* y =
        ggml_reshape_4d(ctx, conv, cw, ch, 2, 2 * oc); // [W,H,kw,rest=kh+2oc]
    // permute (2,0,1,3): -> [H, kw, W, rest] (large ne0 = H), then combine
    // (kw,W) into the doubled width with xx = 2x + kw.
    y = ggml_cont(ctx, ggml_permute(ctx, y, 2, 0, 1, 3)); // [H, 2, W, rest]
    y = ggml_reshape_3d(ctx, y, ch, 2 * cw, 2 * oc);      // [H, 2W, rest]
    y = ggml_cont(ctx, ggml_permute(ctx, y, 1, 0, 2, 3)); // [2W, H, rest]
    // Height pass: split rest -> (kh=2, oc), interleave kh into y; ne0 stays
    // 2W.
    y = ggml_reshape_4d(ctx, y, 2 * cw, ch, 2, oc);
    y = ggml_cont(ctx, ggml_permute(ctx, y, 0, 2, 1, 3)); // [2W, 2, H, OC]
    y = ggml_reshape_3d(ctx, y, 2 * cw, 2 * ch, oc);      // [2W, 2H, OC]
    return y;
  }

  struct ggml_tensor* convTransposeBnAct(
      struct ggml_tensor* input, const std::string& convPrefix,
      const std::string& bnPrefix) const {
    struct ggml_tensor* conv =
        subPixelConvTranspose2x2(input, t(convPrefix + ".weight"));
    conv = ggml_add(ctx, conv, t(convPrefix + ".bias_br"));
    struct ggml_tensor* normed = applyFoldedBn(
        ctx, conv, t(bnPrefix + ".scale"), t(bnPrefix + ".shift"));
    return ggml_relu(ctx, normed);
  }

  struct ggml_tensor* probHead(struct ggml_tensor* input) const {
    struct ggml_tensor* output = convBnAct(
        input,
        "dbnet.prob_head.0",
        "dbnet.prob_head.1",
        /*stride=*/1,
        /*kernel=*/3,
        /*activate=*/true,
        /*useHardswish=*/false);
    output =
        convTransposeBnAct(output, "dbnet.prob_head.3", "dbnet.prob_head.4");
    output = subPixelConvTranspose2x2(output, t("dbnet.prob_head.6.weight"));
    return ggml_add(ctx, output, t("dbnet.prob_head.6.bias_br"));
  }

  /// Depthwise Conv2d + folded BN + activation.
  struct ggml_tensor* dwConvBnAct(
      struct ggml_tensor* x, const std::string& convPrefix,
      // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
      const std::string& bnPrefix, int stride, int kernel,
      bool useHardswish) const {
    struct ggml_tensor* kernelT = t(convPrefix + ".weight");
    const int pad = samePadding(kernel);
    // NOTE: Metal does not implement GGML_OP_CONV_2D_DW, so the direct
    // depthwise variant aborts there. Keep the im2col + mul_mat path
    // (decomposes into Metal-supported ops).
    struct ggml_tensor* conv =
        ggml_conv_2d_dw(ctx, kernelT, x, stride, stride, pad, pad, 1, 1);
    // BN scale folded into the depthwise weights at load time; `.shift` carries
    // the combined (conv bias + BN shift) offset.
    conv = ggml_add(ctx, conv, t(bnPrefix + ".shift"));
    return activate(conv, useHardswish);
  }

  /// Squeeze-and-excite block: global avg pool → 1x1 conv (reduce) → ReLU →
  /// 1x1 conv (expand) → HardSigmoid → element-wise multiply with input.
  struct ggml_tensor*
  seBlock(struct ggml_tensor* x, const std::string& sePrefix) const {
    // Global avg pool over the full (possibly non-square) spatial extent, read
    // from the tensor dims so the graph works at any input size.
    const int poolW = static_cast<int>(x->ne[0]);
    const int poolH = static_cast<int>(x->ne[1]);
    struct ggml_tensor* pooled = ggml_pool_2d(
        ctx, x, GGML_OP_POOL_AVG, poolW, poolH, poolW, poolH, 0, 0);

    struct ggml_tensor* fc1 = ggml_conv_2d(
        ctx, t(sePrefix + ".fc1.weight"), pooled, 1, 1, 0, 0, 1, 1);
    fc1 = ggml_add(ctx, fc1, t(sePrefix + ".fc1.bias_br"));
    fc1 = ggml_relu(ctx, fc1);

    struct ggml_tensor* fc2 =
        ggml_conv_2d(ctx, t(sePrefix + ".fc2.weight"), fc1, 1, 1, 0, 0, 1, 1);
    fc2 = ggml_add(ctx, fc2, t(sePrefix + ".fc2.bias_br"));

    // torchvision's SE uses hardsigmoid on the scale branch.
    struct ggml_tensor* gate = ggml_hardsigmoid(ctx, fc2);
    return ggml_mul(ctx, x, gate);
  }

  /// One torchvision InvertedResidual block.
  struct ggml_tensor* invertedResidual(
      struct ggml_tensor* x, const BlockConfig& cfg, int featuresIndex) const {
    const std::string base = "features." + std::to_string(featuresIndex);
    const bool hasExpand = cfg.expansionSize != cfg.inputChannels;

    struct ggml_tensor* y = x;

    int dwBlockIdx = 0;
    int seBlockIdx = -1;
    int projBlockIdx = 0;

    if (hasExpand) {
      y = convBnAct(
          y,
          base + ".block.0.0",
          base + ".block.0.1",
          /*stride=*/1,
          /*kernel=*/1,
          /*activate=*/true,
          cfg.useHardswish);
      dwBlockIdx = 1;
      if (cfg.useSe) {
        seBlockIdx = 2;
        projBlockIdx = 3;
      } else {
        projBlockIdx = 2;
      }
    } else {
      dwBlockIdx = 0;
      if (cfg.useSe) {
        seBlockIdx = 1;
        projBlockIdx = 2;
      } else {
        projBlockIdx = 1;
      }
    }

    // Depthwise.
    const std::string dwPrefix = base + ".block." + std::to_string(dwBlockIdx);
    y = dwConvBnAct(
        y,
        dwPrefix + ".0",
        dwPrefix + ".1",
        cfg.stride,
        cfg.depthwiseKernel,
        cfg.useHardswish);

    // Squeeze-and-excite.
    if (cfg.useSe) {
      const std::string sePrefix =
          base + ".block." + std::to_string(seBlockIdx);
      y = seBlock(y, sePrefix);
    }

    // Project (no activation on the tail conv).
    const std::string projPrefix =
        base + ".block." + std::to_string(projBlockIdx);
    y = convBnAct(
        y,
        projPrefix + ".0",
        projPrefix + ".1",
        /*stride=*/1,
        /*kernel=*/1,
        /*activate=*/false,
        cfg.useHardswish);

    // Residual add when shape preserved.
    if (cfg.stride == 1 && cfg.inputChannels == cfg.outputChannels) {
      y = ggml_add(ctx, y, x);
    }
    return y;
  }
};

} // namespace

WeightsBundle::~WeightsBundle() { reset(); }

WeightsBundle::WeightsBundle(WeightsBundle&& other) noexcept
    : ctx(std::move(other.ctx)), tensors(std::move(other.tensors)),
      backendBuffer(other.backendBuffer) {
  other.backendBuffer = nullptr;
}

WeightsBundle& WeightsBundle::operator=(WeightsBundle&& other) noexcept {
  if (this != &other) {
    reset();
    ctx = std::move(other.ctx);
    tensors = std::move(other.tensors);
    backendBuffer = other.backendBuffer;
    other.backendBuffer = nullptr;
  }
  return *this;
}

void WeightsBundle::reset() {
  tensors.clear();
  ctx.reset();
  if (backendBuffer != nullptr) {
    ggml_backend_buffer_free(backendBuffer);
    backendBuffer = nullptr;
  }
}

ComputeGraph::~ComputeGraph() { reset(); }

ComputeGraph::ComputeGraph(ComputeGraph&& other) noexcept
    : ctx(std::move(other.ctx)), graph(other.graph), allocr(other.allocr),
      input(other.input), output_1(other.output_1), output_2(other.output_2),
      output_3(other.output_3), output_4(other.output_4),
      backendBuffer(other.backendBuffer) {
  other.graph = nullptr;
  other.allocr = nullptr;
  other.input = nullptr;
  other.output_1 = nullptr;
  other.output_2 = nullptr;
  other.output_3 = nullptr;
  other.output_4 = nullptr;
  other.backendBuffer = nullptr;
}

ComputeGraph& ComputeGraph::operator=(ComputeGraph&& other) noexcept {
  if (this != &other) {
    reset();
    ctx = std::move(other.ctx);
    graph = other.graph;
    allocr = other.allocr;
    input = other.input;
    output_1 = other.output_1;
    output_2 = other.output_2;
    output_3 = other.output_3;
    output_4 = other.output_4;
    backendBuffer = other.backendBuffer;
    other.graph = nullptr;
    other.allocr = nullptr;
    other.input = nullptr;
    other.output_1 = nullptr;
    other.output_2 = nullptr;
    other.output_3 = nullptr;
    other.output_4 = nullptr;
    other.backendBuffer = nullptr;
  }
  return *this;
}

void ComputeGraph::reset() {
  graph = nullptr;
  if (allocr != nullptr) {
    ggml_gallocr_free(allocr);
    allocr = nullptr;
  }
  input = nullptr;
  output_1 = nullptr;
  output_2 = nullptr;
  output_3 = nullptr;
  output_4 = nullptr;
  ctx.reset();
  if (backendBuffer != nullptr) {
    ggml_backend_buffer_free(backendBuffer);
    backendBuffer = nullptr;
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
WeightsBundle loadWeights(
    const std::string& ggufPath, std::vector<ggml_backend_t>& backends,
    std::vector<std::string>& outLabels) {
  outLabels.clear();
  // Load the GGUF into a private ggml ctx so the inspected tensors stay
  // accessible long enough to copy their bytes into our backend buffer.
  struct ggml_context* ggmlCtx = nullptr;
  gguf_init_params params{.no_alloc = false, .ctx = &ggmlCtx};
  gguf_context* gguf = gguf_init_from_file(ggufPath.c_str(), params);
  if (gguf == nullptr) {
    raiseInvalid("Failed to open GGUF file: " + ggufPath);
  }
  std::unique_ptr<gguf_context, decltype(&gguf_free)> ggufGuard(
      gguf, gguf_free);
  std::unique_ptr<struct ggml_context, decltype(&ggml_free)> ggmlCtxGuard(
      ggmlCtx, ggml_free);
  printGgufMetadataKeys(gguf);

  // Read BN epsilon metadata and fall back to the architecture-standard 0.001
  // if the GGUF was produced by a tool that omitted it. Never trust 1e-5.
  float bnEps = kBatchNormEpsilon;
  {
    const int64_t epsIdx = gguf_find_key(gguf, "mobilenet.bn_eps");
    if (epsIdx >= 0) {
      bnEps = gguf_get_val_f32(gguf, static_cast<int>(epsIdx));
    }
  }

  // Fresh ggml ctx sized for our folded set of tensors (no alloc; tensors
  // will be backed by `backend` after ggml_backend_alloc_ctx_tensors).
  WeightsBundle bundle;
  const size_t ctxSize = ggml_tensor_overhead() * kCtxTensorOverhead;
  bundle.ctx = std::unique_ptr<struct ggml_context, decltype(&ggml_free)>(
      ggml_init({.mem_size = ctxSize, .mem_buffer = nullptr, .no_alloc = true}),
      ggml_free);
  if (!bundle.ctx) {
    raise("Failed to allocate weights ggml context");
  }

  auto& tensors = bundle.tensors;
  // TODO Load all of these values from the GGUF metadata
  constexpr int fpnInBranchCount = 4;
  constexpr int fpnInBranchOutChannels = 256;
  constexpr int fpnOutBranchInputChannels = 256;
  constexpr int fpnOutBranchOutChannels = 64;
  constexpr int dbnetHeadChannels = 64;
  constexpr int dbnetProbMapChannels = 1;
  constexpr float dbnetBatchNormEpsilon = 1e-5F;
  constexpr std::array<int, fpnInBranchCount> fpnInBranchInputChannels = {
      24, 40, 112, 960};

  // Lazy helpers.
  auto logTensorLoad = [&](const std::string& tensorName,
                           const struct ggml_tensor* tensor) {
    std::ostringstream os;
    os << "[MobileNetGraph] loading tensor: " << tensorName
       << " (type: " << ggml_type_name(tensor->type) << ", shape: [";
    const int dims = ggml_n_dims(tensor);
    for (int i = 0; i < dims; ++i) {
      if (i > 0) {
        os << ", ";
      }
      os << tensor->ne[i];
    }
    os << "])";
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, os.str());
  };

  auto registerTensor = [&](struct ggml_tensor* dst) {
    const std::string tensorName = ggml_get_name(dst);
    logTensorLoad(tensorName, dst);
    tensors.emplace(tensorName, dst);
  };

  // Raw bias tensors stay FP16, but the broadcast copies are FP32 because
  // CPU ggml_add does not support f32 activations plus f16 bias tensors.
  // The [1,1,C,1] shape broadcasts against 4D feature maps.
  // When the conv has no bias in the GGUF (bias=False, followed by BN), a
  // zero-filled broadcast tensor is created so the graph stays structurally
  // identical; the BN shift absorbs the offset.
  auto addBiasBroadcast = [&](const std::string& name) {
    const std::string brName = name + "_br";
    if (tensors.contains(brName)) {
      return;
    }

    const bool biasExistsInGguf = gguf_find_tensor(gguf, name.c_str()) >= 0;

    int64_t channels = 0;
    if (biasExistsInGguf) {
      // Raw bias (1D, F16) — used in unit tests.
      struct ggml_tensor* raw = nullptr;
      auto rawIt = tensors.find(name);
      if (rawIt == tensors.end()) {
        raw = cloneRaw(bundle.ctx.get(), gguf, ggmlCtx, name.c_str());
        registerTensor(raw);
      } else {
        raw = rawIt->second;
      }
      channels = ggml_nelements(raw);
    } else {
      // No bias tensor in GGUF (conv followed by BN with bias=False).
      // Infer output channels from the corresponding conv weight tensor.
      const std::string weightName =
          name.substr(0, name.size() - std::string(".bias").size()) + ".weight";
      auto wIt = tensors.find(weightName);
      if (wIt == tensors.end()) {
        raise("Cannot infer output channels for missing bias: " + name);
      }
      channels = wIt->second->ne[3];
    }

    const std::array<int64_t, 4> shape4d = {1, 1, channels, 1};
    struct ggml_tensor* broadcastBias =
        cloneAsFp32(bundle.ctx.get(), brName.c_str(), 4, shape4d.data());
    logTensorLoad(brName, broadcastBias);
    tensors.emplace(brName, broadcastBias);
  };

  auto addConvWeight = [&](const std::string& name) {
    if (!name.ends_with(".weight")) {
      raise(
          "Expected convolution weight tensor name to end with .weight: " +
          name);
    }
    struct ggml_tensor* weightTensor =
        cloneRaw(bundle.ctx.get(), gguf, ggmlCtx, name.c_str());
    registerTensor(weightTensor);
    addBiasBroadcast(
        name.substr(0, name.size() - std::string(".weight").size()) + ".bias");
    return weightTensor;
  };

  // Fold BN params into scale[1,1,C,1] and shift[1,1,C,1] at load time, which
  // avoids per-inference sqrt and four-op chains per BN (~34 layers).
  auto addFoldedBn = [&](const std::string& bnPrefix, int channels) {
    const std::array<int64_t, 4> shape4d = {1, 1, channels, 1};
    struct ggml_tensor* scale = cloneAsFp32(
        bundle.ctx.get(), (bnPrefix + ".scale").c_str(), 4, shape4d.data());
    struct ggml_tensor* shift = cloneAsFp32(
        bundle.ctx.get(), (bnPrefix + ".shift").c_str(), 4, shape4d.data());
    logTensorLoad(bnPrefix + ".scale", scale);
    tensors.emplace(bnPrefix + ".scale", scale);
    logTensorLoad(bnPrefix + ".shift", shift);
    tensors.emplace(bnPrefix + ".shift", shift);
  };

  // Classifier linear weights kept as F16 for numerical stability of the tiny
  // 3-element logits tail.
  auto addFcWeightFp16 = [&](const std::string& name, int in, int out) {
    const std::array<int64_t, 2> shape = {in, out};
    struct ggml_tensor* t =
        cloneAsFp16(bundle.ctx.get(), name.c_str(), 2, shape.data());
    logTensorLoad(name, t);
    tensors.emplace(name, t);
  };

  auto addFcBiasFp16 = [&](const std::string& name, int out) {
    const std::array<int64_t, 1> shape = {out};
    struct ggml_tensor* t =
        cloneAsFp16(bundle.ctx.get(), name.c_str(), 1, shape.data());
    logTensorLoad(name, t);
    tensors.emplace(name, t);
  };

  // Stem: features.0.0 = conv, features.0.1 = BN
  addConvWeight("features.0.0.weight");
  addFoldedBn("features.0.1", kStemOutChannels);

  // Inverted residual blocks.
  int featureIndex = 1;
  for (const BlockConfig& cfg : kBlocks) {
    const std::string base = "features." + std::to_string(featureIndex);
    const bool hasExpand =
        cfg.expansionSize != cfg.inputChannels; // true for first layer.
    int dwIdx = 0;
    int seIdx = -1;
    int projIdx = 0;
    if (hasExpand) {
      addConvWeight(base + ".block.0.0.weight");
      addFoldedBn(base + ".block.0.1", cfg.expansionSize);
      dwIdx = 1;
      if (cfg.useSe) {
        seIdx = 2;
        projIdx = 3;
      } else {
        projIdx = 2;
      }
    } else {
      if (cfg.useSe) {
        seIdx = 1;
        projIdx = 2;
      } else {
        projIdx = 1;
      }
    }
    const std::string dwBase = base + ".block." + std::to_string(dwIdx);
    addConvWeight(dwBase + ".0.weight");
    addFoldedBn(dwBase + ".1", cfg.expansionSize);

    if (cfg.useSe) {
      const std::string seBase = base + ".block." + std::to_string(seIdx);
      addConvWeight(seBase + ".fc1.weight");
      addConvWeight(seBase + ".fc2.weight");
    }

    const std::string projBase = base + ".block." + std::to_string(projIdx);
    addConvWeight(projBase + ".0.weight");
    addFoldedBn(projBase + ".1", cfg.outputChannels);

    ++featureIndex;
  }

  // Tail: features.16.0 = conv, features.16.1 = BN
  addConvWeight("features.16.0.weight");
  addFoldedBn("features.16.1", kTailOutChannels);

  // FPN input branches: each backbone feature is projected to 256 channels
  // with Conv1x1 + BN + ReLU before top-down pyramid fusion.
  for (int branch = 0; branch < fpnInBranchCount; ++branch) {
    const std::string base = "dbnet.fpn.in_branches." + std::to_string(branch);
    struct ggml_tensor* conv = addConvWeight(base + ".0.weight");
    if (conv->ne[0] != 1 || conv->ne[1] != 1 ||
        conv->ne[2] !=
            fpnInBranchInputChannels.at(static_cast<size_t>(branch)) ||
        conv->ne[3] != fpnInBranchOutChannels) {
      raise("FPN input branch conv shape mismatch for " + base + ".0.weight");
    }
    addFoldedBn(base + ".1", fpnInBranchOutChannels);
  }

  // FPN output branches: each top-down feature is refined by a 3x3 conv that
  // reduces the 256-channel pyramid feature to the 64-channel concat slice.
  for (int branch = 0; branch < fpnInBranchCount; ++branch) {
    const std::string base = "dbnet.fpn.out_branches." + std::to_string(branch);
    struct ggml_tensor* conv = addConvWeight(base + ".0.weight");
    if (conv->ne[0] != 3 || conv->ne[1] != 3 ||
        conv->ne[2] != fpnOutBranchInputChannels ||
        conv->ne[3] != fpnOutBranchOutChannels) {
      raise("FPN output branch conv shape mismatch for " + base + ".0.weight");
    }
    addFoldedBn(base + ".1", fpnOutBranchOutChannels);
  }

  // DBNet probability head: Conv2d + BN + ReLU, ConvTranspose2d + BN + ReLU,
  // then the final ConvTranspose2d projection to a single probability map.
  addConvWeight("dbnet.prob_head.0.weight");
  addFoldedBn("dbnet.prob_head.1", dbnetHeadChannels);
  addConvWeight("dbnet.prob_head.3.weight");
  addFoldedBn("dbnet.prob_head.4", dbnetHeadChannels);
  addConvWeight("dbnet.prob_head.6.weight");

  // Classifier head.
  addFcWeightFp16("classifier.0.weight", kTailOutChannels, kClassifierHidden);
  addFcBiasFp16("classifier.0.bias", kClassifierHidden);
  addFcWeightFp16("classifier.3.weight", kClassifierHidden, kNumClasses);
  addFcBiasFp16("classifier.3.bias", kNumClasses);

  // Back the newly declared tensors with backend storage so we can write to
  // them via ggml_backend_tensor_set below.
  ggml_backend_buffer_type_t weightsBuft =
      ggml_backend_get_default_buffer_type(backends[0]);
  bundle.backendBuffer =
      ggml_backend_alloc_ctx_tensors_from_buft(bundle.ctx.get(), weightsBuft);
  if (bundle.backendBuffer == nullptr) {
    raise("Failed to allocate backend buffer for weights");
  }

  // Copy raw tensor bytes (for cloneRaw) into the backend buffer.
  for (auto& [name, dst] : tensors) {
    if (name.ends_with(".scale") || name.ends_with(".shift") ||
        name.ends_with(".bias_br") || name == "classifier.0.weight" ||
        name == "classifier.0.bias" || name == "classifier.3.weight" ||
        name == "classifier.3.bias") {
      continue; // handled in the second pass
    }
    struct ggml_tensor* src = ggml_get_tensor(ggmlCtx, name.c_str());
    if (src == nullptr) {
      raise("Source tensor missing from GGUF: " + name);
    }
    if (src->type != dst->type) {
      raise("Dtype mismatch while copying tensor: " + name);
    }
    ggml_backend_tensor_set(dst, src->data, 0, ggml_nbytes(src));
  }

  // Kept for the future classifier-bytes upload path (see commented-out
  // uploadClassifierTensor block at the bottom of this function).
  // NOLINTNEXTLINE(clang-analyzer-deadcode.DeadStores)
  auto uploadTensorBytes = [&](struct ggml_tensor* dst,
                               const std::string& srcName) {
    struct ggml_tensor* src = ggml_get_tensor(ggmlCtx, srcName.c_str());
    if (src == nullptr) {
      raise("Source tensor missing from GGUF: " + srcName);
    }
    if (src->type != dst->type) {
      raise(
          "Dtype mismatch while copying tensor bytes from " + srcName + " to " +
          ggml_get_name(dst) + ": source type " + ggml_type_name(src->type) +
          ", destination type " + ggml_type_name(dst->type));
    }
    if (ggml_nelements(src) != ggml_nelements(dst)) {
      raise(
          "Element count mismatch while copying tensor bytes from " + srcName +
          " to " + ggml_get_name(dst) + ": expected " +
          std::to_string(ggml_nelements(dst)) + ", got " +
          std::to_string(ggml_nelements(src)));
    }
    if (ggml_nbytes(src) != ggml_nbytes(dst)) {
      raise(
          "Byte count mismatch while copying tensor bytes from " + srcName +
          " to " + ggml_get_name(dst) + ": expected " +
          std::to_string(ggml_nbytes(dst)) + ", got " +
          std::to_string(ggml_nbytes(src)));
    }
    ggml_backend_tensor_set(dst, src->data, 0, ggml_nbytes(src));
  };

  auto uploadF32 = [&](struct ggml_tensor* dst, const std::vector<float>& buf) {
    if (static_cast<size_t>(ggml_nelements(dst)) != buf.size()) {
      raise(
          std::string("Element count mismatch for ") + ggml_get_name(dst) +
          ": expected " + std::to_string(ggml_nelements(dst)) + ", got " +
          std::to_string(buf.size()));
    }
    if (dst->type != GGML_TYPE_F32) {
      raise(
          std::string("Expected FP32 destination for ") + ggml_get_name(dst) +
          ", got " + ggml_type_name(dst->type));
    }
    ggml_backend_tensor_set(dst, buf.data(), 0, buf.size() * sizeof(float));
  };

  // Fold the BN per-channel scale into the preceding conv's F16 weights and
  // combine the conv bias + BN shift into a single bias, so the runtime graph
  // collapses `conv + add(bias) + mul(scale) + add(shift)` down to
  // `conv + add(combined)`. Removing two full-tensor elementwise passes per
  // conv is exact (out = scale*(W*x + bias) + shift = (scale*W)*x +
  // (scale*bias + shift)) and matters most on bandwidth-bound mobile GPUs.
  // The conv tensor for a BN named "<P>.1" is "<P>.0.weight" and its broadcast
  // bias is "<P>.0.bias_br" (both already uploaded before this pass runs).
  auto foldScaleIntoConv = [&](const std::string& bnPrefix,
                               const std::vector<float>& scale,
                               std::vector<float>& shift) {
    if (bnPrefix.size() < 2 || bnPrefix.substr(bnPrefix.size() - 2) != ".1") {
      raise("BN fold expects a '<prefix>.1' name, got " + bnPrefix);
    }
    const std::string stem = bnPrefix.substr(0, bnPrefix.size() - 2);
    const std::string convName = stem + ".0.weight";
    auto wIt = tensors.find(convName);
    if (wIt == tensors.end()) {
      raise("BN fold: conv weight not found: " + convName);
    }
    struct ggml_tensor* wTensor = wIt->second;
    if (wTensor->type != GGML_TYPE_F16) {
      raise(
          "BN fold: unsupported conv weight dtype " +
          std::string(ggml_type_name(wTensor->type)) + " for " + convName +
          " (expected F16; quantized weights are not supported by the BN "
          "fold)");
    }
    const int64_t oc = wTensor->ne[3];
    if (static_cast<size_t>(oc) != scale.size()) {
      raise(
          "BN fold: output-channel mismatch for " + convName +
          ": conv oc=" + std::to_string(oc) +
          ", BN scale size=" + std::to_string(scale.size()));
    }
    const int64_t perOc = wTensor->ne[0] * wTensor->ne[1] * wTensor->ne[2];
    const size_t n = static_cast<size_t>(oc * perOc);
    std::vector<ggml_fp16_t> wbuf(n);
    ggml_backend_tensor_get(wTensor, wbuf.data(), 0, n * sizeof(ggml_fp16_t));
    // F16 has no arithmetic: batch-decode each channel row to F32 with ggml's
    // SIMD row converters, apply the per-channel scale, then re-encode. The
    // weight stays F16-stored (not an f16->f16 copy).
    std::vector<float> f32buf(static_cast<size_t>(perOc));
    for (int64_t o = 0; o < oc; ++o) {
      const float s = scale[static_cast<size_t>(o)];
      ggml_fp16_t* row = wbuf.data() + (o * perOc);
      ggml_fp16_to_fp32_row(row, f32buf.data(), perOc);
      for (int64_t i = 0; i < perOc; ++i) {
        f32buf[static_cast<size_t>(i)] *= s;
      }
      ggml_fp32_to_fp16_row(f32buf.data(), row, perOc);
    }
    ggml_backend_tensor_set(wTensor, wbuf.data(), 0, n * sizeof(ggml_fp16_t));

    // combined bias = scale * bias_br + shift (bias_br is zeros for bias=False
    // convs, the offset for offline-folded models).
    auto bIt = tensors.find(stem + ".0.bias_br");
    if (bIt != tensors.end()) {
      std::vector<float> biasBr(scale.size());
      ggml_backend_tensor_get(
          bIt->second, biasBr.data(), 0, biasBr.size() * sizeof(float));
      for (size_t i = 0; i < shift.size(); ++i) {
        shift[i] += scale[i] * biasBr[i];
      }
    }
  };

  auto foldBnWithEps = [&](const std::string& bnPrefix,
                           float eps,
                           bool foldIntoConv) {
    const size_t n =
        static_cast<size_t>(ggml_nelements(tensors.at(bnPrefix + ".scale")));
    std::vector<float> scale(n, 1.0F);
    std::vector<float> shift(n, 0.0F);
    // When running stats are present compute the standard BN fold; otherwise
    // the BN was already folded offline (identity scale/shift; any offset is
    // carried by the conv bias, which foldScaleIntoConv absorbs).
    if (gguf_find_tensor(gguf, (bnPrefix + ".running_mean").c_str()) >= 0) {
      std::vector<float> w = loadVector1d(gguf, ggmlCtx, bnPrefix + ".scale");
      std::vector<float> b = loadVector1d(gguf, ggmlCtx, bnPrefix + ".shift");
      std::vector<float> m =
          loadVector1d(gguf, ggmlCtx, bnPrefix + ".running_mean");
      std::vector<float> v =
          loadVector1d(gguf, ggmlCtx, bnPrefix + ".running_var");
      if (w.size() != n || b.size() != n || m.size() != n || v.size() != n) {
        raise(
            "BN param size mismatch for " + bnPrefix + ": expected " +
            std::to_string(n) + ", got scale=" + std::to_string(w.size()) +
            " shift=" + std::to_string(b.size()) +
            " running_mean=" + std::to_string(m.size()) +
            " running_var=" + std::to_string(v.size()));
      }
      for (size_t i = 0; i < n; ++i) {
        const float invStd = 1.0F / std::sqrt(v[i] + eps);
        scale[i] = w[i] * invStd;
        shift[i] = b[i] - (m[i] * scale[i]);
      }
    }
    if (foldIntoConv) {
      foldScaleIntoConv(bnPrefix, scale, shift);
    }
    uploadF32(tensors.at(bnPrefix + ".scale"), scale);
    uploadF32(tensors.at(bnPrefix + ".shift"), shift);
  };

  auto foldBn = [&](const std::string& bnPrefix) {
    foldBnWithEps(bnPrefix, bnEps, /*foldIntoConv=*/true);
  };

  for (auto& [name, dst] : tensors) {
    if (!name.ends_with(".bias_br")) {
      continue;
    }
    const std::string biasName =
        name.substr(0, name.size() - std::string("_br").size());
    if (gguf_find_tensor(gguf, biasName.c_str()) >= 0) {
      std::vector<float> biasValues = loadVector1d(gguf, ggmlCtx, biasName);
      uploadF32(dst, biasValues);
    } else {
      std::vector<float> zeros(static_cast<size_t>(ggml_nelements(dst)), 0.0F);
      uploadF32(dst, zeros);
    }
  }
  foldBn("features.0.1");

  int foldFeatureIndex = 1;
  for (const BlockConfig& cfg : kBlocks) {
    const std::string base = "features." + std::to_string(foldFeatureIndex);
    const bool hasExpand = cfg.expansionSize != cfg.inputChannels;
    int dwIdx = 0;
    int projIdx = 0;
    if (hasExpand) {
      foldBn(base + ".block.0.1");
      dwIdx = 1;
      projIdx = cfg.useSe ? 3 : 2;
    } else {
      dwIdx = 0;
      projIdx = cfg.useSe ? 2 : 1;
    }
    foldBn(base + ".block." + std::to_string(dwIdx) + ".1");
    foldBn(base + ".block." + std::to_string(projIdx) + ".1");
    ++foldFeatureIndex;
  }

  foldBn("features.16.1");

  for (int branch = 0; branch < fpnInBranchCount; ++branch) {
    const std::string base = "dbnet.fpn.in_branches." + std::to_string(branch);
    foldBnWithEps(base + ".1", dbnetBatchNormEpsilon, /*foldIntoConv=*/true);
  }

  for (int branch = 0; branch < fpnInBranchCount; ++branch) {
    const std::string base = "dbnet.fpn.out_branches." + std::to_string(branch);
    foldBnWithEps(base + ".1", dbnetBatchNormEpsilon, /*foldIntoConv=*/true);
  }

  // prob_head.0 is a plain 3x3 conv (foldable); prob_head.3/.4 is the
  // sub-pixel transposed conv whose weight is reshaped at graph build, so its
  // BN stays as a runtime scale/shift (applyFoldedBn in convTransposeBnAct).
  foldBnWithEps(
      "dbnet.prob_head.1", dbnetBatchNormEpsilon, /*foldIntoConv=*/true);
  foldBnWithEps(
      "dbnet.prob_head.4", dbnetBatchNormEpsilon, /*foldIntoConv=*/false);

  // Classifier FC tensors stay FP16 and are copied directly from GGUF bytes.
  // auto uploadClassifierTensor = [&](const std::string& name) {
  //   uploadTensorBytes(tensors.at(name), name);
  // };
  // uploadClassifierTensor("classifier.0.weight");
  // uploadClassifierTensor("classifier.0.bias");
  // uploadClassifierTensor("classifier.3.weight");
  // uploadClassifierTensor("classifier.3.bias");

  return bundle;
}

ComputeGraph buildGraph(
    const WeightsBundle& weights, std::vector<ggml_backend_t>& backends,
    int inputW, int inputH) {
  ComputeGraph cg;
  const size_t ctxSize =
      (ggml_tensor_overhead() * kCtxTensorOverhead) + ggml_graph_overhead();
  cg.ctx = std::unique_ptr<struct ggml_context, decltype(&ggml_free)>(
      ggml_init({.mem_size = ctxSize, .mem_buffer = nullptr, .no_alloc = true}),
      ggml_free);
  if (!cg.ctx) {
    raise("Failed to allocate graph ggml context");
  }
  struct ggml_context* ctx = cg.ctx.get();

  // WHCN order: W, H, C, N. The canvas is the resized image padded to a
  // multiple of 32 per axis (not necessarily square — see preprocessImage),
  // so the backbone only convolves real content plus minimal padding.
  cg.input = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, inputW, inputH, 3, 1);
  ggml_set_name(cg.input, "input");

  GraphBuilder gb{.ctx = ctx, .w = weights.tensors};

  // Stem.
  struct ggml_tensor* x = gb.convBnAct(
      cg.input,
      "features.0.0",
      "features.0.1",
      /*stride=*/2,
      /*kernel=*/3,
      /*activate=*/true,
      /*useHardswish=*/true);

  // 15 inverted residual blocks. Spatial dims flow from the input tensor
  // (SE pools and FPN upsamples read them directly), so no size tracking here.
  int graphFeatureIndex = 1;
  for (const BlockConfig& cfg : kBlocks) {
    x = gb.invertedResidual(x, cfg, graphFeatureIndex);
    switch (graphFeatureIndex) {
    case kFpnFeatureTap1:
      cg.output_1 = x;
      break;
    case kFpnFeatureTap2:
      cg.output_2 = x;
      break;
    case kFpnFeatureTap3:
      cg.output_3 = x;
      break;
    default:
      break;
    }
    ++graphFeatureIndex;
  }

  // Tail (features.16): 1x1 conv + BN + HardSwish at 7x7 spatial.
  x = gb.convBnAct(
      x,
      "features.16.0",
      "features.16.1",
      /*stride=*/1,
      /*kernel=*/1,
      /*activate=*/true,
      /*useHardswish=*/true);

  if (cg.output_1 == nullptr || cg.output_2 == nullptr ||
      cg.output_3 == nullptr) {
    raise("Missing backbone feature map for FPN input branches");
  }

  // FPN in_branches: project C2/C3/C4/C5 to 256 channels with 1x1 conv + BN +
  // ReLU.
  cg.output_1 = gb.fpnInBranch(cg.output_1, 0);
  cg.output_2 = gb.fpnInBranch(cg.output_2, 1);
  cg.output_3 = gb.fpnInBranch(cg.output_3, 2);
  cg.output_4 = gb.fpnInBranch(x, 3);

  // FPN top-down path: out = [_x[-1]]; append(upsample(out[-1]) + t)
  // for the lower-level lateral features, using bilinear align_corners=True.
  cg.output_3 = gb.fpnUpsampleAdd(cg.output_4, cg.output_3);
  cg.output_2 = gb.fpnUpsampleAdd(cg.output_3, cg.output_2);
  cg.output_1 = gb.fpnUpsampleAdd(cg.output_2, cg.output_1);

  // FPN out_branches consume the top-down outputs in low-to-high order
  // (`out[::-1]` in the PyTorch reference), then upsample to the C2 size.
  cg.output_1 = gb.fpnOutBranch(cg.output_1, 0);
  cg.output_2 = gb.fpnOutBranch(cg.output_2, 1);
  cg.output_3 = gb.fpnOutBranch(cg.output_3, 2);
  cg.output_4 = gb.fpnOutBranch(cg.output_4, 3);

  // PyTorch cats NCHW tensors on dim=1 (channels). In ggml WHCN layout the
  // channel axis is dim=2, yielding the 256-channel DBNet feature map.
  struct ggml_tensor* fpnCat12 = ggml_concat(ctx, cg.output_1, cg.output_2, 2);
  struct ggml_tensor* fpnCat34 = ggml_concat(ctx, cg.output_3, cg.output_4, 2);
  cg.output_4 = ggml_concat(ctx, fpnCat12, fpnCat34, 2);
  cg.output_4 = gb.probHead(cg.output_4);
  // Apply sigmoid on-device: a single fast Metal kernel over the 1024x1024 map
  // replaces a ~1M-element cv::exp on the CPU after readback.
  cg.output_4 = ggml_sigmoid(ctx, cg.output_4);

  ggml_set_name(cg.output_1, "output_1");
  ggml_set_name(cg.output_2, "output_2");
  ggml_set_name(cg.output_3, "output_3");
  ggml_set_name(cg.output_4, "output_4");

  cg.graph = ggml_new_graph_custom(ctx, kMaxGraphNodes, /*grads=*/false);
  ggml_build_forward_expand(cg.graph, cg.output_4);

  cg.allocr =
      ggml_gallocr_new(ggml_backend_get_default_buffer_type(backends[0]));
  if (cg.allocr == nullptr) {
    raise("Failed to create graph allocator for compute graph");
  }

  if (!ggml_gallocr_alloc_graph(cg.allocr, cg.graph)) {
    raise("Failed to allocate compute graph");
  }

  return cg;
}

} // namespace qvac_lib_infer_ggml_classification::graph

// NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,readability-identifier-naming,readability-identifier-length)
