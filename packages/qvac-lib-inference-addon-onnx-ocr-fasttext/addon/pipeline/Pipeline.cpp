#include "Pipeline.hpp"

#include <chrono>
#include <cmath>
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

constexpr double NANOSECONDS_TO_SECONDS = 1e9;

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
      timeout_(timeout) {

  std::string modeStr = (config.mode == PipelineMode::DOCTR) ? "DOCTR" : "EASYOCR";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "[Pipeline] Creating pipeline in " + modeStr + " mode");
  ALOG_INFO(std::string("[Pipeline] Creating pipeline in " + modeStr + " mode"));

  if (config.mode == PipelineMode::DOCTR) {
    stepDoctrDetection_ = std::make_unique<StepDoctrDetection>(pathDetector, useGPU);
    stepDoctrRecognition_ = std::make_unique<StepDoctrRecognition>(
        pathRecognizer, useGPU, config.recognizerBatchSize, config.decodingMethod);
  } else {
    stepDetection_ = std::make_unique<StepDetectionInference>(pathDetector, useGPU, config.magRatio);
    stepBoundingBox_ = std::make_unique<StepBoundingBox>();
    stepRecognition_ = std::make_unique<StepRecognizeText>(
        pathRecognizer, langList, useGPU,
        StepRecognizeText::Config{config.defaultRotationAngles, config.contrastRetry,
                                  config.lowConfidenceThreshold, config.recognizerBatchSize});
  }

  // Log all config parameters
  std::string configMsg = "[Pipeline] Config: mode=" + modeStr +
      ", useGPU=" + std::string(useGPU ? "true" : "false") +
      ", timeout=" + std::to_string(timeout) +
      ", recognizerBatchSize=" + std::to_string(config.recognizerBatchSize);
  if (config.mode == PipelineMode::EASYOCR) {
    configMsg += ", magRatio=" + std::to_string(config.magRatio) +
        ", contrastRetry=" + std::string(config.contrastRetry ? "true" : "false") +
        ", lowConfidenceThreshold=" + std::to_string(config.lowConfidenceThreshold);
  } else {
    std::string decodingStr = (config.decodingMethod == DecodingMethod::CTC) ? "CTC" : "ATTENTION";
    configMsg += ", decodingMethod=" + decodingStr +
        ", straightenPages=" + std::string(config.straightenPages ? "true" : "false");
  }
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, configMsg);
  ALOG_INFO(configMsg);

  if (config.mode == PipelineMode::EASYOCR) {
    std::string anglesMsg = "[Pipeline] defaultRotationAngles=[";
    for (size_t i = 0; i < config.defaultRotationAngles.size(); i++) {
      anglesMsg += std::to_string(config.defaultRotationAngles[i]);
      if (i < config.defaultRotationAngles.size() - 1) anglesMsg += ",";
    }
    anglesMsg += "]";
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, anglesMsg);
    ALOG_INFO(anglesMsg);
  }
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
  if (config_.mode == PipelineMode::DOCTR) {
    return stepDoctrDetection_ && stepDoctrRecognition_;
  }
  return stepDetection_ && stepBoundingBox_ && stepRecognition_;
}

Pipeline::Output Pipeline::process(Pipeline::Input input) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Pipeline] Sequential process() starting");
  ALOG_DEBUG(std::string("[Pipeline] Sequential process() starting"));
  auto timeStart = std::chrono::high_resolution_clock::now();

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

    // Resize image to max 1200px on longest side (EasyOCR only)
    // DocTR skips this because detection internally resizes to 1024x1024,
    // and recognition benefits from full-resolution crops (matching Python OnnxTR)
    constexpr int maxInputSize = 1200;
    float initialResizeRatio = 1.0F;
    if (config_.mode != PipelineMode::DOCTR) {
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
    }

    Output result;

    if (config_.mode == PipelineMode::DOCTR) {
      result = processDocTR(image, input, initialResizeRatio);
    } else {
      result = processEasyOCR(image, input, initialResizeRatio);
    }

    // Record total processing time
    auto timeEnd = std::chrono::high_resolution_clock::now();
    double processingTimeSec =
        static_cast<double>((timeEnd - timeStart).count()) /
        NANOSECONDS_TO_SECONDS;
    {
      std::scoped_lock scopedLock(processingTimeMtx_);
      processingTime_.push(processingTimeSec);
    }
    std::string completeMsg = "[Pipeline] Complete in " + std::to_string(processingTimeSec) + " seconds";
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, completeMsg);
    ALOG_INFO(completeMsg);

    return result;

  } catch (const std::exception& e) {
    std::string errorMsg = std::string("[Pipeline] Error: ") + e.what();
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR, errorMsg);
    ALOG_ERROR(errorMsg);

    auto timeEnd = std::chrono::high_resolution_clock::now();
    {
      std::scoped_lock scopedLock(processingTimeMtx_);
      processingTime_.push(
          static_cast<double>((timeEnd - timeStart).count()) /
          NANOSECONDS_TO_SECONDS);
    }
    throw;
  }
}

