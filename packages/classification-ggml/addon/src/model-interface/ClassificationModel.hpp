#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <variant>
#include <vector>

#include <ggml-backend.h>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>

#include "MobileNetGraph.hpp"

namespace qvac_lib_infer_ggml_classification {

/// Dimensions for the raw-RGB classify path. Only populated when the
/// caller explicitly provides `{ width, height, channels }` from JS;
/// for an encoded JPEG/PNG buffer this struct is absent and the
/// decoder picks the dimensions itself.
struct RawRgbDims {
  uint32_t width;
  uint32_t height;
  uint32_t channels; // validated == 3 at the binding boundary
};

/// Raw input accepted by the model. The two paths are distinguished by
/// whether `rawRgb` is set:
///   - rawRgb has_value()  -> `data` is already-decoded WHC RGB bytes
///                            with the dimensions in `rawRgb`.
///   - rawRgb empty        -> `data` is an encoded JPEG/PNG buffer; the
///                            preprocessor decodes and reads the
///                            dimensions from the file.
/// This avoids the previous sentinel-zero convention (`width = 0`
/// meant "not provided") that conflated the encoded path with a
/// degenerate raw-input shape.
struct ClassifyInput {
  std::vector<uint8_t> data;
  std::optional<RawRgbDims> rawRgb;
  // 0 = caller did not request a topK filter, return every class.
  // Any positive value is validated > 0 at the binding boundary.
  uint32_t topK = 0;
};

/// A single `{ label, confidence }` classification result entry.
struct ClassifyResult {
  std::string label;
  float confidence;
};

/// Aggregated output returned by `process()`. Softmax probabilities, always
/// sorted by confidence descending.
struct ClassifyOutput {
  std::vector<ClassifyResult> results;
};

/// MobileNetV3-Small 3-class image classification model backed by libggml's
/// CPU backend. Owns the GGUF weights, the static compute graph, and the
/// pre-allocated input/output tensors. Thread-safety is provided by the
/// AddonCpp JobRunner (one job at a time per instance), with an internal
/// mutex guarding `process()` so independent instances remain safe.
class ClassificationModel
    : public qvac_lib_inference_addon_cpp::model::IModel {
public:
  explicit ClassificationModel(std::string modelPath);
  ~ClassificationModel() override;

  ClassificationModel(const ClassificationModel&) = delete;
  ClassificationModel& operator=(const ClassificationModel&) = delete;

  // IModel contract.
  [[nodiscard]] std::string getName() const override;
  std::any process(const std::any& input) override;
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const override;

  /// Explicit loader. Called by AddonJs during createInstance so load failures
  /// surface synchronously before the job runner accepts any input.
  void load();

  /// Hint the total CPU threads to use for the ggml compute graph. 0 keeps
  /// libggml's default (usually std::thread::hardware_concurrency).
  void setNumThreads(int threads);

private:
  // Direct members instead of a PIMPL struct: the addon is internal,
  // ggml types only flow into this header (not into any package
  // consumer), and a flat layout is easier to navigate. Field
  // ordering matters for destruction: ggml requires every buffer
  // (compute graph + weights bundle) to be released BEFORE the
  // backend they were allocated on, and ~ClassificationModel honours
  // that ordering explicitly. The mutex is the last member declared
  // because clang-tidy prefers initialised-before-used ordering and
  // the mutex protects access to all of the above.
  std::string modelPath_;
  ggml_backend_t backend_ = nullptr;
  graph::WeightsBundle weights_;
  graph::ComputeGraph compute_;
  std::vector<std::string> labels_;
  int numThreads_ = 0;
  bool loaded_ = false;
  uint64_t lastInferenceUs_ = 0;
  mutable std::mutex mutex_;
};

} // namespace qvac_lib_infer_ggml_classification
