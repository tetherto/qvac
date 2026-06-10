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

#include <inference-addon-cpp/Errors.hpp>

namespace classification_ggml::graph {

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

// FP16 tensors are storage-only; runtime-math tensors (BN scale/shift,
// FC weights) are promoted to F32 at load time so the graph never casts.

void fp16ToFp32(const void* src, float* out, size_t count) {
  const auto* halfPtr = static_cast<const ggml_fp16_t*>(src);
  for (size_t i = 0; i < count; ++i) {
    out[i] = ggml_fp16_to_fp32(halfPtr[i]);
  }
}

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

/// Like cloneRaw but forces the destination dtype to F32.
struct ggml_tensor* cloneAsFp32(
    struct ggml_context* bundleCtx, const char* name, int nDims,
    const int64_t* ne) {
  struct ggml_tensor* dst =
      ggml_new_tensor(bundleCtx, GGML_TYPE_F32, nDims, ne);
  ggml_set_name(dst, name);
  return dst;
}

// torchvision same-padding: p = (k - 1) / 2.
constexpr int samePadding(int kernel) {
  return (kernel - 1) / 2;
}

/// Read a GGUF tensor (FP16 or FP32) into an FP32 vector.
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

/// Folded BN: `x * scale + shift`, scale/shift pre-reshaped to [1,1,C,1].
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

  struct ggml_tensor* activate(struct ggml_tensor* x, bool useHardswish) {
    return useHardswish ? ggml_hardswish(ctx, x) : ggml_relu(ctx, x);
  }

  /// Conv2d + folded BN [+ optional activation].
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

  /// SE: avgpool → 1x1 reduce + ReLU → 1x1 expand + HardSigmoid → mul.
  struct ggml_tensor* seBlock(
      struct ggml_tensor* x, const std::string& sePrefix, int spatialHw) {
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

    struct ggml_tensor* gate = ggml_hardsigmoid(ctx, fc2);
    return ggml_mul(ctx, x, gate);
  }

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

    const std::string dwPrefix = base + ".block." + std::to_string(dwBlockIdx);
    y = dwConvBnAct(
        y, dwPrefix + ".0", dwPrefix + ".1", cfg.stride, cfg.depthwiseKernel,
        cfg.useHardswish);
    if (cfg.stride == 2) {
      spatial = (spatial + 1) / 2;
    }

    if (cfg.useSe) {
      const std::string sePrefix =
          base + ".block." + std::to_string(seBlockIdx);
      y = seBlock(y, sePrefix, spatial);
    }

    const std::string projPrefix =
        base + ".block." + std::to_string(projBlockIdx);
    y = convBnAct(
        y, projPrefix + ".0", projPrefix + ".1",
        /*stride=*/1, /*kernel=*/1, /*activate=*/false, cfg.useHardswish);

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
  struct ggml_context* ggufCtx = nullptr;
  gguf_init_params params{/*no_alloc=*/false, &ggufCtx};
  gguf_context* gguf = gguf_init_from_file(ggufPath.c_str(), params);
  if (gguf == nullptr) {
    raiseInvalid("Failed to open GGUF file: " + ggufPath);
  }
  std::unique_ptr<gguf_context, decltype(&gguf_free)> ggufGuard(gguf, gguf_free);
  std::unique_ptr<struct ggml_context, decltype(&ggml_free)> ggufCtxGuard(
      ggufCtx, ggml_free);

  // Default to the architecture-standard 0.001 (PyTorch's BN default).
  // Never silently fall back to torchvision's 1e-5 reference value.
  float bnEps = BATCH_NORM_EPSILON;
  {
    const int64_t epsIdx = gguf_find_key(gguf, "mobilenet.bn_eps");
    if (epsIdx >= 0) {
      bnEps = gguf_get_val_f32(gguf, static_cast<int>(epsIdx));
    }
  }

