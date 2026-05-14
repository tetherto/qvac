#include "MobileNetGraph.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml.h>
#include <gguf.h>

#include <inference-addon-cpp/Errors.hpp>

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

void printGgufMetadataKeys(const gguf_context* gguf) {
  if (gguf == nullptr) {
    std::cout << "[MobileNetGraph] GGUF context is null; cannot print metadata keys\n";
    return;
  }

  const int64_t metadataCount = gguf_get_n_kv(gguf);
  std::cout << "[MobileNetGraph] GGUF metadata keys (" << metadataCount << ")\n";
  for (int64_t i = 0; i < metadataCount; ++i) {
    const char* key = gguf_get_key(gguf, i);
    std::cout << "  - " << (key != nullptr ? key : "<null>") << '\n';
  }
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
  const int idx = gguf_find_tensor(ggufCtx, name);
  if (idx < 0) {
    raise(std::string("Missing tensor in GGUF: ") + name);
  }
  struct ggml_tensor* src = ggml_get_tensor(ggmlCtx, name);
  if (src == nullptr) {
    raise(std::string("Cannot resolve tensor from ggml ctx: ") + name);
  }
  struct ggml_tensor* dst =
      ggml_new_tensor(bundleCtx, src->type, ggml_n_dims(src), src->ne);
  ggml_set_name(dst, name);
  return dst;
}

/// Same as cloneRaw but forces the destination dtype to F32 (used for BN
/// scale/shift and classifier weights promoted at load time).
struct ggml_tensor* cloneAsFp32(
    struct ggml_context* bundleCtx, const char* name, int n_dims,
    const int64_t* ne) {
  struct ggml_tensor* dst = ggml_new_tensor(bundleCtx, GGML_TYPE_F32, n_dims, ne);
  ggml_set_name(dst, name);
  return dst;
}

struct ggml_tensor* cloneAsFp16(
  struct ggml_context* bundleCtx, const char* name, int n_dims,
  const int64_t* ne) {
  struct ggml_tensor* dst = ggml_new_tensor(bundleCtx, GGML_TYPE_F16, n_dims, ne);
  ggml_set_name(dst, name);
  return dst;
}

/// Same kernel-parity padding as torchvision: p = (k - 1) / 2 keeps same-size
/// output when stride=1 and reduces by floor(H/s) when stride=2.
constexpr int samePadding(int kernel) {
  return (kernel - 1) / 2;
}

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
// TODO The form here is just affine transformation form. 
// Folded would mean to just merge it with convolution.
// struct ggml_tensor* applyFoldedBn(
//     struct ggml_context* ctx, struct ggml_tensor* x,
//     struct ggml_tensor* scale, struct ggml_tensor* shift) {
//   struct ggml_tensor* scaled = ggml_mul(ctx, x, scale);
//   return ggml_add(ctx, scaled, shift);
// }

struct GraphBuilder {
  struct ggml_context* ctx;
  const std::unordered_map<std::string, struct ggml_tensor*>& w;

  struct ggml_tensor* t(const std::string& name) const {
    auto it = w.find(name);
    if (it == w.end()) {
      raise("Missing weight tensor at graph build time: " + name);
    }
    return it->second;
  }

  /// Activation selection: HardSwish for later blocks, ReLU for early
  /// layers, matching torchvision's MobileNetV3-Large config.
  struct ggml_tensor* activate(struct ggml_tensor* x, bool useHardswish) {
    return useHardswish ? ggml_hardswish(ctx, x) : ggml_relu(ctx, x);
  }

  /// Conv2d + folded BN, optionally followed by an activation.
  struct ggml_tensor* convBnAct(
      struct ggml_tensor* x, const std::string& convPrefix,
      const std::string& bnPrefix, int stride, int kernel, bool activate,
      bool useHardswish) {
    struct ggml_tensor* kernelT = t(convPrefix + ".weight");
    const int pad = samePadding(kernel);
    struct ggml_tensor* conv =
        ggml_conv_2d(ctx, kernelT, x, stride, stride, pad, pad, 1, 1);
    conv = ggml_add(ctx, conv, t(convPrefix + ".bias_br"));

//     struct ggml_tensor* bn =
//         applyFoldedBn(ctx, conv, t(bnPrefix + ".scale"), t(bnPrefix + ".shift"));
    if (!activate) {
      return conv;
    }
    return this->activate(conv, useHardswish);
  }

