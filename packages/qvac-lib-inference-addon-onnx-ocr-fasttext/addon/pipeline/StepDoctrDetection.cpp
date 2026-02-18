#include "StepDoctrDetection.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include <opencv2/opencv.hpp>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "AndroidLog.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

namespace {

// DocTR normalization constants (from HuggingFace config.json for db_resnet50)
const cv::Scalar DOCTR_DET_MEAN(0.798, 0.785, 0.772);
const cv::Scalar DOCTR_DET_STD(0.264, 0.2749, 0.287);

constexpr double PIXEL_MAX = 255.0;

// Compute mean probability within a contour region as confidence score
float boxScore(const cv::Mat& probMap, const std::vector<cv::Point>& contour) {
  cv::Rect bbox = cv::boundingRect(contour);

  // Clamp to image bounds
  int x0 = std::max(0, bbox.x);
  int y0 = std::max(0, bbox.y);
  int x1 = std::min(probMap.cols, bbox.x + bbox.width);
  int y1 = std::min(probMap.rows, bbox.y + bbox.height);

  if (x1 <= x0 || y1 <= y0) {
    return 0.0F;
  }

  cv::Mat mask = cv::Mat::zeros(y1 - y0, x1 - x0, CV_8UC1);
  std::vector<cv::Point> shifted;
  shifted.reserve(contour.size());
  for (const auto& pt : contour) {
    shifted.emplace_back(pt.x - x0, pt.y - y0);
  }
  cv::fillPoly(mask, std::vector<std::vector<cv::Point>>{shifted}, cv::Scalar(255));

  cv::Mat roi = probMap(cv::Rect(x0, y0, x1 - x0, y1 - y0));
  return static_cast<float>(cv::mean(roi, mask)[0]);
}

// Unclip a polygon by expanding it by offset = area * unclip_ratio / perimeter
std::vector<cv::Point> unclipPolygon(const std::vector<cv::Point>& polygon, float unclipRatio) {
  double area = std::abs(cv::contourArea(polygon));
  double perimeter = cv::arcLength(polygon, true);
  if (perimeter < 1e-6) {
    return polygon;
  }

  double offset = area * unclipRatio / perimeter;

  // Use morphological dilation as a simpler alternative to Clipper library
  cv::Rect bbox = cv::boundingRect(polygon);
  int margin = static_cast<int>(std::ceil(offset)) + 1;
  int maskW = bbox.width + 2 * margin;
  int maskH = bbox.height + 2 * margin;

  cv::Mat mask = cv::Mat::zeros(maskH, maskW, CV_8UC1);
  std::vector<cv::Point> shifted;
  shifted.reserve(polygon.size());
  for (const auto& pt : polygon) {
    shifted.emplace_back(pt.x - bbox.x + margin, pt.y - bbox.y + margin);
  }
  cv::fillPoly(mask, std::vector<std::vector<cv::Point>>{shifted}, cv::Scalar(255));

  // Dilate by offset
  int kernelSize = static_cast<int>(std::round(offset * 2)) + 1;
  if (kernelSize < 3) kernelSize = 3;
  cv::Mat kernel = cv::getStructuringElement(cv::MORPH_ELLIPSE, cv::Size(kernelSize, kernelSize));
  cv::Mat dilated;
  cv::dilate(mask, dilated, kernel);

  // Find contour of dilated mask
  std::vector<std::vector<cv::Point>> contours;
  cv::findContours(dilated, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);
  if (contours.empty()) {
    return polygon;
  }

  // Pick largest contour
  size_t largestIdx = 0;
  double largestArea = 0;
  for (size_t i = 0; i < contours.size(); i++) {
    double a = cv::contourArea(contours[i]);
    if (a > largestArea) {
      largestArea = a;
      largestIdx = i;
    }
  }

  // Shift back to original coordinates
  std::vector<cv::Point> result;
  result.reserve(contours[largestIdx].size());
  for (const auto& pt : contours[largestIdx]) {
    result.emplace_back(pt.x + bbox.x - margin, pt.y + bbox.y - margin);
  }
  return result;
}

// Ensure points are in clockwise order: top-left, top-right, bottom-right, bottom-left
std::array<cv::Point2f, 4> makeClockwise(cv::Point2f pts[4]) {
  // Sort by y first
  std::array<cv::Point2f, 4> sorted = {pts[0], pts[1], pts[2], pts[3]};
  std::sort(sorted.begin(), sorted.end(), [](const cv::Point2f& a, const cv::Point2f& b) {
    return a.y < b.y;
  });

  // Top two points: left one is top-left, right one is top-right
  std::array<cv::Point2f, 4> result{};
  if (sorted[0].x <= sorted[1].x) {
    result[0] = sorted[0]; // top-left
    result[1] = sorted[1]; // top-right
  } else {
    result[0] = sorted[1];
    result[1] = sorted[0];
  }

  // Bottom two points: right one is bottom-right, left one is bottom-left
  if (sorted[2].x >= sorted[3].x) {
    result[2] = sorted[2]; // bottom-right
    result[3] = sorted[3]; // bottom-left
  } else {
    result[2] = sorted[3];
    result[3] = sorted[2];
  }

  return result;
}

} // namespace

