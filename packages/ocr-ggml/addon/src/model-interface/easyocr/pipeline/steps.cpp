// Lifted verbatim from @qvac/ocr-onnx's addon/pipeline/Steps.cpp, except for:
//   - namespace renamed to `easyocr::ggml::pipeline`,
//   - the Windows ORT-leak workaround removed (no Ort::Session here).

#include "steps.hpp"

#include <algorithm>
#include <cmath>
#include <sstream>
#include <string>
#include <thread>

#include <opencv2/opencv.hpp>

namespace easyocr::ggml::pipeline {

std::string InferredText::toString() const {
  std::stringstream stringStream;
  stringStream << "Inferred text: '" << text
               << "', confidence: " << confidenceScore << ", bounding box: [";
  for (size_t i = 0; i < boxCoordinates.size(); ++i) {
    stringStream << "(" << boxCoordinates.at(i).x << ", "
                 << boxCoordinates.at(i).y << ")";
    if (i != boxCoordinates.size() - 1) {
      stringStream << ", ";
    }
  }
  stringStream << "]";
  return stringStream.str();
}

cv::Mat fourPointTransform(
    const cv::Mat& image, const std::array<cv::Point2f, 4>& rect) {
  cv::Point2f topLeft = rect[0];
  cv::Point2f topRight = rect[1];
  cv::Point2f bottomRight = rect[2];
  cv::Point2f bottomLeft = rect[3];

  const auto widthA = static_cast<float>(std::sqrt(
      std::pow(bottomRight.x - bottomLeft.x, 2) +
      std::pow(bottomRight.y - bottomLeft.y, 2)));
  const auto widthB = static_cast<float>(std::sqrt(
      std::pow(topRight.x - topLeft.x, 2) +
      std::pow(topRight.y - topLeft.y, 2)));
  const int maxWidth =
      std::max(static_cast<int>(widthA), static_cast<int>(widthB));

  const auto heightA = static_cast<float>(std::sqrt(
      std::pow(topRight.x - bottomRight.x, 2) +
      std::pow(topRight.y - bottomRight.y, 2)));
  const auto heightB = static_cast<float>(std::sqrt(
      std::pow(topLeft.x - bottomLeft.x, 2) +
      std::pow(topLeft.y - bottomLeft.y, 2)));
  const int maxHeight =
      std::max(static_cast<int>(heightA), static_cast<int>(heightB));

  if (maxWidth <= 0 || maxHeight <= 0) {
    return cv::Mat();
  }

  std::array<cv::Point2f, 4> destination = {
      {cv::Point2f(0.0F, 0.0F),
       cv::Point2f(static_cast<float>(maxWidth - 1), 0.0F),
       cv::Point2f(
           static_cast<float>(maxWidth - 1), static_cast<float>(maxHeight - 1)),
       cv::Point2f(0.0F, static_cast<float>(maxHeight - 1))}};

  cv::Mat perspectiveTransform =
      cv::getPerspectiveTransform(rect.data(), destination.data());
  cv::Mat warpedImg;
  cv::warpPerspective(
      image, warpedImg, perspectiveTransform, cv::Size(maxWidth, maxHeight));
  return warpedImg;
}

int defaultPhysicalThreadCount() {
  const unsigned hc = std::thread::hardware_concurrency();
  if (hc <= 1) {
    return 1;
  }
  return std::max(1, static_cast<int>(hc / 2));
}

} // namespace easyocr::ggml::pipeline
