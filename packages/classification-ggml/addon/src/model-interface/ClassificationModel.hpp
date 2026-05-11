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

namespace classification_ggml {

struct RawRgbDims {
  uint32_t width;
  uint32_t height;
  uint32_t channels;
};

/// Raw classify input. `rawRgb` present = caller-supplied RGB bytes;
/// absent = encoded JPEG/PNG, dimensions come from the decoder.
struct ClassifyInput {
  std::vector<uint8_t> data;
  std::optional<RawRgbDims> rawRgb;
  uint32_t topK = 0; // 0 = no topK filter
};

struct ClassifyResult {
  std::string label;
  float confidence;
};

/// Sorted by confidence descending.
struct ClassifyOutput {
  std::vector<ClassifyResult> results;
};

/// MobileNetV3-Small 3-class classifier on libggml's CPU backend.
class ClassificationModel
    : public qvac_lib_inference_addon_cpp::model::IModel {
public:
  explicit ClassificationModel(std::string modelPath);
  ~ClassificationModel() override;

  ClassificationModel(const ClassificationModel&) = delete;
  ClassificationModel& operator=(const ClassificationModel&) = delete;

  [[nodiscard]] std::string getName() const override;
  std::any process(const std::any& input) override;
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const override;

  /// Called from createInstance so load failures surface synchronously.
  void load();

  /// Optional addon-prebuilds root (e.g. `<addon>/prebuilds`). On Android
  /// it's combined with the BACKENDS_SUBDIR compile-time relative path to
  /// locate the per-microarch CPU variant .so files for ggml's runtime
  /// backend loader. No-op on platforms where the CPU backend is static.
  void setBackendsDir(std::string backendsDir);

private:
  std::string modelPath_;
  std::string backendsDir_;
  ggml_backend_t backend_ = nullptr;
  graph::WeightsBundle weights_;
  graph::ComputeGraph compute_;
  std::vector<std::string> labels_;
  bool loaded_ = false;
  uint64_t lastInferenceUs_ = 0;
  mutable std::mutex mutex_;
};

} // namespace classification_ggml
