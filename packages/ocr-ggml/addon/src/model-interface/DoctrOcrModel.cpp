#include "DoctrOcrModel.hpp"

#include <chrono>
#include <stdexcept>
#include <utility>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include "ggml.h"
#include "ggml-backend.h"

namespace qvac_lib_infer_ocr_ggml {

namespace {

cv::Mat decodeOrWrapImageDoctr(const OcrInput& input) {
    if (input.isEncoded) {
        cv::Mat encoded(1, static_cast<int>(input.data.size()), CV_8UC1,
                        const_cast<uint8_t*>(input.data.data()));
        cv::Mat decoded = cv::imdecode(encoded, cv::IMREAD_COLOR);
        if (decoded.empty()) {
            throw std::runtime_error(
                "doctr-ocr-ggml: failed to decode image");
        }
        cv::cvtColor(decoded, decoded, cv::COLOR_BGR2RGB);
        return decoded;
    }
    if (input.imageWidth <= 0 || input.imageHeight <= 0 || input.data.empty()) {
        throw std::runtime_error(
            "doctr-ocr-ggml: raw image requires positive width/height and data");
    }
    cv::Mat raw(input.imageHeight, input.imageWidth, CV_8UC3,
                const_cast<uint8_t*>(input.data.data()));
    return raw.clone();
}

double elapsedMs(std::chrono::steady_clock::time_point start) {
    using namespace std::chrono;
    return duration_cast<duration<double, std::milli>>(
               steady_clock::now() - start)
        .count();
}

} // namespace

DoctrOcrModel::DoctrOcrModel(std::string pathDetector,
                             std::string pathRecognizer,
                             const OcrConfig& config)
    : config_(config) {
    if (!config_.backendsDir.empty()) {
        ggml_backend_load_all_from_path(config_.backendsDir.c_str());
    } else {
        ggml_backend_load_all();
    }

    detector_ = std::make_unique<doctr::ggml::pipeline::StepDoctrDetectionGGML>(
        pathDetector, config_.nThreads);

    recognizer_ = std::make_unique<doctr::ggml::pipeline::StepDoctrRecognitionGGML>(
        pathRecognizer, config_.recognizerBatchSize);
}

DoctrOcrModel::~DoctrOcrModel() {
    recognizer_.reset();
    detector_.reset();
}

std::any DoctrOcrModel::process(const std::any& input) {
    if (const auto* asInput = std::any_cast<OcrInput>(&input)) {
        return processImage(*asInput);
    }
    throw std::runtime_error(
        "doctr-ocr-ggml: invalid input type (expected OcrInput)");
}

DoctrOcrModel::Output DoctrOcrModel::processImage(const Input& input) {
    cancelFlag_.store(false, std::memory_order_relaxed);

    const auto t0 = std::chrono::steady_clock::now();

    cv::Mat img = decodeOrWrapImageDoctr(input);

    doctr::ggml::pipeline::PipelineContext ctx{
        /*origImg=*/img,
        /*paragraph=*/false,
        /*rotationAngles=*/std::nullopt,
        /*boxMarginMultiplier=*/input.boxMarginMultiplier,
        /*initialResizeRatio=*/1.0F,
    };

    const auto tDetectStart = std::chrono::steady_clock::now();
    auto detOut = detector_->process(ctx);
    lastDetectionMs_ = elapsedMs(tDetectStart);
    lastNumBoxes_ = static_cast<int>(detOut.polygons.size());

    if (cancelFlag_.load(std::memory_order_relaxed)) {
        return {};
    }

    const auto tRecogStart = std::chrono::steady_clock::now();
    auto texts = recognizer_->process(std::move(detOut), &cancelFlag_);
    lastRecognitionMs_ = elapsedMs(tRecogStart);

    lastProcessMs_ = elapsedMs(t0);
    return texts;
}

qvac_lib_inference_addon_cpp::RuntimeStats DoctrOcrModel::runtimeStats() const {
    return {
        std::make_pair("totalTime",
                       std::variant<double, int64_t>(lastProcessMs_ / 1000.0)),
        std::make_pair("detectionTime",
                       std::variant<double, int64_t>(lastDetectionMs_ / 1000.0)),
        std::make_pair("recognitionTime",
                       std::variant<double, int64_t>(lastRecognitionMs_ / 1000.0)),
        std::make_pair("numBoxes",
                       std::variant<double, int64_t>(
                           static_cast<int64_t>(lastNumBoxes_)))};
}

} // namespace qvac_lib_infer_ocr_ggml
