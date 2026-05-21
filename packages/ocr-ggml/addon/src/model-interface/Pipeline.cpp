#include "Pipeline.hpp"

#include <chrono>
#include <stdexcept>
#include <utility>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml.h"

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length)
// Pipeline consolidates the EasyOCR and DocTR orchestrators into a single
// IModel adapter, mirroring `@qvac/ocr-onnx`'s `Pipeline` class. The
// mode-specific step sequences live in private `processEasyOcr` /
// `processDoctr` helpers; everything else (image decode, timing, cancel,
// runtimeStats) is shared.

namespace qvac_lib_infer_ocr_ggml {

namespace {

cv::Mat decodeOrWrapImage(const OcrInput& input) {
  if (input.isEncoded) {
    // cv::Mat constructor wants non-const void* but cv::imdecode does not
    // write through it.
    cv::Mat encoded(
        1,
        static_cast<int>(input.data.size()),
        CV_8UC1,
        const_cast<uint8_t*>( // NOLINT(cppcoreguidelines-pro-type-const-cast)
            input.data.data()));
    cv::Mat decoded = cv::imdecode(encoded, cv::IMREAD_COLOR);
    if (decoded.empty()) {
      throw std::runtime_error("ocr-ggml: failed to decode image (unsupported "
                               "format or corrupt data)");
    }
    // cv::imdecode returns BGR; the OCR pre-processing expects RGB.
    cv::cvtColor(decoded, decoded, cv::COLOR_BGR2RGB);
    return decoded;
  }

  if (input.imageWidth <= 0 || input.imageHeight <= 0 || input.data.empty()) {
    throw std::runtime_error(
        "ocr-ggml: raw image input requires positive width/height and data");
  }

  // Raw RGB bytes — wrap without copying, then clone so OcrInput can be safely
  // destroyed afterwards.
  // cv::Mat constructor wants non-const void* but we clone() before mutating.
  cv::Mat raw(
      input.imageHeight,
      input.imageWidth,
      CV_8UC3,
      const_cast<uint8_t*>( // NOLINT(cppcoreguidelines-pro-type-const-cast)
          input.data.data()));
  return raw.clone();
}

double elapsedMs(std::chrono::steady_clock::time_point start) {
  using namespace std::chrono;
  return duration_cast<duration<double, std::milli>>(
             steady_clock::now() - start)
      .count();
}

} // namespace

// TODO(clang-tidy): consider wrapping the two model paths in a small
// `OcrModelPaths { std::string detector; std::string recognizer; }` struct
// to make them un-swappable at the call site.
Pipeline::Pipeline(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    const std::string& pathDetector, const std::string& pathRecognizer,
    std::span<const std::string> langList, OcrConfig config)
    : config_(std::move(config)) {
  // Make every available ggml backend visible to the runtime. When
  // backendsDir is set, prefer the explicit search path (matches
  // translation-nmtcpp's NmtBackendsHandle behaviour); otherwise fall
  // back to ggml's default lookup.
  if (!config_.backendsDir.empty()) {
    ggml_backend_load_all_from_path(config_.backendsDir.c_str());
  } else {
    ggml_backend_load_all();
  }

  if (config_.mode == PipelineMode::DOCTR) {
    doctrDetector_ =
        std::make_unique<doctr::ggml::pipeline::StepDoctrDetectionGGML>(
            pathDetector, config_.nThreads);

    doctrRecognizer_ =
        std::make_unique<doctr::ggml::pipeline::StepDoctrRecognitionGGML>(
            pathRecognizer, config_.recognizerBatchSize);
  } else {
    recognizerBackend_ =
        ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
    if (recognizerBackend_ == nullptr) {
      throw std::runtime_error(
          "ocr-ggml: failed to init CPU ggml backend for recognizer");
    }

    if (config_.nThreads >= 0) {
      const int effective =
          (config_.nThreads == 0)
              ? easyocr::ggml::pipeline::defaultPhysicalThreadCount()
              : config_.nThreads;
      ggml_backend_cpu_set_n_threads(recognizerBackend_, effective);
    }

    easyDetector_ =
        std::make_unique<easyocr::ggml::pipeline::StepDetectionInference>(
            pathDetector, config_.magRatio, config_.nThreads);

    easyBoxer_ = std::make_unique<easyocr::ggml::pipeline::StepBoundingBox>();

    easyocr::ggml::pipeline::StepRecognizeText::Config recogConfig(
        config_.defaultRotationAngles,
        config_.contrastRetry,
        config_.lowConfidenceThreshold,
        config_.recognizerBatchSize);

    easyRecognizer_ =
        std::make_unique<easyocr::ggml::pipeline::StepRecognizeText>(
            pathRecognizer, langList, recognizerBackend_, recogConfig);
  }
}

Pipeline::~Pipeline() {
  // Destroy steps first; their tensors live in buffers owned by backends.
  // For EASYOCR mode, the detector owns its own backend and we own the
  // recognizer's. For DOCTR mode, both steps own their backends internally.
  easyRecognizer_.reset();
  easyBoxer_.reset();
  easyDetector_.reset();
  doctrRecognizer_.reset();
  doctrDetector_.reset();

  if (recognizerBackend_ != nullptr) {
    ggml_backend_free(recognizerBackend_);
    recognizerBackend_ = nullptr;
  }
}

std::any Pipeline::process(const std::any& input) {
  if (const auto* asInput = std::any_cast<OcrInput>(&input)) {
    return processImage(*asInput);
  }
  throw std::runtime_error("ocr-ggml: invalid input type (expected OcrInput)");
}

Pipeline::Output Pipeline::processImage(const Input& input) {
  cancelFlag_.store(false, std::memory_order_relaxed);

  const auto t0 = std::chrono::steady_clock::now();

  cv::Mat img = decodeOrWrapImage(input);

  Output result = (config_.mode == PipelineMode::DOCTR)
                      ? processDoctr(img, input)
                      : processEasyOcr(img, input);

  lastProcessMs_ = elapsedMs(t0);
  return result;
}

Pipeline::Output
Pipeline::processEasyOcr(const cv::Mat& img, const Input& input) {
  easyocr::ggml::pipeline::PipelineContext ctx{
      .origImg = img,
      .paragraph = input.paragraph,
      .rotationAngles = input.rotationAngles,
      .boxMarginMultiplier = input.boxMarginMultiplier,
      .initialResizeRatio = 1.0F,
  };

  const auto tDetectStart = std::chrono::steady_clock::now();
  auto detOut = easyDetector_->process(ctx);
  lastDetectionMs_ = elapsedMs(tDetectStart);

  if (cancelFlag_.load(std::memory_order_relaxed)) {
    return {};
  }

  auto bbOut = easyBoxer_->process(detOut);
  lastNumBoxes_ =
      static_cast<int>(bbOut.alignedBoxes.size() + bbOut.unalignedBoxes.size());

  if (cancelFlag_.load(std::memory_order_relaxed)) {
    return {};
  }

  const auto tRecogStart = std::chrono::steady_clock::now();
  auto texts = easyRecognizer_->process(std::move(bbOut), &cancelFlag_);
  lastRecognitionMs_ = elapsedMs(tRecogStart);

  return texts;
}

Pipeline::Output
Pipeline::processDoctr(const cv::Mat& img, const Input& input) {
  doctr::ggml::pipeline::PipelineContext ctx{
      .origImg = img,
      .paragraph = false,
      .rotationAngles = std::nullopt,
      .boxMarginMultiplier = input.boxMarginMultiplier,
      .initialResizeRatio = 1.0F,
  };

  const auto tDetectStart = std::chrono::steady_clock::now();
  auto detOut = doctrDetector_->process(ctx);
  lastDetectionMs_ = elapsedMs(tDetectStart);
  lastNumBoxes_ = static_cast<int>(detOut.polygons.size());

  if (cancelFlag_.load(std::memory_order_relaxed)) {
    return {};
  }

  const auto tRecogStart = std::chrono::steady_clock::now();
  auto texts = doctrRecognizer_->process(std::move(detOut), &cancelFlag_);
  lastRecognitionMs_ = elapsedMs(tRecogStart);

  return texts;
}

qvac_lib_inference_addon_cpp::RuntimeStats Pipeline::runtimeStats() const {
  // Seconds (totalTime/decodeTime/encodeTime) and milliseconds (TTFT) —
  // same unit convention as TranslationModel so JS-side stats objects
  // remain comparable across qvac inference addons.
  const double totalTimeSec = lastProcessMs_ / 1000.0;
  const double detectionTimeSec = lastDetectionMs_ / 1000.0;
  const double recognitionTimeSec = lastRecognitionMs_ / 1000.0;

  return {
      std::make_pair("totalTime", std::variant<double, int64_t>(totalTimeSec)),
      std::make_pair(
          "detectionTime", std::variant<double, int64_t>(detectionTimeSec)),
      std::make_pair(
          "recognitionTime", std::variant<double, int64_t>(recognitionTimeSec)),
      std::make_pair(
          "numBoxes",
          std::variant<double, int64_t>(static_cast<int64_t>(lastNumBoxes_)))};
}

} // namespace qvac_lib_infer_ocr_ggml

// NOLINTEND(readability-identifier-naming,readability-identifier-length)
