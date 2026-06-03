#pragma once

// Pipeline — the single `qvac_lib_inference_addon_cpp::model::IModel`
// adapter for both ocr-ggml backends (EasyOCR and DocTR).
//
// Mirrors the consolidation pattern from `@qvac/ocr-onnx`'s `Pipeline`
// class: `OcrConfig::mode` (a `PipelineMode` enum) selects which set of
// steps is constructed at load time and which private helper drives
// `processImage()`.
//
// Lifetime / threading:
//   - In `EASYOCR` mode, `StepDetectionInference` and `StepRecognizeText`
//     each own their CPU backend internally; this class allocates none.
//   - In `DOCTR` mode, the detection and recognition steps own their
//     backends directly; this class does not allocate one.
//   - `process()` is serialised by the parent addon plumbing; this class
//     does not need its own mutex.
//   - `cancel()` flips an atomic flag observed between detection / boxer
//     / recognition stages.

#include <any>
#include <atomic>
#include <memory>
#include <span>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>
#include <opencv2/core.hpp>

#include "OcrBackendSelection.hpp"
#include "OcrLazyInitializeBackend.hpp"
#include "OcrTypes.hpp"
#include "doctr/StepDoctrDetectionGGML.hpp"
#include "doctr/StepDoctrRecognitionGGML.hpp"
#include "easyocr/pipeline/step_bounding_box.hpp"
#include "easyocr/pipeline/step_detection_inference.hpp"
#include "easyocr/pipeline/step_recognize_text.hpp"
#include "easyocr/pipeline/steps.hpp"

// NOLINTBEGIN(readability-identifier-naming)
// Constructor parameter pairs (pathDetector/pathRecognizer) follow the
// @qvac/ocr-onnx JS API surface and are documented at the call site.

namespace qvac_lib_infer_ocr_ggml {

class Pipeline : public qvac_lib_inference_addon_cpp::model::IModel,
                 public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  using Input = OcrInput;
  using Output = std::vector<easyocr::ggml::pipeline::InferredText>;

  Pipeline(
      const std::string& pathDetector, const std::string& pathRecognizer,
      std::span<const std::string> langList, OcrConfig config);

  ~Pipeline() override;

  Pipeline(const Pipeline&) = delete;
  Pipeline& operator=(const Pipeline&) = delete;
  Pipeline(Pipeline&&) = delete;
  Pipeline& operator=(Pipeline&&) = delete;

  std::any process(const std::any& input) override;

  [[nodiscard]] std::string getName() const override { return "Pipeline"; }

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const override;

  // The backend device that was resolved for this pipeline's inference steps.
  // Surfaced to JS (see `getBackendInfo` in AddonJs.hpp) for diagnostics and
  // exercised by the Vulkan integration test.
  [[nodiscard]] const ocr_backend_selection::BackendSelection&
  backendInfo() const {
    return backendInfo_;
  }

  void cancel() const override {
    cancelFlag_.store(true, std::memory_order_relaxed);
  }

private:
  Output processImage(const Input& input);
  Output processEasyOcr(const cv::Mat& img, const Input& input);
  Output processDoctr(const cv::Mat& img, const Input& input);

  OcrConfig config_;
  OcrBackendsHandle backendsHandle_; // must be declared after config_
  // Resolved backend device for the inference steps; populated in the ctor
  // after `backendsHandle_` has loaded the ggml backends.
  ocr_backend_selection::BackendSelection backendInfo_;

  // EasyOCR steps (constructed when config_.mode == PipelineMode::EASYOCR).
  std::unique_ptr<easyocr::ggml::pipeline::StepDetectionInference> easyDetector_;
  std::unique_ptr<easyocr::ggml::pipeline::StepBoundingBox> easyBoxer_;
  std::unique_ptr<easyocr::ggml::pipeline::StepRecognizeText> easyRecognizer_;

  // DocTR steps (constructed when config_.mode == PipelineMode::DOCTR).
  std::unique_ptr<doctr::ggml::pipeline::StepDoctrDetectionGGML> doctrDetector_;
  std::unique_ptr<doctr::ggml::pipeline::StepDoctrRecognitionGGML>
      doctrRecognizer_;

  // Per-process() timings cached for runtimeStats().
  mutable std::atomic<bool> cancelFlag_{false};
  mutable double lastProcessMs_{0.0};
  mutable double lastDetectionMs_{0.0};
  mutable double lastRecognitionMs_{0.0};
  mutable int lastNumBoxes_{0};
};

} // namespace qvac_lib_infer_ocr_ggml

// NOLINTEND(readability-identifier-naming)
