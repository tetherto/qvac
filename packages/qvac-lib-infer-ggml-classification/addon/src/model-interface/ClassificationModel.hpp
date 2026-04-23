#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <variant>
#include <vector>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>

namespace qvac_lib_infer_ggml_classification {

/// Raw input accepted by the model: either an encoded JPEG/PNG buffer, or
/// already-decoded RGB bytes carrying their dimensions.
struct ClassifyInput {
  std::vector<uint8_t> data;
  // Raw pixel path: width/height/channels are set. Encoded path leaves them
  // at 0 and lets the decoder pick the right dimensions.
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t channels = 0;
  // topK from caller; 0 means "return every class".
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
  struct Impl;
  std::unique_ptr<Impl> impl_;
  mutable std::mutex mutex_;
};

} // namespace qvac_lib_infer_ggml_classification
