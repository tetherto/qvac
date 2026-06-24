#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <ggml-backend.h>
#include <ggml.h>

namespace classification_ggml::graph {

/// One torchvision MobileNetV3-Small `InvertedResidual` block.
struct BlockConfig {
  int featuresIndex;   // 1..11, matches `features.N` in the GGUF
  int inputChannels;
  int expandedChannels;
  int outputChannels;
  int depthwiseKernel; // 3 or 5
  int stride;          // 1 or 2
  bool useHardswish;   // false = ReLU
  bool useSe;
  int seReducedChannels;
};

inline constexpr int NUM_BLOCKS = 11;
inline constexpr std::array<BlockConfig, NUM_BLOCKS> BLOCKS = {{
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

inline constexpr int STEM_OUT_CHANNELS = 16;
inline constexpr int TAIL_OUT_CHANNELS = 576;
inline constexpr int CLASSIFIER_HIDDEN = 1024;
inline constexpr int NUM_CLASSES = 3;
inline constexpr float BATCH_NORM_EPSILON = 0.001F;
inline constexpr int INPUT_HW = 224;

/// ggml context + name→tensor map for every weight, plus the backing
/// backend buffer. Lives for the entire model lifetime.
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

/// Compute graph + its ggml context. Input/output tensors are reused
/// across classify() calls; only input pixel data is rewritten per call.
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

/// Loads every tensor + the `mobilenet.class_N` labels from a GGUF file.
/// `outLabels` is left empty if the metadata keys are not present.
WeightsBundle loadWeights(
    const std::string& ggufPath, ggml_backend_t backend,
    std::vector<std::string>& outLabels);

/// Build the MobileNetV3-Small forward graph. Caller writes pixels into
/// `graph.input` via `ggml_backend_tensor_set` before each compute.
ComputeGraph buildGraph(const WeightsBundle& weights, ggml_backend_t backend);

} // namespace classification_ggml::graph
