#include "Pipeline.hpp"

#include <chrono>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include "AndroidLog.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

namespace {

void validatePipelineInput(const Pipeline::Input &input) {
  // Skip validation for encoded images - they will be decoded by OpenCV
  if (input.isEncoded) {
    return;
  }
  int expectedSize = input.imageWidth * input.imageHeight * 3;
  if (input.data.size() != expectedSize) {
    std::stringstream stringStream;
    stringStream << "Received image with inconsistent raw data size. Actual: " << input.data.size() << ". Expected: " << expectedSize
       << " based on (width=" << input.imageWidth << " * height=" << input.imageHeight << " * 3 channels)";
    throw std::invalid_argument{stringStream.str()};
  }
}

cv::Mat decodeEncodedImage(const std::vector<uint8_t>& data) {
  cv::Mat encoded(1, static_cast<int>(data.size()), CV_8UC1, const_cast<uint8_t*>(data.data()));
  cv::Mat decoded = cv::imdecode(encoded, cv::IMREAD_COLOR);
  if (decoded.empty()) {
    throw std::invalid_argument{"Failed to decode image. Unsupported format or corrupted data."};
  }
  return decoded;
}

} // namespace

Pipeline::Pipeline(
    const ORTCHAR_T* pathDetector, const ORTCHAR_T* pathRecognizer,
    std::span<const std::string> langList, bool useGPU, int timeout,
    const PipelineConfig& config)
    : config_(config),
      stepDetection_(std::make_unique<StepDetectionInference>(pathDetector, useGPU, config.magRatio)),
      stepBoundingBox_(std::make_unique<StepBoundingBox>()),
      stepRecognition_(std::make_unique<StepRecognizeText>(
          pathRecognizer, langList, useGPU,
          StepRecognizeText::Config{config.defaultRotationAngles, config.contrastRetry, config.lowConfidenceThreshold, config.recognizerBatchSize})),
      timeout_(timeout) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, "[Pipeline] Sequential pipeline created (no threading)");
  ALOG_INFO(std::string("[Pipeline] Sequential pipeline created (no threading)"));

  // Log all config parameters
  std::string configMsg = "[Pipeline] Config: useGPU=" + std::string(useGPU ? "true" : "false") +
      ", timeout=" + std::to_string(timeout) +
      ", magRatio=" + std::to_string(config.magRatio) +
      ", contrastRetry=" + std::string(config.contrastRetry ? "true" : "false") +
      ", lowConfidenceThreshold=" + std::to_string(config.lowConfidenceThreshold) +
      ", recognizerBatchSize=" + std::to_string(config.recognizerBatchSize);
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, configMsg);
  ALOG_INFO(configMsg);

  std::string anglesMsg = "[Pipeline] defaultRotationAngles=[";
  for (size_t i = 0; i < config.defaultRotationAngles.size(); i++) {
    anglesMsg += std::to_string(config.defaultRotationAngles[i]);
    if (i < config.defaultRotationAngles.size() - 1) anglesMsg += ",";
  }
  anglesMsg += "]";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, anglesMsg);
  ALOG_INFO(anglesMsg);
}

std::any Pipeline::process(const std::any& input) {
  if (input.type() != typeid(Input)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Pipeline::process: unsupported input type");
  }
  return process(std::any_cast<Input>(input));
}

void Pipeline::initializeBackend() {
  // No initialization needed for sequential pipeline
}

bool Pipeline::isLoaded() const {
  return stepDetection_ && stepBoundingBox_ && stepRecognition_;
}

