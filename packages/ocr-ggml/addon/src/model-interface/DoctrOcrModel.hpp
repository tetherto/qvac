#pragma once

#include <any>
#include <atomic>
#include <memory>
#include <span>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "OcrModel.hpp"
#include "doctr/StepDoctrDetectionGGML.hpp"
#include "doctr/StepDoctrRecognitionGGML.hpp"
#include "easyocr/pipeline/steps.hpp"

namespace qvac_lib_infer_ocr_ggml {

class DoctrOcrModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
    using Input  = OcrInput;
    using Output = std::vector<easyocr::ggml::pipeline::InferredText>;

    DoctrOcrModel(std::string pathDetector,
                  std::string pathRecognizer,
                  OcrConfig config);
    ~DoctrOcrModel() override;

    DoctrOcrModel(const DoctrOcrModel&)            = delete;
    DoctrOcrModel& operator=(const DoctrOcrModel&) = delete;
    DoctrOcrModel(DoctrOcrModel&&)                 = delete;
    DoctrOcrModel& operator=(DoctrOcrModel&&)      = delete;

    std::any process(const std::any& input) override;

    [[nodiscard]] std::string getName() const override { return "DoctrOcrGgml"; }

    [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
    runtimeStats() const override;

    void cancel() const override {
        cancelFlag_.store(true, std::memory_order_relaxed);
    }

private:
    Output processImage(const Input& input);

    OcrConfig config_;

    std::unique_ptr<doctr::ggml::pipeline::StepDoctrDetectionGGML>   detector_;
    std::unique_ptr<doctr::ggml::pipeline::StepDoctrRecognitionGGML> recognizer_;

    mutable std::atomic<bool> cancelFlag_{false};
    mutable double lastProcessMs_{0.0};
    mutable double lastDetectionMs_{0.0};
    mutable double lastRecognitionMs_{0.0};
    mutable int    lastNumBoxes_{0};
};

} // namespace qvac_lib_infer_ocr_ggml