  {
    uint32_t numClasses = NUM_CLASSES;
    const int64_t idxN = gguf_find_key(gguf, "mobilenet.num_classes");
    if (idxN >= 0) {
      numClasses = gguf_get_val_u32(gguf, static_cast<int>(idxN));
    }
    // Mismatch silently corrupts the classifier upload and the per-call
    // tensor_get; reject up front.
    if (numClasses != NUM_CLASSES) {
      raiseInvalid(
          "GGUF metadata 'mobilenet.num_classes' (" +
          std::to_string(numClasses) +
          ") does not match the addon's compiled-in class count (" +
          std::to_string(NUM_CLASSES) +
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

  WeightsBundle bundle;
  const size_t ctxSize = ggml_tensor_overhead() * 4096;
  bundle.ctx = std::unique_ptr<struct ggml_context, decltype(&ggml_free)>(
      ggml_init({ctxSize, nullptr, /*no_alloc=*/true}), ggml_free);
  if (!bundle.ctx) {
    raise("Failed to allocate weights ggml context");
  }

  auto& tensors = bundle.tensors;

  auto registerTensor = [&](struct ggml_tensor* dst) {
    tensors.emplace(ggml_get_name(dst), dst);
  };

  auto addConvWeight = [&](const std::string& name) {
    struct ggml_tensor* t = cloneRaw(bundle.ctx.get(), gguf, ggufCtx, name.c_str());
    registerTensor(t);
  };

  // SE bias is registered twice: 1D raw (used by unit tests) and an F32
  // [1,1,C,1] broadcast view (consumed by the graph against 4D feature maps).
  auto addSeBiasBroadcast = [&](const std::string& name, int channels) {
    struct ggml_tensor* raw =
        cloneRaw(bundle.ctx.get(), gguf, ggufCtx, name.c_str());
    registerTensor(raw);

    const int64_t shape4d[4] = {1, 1, channels, 1};
    const std::string brName = name + "_br";
    struct ggml_tensor* br = cloneAsFp32(bundle.ctx.get(), brName.c_str(), 4, shape4d);
    tensors.emplace(brName, br);
  };

  // Fold BN at load time: replaces ~34 per-inference sqrt + 4-op chains.
  auto addFoldedBn = [&](const std::string& bnPrefix, int channels) {
    const int64_t shape4d[4] = {1, 1, channels, 1};
    struct ggml_tensor* scale =
        cloneAsFp32(bundle.ctx.get(), (bnPrefix + ".scale").c_str(), 4, shape4d);
    struct ggml_tensor* shift =
        cloneAsFp32(bundle.ctx.get(), (bnPrefix + ".shift").c_str(), 4, shape4d);
    tensors.emplace(bnPrefix + ".scale", scale);
    tensors.emplace(bnPrefix + ".shift", shift);
  };

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

  addConvWeight("features.0.0.weight");
  addFoldedBn("features.0.1", STEM_OUT_CHANNELS);

  for (const BlockConfig& cfg : BLOCKS) {
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

  addConvWeight("features.12.0.weight");
  addFoldedBn("features.12.1", TAIL_OUT_CHANNELS);

  addFcWeightFp32("classifier.0.weight", TAIL_OUT_CHANNELS, CLASSIFIER_HIDDEN);
  addFcBiasFp32("classifier.0.bias", CLASSIFIER_HIDDEN);
  addFcWeightFp32("classifier.3.weight", CLASSIFIER_HIDDEN, NUM_CLASSES);
  addFcBiasFp32("classifier.3.bias", NUM_CLASSES);

  bundle.backendBuffer =
      ggml_backend_alloc_ctx_tensors(bundle.ctx.get(), backend);
  if (bundle.backendBuffer == nullptr) {
    raise("Failed to allocate backend buffer for weights");
  }

  // First pass: raw byte copies for storage-only tensors. Folded/promoted
  // tensors are filled by foldBn / foldSeBias / uploadClassifierTensor below.
  for (auto& [name, dst] : tensors) {
    if (name.ends_with(".scale") || name.ends_with(".shift") ||
        name.ends_with(".bias_br") || name == "classifier.0.weight" ||
        name == "classifier.0.bias" || name == "classifier.3.weight" ||
        name == "classifier.3.bias") {
      continue;
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
  for (const BlockConfig& cfg : BLOCKS) {
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

  auto uploadClassifierTensor = [&](const std::string& name) {
    std::vector<float> buf = loadVector1d(gguf, ggufCtx, name);
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

  // WHCN: width, height, channels, batch.
  cg.input = ggml_new_tensor_4d(ctx, GGML_TYPE_F32, INPUT_HW, INPUT_HW, 3, 1);
  ggml_set_name(cg.input, "input");

  GraphBuilder gb{ctx, weights.tensors};

  struct ggml_tensor* x = gb.convBnAct(
      cg.input, "features.0.0", "features.0.1", /*stride=*/2, /*kernel=*/3,
      /*activate=*/true, /*useHardswish=*/true);

  int spatial = INPUT_HW / 2;

  for (const BlockConfig& cfg : BLOCKS) {
    x = gb.invertedResidual(x, cfg, spatial);
    if (cfg.stride == 2) {
      spatial = (spatial + 1) / 2;
    }
  }

  x = gb.convBnAct(
      x, "features.12.0", "features.12.1", /*stride=*/1, /*kernel=*/1,
      /*activate=*/true, /*useHardswish=*/true);

  struct ggml_tensor* pooled = ggml_pool_2d(
      ctx, x, GGML_OP_POOL_AVG, spatial, spatial, spatial, spatial, 0, 0);
  struct ggml_tensor* flat = ggml_reshape_1d(ctx, pooled, TAIL_OUT_CHANNELS);

  struct ggml_tensor* fc0 = ggml_mul_mat(
      ctx, gb.t("classifier.0.weight"), flat);
  fc0 = ggml_add(ctx, fc0, gb.t("classifier.0.bias"));
  fc0 = ggml_hardswish(ctx, fc0);

  struct ggml_tensor* fc3 = ggml_mul_mat(
      ctx, gb.t("classifier.3.weight"), fc0);
  fc3 = ggml_add(ctx, fc3, gb.t("classifier.3.bias"));

  cg.output = fc3;
  ggml_set_name(cg.output, "logits");

  // The warmup and process() paths both read sizeof(float)*NUM_CLASSES
  // bytes from cg.output; mismatch silently truncates or reads OOB.
  if (ggml_nelements(cg.output) != static_cast<int64_t>(NUM_CLASSES)) {
    raise(
        "Compute graph output has " +
        std::to_string(ggml_nelements(cg.output)) + " elements, expected " +
        std::to_string(NUM_CLASSES) +
        "; classifier wiring or GGUF weight shapes are inconsistent with "
        "graph::NUM_CLASSES");
  }

  cg.graph = ggml_new_graph_custom(ctx, 8192, /*grads=*/false);
  ggml_build_forward_expand(cg.graph, cg.output);

  cg.backendBuffer = ggml_backend_alloc_ctx_tensors(ctx, backend);
  if (cg.backendBuffer == nullptr) {
    raise("Failed to allocate backend buffer for compute graph");
  }

  return cg;
}

} // namespace classification_ggml::graph