Pipeline::Output Pipeline::processEasyOCR(const cv::Mat& image, Input& input, float initialResizeRatio) {
  // Step 1: Detection
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Pipeline] Step 1: Running detection...");
  ALOG_INFO(std::string("[Pipeline] Step 1: Running detection..."));
  auto detectionStart = std::chrono::high_resolution_clock::now();
  StepDetectionInference::Input detectionInput{image, input.paragraph, input.rotationAngles, input.boxMarginMultiplier, initialResizeRatio};
  StepDetectionInference::Output detectionOutput = stepDetection_->process(std::move(detectionInput));
  auto detectionEnd = std::chrono::high_resolution_clock::now();
  double detectionTimeSec =
      static_cast<double>((detectionEnd - detectionStart).count()) /
      NANOSECONDS_TO_SECONDS;
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
      NANOSECONDS_TO_SECONDS;
  std::string step3Msg = "[Pipeline] Step 3: Recognition complete (" + std::to_string(recognitionOutput.size()) + " text regions) in " + std::to_string(recognitionTimeSec) + "s";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, step3Msg);
  ALOG_INFO(step3Msg);

  // Record timing stats
  {
    std::scoped_lock scopedLock(processingTimeMtx_);
    detectionTime_.push(detectionTimeSec);
    recognitionTime_.push(recognitionTimeSec);
    textRegionsCount_.push(static_cast<int>(recognitionOutput.size()));
  }

  return recognitionOutput;
}

float Pipeline::estimatePageOrientation(const cv::Mat& probMap, int paddedW, int paddedH, int padLeft, int padTop) {
  // Crop probability map to the actual content region (remove symmetric padding)
  cv::Mat croppedProb = probMap(cv::Rect(padLeft, padTop,
      std::min(paddedW, probMap.cols - padLeft),
      std::min(paddedH, probMap.rows - padTop)));

  // Binarize the probability map
  cv::Mat binary;
  cv::threshold(croppedProb, binary, 0.3, 1.0, cv::THRESH_BINARY);
  binary.convertTo(binary, CV_8U, 255);

  // Find contours
  std::vector<std::vector<cv::Point>> contours;
  cv::findContours(binary, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);

  if (contours.empty()) {
    return 0.0F;
  }

  // Collect angles from line-like contours (high aspect ratio)
  float weightedAngleSum = 0.0F;
  float totalWeight = 0.0F;

  for (const auto& contour : contours) {
    if (contour.size() < 5) {
      continue;
    }

    cv::RotatedRect rotRect = cv::minAreaRect(contour);
    float w = rotRect.size.width;
    float h = rotRect.size.height;

    // Ensure width >= height for consistent angle interpretation
    float longer = std::max(w, h);
    float shorter = std::min(w, h);

    if (shorter < 1.0F) {
      continue;
    }

    float aspectRatio = longer / shorter;

    // Only consider line-like contours (aspect ratio > 5)
    if (aspectRatio <= 5.0F) {
      continue;
    }

    // Get the angle — OpenCV minAreaRect returns angle in [-90, 0)
    float angle = rotRect.angle;

    // Normalize: if the rect is taller than wide, the long axis is the height
    // edge, which is perpendicular to the width edge (at angle - 90°)
    if (w < h) {
      angle -= 90.0F;
    }

    // Weight by contour area
    float area = static_cast<float>(cv::contourArea(contour));
    weightedAngleSum += angle * area;
    totalWeight += area;
  }

  if (totalWeight < 1e-6F) {
    return 0.0F;
  }

  float avgAngle = weightedAngleSum / totalWeight;

  // Round to nearest 90° increment
  float rounded = std::round(avgAngle / 90.0F) * 90.0F;
  // Normalize to [0, 360)
  rounded = std::fmod(rounded + 360.0F, 360.0F);

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "[Pipeline] Estimated page orientation: avg=" + std::to_string(avgAngle) +
       "° -> rounded=" + std::to_string(rounded) + "°");

  return rounded;
}

