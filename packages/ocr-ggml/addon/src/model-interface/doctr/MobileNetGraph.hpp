#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml.h>

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length)
// MobileNet header exposes architecture-defined layer-dim constants and
// uses snake_case identifiers to mirror upstream PyTorch state-dict paths.

namespace qvac_lib_infer_ggml_classification::graph {

/// Per-block hyperparameters for one torchvision MobileNetV3-Large
/// `InvertedResidual` layer.
struct BlockConfig {
  int inputChannels;
  int outputChannels;
  int kernelSize;
  int expansionSize;
  bool useSe;        // squeeze-and-excite after the depthwise conv
  bool useHardswish; // false = ReLU, true = HardSwish
  int stride;        // 1 or 2
  int padding;
  int depthwiseKernel; // 3 or 5
  int seReducedChannels;
};

inline constexpr int kNumBlocks = 15;
inline constexpr std::array<BlockConfig, kNumBlocks> kBlocks = {
    {{.inputChannels = 16,
      .outputChannels = 16,
      .kernelSize = 3,
      .expansionSize = 16,
      .useSe = false,
      .useHardswish = false,
      .stride = 1,
      .padding = 1,
      .depthwiseKernel = 3,
      .seReducedChannels = 0},
     {.inputChannels = 16,
      .outputChannels = 24,
      .kernelSize = 3,
      .expansionSize = 64,
      .useSe = false,
      .useHardswish = false,
      .stride = 2,
      .padding = 1,
      .depthwiseKernel = 3,
      .seReducedChannels = 0},
     {.inputChannels = 24,
      .outputChannels = 24,
      .kernelSize = 3,
      .expansionSize = 72,
      .useSe = false,
      .useHardswish = false,
      .stride = 1,
      .padding = 1,
      .depthwiseKernel = 3,
      .seReducedChannels = 0},
     {.inputChannels = 24,
      .outputChannels = 40,
      .kernelSize = 5,
      .expansionSize = 72,
      .useSe = true,
      .useHardswish = false,
      .stride = 2,
      .padding = 2,
      .depthwiseKernel = 5,
      .seReducedChannels = 24},
     {.inputChannels = 40,
      .outputChannels = 40,
      .kernelSize = 5,
      .expansionSize = 120,
      .useSe = true,
      .useHardswish = false,
      .stride = 1,
      .padding = 2,
      .depthwiseKernel = 5,
      .seReducedChannels = 32},
     {.inputChannels = 40,
      .outputChannels = 40,
      .kernelSize = 5,
      .expansionSize = 120,
      .useSe = true,
      .useHardswish = false,
      .stride = 1,
      .padding = 2,
      .depthwiseKernel = 5,
      .seReducedChannels = 32},
     {.inputChannels = 40,
      .outputChannels = 80,
      .kernelSize = 3,
      .expansionSize = 240,
      .useSe = false,
      .useHardswish = true,
      .stride = 2,
      .padding = 1,
      .depthwiseKernel = 3,
      .seReducedChannels = 0},
     {.inputChannels = 80,
      .outputChannels = 80,
      .kernelSize = 3,
      .expansionSize = 200,
      .useSe = false,
      .useHardswish = true,
      .stride = 1,
      .padding = 1,
      .depthwiseKernel = 3,
      .seReducedChannels = 0},
     {.inputChannels = 80,
      .outputChannels = 80,
      .kernelSize = 3,
      .expansionSize = 184,
      .useSe = false,
      .useHardswish = true,
      .stride = 1,
      .padding = 1,
      .depthwiseKernel = 3,
      .seReducedChannels = 0},
     {.inputChannels = 80,
      .outputChannels = 80,
      .kernelSize = 3,
      .expansionSize = 184,
      .useSe = false,
      .useHardswish = true,
      .stride = 1,
      .padding = 1,
      .depthwiseKernel = 3,
      .seReducedChannels = 0},
     {.inputChannels = 80,
      .outputChannels = 112,
      .kernelSize = 3,
      .expansionSize = 480,
      .useSe = true,
      .useHardswish = true,
      .stride = 1,
      .padding = 1,
      .depthwiseKernel = 3,
      .seReducedChannels = 120},
     {.inputChannels = 112,
      .outputChannels = 112,
      .kernelSize = 3,
      .expansionSize = 672,
      .useSe = true,
      .useHardswish = true,
      .stride = 1,
      .padding = 1,
      .depthwiseKernel = 3,
      .seReducedChannels = 168},
     {.inputChannels = 112,
      .outputChannels = 160,
      .kernelSize = 5,
      .expansionSize = 672,
      .useSe = true,
      .useHardswish = true,
      .stride = 2,
      .padding = 2,
      .depthwiseKernel = 5,
      .seReducedChannels = 168},
     {.inputChannels = 160,
      .outputChannels = 160,
      .kernelSize = 5,
      .expansionSize = 960,
      .useSe = true,
      .useHardswish = true,
      .stride = 1,
      .padding = 2,
      .depthwiseKernel = 5,
      .seReducedChannels = 240},
     {.inputChannels = 160,
      .outputChannels = 160,
      .kernelSize = 5,
      .expansionSize = 960,
      .useSe = true,
      .useHardswish = true,
      .stride = 1,
      .padding = 2,
      .depthwiseKernel = 5,
      .seReducedChannels = 240}}};

inline constexpr int kStemOutChannels = 16;
inline constexpr int kTailOutChannels = 960;
inline constexpr int kClassifierHidden = 1280;
inline constexpr int kNumClasses = 3;
inline constexpr float kBatchNormEpsilon = 0.001F;
inline constexpr int kInputHw = 1024;

/// Owned bundle: a ggml context holding every weight tensor, plus a map from
/// GGUF tensor name to the live tensor handle. Created once at model load and
/// kept alive for the entire lifetime of the model.
struct WeightsBundle {
  std::unique_ptr<struct ggml_context, decltype(&ggml_free)> ctx{
      nullptr, ggml_free};
  std::unordered_map<std::string, struct ggml_tensor*> tensors;
  ggml_backend_buffer_t backendBuffer = nullptr;