StepDoctrDetection::StepDoctrDetection(const ORTCHAR_T* pathDetector, bool useGPU)
    : ortEnv_(ORT_LOGGING_LEVEL_WARNING, "DoctrDetector"),
      ortSession_(ortEnv_, pathDetector, getOrtSessionOptions(useGPU)) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "[DoctrDetection] ONNX session created");
  ALOG_INFO(std::string("[DoctrDetection] ONNX session created"));
}

std::tuple<cv::Mat, float, int, int> StepDoctrDetection::preprocessImage(const cv::Mat& img) {
  int h = img.rows;
  int w = img.cols;
  float scale = std::min(
      static_cast<float>(DBNET_INPUT_SIZE) / static_cast<float>(h),
      static_cast<float>(DBNET_INPUT_SIZE) / static_cast<float>(w));
  int newH = static_cast<int>(static_cast<float>(h) * scale);
  int newW = static_cast<int>(static_cast<float>(w) * scale);

  cv::Mat resized;
  cv::resize(img, resized, cv::Size(newW, newH), 0, 0, cv::INTER_LINEAR);

  // Convert to float and normalize
  cv::Mat floatImg;
  resized.convertTo(floatImg, CV_32FC3, 1.0 / PIXEL_MAX);

  // Pad to 1024x1024
  cv::Mat padded = cv::Mat::zeros(DBNET_INPUT_SIZE, DBNET_INPUT_SIZE, CV_32FC3);
  cv::Mat roi = padded(cv::Rect(0, 0, newW, newH));
  floatImg.copyTo(roi);

  // Normalize: (pixel - mean) / std
  cv::subtract(padded, DOCTR_DET_MEAN, padded);
  cv::divide(padded, DOCTR_DET_STD, padded);

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DoctrDetection] Preprocessed image: " + std::to_string(w) + "x" + std::to_string(h) +
       " -> " + std::to_string(newW) + "x" + std::to_string(newH) +
       " (scale=" + std::to_string(scale) + ")");

  return {padded, scale, newW, newH};
}

cv::Mat StepDoctrDetection::runInference(const cv::Mat& preprocessed) {
  // Convert HWC to CHW format
  std::vector<cv::Mat> channels;
  cv::split(preprocessed, channels);

  int height = preprocessed.rows;
  int width = preprocessed.cols;
  int numChannels = static_cast<int>(channels.size());

  // Create CHW blob
  std::vector<float> inputData(numChannels * height * width);
  for (int c = 0; c < numChannels; c++) {
    CV_Assert(channels[c].isContinuous());
    std::memcpy(inputData.data() + c * height * width,
                channels[c].ptr<float>(),
                sizeof(float) * height * width);
  }

  std::vector<int64_t> inputShape = {1, numChannels, height, width};
  size_t inputTensorSize = inputData.size();

  Ort::MemoryInfo memInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
      memInfo, inputData.data(), inputTensorSize, inputShape.data(), inputShape.size());

  // Get input/output names from the model dynamically
  Ort::AllocatorWithDefaultOptions allocator;
  auto inputName = ortSession_.GetInputNameAllocated(0, allocator);
  auto outputName = ortSession_.GetOutputNameAllocated(0, allocator);

  const char* inputNames[] = {inputName.get()};
  const char* outputNames[] = {outputName.get()};

  std::array<Ort::Value, 1> inputTensors = {std::move(inputTensor)};

  auto outputTensors = ortSession_.Run(
      Ort::RunOptions{nullptr},
      inputNames, inputTensors.data(), 1,
      outputNames, 1);

  // Extract probability map from output
  Ort::Value& outTensor = outputTensors[0];
  auto* outData = outTensor.GetTensorMutableData<float>();
  auto typeInfo = outTensor.GetTypeInfo();
  auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();
  std::vector<int64_t> outShape = tensorInfo.GetShape();

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DoctrDetection] Output shape: [" + std::to_string(outShape[0]) +
       ", " + std::to_string(outShape[1]) +
       (outShape.size() > 2 ? ", " + std::to_string(outShape[2]) : "") +
       (outShape.size() > 3 ? ", " + std::to_string(outShape[3]) : "") + "]");

  // Output can be [1, 1, H, W] or [1, H, W] - extract as 2D probability map
  cv::Mat probMap;
  if (outShape.size() == 4) {
    // [batch, channels, height, width]
    int outH = static_cast<int>(outShape[2]);
    int outW = static_cast<int>(outShape[3]);
    probMap = cv::Mat(outH, outW, CV_32F, outData).clone();
  } else if (outShape.size() == 3) {
    // [batch, height, width]
    int outH = static_cast<int>(outShape[1]);
    int outW = static_cast<int>(outShape[2]);
    probMap = cv::Mat(outH, outW, CV_32F, outData).clone();
  } else {
    throw std::runtime_error("[DoctrDetection] Unexpected output tensor shape with " +
                             std::to_string(outShape.size()) + " dimensions");
  }

  return probMap;
}

