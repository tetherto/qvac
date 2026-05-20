#pragma once

// OcrModel — the `qvac_lib_inference_addon_cpp::model::IModel` adapter that
// composes the three EasyOcr-ggml pipeline steps (CRAFT detection,
// bounding-box extraction, CRNN gen-2 recognition) into a single addon
// model with the same input/output contract as @qvac/ocr-onnx's
// `Pipeline`.
//
// Lifetime / threading:
//   - The model owns one CPU `ggml_backend` that the recognizer borrows.
//     `StepDetectionInference` continues to own its own backend internally.
//   - `process()` is serialised by the parent addon plumbing; this class
//     does not need its own mutex.
//   - `cancel()` flips an atomic flag observed between recognition batches.

#include <any>
#include <atomic>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "easyocr/pipeline/step_bounding_box.hpp"
#include "easyocr/pipeline/step_detection_inference.hpp"
#include "easyocr/pipeline/step_recognize_text.hpp"
#include "easyocr/pipeline/steps.hpp"

typedef struct ggml_backend* ggml_backend_t;

namespace qvac_lib_infer_ocr_ggml {

// Mirrors @qvac/ocr-onnx's PipelineInput so the JS side can interchangeably
// drive both addons. Either pass an encoded JPEG/PNG byte buffer (set
// `isEncoded`) or a raw RGB image with explicit width/height.
struct OcrInput {
  int imageWidth{};
  int imageHeight{};
  std::vector<uint8_t> data;
  bool isEncoded{false};
  bool paragraph{false};
  std::optional<std::vector<int>> rotationAngles;
  float boxMarginMultiplier{0.1F};
};

struct OcrConfig {
  float magRatio{1.5F};
  std::vector<int> defaultRotationAngles{90, 270};
  bool contrastRetry{false};
  float lowConfidenceThreshold{0.4F};
  int recognizerBatchSize{32};
  // <0 leave GGML default, 0 auto-detect physical cores, >0 explicit override.
  int nThreads{0};
  // Directory that holds dynamic ggml backend shared libraries (libggml-*.so).
  // Default empty -> ggml_backend_load_all() picks up backends via env / dl path.
  std::string backendsDir;
};

class OcrModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  using Input = OcrInput;
  using Output = std::vector<easyocr::ggml::pipeline::InferredText>;

  OcrModel(std::string pathDetector,
           std::string pathRecognizer,
           std::span<const std::string> langList,
           const OcrConfig& config);

  ~OcrModel() override;

  OcrModel(const OcrModel&) = delete;
  OcrModel& operator=(const OcrModel&) = delete;

  std::any process(const std::any& input) override;

  [[nodiscard]] std::string getName() const override { return "OcrGgml"; }

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const override;

  void cancel() const override {
    cancelFlag_.store(true, std::memory_order_relaxed);
  }

private:
  Output processImage(const Input& input);

  OcrConfig config_;

  // Recognizer-borrowed backend. The detector owns its own backend.
  ggml_backend_t recognizerBackend_{nullptr};

  std::unique_ptr<easyocr::ggml::pipeline::StepDetectionInference> detector_;
  std::unique_ptr<easyocr::ggml::pipeline::StepBoundingBox> boxer_;
  std::unique_ptr<easyocr::ggml::pipeline::StepRecognizeText> recognizer_;

  // Per-process() timings cached for runtimeStats().
  mutable std::atomic<bool> cancelFlag_{false};
  mutable double lastProcessMs_{0.0};
  mutable double lastDetectionMs_{0.0};
  mutable double lastRecognitionMs_{0.0};
  mutable int lastNumBoxes_{0};
};

} // namespace qvac_lib_infer_ocr_ggml
