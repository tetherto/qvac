#include "Pipeline.hpp"

#include <chrono>
#include <iostream>
#include <string_view>
#include <vector>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

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
          StepRecognizeText::Config{config.defaultRotationAngles, config.contrastRetry, config.lowConfidenceThreshold})),
      timeout_(timeout) {
  std::printf("[Pipeline] Sequential pipeline created (no threading)\n");
  std::fflush(stdout);
}

Pipeline::Output Pipeline::process(
    Pipeline::Input input,
    std::function<void(const Pipeline::Output&)> callback) {
  auto output = process(std::move(input));
  if (callback) {
    callback(output);
  }
  return output;
}

void Pipeline::initializeBackend() {
  // No initialization needed for sequential pipeline
}

bool Pipeline::isLoaded() {
  return stepDetection_ && stepBoundingBox_ && stepRecognition_;
}

Pipeline::Output Pipeline::process(Pipeline::Input input) {
  std::printf("[Pipeline] Sequential process() starting\n");
  std::fflush(stdout);
  auto timeStart = std::chrono::high_resolution_clock::now();
  static constexpr double NANOSECONDS_TO_SECONDS = 1e9;

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

    // Step 1: Detection
    std::printf("[Pipeline] Step 1: Running detection...\n");
    std::fflush(stdout);
    StepDetectionInference::Input detectionInput{image, input.paragraph, input.rotationAngles, input.boxMarginMultiplier};
    StepDetectionInference::Output detectionOutput = stepDetection_->process(std::move(detectionInput));
    std::printf("[Pipeline] Step 1: Detection complete\n");
    std::fflush(stdout);

    // Step 2: Bounding Box extraction
    std::printf("[Pipeline] Step 2: Running bounding box extraction...\n");
    std::fflush(stdout);
    StepBoundingBox::Output boundingBoxOutput = stepBoundingBox_->process(std::move(detectionOutput));
    std::printf("[Pipeline] Step 2: Bounding box complete (%zu aligned, %zu unaligned boxes)\n",
                boundingBoxOutput.alignedBoxes.size(), boundingBoxOutput.unalignedBoxes.size());
    std::fflush(stdout);

    // Step 3: Text recognition
    std::printf("[Pipeline] Step 3: Running text recognition...\n");
    std::fflush(stdout);
    StepRecognizeText::Output recognitionOutput = stepRecognition_->process(std::move(boundingBoxOutput));
    std::printf("[Pipeline] Step 3: Recognition complete (%zu text regions)\n", recognitionOutput.size());
    std::fflush(stdout);

    // Record processing time
    auto timeEnd = std::chrono::high_resolution_clock::now();
    double processingTimeSec = static_cast<double>((timeEnd - timeStart).count()) / NANOSECONDS_TO_SECONDS;
    {
      std::scoped_lock scopedLock(processingTimeMtx_);
      processingTime_.push(processingTimeSec);
    }
    std::printf("[Pipeline] Complete in %.2f seconds\n", processingTimeSec);
    std::fflush(stdout);

    return recognitionOutput;

  } catch (const std::exception& e) {
    std::printf("[Pipeline] Error: %s\n", e.what());
    std::fflush(stdout);

    auto timeEnd = std::chrono::high_resolution_clock::now();
    {
      std::scoped_lock scopedLock(processingTimeMtx_);
      processingTime_.push(static_cast<double>((timeEnd - timeStart).count()) / NANOSECONDS_TO_SECONDS);
    }
    throw;
  }
}

void Pipeline::reset() {
  // No state to reset in sequential pipeline
}

qvac_lib_inference_addon_cpp::RuntimeStats Pipeline::runtimeStats() {
  double lastProcessingTime = 0;
  {
    std::scoped_lock scopedLock(processingTimeMtx_);
    if (!processingTime_.empty()) {
      lastProcessingTime = processingTime_.top();
      processingTime_.pop();
    }
  }
  return {
    {"LastProcessingTime", lastProcessingTime}
  };
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