Pipeline::Output Pipeline::process(Pipeline::Input input) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Pipeline] Sequential process() starting");
  ALOG_DEBUG(std::string("[Pipeline] Sequential process() starting"));
  auto timeStart = std::chrono::high_resolution_clock::now();
  static constexpr double nanosecondsToSeconds = 1e9;

  try {
    validatePipelineInput(input);

    // Prepare image
    cv::Mat image;
    if (input.isEncoded) {
      cv::Mat bgr = decodeEncodedImage(input.data);
      cv::cvtColor(bgr, image, cv::COLOR_BGR2RGB);
    } else {
      image = cv::Mat(input.imageHeight, input.imageWidth, CV_8UC3, input.data.data()).clone();
    }

    // Resize image to max 1200px on longest side
    constexpr int maxInputSize = 1200;
    float initialResizeRatio = 1.0F;
    int maxDim = std::max(image.cols, image.rows);
    if (maxDim > maxInputSize) {
      initialResizeRatio =
          static_cast<float>(maxInputSize) / static_cast<float>(maxDim);
      int newWidth = static_cast<int>(static_cast<float>(image.cols) * initialResizeRatio);
      int newHeight = static_cast<int>(static_cast<float>(image.rows) * initialResizeRatio);
      cv::Mat resized;
      cv::resize(image, resized, cv::Size(newWidth, newHeight), 0, 0, cv::INTER_LINEAR);
      image = resized;
      std::string resizeMsg = "[Pipeline] Resized image from " + std::to_string(maxDim) + "px to " +
          std::to_string(std::max(newWidth, newHeight)) + "px (ratio=" + std::to_string(initialResizeRatio) + ")";
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, resizeMsg);
      ALOG_INFO(resizeMsg);
    }

    // Step 1: Detection
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Pipeline] Step 1: Running detection...");
    ALOG_INFO(std::string("[Pipeline] Step 1: Running detection..."));
    auto detectionStart = std::chrono::high_resolution_clock::now();
    StepDetectionInference::Input detectionInput{image, input.paragraph, input.rotationAngles, input.boxMarginMultiplier, initialResizeRatio};
    StepDetectionInference::Output detectionOutput = stepDetection_->process(std::move(detectionInput));
    auto detectionEnd = std::chrono::high_resolution_clock::now();
    double detectionTimeSec =
        static_cast<double>((detectionEnd - detectionStart).count()) /
        nanosecondsToSeconds;
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Pipeline] Step 1: Detection complete in " + std::to_string(detectionTimeSec) + "s");
    ALOG_INFO(std::string("[Pipeline] Step 1: Detection complete"));

    // Step 2: Bounding Box extraction
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Pipeline] Step 2: Running bounding box extraction...");
    ALOG_INFO(std::string("[Pipeline] Step 2: Running bounding box extraction..."));
    StepBoundingBox::Output boundingBoxOutput = stepBoundingBox_->process(std::move(detectionOutput));
    std::string step2Msg = "[Pipeline] Step 2: Bounding box complete (" + std::to_string(boundingBoxOutput.alignedBoxes.size()) +
         " aligned, " + std::to_string(boundingBoxOutput.unalignedBoxes.size()) + " unaligned boxes)";
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, step2Msg);
    ALOG_INFO(step2Msg);

    // Step 3: Text recognition
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Pipeline] Step 3: Running text recognition...");
    ALOG_INFO(std::string("[Pipeline] Step 3: Running text recognition..."));
    auto recognitionStart = std::chrono::high_resolution_clock::now();
    StepRecognizeText::Output recognitionOutput = stepRecognition_->process(std::move(boundingBoxOutput));
    auto recognitionEnd = std::chrono::high_resolution_clock::now();
    double recognitionTimeSec =
        static_cast<double>((recognitionEnd - recognitionStart).count()) /
        nanosecondsToSeconds;
    std::string step3Msg = "[Pipeline] Step 3: Recognition complete (" + std::to_string(recognitionOutput.size()) + " text regions) in " + std::to_string(recognitionTimeSec) + "s";
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, step3Msg);
    ALOG_INFO(step3Msg);

    // Record processing time and stats
    auto timeEnd = std::chrono::high_resolution_clock::now();
    double processingTimeSec =
        static_cast<double>((timeEnd - timeStart).count()) /
        nanosecondsToSeconds;
    {
      std::scoped_lock scopedLock(processingTimeMtx_);
      processingTime_.push(processingTimeSec);
      detectionTime_.push(detectionTimeSec);
      recognitionTime_.push(recognitionTimeSec);
      textRegionsCount_.push(static_cast<int>(recognitionOutput.size()));
    }
    std::string completeMsg = "[Pipeline] Complete in " + std::to_string(processingTimeSec) + " seconds";
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, completeMsg);
    ALOG_INFO(completeMsg);

    return recognitionOutput;

  } catch (const std::exception& e) {
    std::string errorMsg = std::string("[Pipeline] Error: ") + e.what();
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR, errorMsg);
    ALOG_ERROR(errorMsg);

    auto timeEnd = std::chrono::high_resolution_clock::now();
    {
      std::scoped_lock scopedLock(processingTimeMtx_);
      processingTime_.push(
          static_cast<double>((timeEnd - timeStart).count()) /
          nanosecondsToSeconds);
    }
    throw;
  }
}

void Pipeline::reset() {
  // No state to reset in sequential pipeline
}

qvac_lib_inference_addon_cpp::RuntimeStats Pipeline::runtimeStats() const {
  double lastProcessingTime = 0;
  double lastDetectionTime = 0;
  double lastRecognitionTime = 0;
  int lastTextRegionsCount = 0;
  {
    std::scoped_lock scopedLock(processingTimeMtx_);
    if (!processingTime_.empty()) {
      lastProcessingTime = processingTime_.top();
      processingTime_.pop();
    }
    if (!detectionTime_.empty()) {
      lastDetectionTime = detectionTime_.top();
      detectionTime_.pop();
    }
    if (!recognitionTime_.empty()) {
      lastRecognitionTime = recognitionTime_.top();
      recognitionTime_.pop();
    }
    if (!textRegionsCount_.empty()) {
      lastTextRegionsCount = textRegionsCount_.top();
      textRegionsCount_.pop();
    }
  }
  return {
    {"totalTime", lastProcessingTime},
    {"detectionTime", lastDetectionTime},
    {"recognitionTime", lastRecognitionTime},
    {"textRegionsCount", static_cast<int64_t>(lastTextRegionsCount)}
  };
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