  struct ggml_tensor* fpnInBranch(struct ggml_tensor* input, int branchIndex) {
    const std::string base =
        "dbnet.fpn.in_branches." + std::to_string(branchIndex);
    return convBnAct(
        input, base + ".0", base + ".1", /*stride=*/1, /*kernel=*/1,
        /*activate=*/true, /*useHardswish=*/false);
  }

  struct ggml_tensor* fpnUpsampleAdd(
      struct ggml_tensor* topDown, struct ggml_tensor* lateral) const {
    constexpr uint32_t upsampleMode =
        GGML_SCALE_MODE_BILINEAR | GGML_SCALE_FLAG_ALIGN_CORNERS;
    struct ggml_tensor* upsampled = ggml_interpolate(
        ctx, topDown, lateral->ne[0], lateral->ne[1], lateral->ne[2],
        lateral->ne[3], upsampleMode);
    return ggml_add(ctx, upsampled, lateral);
  }

  struct ggml_tensor* fpnOutBranch(struct ggml_tensor* input, int branchIndex) {
    constexpr std::array<int, 4> upsampleScaleFactors = {1, 2, 4, 8};
    const int upsampleScaleFactor =
        upsampleScaleFactors.at(static_cast<size_t>(branchIndex));
    const std::string base =
        "dbnet.fpn.out_branches." + std::to_string(branchIndex);
    struct ggml_tensor* output = convBnAct(
        input, base + ".0", base + ".1", /*stride=*/1, /*kernel=*/3,
        /*activate=*/true, /*useHardswish=*/false);

    constexpr uint32_t upsampleMode =
        GGML_SCALE_MODE_BILINEAR | GGML_SCALE_FLAG_ALIGN_CORNERS;
    return ggml_interpolate(
        ctx, output, output->ne[0] * upsampleScaleFactor,
        output->ne[1] * upsampleScaleFactor, output->ne[2], output->ne[3],
        upsampleMode);
  }

  struct ggml_tensor* convTransposeBnAct(
      struct ggml_tensor* input, const std::string& convPrefix,
      const std::string& bnPrefix) const {
    struct ggml_tensor* conv =
        ggml_conv_transpose_2d_p0(ctx, t(convPrefix + ".weight"), input, 2);
    conv = ggml_add(ctx, conv, t(convPrefix + ".bias_br"));
    // struct ggml_tensor* normed =
    //     applyFoldedBn(ctx, conv, t(bnPrefix + ".scale"), t(bnPrefix + ".shift"));
    return ggml_relu(ctx, conv);
  }

  struct ggml_tensor* probHead(struct ggml_tensor* input) {
    struct ggml_tensor* output = convBnAct(
        input, "dbnet.prob_head.0", "dbnet.prob_head.1", /*stride=*/1,
        /*kernel=*/3, /*activate=*/true, /*useHardswish=*/false);
    output = convTransposeBnAct(
        output, "dbnet.prob_head.3", "dbnet.prob_head.4");
    output = ggml_conv_transpose_2d_p0(
        ctx, t("dbnet.prob_head.6.weight"), output, 2);
    return ggml_add(ctx, output, t("dbnet.prob_head.6.bias_br"));
  }

  /// Depthwise Conv2d + folded BN + activation.
  struct ggml_tensor* dwConvBnAct(
      struct ggml_tensor* x, const std::string& convPrefix,
      const std::string& bnPrefix, int stride, int kernel, bool useHardswish) {
    struct ggml_tensor* kernelT = t(convPrefix + ".weight");
    const int pad = samePadding(kernel);
    struct ggml_tensor* conv =
        ggml_conv_2d_dw(ctx, kernelT, x, stride, stride, pad, pad, 1, 1);
    conv = ggml_add(ctx, conv, t(convPrefix + ".bias_br"));
    // struct ggml_tensor* bn =
    //     applyFoldedBn(ctx, conv, t(bnPrefix + ".scale"), t(bnPrefix + ".shift"));
    return activate(conv, useHardswish);
  }

  /// Squeeze-and-excite block: global avg pool → 1x1 conv (reduce) → ReLU →
  /// 1x1 conv (expand) → HardSigmoid → element-wise multiply with input.
  struct ggml_tensor* seBlock(
      struct ggml_tensor* x, const std::string& sePrefix, int spatialHw) {
    // Global avg pool: kernel = full spatial extent, stride = same.
    struct ggml_tensor* pooled = ggml_pool_2d(
        ctx, x, GGML_OP_POOL_AVG, spatialHw, spatialHw, spatialHw, spatialHw,
        0, 0);