  WeightsBundle() = default;
  WeightsBundle(const WeightsBundle&) = delete;
  WeightsBundle& operator=(const WeightsBundle&) = delete;
  WeightsBundle(WeightsBundle&& other) noexcept;
  WeightsBundle& operator=(WeightsBundle&& other) noexcept;
  ~WeightsBundle();

  void reset();
};

/// Owned compute graph + its ggml context. Input / output tensors are
/// re-used across `classify()` calls; only the input pixel data is rewritten
/// per inference.
struct ComputeGraph {
  std::unique_ptr<struct ggml_context, decltype(&ggml_free)> ctx{
      nullptr, ggml_free};
  struct ggml_cgraph* graph = nullptr;
  ggml_gallocr_t allocr = nullptr;
  struct ggml_tensor* input = nullptr;
  struct ggml_tensor* output_1 = nullptr;
  struct ggml_tensor* output_2 = nullptr;
  struct ggml_tensor* output_3 = nullptr;
  struct ggml_tensor* output_4 = nullptr;
  ggml_backend_buffer_t backendBuffer = nullptr;

  ComputeGraph() = default;
  ComputeGraph(const ComputeGraph&) = delete;
  ComputeGraph& operator=(const ComputeGraph&) = delete;
  ComputeGraph(ComputeGraph&& other) noexcept;
  ComputeGraph& operator=(ComputeGraph&& other) noexcept;
  ~ComputeGraph();

  void reset();
};

/// Loads every tensor from a GGUF file into a single ggml context attached to
/// the given backend. Throws StatusError on any I/O, parsing, or schema
/// mismatch. The returned bundle owns all memory. Additionally populates
/// `outLabels` with class names read from the `mobilenet.class_N` metadata
/// keys (or an empty vector if not present).
WeightsBundle loadWeights(
    const std::string& ggufPath, std::vector<ggml_backend_t>& backends,
    std::vector<std::string>& outLabels);

/// Builds the forward compute graph for MobileNetV3-Large using the weights
/// bundle. The returned ComputeGraph holds its own ggml_context (graph only,
/// not weights) and a pre-allocated input/output buffer on `backends`.
///
/// The graph expects the input tensor to be set via
/// `ggml_backend_tensor_set(graph.input, fp32WhcnBuffer, ...)` before each
/// `ggml_backend_graph_compute` call.
ComputeGraph
buildGraph(const WeightsBundle& weights, std::vector<ggml_backend_t>& backends);

} // namespace qvac_lib_infer_ggml_classification::graph

// NOLINTEND(readability-identifier-naming,readability-identifier-length)