cv::Mat Pipeline::rotateImage(const cv::Mat& image, float angleDeg) {
  int angle = static_cast<int>(std::fmod(angleDeg + 360.0F, 360.0F));
  if (angle == 0) {
    return image.clone();
  }

  cv::Mat rotated;
  if (angle == 90) {
    cv::transpose(image, rotated);
    cv::flip(rotated, rotated, 1); // flip around y-axis
  } else if (angle == 180) {
    cv::flip(image, rotated, -1); // flip around both axes
  } else if (angle == 270) {
    cv::transpose(image, rotated);
    cv::flip(rotated, rotated, 0); // flip around x-axis
  } else {
    // For non-90° multiples, use affine transform (shouldn't happen with our rounding)
    cv::Point2f center(static_cast<float>(image.cols) / 2.0F,
                       static_cast<float>(image.rows) / 2.0F);
    cv::Mat rotMatrix = cv::getRotationMatrix2D(center, static_cast<double>(angleDeg), 1.0);
    cv::warpAffine(image, rotated, rotMatrix, image.size());
  }
  return rotated;
}

Pipeline::Output Pipeline::processDocTR(const cv::Mat& image, Input& input, float initialResizeRatio) {
  cv::Mat workingImage = image;

  // Step 0 (optional): Straighten pages - detect rotation and correct it
  if (config_.straightenPages) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "[Pipeline] DocTR Step 0: Running straighten_pages pre-detection...");
    ALOG_INFO(std::string("[Pipeline] DocTR Step 0: Running straighten_pages..."));

    // Run detection on original image to get probability map
    StepDoctrDetection::Input preDetInput{image, input.paragraph, input.rotationAngles,
                                          input.boxMarginMultiplier, initialResizeRatio};
    StepDoctrDetection::Output preDetOutput = stepDoctrDetection_->process(preDetInput);

    // Estimate orientation from the probability map
    float angle = estimatePageOrientation(preDetOutput.probMap,
                                          preDetOutput.paddedW, preDetOutput.paddedH,
                                          preDetOutput.padLeft, preDetOutput.padTop);

    if (angle != 0.0F) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
           "[Pipeline] Straightening page by " + std::to_string(angle) + "°");
      workingImage = rotateImage(image, angle);
    }
  }

  // Step 1: DocTR Detection (DBNet)
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Pipeline] DocTR Step 1: Running DBNet detection...");
  ALOG_INFO(std::string("[Pipeline] DocTR Step 1: Running DBNet detection..."));
  auto detectionStart = std::chrono::high_resolution_clock::now();
  StepDoctrDetection::Input detInput{workingImage, input.paragraph, input.rotationAngles,
                                     input.boxMarginMultiplier, initialResizeRatio};
  StepDoctrDetection::Output detOutput = stepDoctrDetection_->process(detInput);
  auto detectionEnd = std::chrono::high_resolution_clock::now();
  double detectionTimeSec =
      static_cast<double>((detectionEnd - detectionStart).count()) /
      NANOSECONDS_TO_SECONDS;
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[Pipeline] DocTR Step 1: Detection complete (" + std::to_string(detOutput.polygons.size()) +
       " regions) in " + std::to_string(detectionTimeSec) + "s");

  // Step 2: DocTR Recognition
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Pipeline] DocTR Step 2: Running recognition...");
  ALOG_INFO(std::string("[Pipeline] DocTR Step 2: Running recognition..."));
  auto recognitionStart = std::chrono::high_resolution_clock::now();
  StepDoctrRecognition::Output recognitionOutput = stepDoctrRecognition_->process(std::move(detOutput));
  auto recognitionEnd = std::chrono::high_resolution_clock::now();
  double recognitionTimeSec =
      static_cast<double>((recognitionEnd - recognitionStart).count()) /
      NANOSECONDS_TO_SECONDS;
  std::string stepMsg = "[Pipeline] DocTR Step 2: Recognition complete (" + std::to_string(recognitionOutput.size()) + " text regions) in " + std::to_string(recognitionTimeSec) + "s";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, stepMsg);
  ALOG_INFO(stepMsg);

  // Record timing stats
  {
    std::scoped_lock scopedLock(processingTimeMtx_);
    detectionTime_.push(detectionTimeSec);
    recognitionTime_.push(recognitionTimeSec);
    textRegionsCount_.push(static_cast<int>(recognitionOutput.size()));
  }

  return recognitionOutput;
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
