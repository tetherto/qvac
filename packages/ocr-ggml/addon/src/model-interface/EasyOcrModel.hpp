#pragma once

// EasyOcrModel — the `qvac_lib_inference_addon_cpp::model::IModel` adapter
// that composes the three EasyOcr-ggml pipeline steps (CRAFT detection,
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
#include <span>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "OcrTypes.hpp"
#include "easyocr/pipeline/step_bounding_box.hpp"
#include "easyocr/pipeline/step_detection_inference.hpp"
#include "easyocr/pipeline/step_recognize_text.hpp"
#include "easyocr/pipeline/steps.hpp"

using ggml_backend_t = struct ggml_backend*;

// NOLINTBEGIN(readability-identifier-naming)
// Constructor parameter pairs (pathDetector/pathRecognizer) follow the
// @qvac/ocr-onnx JS API surface and are documented at the call site.

namespace qvac_lib_infer_ocr_ggml {

class EasyOcrModel : public qvac_lib_inference_addon_cpp::model::IModel,
                     public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  using Input = OcrInput;
  using Output = std::vector<easyocr::ggml::pipeline::InferredText>;

  EasyOcrModel(
      const std::string& pathDetector, const std::string& pathRecognizer,
      std::span<const std::string> langList, OcrConfig config);

  ~EasyOcrModel() override;

  EasyOcrModel(const EasyOcrModel&) = delete;
  EasyOcrModel& operator=(const EasyOcrModel&) = delete;
  EasyOcrModel(EasyOcrModel&&) = delete;
  EasyOcrModel& operator=(EasyOcrModel&&) = delete;

  std::any process(const std::any& input) override;

  [[nodiscard]] std::string getName() const override { return "EasyOcrGgml"; }

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

// NOLINTEND(readability-identifier-naming)