    struct ggml_tensor* fc1 = ggml_conv_2d(
        ctx, t(sePrefix + ".fc1.weight"), pooled, 1, 1, 0, 0, 1, 1);
    fc1 = ggml_add(ctx, fc1, t(sePrefix + ".fc1.bias_br"));
    fc1 = ggml_relu(ctx, fc1);

    struct ggml_tensor* fc2 = ggml_conv_2d(
        ctx, t(sePrefix + ".fc2.weight"), fc1, 1, 1, 0, 0, 1, 1);
    fc2 = ggml_add(ctx, fc2, t(sePrefix + ".fc2.bias_br"));

    // torchvision's SE uses hardsigmoid on the scale branch.
    struct ggml_tensor* gate = ggml_hardsigmoid(ctx, fc2);
    return ggml_mul(ctx, x, gate);
  }

  /// One torchvision InvertedResidual block.
  struct ggml_tensor* invertedResidual(
      struct ggml_tensor* x, const BlockConfig& cfg, int featuresIndex,
      int inputSpatialHw) {
    const std::string base = "features." + std::to_string(featuresIndex);
    const bool hasExpand = cfg.expansionSize != cfg.inputChannels;

    int spatial = inputSpatialHw;
    struct ggml_tensor* y = x;

    int dwBlockIdx = 0;
    int seBlockIdx = -1;
    int projBlockIdx = 0;

    if (hasExpand) {
      y = convBnAct(
          y, base + ".block.0.0", base + ".block.0.1",
          /*stride=*/1, /*kernel=*/1, /*activate=*/true, cfg.useHardswish);
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
          y, dwPrefix + ".0", dwPrefix + ".1", cfg.stride, cfg.depthwiseKernel,
        cfg.useHardswish);
    if (cfg.stride == 2) {
      spatial = (spatial + 1) / 2;
    }

    // Squeeze-and-excite.
    if (cfg.useSe) {
      const std::string sePrefix =
          base + ".block." + std::to_string(seBlockIdx);
      y = seBlock(y, sePrefix, spatial);
    }

    // Project (no activation on the tail conv).
    const std::string projPrefix =
        base + ".block." + std::to_string(projBlockIdx);
    y = convBnAct(
        y, projPrefix + ".0", projPrefix + ".1",
        /*stride=*/1, /*kernel=*/1, /*activate=*/false, cfg.useHardswish);

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
    : ctx(std::move(other.ctx)),
      tensors(std::move(other.tensors)),
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
    : ctx(std::move(other.ctx)),
      graph(other.graph),
      allocr(other.allocr),
      input(other.input),
      output_1(other.output_1),
      output_2(other.output_2),
      output_3(other.output_3),
      output_4(other.output_4),
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

WeightsBundle loadWeights(
    const std::string& ggufPath, std::vector<ggml_backend_t>& backends,
    std::vector<std::string>& outLabels) {
  outLabels.clear();
  // Load the GGUF into a private ggml ctx so the inspected tensors stay
  // accessible long enough to copy their bytes into our backend buffer.
  struct ggml_context* ggmlCtx = nullptr;
  gguf_init_params params{/*no_alloc=*/false, &ggmlCtx};
  gguf_context* gguf = gguf_init_from_file(ggufPath.c_str(), params);
  if (gguf == nullptr) {
    raiseInvalid("Failed to open GGUF file: " + ggufPath);
  }
  std::unique_ptr<gguf_context, decltype(&gguf_free)> ggufGuard(gguf, gguf_free);
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
  const size_t ctxSize = ggml_tensor_overhead() * 4096;
  bundle.ctx = std::unique_ptr<struct ggml_context, decltype(&ggml_free)>(
      ggml_init({ctxSize, nullptr, /*no_alloc=*/true}), ggml_free);
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
  auto logTensorLoad = [&](const std::string& tensorName, const struct ggml_tensor* tensor) {
    std::cout << "[MobileNetGraph] loading tensor: " << tensorName
              << " (type: " << ggml_type_name(tensor->type)
              << ", shape: [";
    const int dims = ggml_n_dims(tensor);
    for (int i = 0; i < dims; ++i) {
      if (i > 0) {
        std::cout << ", ";
      }
      std::cout << tensor->ne[i];
    }
    std::cout << "])\n";
  };

  auto registerTensor = [&](struct ggml_tensor* dst) {
    const std::string tensorName = ggml_get_name(dst);
    logTensorLoad(tensorName, dst);
    tensors.emplace(tensorName, dst);
  };

  // Raw bias tensors stay FP16, but the broadcast copies are FP32 because
  // CPU ggml_add does not support f32 activations plus f16 bias tensors.
  // The [1,1,C,1] shape broadcasts against 4D feature maps.
  auto addBiasBroadcast = [&](const std::string& name) {
    // Raw bias (1D, F16) — used in unit tests.
    struct ggml_tensor* raw = nullptr;
    auto rawIt = tensors.find(name);
    if (rawIt == tensors.end()) {
      raw = cloneRaw(bundle.ctx.get(), gguf, ggmlCtx, name.c_str());
      registerTensor(raw);
    } else {
      raw = rawIt->second;
    }

    // Broadcasted FP32 copy for graph consumption.
    const std::string brName = name + "_br";
    if (tensors.find(brName) != tensors.end()) {
      return;
    }
    const int64_t channels = ggml_nelements(raw);
    const std::array<int64_t, 4> shape4d = {1, 1, channels, 1};
    struct ggml_tensor* broadcastBias =
        cloneAsFp32(bundle.ctx.get(), brName.c_str(), 4, shape4d.data());
    logTensorLoad(brName, broadcastBias);
    tensors.emplace(brName, broadcastBias);
  };

  auto addConvWeight = [&](const std::string& name) {
    if (!name.ends_with(".weight")) {
      raise("Expected convolution weight tensor name to end with .weight: " + name);
    }
    struct ggml_tensor* weightTensor =
        cloneRaw(bundle.ctx.get(), gguf, ggmlCtx, name.c_str());
    registerTensor(weightTensor);
    addBiasBroadcast(name.substr(0, name.size() - std::string(".weight").size()) + ".bias");
    return weightTensor;
  };

  // Fold BN params into scale[1,1,C,1] and shift[1,1,C,1] at load time, which
  // avoids per-inference sqrt and four-op chains per BN (~34 layers).
  // auto addFoldedBn = [&](const std::string& bnPrefix, int channels) {
  //   const int64_t shape4d[4] = {1, 1, channels, 1};
  //   struct ggml_tensor* scale =
  //       cloneAsFp32(bundle.ctx.get(), (bnPrefix + ".scale").c_str(), 4, shape4d);
  //   struct ggml_tensor* shift =
  //       cloneAsFp32(bundle.ctx.get(), (bnPrefix + ".shift").c_str(), 4, shape4d);
  //   logTensorLoad(bnPrefix + ".scale", scale->type);
  //   tensors.emplace(bnPrefix + ".scale", scale);
  //   logTensorLoad(bnPrefix + ".shift", shift->type);
  //   tensors.emplace(bnPrefix + ".shift", shift);
  // };

  // Classifier linear weights kept as F32 for numerical stability of the tiny
  // 3-element logits tail.
  auto addFcWeightFp32 = [&](const std::string& name, int in, int out) {
    const int64_t shape[2] = {in, out};
    struct ggml_tensor* t = cloneAsFp32(bundle.ctx.get(), name.c_str(), 2, shape);
    logTensorLoad(name, t);
    tensors.emplace(name, t);
  };

  auto addFcWeightFp16 = [&](const std::string& name, int in, int out) {
    const int64_t shape[2] = {in, out};
    struct ggml_tensor* t = cloneAsFp16(bundle.ctx.get(), name.c_str(), 2, shape);
    logTensorLoad(name, t);
    tensors.emplace(name, t);
  };

  auto addFcBiasFp32 = [&](const std::string& name, int out) {
    const int64_t shape[1] = {out};
    struct ggml_tensor* t = cloneAsFp32(bundle.ctx.get(), name.c_str(), 1, shape);
    logTensorLoad(name, t);
    tensors.emplace(name, t);
  };

  auto addFcBiasFp16 = [&](const std::string& name, int out) {
    const int64_t shape[1] = {out};
    struct ggml_tensor* t = cloneAsFp16(bundle.ctx.get(), name.c_str(), 1, shape);
    logTensorLoad(name, t);
    tensors.emplace(name, t);
  };

  // Stem: features.0.0 = conv, features.0.1 = BN
  addConvWeight("features.0.0.weight");
  // addFoldedBn("features.0.1", kStemOutChannels);

  // Inverted residual blocks.
  int featureIndex = 1;
  for (const BlockConfig& cfg : kBlocks) {
    const std::string base = "features." + std::to_string(featureIndex);
    const bool hasExpand = cfg.expansionSize != cfg.inputChannels; // true for first layer.
    int dwIdx = 0;
    int seIdx = -1;
    int projIdx = 0;
    if (hasExpand) {
      addConvWeight(base + ".block.0.0.weight");
      // addFoldedBn(base + ".block.0.1", cfg.expansionSize);
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
    // addFoldedBn(dwBase + ".1", cfg.expansionSize);

    if (cfg.useSe) {
      const std::string seBase = base + ".block." + std::to_string(seIdx);
      addConvWeight(seBase + ".fc1.weight");
      addConvWeight(seBase + ".fc2.weight");
    }

    const std::string projBase = base + ".block." + std::to_string(projIdx);
    addConvWeight(projBase + ".0.weight");
    // addFoldedBn(projBase + ".1", cfg.outputChannels);

    ++featureIndex;
  }

  // Tail: features.16.0 = conv, features.16.1 = BN
  addConvWeight("features.16.0.weight");
  // addFoldedBn("features.16.1", kTailOutChannels);

  // FPN input branches: each backbone feature is projected to 256 channels
  // with Conv1x1 + BN + ReLU before top-down pyramid fusion.
  for (int branch = 0; branch < fpnInBranchCount; ++branch) {
    const std::string base =
        "dbnet.fpn.in_branches." + std::to_string(branch);
    struct ggml_tensor* conv = addConvWeight(base + ".0.weight");
    if (conv->ne[0] != 1 || conv->ne[1] != 1 ||
        conv->ne[2] != fpnInBranchInputChannels.at(static_cast<size_t>(branch)) ||
        conv->ne[3] != fpnInBranchOutChannels) {
      raise("FPN input branch conv shape mismatch for " + base + ".0.weight");
    }
    // addFoldedBn(base + ".1", fpnInBranchOutChannels);
  }

  // FPN output branches: each top-down feature is refined by a 3x3 conv that
  // reduces the 256-channel pyramid feature to the 64-channel concat slice.
  for (int branch = 0; branch < fpnInBranchCount; ++branch) {
    const std::string base =
        "dbnet.fpn.out_branches." + std::to_string(branch);
    struct ggml_tensor* conv = addConvWeight(base + ".0.weight");
    if (conv->ne[0] != 3 || conv->ne[1] != 3 ||
        conv->ne[2] != fpnOutBranchInputChannels ||
        conv->ne[3] != fpnOutBranchOutChannels) {
      raise("FPN output branch conv shape mismatch for " + base + ".0.weight");
    }
    // addFoldedBn(base + ".1", fpnOutBranchOutChannels);
  }

  // DBNet probability head: Conv2d + BN + ReLU, ConvTranspose2d + BN + ReLU,
  // then the final ConvTranspose2d projection to a single probability map.
  addConvWeight("dbnet.prob_head.0.weight");
  // addFoldedBn("dbnet.prob_head.1", dbnetHeadChannels);
  addConvWeight("dbnet.prob_head.3.weight");
  // addFoldedBn("dbnet.prob_head.4", dbnetHeadChannels);
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

  auto uploadTensorBytes = [&](struct ggml_tensor* dst, const std::string& srcName) {
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

  // auto foldBnWithEps = [&](const std::string& bnPrefix, float eps) {
  //   std::vector<float> w =
  //       loadVector1d(gguf, ggmlCtx, bnPrefix + ".scale");
  //   std::vector<float> b =
  //       loadVector1d(gguf, ggmlCtx, bnPrefix + ".shift");
  //   std::vector<float> m =
  //       loadVector1d(gguf, ggmlCtx, bnPrefix + ".running_mean");
  //   std::vector<float> v =
  //       loadVector1d(gguf, ggmlCtx, bnPrefix + ".running_var");
  //   const size_t n = w.size();
  //   if (b.size() != n || m.size() != n || v.size() != n) {
  //     raise("BN param size mismatch for " + bnPrefix);
  //   }
  //   std::vector<float> scale(n);
  //   std::vector<float> shift(n);
  //   for (size_t i = 0; i < n; ++i) {
  //     const float invStd = 1.0F / std::sqrt(v[i] + eps);
  //     scale[i] = w[i] * invStd;
  //     shift[i] = b[i] - m[i] * scale[i];
  //   }
  //   uploadF32(tensors.at(bnPrefix + ".scale"), scale);
  //   uploadF32(tensors.at(bnPrefix + ".shift"), shift);
  // };

  // auto foldBn = [&](const std::string& bnPrefix) {
  //   foldBnWithEps(bnPrefix, bnEps);
  // };

  for (auto& [name, dst] : tensors) {
    if (!name.ends_with(".bias_br")) {
      continue;
    }
    const std::string biasName =
        name.substr(0, name.size() - std::string("_br").size());
    std::vector<float> biasValues = loadVector1d(gguf, ggmlCtx, biasName);
    uploadF32(dst, biasValues);
  }
  // foldBn("features.0.1");
  // foldBn("features.16.1");

  // for (int branch = 0; branch < fpnInBranchCount; ++branch) {
  //   const std::string base =
  //       "dbnet.fpn.in_branches." + std::to_string(branch);
  //   foldBnWithEps(base + ".1", dbnetBatchNormEpsilon);
  // }

  // for (int branch = 0; branch < fpnInBranchCount; ++branch) {
  //   const std::string base =
  //       "dbnet.fpn.out_branches." + std::to_string(branch);
  //   foldBnWithEps(base + ".1", dbnetBatchNormEpsilon);
  // }

  // foldBnWithEps("dbnet.prob_head.1", dbnetBatchNormEpsilon);
  // foldBnWithEps("dbnet.prob_head.4", dbnetBatchNormEpsilon);

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

ComputeGraph buildGraph(const WeightsBundle& weights, std::vector<ggml_backend_t>& backends) {
  ComputeGraph cg;
  const size_t ctxSize = ggml_tensor_overhead() * 4096 + ggml_graph_overhead();
  cg.ctx = std::unique_ptr<struct ggml_context, decltype(&ggml_free)>(
      ggml_init({ctxSize, nullptr, /*no_alloc=*/true}), ggml_free);
  if (!cg.ctx) {
    raise("Failed to allocate graph ggml context");
  }
  struct ggml_context* ctx = cg.ctx.get();

  // WHCN order: W, H, C, N.
  cg.input =
      ggml_new_tensor_4d(ctx, GGML_TYPE_F32, kInputHw, kInputHw, 3, 1);
  ggml_set_name(cg.input, "input");

  GraphBuilder gb{ctx, weights.tensors};

  // Stem.
  struct ggml_tensor* x = gb.convBnAct(
      cg.input, "features.0.0", "features.0.1", /*stride=*/2, /*kernel=*/3,
      /*activate=*/true, /*useHardswish=*/true);

  int spatial = kInputHw / 2; // 112 after stem

  // 15 inverted residual blocks.
  int graphFeatureIndex = 1;
  for (const BlockConfig& cfg : kBlocks) {
    x = gb.invertedResidual(x, cfg, graphFeatureIndex, spatial);
    if (cfg.stride == 2) {
      spatial = (spatial + 1) / 2;
    }
    switch(graphFeatureIndex)
    {
      case 3 :  cg.output_1 = x; break;
      case 6 :  cg.output_2 = x; break;
      case 12 : cg.output_3 = x; break;
    }
    ++graphFeatureIndex;
  }

  // Tail (features.16): 1x1 conv + BN + HardSwish at 7x7 spatial.
  x = gb.convBnAct(
      x, "features.16.0", "features.16.1", /*stride=*/1, /*kernel=*/1,
      /*activate=*/true, /*useHardswish=*/true);

  if (cg.output_1 == nullptr || cg.output_2 == nullptr || cg.output_3 == nullptr) {
    raise("Missing backbone feature map for FPN input branches");
  }

  // FPN in_branches: project C2/C3/C4/C5 to 256 channels with 1x1 conv + BN + ReLU.
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
  // cg.output_4 = ggml_sigmoid(ctx, cg.output_4);

  ggml_set_name(cg.output_1, "output_1");
  ggml_set_name(cg.output_2, "output_2");
  ggml_set_name(cg.output_3, "output_3");
  ggml_set_name(cg.output_4, "output_4");


  cg.graph = ggml_new_graph_custom(ctx, 8192, /*grads=*/false);
  ggml_build_forward_expand(cg.graph, cg.output_4);

  cg.allocr = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backends[0]));
  if (cg.allocr == nullptr) {
    raise("Failed to create graph allocator for compute graph");
  }

  if (!ggml_gallocr_alloc_graph(cg.allocr, cg.graph)) {
    raise("Failed to allocate compute graph");
  }

  return cg;
}

} // namespace qvac_lib_infer_ggml_classification::graph
