#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <ggml-backend.h>
#include <ggml.h>

namespace qvac_lib_infer_ggml_classification::graph {

/// Per-block hyperparameters for one torchvision MobileNetV3-Small
/// `InvertedResidual` layer, reconstructed from the bundled GGUF weights so
/// the C++ graph matches the ONNX reference line-for-line.
struct BlockConfig {
  int featuresIndex;   // 1..11 (matches `features.N` in the GGUF)
  int inputChannels;
  int expandedChannels;
  int outputChannels;
  int depthwiseKernel; // 3 or 5
  int stride;          // 1 or 2
  bool useHardswish;   // false = ReLU, true = HardSwish
  bool useSe;          // squeeze-and-excite after the depthwise conv
  int seReducedChannels;
};

/// Static MobileNetV3-Small configuration. Matches `torchvision.models
/// .mobilenet_v3_small` with the 3-class classifier head used by the bundled
/// GGUF weights. Kept here as a named constant table so reviewers can check
/// it against the published architecture without chasing magic numbers.
inline constexpr int kNumBlocks = 11;
inline constexpr std::array<BlockConfig, kNumBlocks> kBlocks = {{
    // idx  inC  expC  outC  k  s  hs     se     seR
    {1, 16, 16, 16, 3, 2, false, true, 8},
    {2, 16, 72, 24, 3, 2, false, false, 0},
    {3, 24, 88, 24, 3, 1, false, false, 0},
    {4, 24, 96, 40, 5, 2, true, true, 24},
    {5, 40, 240, 40, 5, 1, true, true, 64},
    {6, 40, 240, 40, 5, 1, true, true, 64},
    {7, 40, 120, 48, 5, 1, true, true, 32},
    {8, 48, 144, 48, 5, 1, true, true, 40},
    {9, 48, 288, 96, 5, 2, true, true, 72},
    {10, 96, 576, 96, 5, 1, true, true, 144},
    {11, 96, 576, 96, 5, 1, true, true, 144},
}};

inline constexpr int kStemOutChannels = 16;
inline constexpr int kTailOutChannels = 576;
inline constexpr int kClassifierHidden = 1024;
inline constexpr int kNumClasses = 3;
inline constexpr float kBatchNormEpsilon = 0.001F;
inline constexpr int kInputHw = 224;

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
  struct ggml_tensor* input = nullptr;
  struct ggml_tensor* output = nullptr;
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
    const std::string& ggufPath, ggml_backend_t backend,
    std::vector<std::string>& outLabels);

/// Builds the forward compute graph for MobileNetV3-Small using the weights
/// bundle. The returned ComputeGraph holds its own ggml_context (graph only,
/// not weights) and a pre-allocated input/output buffer on `backend`.
///
/// The graph expects the input tensor to be set via
/// `ggml_backend_tensor_set(graph.input, fp32WhcnBuffer, ...)` before each
/// `ggml_backend_graph_compute` call.
ComputeGraph buildGraph(const WeightsBundle& weights, ggml_backend_t backend);

} // namespace qvac_lib_infer_ggml_classification::graph