std::pair<std::vector<std::array<cv::Point2f, 4>>, std::vector<float>>
StepDoctrDetection::extractPolygons(const cv::Mat& probMap, const cv::Mat& /*origProbMap*/,
                                    float scale, int paddedW, int paddedH,
                                    int origW, int origH) {
  // Crop probability map to the actually used region (remove padding)
  cv::Mat croppedProb = probMap(cv::Rect(0, 0,
      std::min(paddedW, probMap.cols),
      std::min(paddedH, probMap.rows)));

  // Binarize
  cv::Mat binary;
  cv::threshold(croppedProb, binary, BINARIZE_THRESHOLD, 1.0, cv::THRESH_BINARY);
  binary.convertTo(binary, CV_8U, 255);

  // Morphological opening to clean noise
  cv::Mat kernel = cv::getStructuringElement(cv::MORPH_RECT, cv::Size(3, 3));
  cv::morphologyEx(binary, binary, cv::MORPH_OPEN, kernel);

  // Find contours
  std::vector<std::vector<cv::Point>> contours;
  cv::findContours(binary, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DoctrDetection] Found " + std::to_string(contours.size()) + " contours");

  std::vector<std::array<cv::Point2f, 4>> polygons;
  std::vector<float> confidences;

  for (const auto& contour : contours) {
    // Filter by minimum size
    cv::Rect bbox = cv::boundingRect(contour);
    if (bbox.width < MIN_SIZE_BOX || bbox.height < MIN_SIZE_BOX) {
      continue;
    }

    // Compute confidence score from probability map
    float score = boxScore(croppedProb, contour);
    if (score < BOX_THRESHOLD) {
      continue;
    }

    // Unclip the polygon to expand detected regions
    std::vector<cv::Point> expanded = unclipPolygon(contour, UNCLIP_RATIO);
    if (expanded.size() < 3) {
      continue;
    }

    // Get minimum area rectangle
    cv::RotatedRect rotRect = cv::minAreaRect(expanded);
    cv::Point2f pts[4];
    rotRect.points(pts);

    // Scale back to original image coordinates
    for (int i = 0; i < 4; i++) {
      pts[i].x = std::clamp(pts[i].x / scale, 0.0F, static_cast<float>(origW));
      pts[i].y = std::clamp(pts[i].y / scale, 0.0F, static_cast<float>(origH));
    }

    // Ensure clockwise ordering
    std::array<cv::Point2f, 4> polygon = makeClockwise(pts);

    // Verify the scaled polygon is still valid (non-degenerate)
    float polyW = std::sqrt(std::pow(polygon[1].x - polygon[0].x, 2) + std::pow(polygon[1].y - polygon[0].y, 2));
    float polyH = std::sqrt(std::pow(polygon[3].x - polygon[0].x, 2) + std::pow(polygon[3].y - polygon[0].y, 2));
    if (polyW < 1.0F || polyH < 1.0F) {
      continue;
    }

    polygons.push_back(polygon);
    confidences.push_back(score);
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "[DoctrDetection] Extracted " + std::to_string(polygons.size()) + " valid polygons");

  return {polygons, confidences};
}

StepDoctrDetection::Output StepDoctrDetection::process(const Input& input) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DoctrDetection] Processing image " +
       std::to_string(input.origImg.cols) + "x" + std::to_string(input.origImg.rows));

  auto [preprocessed, scale, paddedW, paddedH] = preprocessImage(input.origImg);

  cv::Mat probMap = runInference(preprocessed);

  auto [polygons, confidences] = extractPolygons(
      probMap, probMap, scale, paddedW, paddedH,
      input.origImg.cols, input.origImg.rows);

  Output output;
  output.context = input;
  output.polygons = std::move(polygons);
  output.polygonConfidences = std::move(confidences);
  output.probMap = probMap;
  output.paddedW = paddedW;
  output.paddedH = paddedH;

  return output;
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
