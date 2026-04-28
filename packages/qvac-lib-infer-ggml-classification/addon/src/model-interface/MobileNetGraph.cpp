#include "MobileNetGraph.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml.h>
#include <gguf.h>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

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
    struct ggml_context* bundleCtx, const gguf_context* gguf,
    struct ggml_context* ggufCtx, const char* name) {
  const int idx = gguf_find_tensor(gguf, name);
  if (idx < 0) {
    raise(std::string("Missing tensor in GGUF: ") + name);
  }
  struct ggml_tensor* src = ggml_get_tensor(ggufCtx, name);
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
struct ggml_tensor* applyFoldedBn(
    struct ggml_context* ctx, struct ggml_tensor* x,
    struct ggml_tensor* scale, struct ggml_tensor* shift) {
  struct ggml_tensor* scaled = ggml_mul(ctx, x, scale);
  return ggml_add(ctx, scaled, shift);
}

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

  /// Activation selection: HardSwish for newer-block layers, ReLU for early
  /// layers, exactly matching torchvision's MobileNetV3-Small config.
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
    struct ggml_tensor* bn =
        applyFoldedBn(ctx, conv, t(bnPrefix + ".scale"), t(bnPrefix + ".shift"));
    if (!activate) {
      return bn;
    }
    return this->activate(bn, useHardswish);
  }

  /// Depthwise Conv2d + folded BN + activation.
  struct ggml_tensor* dwConvBnAct(
      struct ggml_tensor* x, const std::string& convPrefix,
      const std::string& bnPrefix, int stride, int kernel, bool useHardswish) {
    struct ggml_tensor* kernelT = t(convPrefix + ".weight");
    const int pad = samePadding(kernel);
    struct ggml_tensor* conv =
        ggml_conv_2d_dw(ctx, kernelT, x, stride, stride, pad, pad, 1, 1);
    struct ggml_tensor* bn =
        applyFoldedBn(ctx, conv, t(bnPrefix + ".scale"), t(bnPrefix + ".shift"));
    return activate(bn, useHardswish);
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
      struct ggml_tensor* x, const BlockConfig& cfg, int inputSpatialHw) {
    const std::string base = "features." + std::to_string(cfg.featuresIndex);
    const bool hasExpand = cfg.expandedChannels != cfg.inputChannels;

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
      input(other.input),
      output(other.output),
      backendBuffer(other.backendBuffer) {
  other.graph = nullptr;
  other.input = nullptr;
  other.output = nullptr;
  other.backendBuffer = nullptr;
}

ComputeGraph& ComputeGraph::operator=(ComputeGraph&& other) noexcept {
  if (this != &other) {
    reset();
    ctx = std::move(other.ctx);
    graph = other.graph;
    input = other.input;
    output = other.output;
    backendBuffer = other.backendBuffer;
    other.graph = nullptr;
    other.input = nullptr;
    other.output = nullptr;
    other.backendBuffer = nullptr;
  }
  return *this;
}

void ComputeGraph::reset() {
  graph = nullptr;
  input = nullptr;
  output = nullptr;
  ctx.reset();
  if (backendBuffer != nullptr) {
    ggml_backend_buffer_free(backendBuffer);
    backendBuffer = nullptr;
  }
}

WeightsBundle loadWeights(
    const std::string& ggufPath, ggml_backend_t backend,
    std::vector<std::string>& outLabels) {
  outLabels.clear();
  // Load the GGUF into a private ggml ctx so the inspected tensors stay
  // accessible long enough to copy their bytes into our backend buffer.
  struct ggml_context* ggufCtx = nullptr;
  gguf_init_params params{/*no_alloc=*/false, &ggufCtx};
  gguf_context* gguf = gguf_init_from_file(ggufPath.c_str(), params);
  if (gguf == nullptr) {
    raiseInvalid("Failed to open GGUF file: " + ggufPath);
  }
  std::unique_ptr<gguf_context, decltype(&gguf_free)> ggufGuard(gguf, gguf_free);
  std::unique_ptr<struct ggml_context, decltype(&ggml_free)> ggufCtxGuard(
      ggufCtx, ggml_free);

  // Read BN epsilon metadata and fall back to the architecture-standard 0.001
  // if the GGUF was produced by a tool that omitted it. Never trust 1e-5.
  float bnEps = kBatchNormEpsilon;
  {
    const int64_t epsIdx = gguf_find_key(gguf, "mobilenet.bn_eps");
    if (epsIdx >= 0) {
      bnEps = gguf_get_val_f32(gguf, static_cast<int>(epsIdx));
    }
  }

  // Read class labels while we already have the GGUF open; this avoids a
  // second mmap of the file from ClassificationModel::load.
  {
    uint32_t numClasses = kNumClasses;
    const int64_t idxN = gguf_find_key(gguf, "mobilenet.num_classes");
    if (idxN >= 0) {
      numClasses = gguf_get_val_u32(gguf, static_cast<int>(idxN));
    }
    // The graph has compile-time fixed FC weights for `kNumClasses` and a
    // matching `kNumClasses`-element output tensor; a GGUF that advertises
    // a different class count cannot be served by this build of the
    // addon. Reject up-front rather than letting downstream
    // `ggml_backend_tensor_get(..., logits, sizeof(float)*kNumClasses)`
    // either truncate (numClasses > kNumClasses) or read past the
    // tensor buffer (numClasses < kNumClasses), and rather than letting
    // the FC weight upload corrupt the classifier silently due to a
    // shape mismatch.
    if (numClasses != kNumClasses) {
      raiseInvalid(
          "GGUF metadata 'mobilenet.num_classes' (" +
          std::to_string(numClasses) +
          ") does not match the addon's compiled-in class count (" +
          std::to_string(kNumClasses) +
          "); rebuild @qvac/classification-ggml against this model or use "
          "a GGUF with the expected number of classes");
    }
    for (uint32_t i = 0; i < numClasses; ++i) {
      const std::string key = "mobilenet.class_" + std::to_string(i);
      const int64_t idx = gguf_find_key(gguf, key.c_str());
      if (idx < 0) {
        outLabels.clear();
        break;
      }
      outLabels.emplace_back(gguf_get_val_str(gguf, static_cast<int>(idx)));
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

  // Lazy helpers.
  auto registerTensor = [&](struct ggml_tensor* dst) {
    tensors.emplace(ggml_get_name(dst), dst);
  };

  auto addConvWeight = [&](const std::string& name) {
    struct ggml_tensor* t = cloneRaw(bundle.ctx.get(), gguf, ggufCtx, name.c_str());
    registerTensor(t);
  };

  // 1D bias tensor kept as F32, reshaped to [1,1,C,1] so it broadcasts
  // against the 4D feature map produced by the 1x1 convs in SE blocks.
  auto addSeBiasBroadcast = [&](const std::string& name, int channels) {
    // Raw bias (1D, F16) — used in unit tests.
    struct ggml_tensor* raw =
        cloneRaw(bundle.ctx.get(), gguf, ggufCtx, name.c_str());
    registerTensor(raw);

    // Broadcasted F32 view for graph consumption.
    const int64_t shape4d[4] = {1, 1, channels, 1};
    const std::string brName = name + "_br";
    struct ggml_tensor* br = cloneAsFp32(bundle.ctx.get(), brName.c_str(), 4, shape4d);
    tensors.emplace(brName, br);
  };

  // Fold BN params into scale[1,1,C,1] and shift[1,1,C,1] at load time, which
  // avoids per-inference sqrt and four-op chains per BN (~34 layers).
  auto addFoldedBn = [&](const std::string& bnPrefix, int channels) {
    const int64_t shape4d[4] = {1, 1, channels, 1};
    struct ggml_tensor* scale =
        cloneAsFp32(bundle.ctx.get(), (bnPrefix + ".scale").c_str(), 4, shape4d);
    struct ggml_tensor* shift =
        cloneAsFp32(bundle.ctx.get(), (bnPrefix + ".shift").c_str(), 4, shape4d);
    tensors.emplace(bnPrefix + ".scale", scale);
    tensors.emplace(bnPrefix + ".shift", shift);
  };

  // Classifier linear weights kept as F32 for numerical stability of the tiny
  // 3-element logits tail.
  auto addFcWeightFp32 = [&](const std::string& name, int in, int out) {
    const int64_t shape[2] = {in, out};
    struct ggml_tensor* t = cloneAsFp32(bundle.ctx.get(), name.c_str(), 2, shape);
    tensors.emplace(name, t);
  };
  auto addFcBiasFp32 = [&](const std::string& name, int out) {
    const int64_t shape[1] = {out};
    struct ggml_tensor* t = cloneAsFp32(bundle.ctx.get(), name.c_str(), 1, shape);
    tensors.emplace(name, t);
  };

  // Stem: features.0.0 = conv, features.0.1 = BN
  addConvWeight("features.0.0.weight");
  addFoldedBn("features.0.1", kStemOutChannels);

  // Inverted residual blocks.
  for (const BlockConfig& cfg : kBlocks) {
    const std::string base = "features." + std::to_string(cfg.featuresIndex);
    const bool hasExpand = cfg.expandedChannels != cfg.inputChannels;
    int dwIdx = 0;
    int seIdx = -1;
    int projIdx = 0;
    if (hasExpand) {
      addConvWeight(base + ".block.0.0.weight");
      addFoldedBn(base + ".block.0.1", cfg.expandedChannels);
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
    addFoldedBn(dwBase + ".1", cfg.expandedChannels);

    if (cfg.useSe) {
      const std::string seBase = base + ".block." + std::to_string(seIdx);
      addConvWeight(seBase + ".fc1.weight");
      addSeBiasBroadcast(seBase + ".fc1.bias", cfg.seReducedChannels);
      addConvWeight(seBase + ".fc2.weight");
      addSeBiasBroadcast(seBase + ".fc2.bias", cfg.expandedChannels);
    }

    const std::string projBase = base + ".block." + std::to_string(projIdx);
    addConvWeight(projBase + ".0.weight");
    addFoldedBn(projBase + ".1", cfg.outputChannels);
  }

  // Tail: features.12.0 = conv, features.12.1 = BN
  addConvWeight("features.12.0.weight");
  addFoldedBn("features.12.1", kTailOutChannels);

  // Classifier head.
  addFcWeightFp32("classifier.0.weight", kTailOutChannels, kClassifierHidden);
  addFcBiasFp32("classifier.0.bias", kClassifierHidden);
  addFcWeightFp32("classifier.3.weight", kClassifierHidden, kNumClasses);
  addFcBiasFp32("classifier.3.bias", kNumClasses);

  // Back the newly declared tensors with backend storage so we can write to
  // them via ggml_backend_tensor_set below.
  bundle.backendBuffer =
      ggml_backend_alloc_ctx_tensors(bundle.ctx.get(), backend);
  if (bundle.backendBuffer == nullptr) {
    raise("Failed to allocate backend buffer for weights");
  }

  // Copy raw tensor bytes (for cloneRaw) and compute folded BN / F32 linear
  // weights (for cloneAsFp32) into the backend buffer.
  for (auto& [name, dst] : tensors) {
    if (name.ends_with(".scale") || name.ends_with(".shift") ||
        name.ends_with(".bias_br") || name == "classifier.0.weight" ||
        name == "classifier.0.bias" || name == "classifier.3.weight" ||
        name == "classifier.3.bias") {
      continue; // handled in the second pass
    }
    struct ggml_tensor* src = ggml_get_tensor(ggufCtx, name.c_str());
    if (src == nullptr) {
      raise("Source tensor missing from GGUF: " + name);
    }
    if (src->type != dst->type) {
      raise("Dtype mismatch while copying tensor: " + name);
    }
    ggml_backend_tensor_set(dst, src->data, 0, ggml_nbytes(src));
  }

  // Second pass: BN fold, SE bias broadcast, classifier F32 upload.
  auto uploadF32 = [&](struct ggml_tensor* dst, const std::vector<float>& buf) {
    if (static_cast<size_t>(ggml_nelements(dst)) != buf.size()) {
      raise(
          std::string("Element count mismatch for ") + ggml_get_name(dst) +
          ": expected " + std::to_string(ggml_nelements(dst)) + ", got " +
          std::to_string(buf.size()));
    }
    ggml_backend_tensor_set(dst, buf.data(), 0, buf.size() * sizeof(float));
  };

  auto foldBn = [&](const std::string& bnPrefix) {
    std::vector<float> w =
        loadVector1d(gguf, ggufCtx, bnPrefix + ".weight");
    std::vector<float> b =
        loadVector1d(gguf, ggufCtx, bnPrefix + ".bias");
    std::vector<float> m =
        loadVector1d(gguf, ggufCtx, bnPrefix + ".running_mean");
    std::vector<float> v =
        loadVector1d(gguf, ggufCtx, bnPrefix + ".running_var");
    const size_t n = w.size();
    if (b.size() != n || m.size() != n || v.size() != n) {
      raise("BN param size mismatch for " + bnPrefix);
    }
    std::vector<float> scale(n);
    std::vector<float> shift(n);
    for (size_t i = 0; i < n; ++i) {
      const float invStd = 1.0F / std::sqrt(v[i] + bnEps);
      scale[i] = w[i] * invStd;
      shift[i] = b[i] - m[i] * scale[i];
    }
    uploadF32(tensors.at(bnPrefix + ".scale"), scale);
    uploadF32(tensors.at(bnPrefix + ".shift"), shift);
  };

  auto foldSeBias = [&](const std::string& biasName) {
    std::vector<float> b = loadVector1d(gguf, ggufCtx, biasName);
    uploadF32(tensors.at(biasName + "_br"), b);
  };

  foldBn("features.0.1");
  for (const BlockConfig& cfg : kBlocks) {
    const std::string base = "features." + std::to_string(cfg.featuresIndex);
    const bool hasExpand = cfg.expandedChannels != cfg.inputChannels;
    int dwIdx = 0;
    int seIdx = -1;
    int projIdx = 0;
    if (hasExpand) {
      foldBn(base + ".block.0.1");
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
    foldBn(base + ".block." + std::to_string(dwIdx) + ".1");
    if (cfg.useSe) {
      const std::string seBase = base + ".block." + std::to_string(seIdx);
      foldSeBias(seBase + ".fc1.bias");
      foldSeBias(seBase + ".fc2.bias");
    }
    foldBn(base + ".block." + std::to_string(projIdx) + ".1");
  }
  foldBn("features.12.1");

  // Classifier FC tensors: FP16 -> FP32 upload.
  auto uploadClassifierTensor = [&](const std::string& name) {
    std::vector<float> buf =
        loadVector1d(gguf, ggufCtx, name); // works for any shape (flat count)
    uploadF32(tensors.at(name), buf);
  };
  uploadClassifierTensor("classifier.0.weight");
  uploadClassifierTensor("classifier.0.bias");
  uploadClassifierTensor("classifier.3.weight");
  uploadClassifierTensor("classifier.3.bias");

  return bundle;
}

ComputeGraph buildGraph(const WeightsBundle& weights, ggml_backend_t backend) {
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

  // 11 inverted residual blocks.
  for (const BlockConfig& cfg : kBlocks) {
    x = gb.invertedResidual(x, cfg, spatial);
    if (cfg.stride == 2) {
      spatial = (spatial + 1) / 2;
    }
  }

  // Tail (features.12): 1x1 conv + BN + HardSwish at 7x7 spatial.
  x = gb.convBnAct(
      x, "features.12.0", "features.12.1", /*stride=*/1, /*kernel=*/1,
      /*activate=*/true, /*useHardswish=*/true);

  // Classifier: global avg pool → reshape → Linear → HardSwish → Linear.
  struct ggml_tensor* pooled = ggml_pool_2d(
      ctx, x, GGML_OP_POOL_AVG, spatial, spatial, spatial, spatial, 0, 0);
  struct ggml_tensor* flat = ggml_reshape_1d(ctx, pooled, kTailOutChannels);

  struct ggml_tensor* fc0 = ggml_mul_mat(
      ctx, gb.t("classifier.0.weight"), flat);
  fc0 = ggml_add(ctx, fc0, gb.t("classifier.0.bias"));
  fc0 = ggml_hardswish(ctx, fc0);

  struct ggml_tensor* fc3 = ggml_mul_mat(
      ctx, gb.t("classifier.3.weight"), fc0);
  fc3 = ggml_add(ctx, fc3, gb.t("classifier.3.bias"));

  cg.output = fc3;
  ggml_set_name(cg.output, "logits");

  // Defence-in-depth invariant: every site that reads from
  // `cg.output` (warmup pass and per-inference path) does so with a
  // stack-allocated `float[kNumClasses]` and asks ggml for exactly
  // `sizeof(float) * kNumClasses` bytes. If the graph as constructed
  // ever ends up with a different output element count -- whether
  // because of an upstream ggml change to how `mul_mat` shapes its
  // result, an accidental edit to the classifier wiring above, or a
  // future fine-tune slipping through the GGUF metadata check -- we
  // would silently corrupt the read (truncation or OOB). Catch it
  // here, before any inference runs.
  if (ggml_nelements(cg.output) != static_cast<int64_t>(kNumClasses)) {
    raise(
        "Compute graph output has " +
        std::to_string(ggml_nelements(cg.output)) +
        " elements, expected " + std::to_string(kNumClasses) +
        "; classifier wiring or GGUF weight shapes are inconsistent with "
        "graph::kNumClasses");
  }

  cg.graph = ggml_new_graph_custom(ctx, 8192, /*grads=*/false);
  ggml_build_forward_expand(cg.graph, cg.output);

  cg.backendBuffer = ggml_backend_alloc_ctx_tensors(ctx, backend);
  if (cg.backendBuffer == nullptr) {
    raise("Failed to allocate backend buffer for compute graph");
  }

  return cg;
}

} // namespace qvac_lib_infer_ggml_classification::graph
