#include "Pipeline.hpp"

#include <chrono>
#include <stdexcept>
#include <utility>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

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

  int matType = 0;
  int expectedBytesPerPixel = 0;
  // NOLINTBEGIN(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
  switch (input.bitsPerPixel) {
    case 8:
      matType = CV_8UC1;
      expectedBytesPerPixel = 1;
      break;
    case 24:
      matType = CV_8UC3;
      expectedBytesPerPixel = 3;
      break;
    case 32:
      matType = CV_8UC4;
      expectedBytesPerPixel = 4;
      break;
    default:
      throw std::runtime_error(
          "ocr-ggml: unsupported raw image bitsPerPixel " +
          std::to_string(input.bitsPerPixel) +
          " (only 8 / 24 / 32 are supported)");
  }
  // NOLINTEND(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)

  const size_t expectedBytes = static_cast<size_t>(input.imageWidth) *
                               static_cast<size_t>(input.imageHeight) *
                               static_cast<size_t>(expectedBytesPerPixel);
  if (input.data.size() != expectedBytes) {
    throw std::runtime_error(
        "ocr-ggml: raw image data size mismatch (expected " +
        std::to_string(expectedBytes) + " bytes for " +
        std::to_string(input.imageWidth) + "x" +
        std::to_string(input.imageHeight) + " @ " +
        std::to_string(input.bitsPerPixel) + "bpp, got " +
        std::to_string(input.data.size()) + ")");
  }

  // Wrap as a non-owning cv::Mat. OcrInput is passed by const& through
  // Pipeline::process and lives for the synchronous duration of processImage,
  // so this view is safe to use until processImage returns.
  cv::Mat raw(
      input.imageHeight,
      input.imageWidth,
      matType,
      const_cast<uint8_t*>( // NOLINT(cppcoreguidelines-pro-type-const-cast)
          input.data.data()));

  // Normalise to a 3-channel image; downstream steps expect CV_8UC3.
  // 24bpp is the historical fast path — pass through unchanged.
  if (matType == CV_8UC3) {
    return raw;
  }
  cv::Mat rgb;
  if (matType == CV_8UC1) {
    cv::cvtColor(raw, rgb, cv::COLOR_GRAY2RGB);
  } else { // CV_8UC4
    cv::cvtColor(raw, rgb, cv::COLOR_BGRA2RGB);
  }
  return rgb;
}

double elapsedMs(std::chrono::steady_clock::time_point start) {
  using namespace std::chrono;
  return duration_cast<duration<double, std::milli>>(
             steady_clock::now() - start)
      .count();
}

} // namespace

Pipeline::Pipeline(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    const std::string& pathDetector, const std::string& pathRecognizer,
    std::span<const std::string> langList, OcrConfig config)
    : config_(std::move(config)), backendsHandle_(config_.backendsDir) {

  // `backendsHandle_` (above) has loaded all ggml backends, so it is now safe
  // to enumerate devices and resolve the requested backend. The resolved
  // device is handed to every inference step; CPU is selected when VULKAN was
  // requested but unavailable (see OcrBackendSelection).
  backendInfo_ = ocr_backend_selection::selectBackendDevice(
      config_.backendDevice, config_.gpuDevice);
  ggml_backend_dev_t selectedDevice = backendInfo_.device;

  if (config_.mode == PipelineMode::DOCTR) {
    doctrDetector_ =
        std::make_unique<doctr::ggml::pipeline::StepDoctrDetectionGGML>(
            pathDetector, config_.nThreads, selectedDevice);

    doctrRecognizer_ =
        std::make_unique<doctr::ggml::pipeline::StepDoctrRecognitionGGML>(
            pathRecognizer,
            config_.recognizerBatchSize,
            doctr::ggml::pipeline::DecodingMethod::CTC,
            selectedDevice,
            config_.nThreads);
  } else {
    easyDetector_ =
        std::make_unique<easyocr::ggml::pipeline::StepDetectionInference>(
            pathDetector,
            config_.magRatio,
            config_.nThreads,
            config_.backendsDir,
            config_.canvasSize,
            selectedDevice);

    easyBoxer_ = std::make_unique<easyocr::ggml::pipeline::StepBoundingBox>();

    easyocr::ggml::pipeline::StepRecognizeText::Config recogConfig(
        config_.defaultRotationAngles,
        config_.contrastRetry,
        config_.lowConfidenceThreshold,
        config_.recognizerBatchSize,
        config_.nThreads,
        config_.backendsDir);
    recogConfig.backendDevice = selectedDevice;

    easyRecognizer_ =
        std::make_unique<easyocr::ggml::pipeline::StepRecognizeText>(
            pathRecognizer, langList, recogConfig);
  }
}

Pipeline::~Pipeline() {
  // Destroy steps first; their tensors live in buffers owned by backends.
  // Each step owns its backend internally.
  easyRecognizer_.reset();
  easyBoxer_.reset();
  easyDetector_.reset();
  doctrRecognizer_.reset();
  doctrDetector_.reset();
}

std::any Pipeline::process(const std::any& input) {
  if (const auto* asInput = std::any_cast<OcrInput>(&input)) {
    return processImage(*asInput);
  }
  throw std::runtime_error("ocr-ggml: invalid input type (expected OcrInput)");
}

Pipeline::Output Pipeline::processImage(const Input& input) {
  cancelFlag_.store(false, std::memory_order_relaxed);

  const auto startTime = std::chrono::steady_clock::now();

  cv::Mat img = decodeOrWrapImage(input);

  Output result = (config_.mode == PipelineMode::DOCTR)
                      ? processDoctr(img, input)
                      : processEasyOcr(img, input);

  lastProcessMs_ = elapsedMs(startTime);
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

  // `RuntimeStats` values are numeric only (variant<double,int64_t>), so the
  // human-readable backend name / device type are surfaced via `backendInfo()`
  // / `getBackendInfo` instead. `backendIsGpu` is a 0/1 flag that lets JS
  // consumers (and the Vulkan integration test) detect whether inference ran
  // on a GPU (Vulkan) device or fell back to CPU without a string channel.
  const int64_t backendIsGpu = backendInfo_.selectedIsCpu() ? 0 : 1;

  return {
      std::make_pair("totalTime", std::variant<double, int64_t>(totalTimeSec)),
      std::make_pair(
          "detectionTime", std::variant<double, int64_t>(detectionTimeSec)),
      std::make_pair(
          "recognitionTime", std::variant<double, int64_t>(recognitionTimeSec)),
      std::make_pair(
          "numBoxes",
          std::variant<double, int64_t>(static_cast<int64_t>(lastNumBoxes_))),
      std::make_pair(
          "backendIsGpu", std::variant<double, int64_t>(backendIsGpu))};
}

} // namespace qvac_lib_infer_ocr_ggml

