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

// Compute mean probability within a bounding rect region (matching OnnxTR assume_straight_pages=True)
float boxScore(const cv::Mat& probMap, const cv::Rect& bbox) {
  // Clamp to image bounds (matching Python: np.clip(np.floor/ceil(...), 0, dim-1))
  int x0 = std::max(0, bbox.x);
  int y0 = std::max(0, bbox.y);
  int x1 = std::min(probMap.cols - 1, bbox.x + bbox.width);
  int y1 = std::min(probMap.rows - 1, bbox.y + bbox.height);

  if (x1 <= x0 || y1 <= y0) {
    return 0.0F;
  }

  // Simple rectangular mean (no polygon masking) - matches Python's assume_straight_pages=True
  cv::Mat roi = probMap(cv::Rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1));
  return static_cast<float>(cv::mean(roi)[0]);
}

} // namespace

StepDoctrDetection::StepDoctrDetection(const ORTCHAR_T* pathDetector, bool useGPU)
    : ortSession_(getSharedOrtEnv(), pathDetector, getOrtSessionOptions(useGPU)) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "[DoctrDetection] ONNX session created");
  ALOG_INFO(std::string("[DoctrDetection] ONNX session created"));
}

std::tuple<cv::Mat, float, int, int, int, int> StepDoctrDetection::preprocessImage(const cv::Mat& img) {
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

  // Symmetric padding to 1024x1024 (matching OnnxTR: symmetric_pad=True)
  // Center the image in the canvas with equal padding on both sides
  int deltaW = DBNET_INPUT_SIZE - newW;
  int deltaH = DBNET_INPUT_SIZE - newH;
  int padLeft = (deltaW + 1) / 2;  // ceil(deltaW / 2)
  int padTop = (deltaH + 1) / 2;   // ceil(deltaH / 2)

  cv::Mat padded = cv::Mat::zeros(DBNET_INPUT_SIZE, DBNET_INPUT_SIZE, CV_32FC3);
  cv::Mat roi = padded(cv::Rect(padLeft, padTop, newW, newH));
  floatImg.copyTo(roi);

  // Normalize: (pixel - mean) / std
  cv::subtract(padded, DOCTR_DET_MEAN, padded);
  cv::divide(padded, DOCTR_DET_STD, padded);

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DoctrDetection] Preprocessed image: " + std::to_string(w) + "x" + std::to_string(h) +
       " -> " + std::to_string(newW) + "x" + std::to_string(newH) +
       " (scale=" + std::to_string(scale) + ", pad=" + std::to_string(padLeft) + "," + std::to_string(padTop) + ")");

  return {padded, scale, newW, newH, padLeft, padTop};
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

  {
    std::string shapeStr = "[";
    for (size_t i = 0; i < outShape.size(); i++) {
      if (i > 0) shapeStr += ", ";
      shapeStr += std::to_string(outShape[i]);
    }
    shapeStr += "]";
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "[DoctrDetection] Output shape: " + shapeStr);
  }

  // Output can be [1, 1, H, W] or [1, H, W] - extract as 2D logit map
  cv::Mat logitMap;
  if (outShape.size() == 4) {
    // [batch, channels, height, width]
    int outH = static_cast<int>(outShape[2]);
    int outW = static_cast<int>(outShape[3]);
    logitMap = cv::Mat(outH, outW, CV_32F, outData).clone();
  } else if (outShape.size() == 3) {
    // [batch, height, width]
    int outH = static_cast<int>(outShape[1]);
    int outW = static_cast<int>(outShape[2]);
    logitMap = cv::Mat(outH, outW, CV_32F, outData).clone();
  } else {
    throw std::runtime_error("[DoctrDetection] Unexpected output tensor shape with " +
                             std::to_string(outShape.size()) + " dimensions");
  }

  // Apply sigmoid to convert logits to probabilities (matching Python OnnxTR's expit(logits))
  cv::Mat probMap;
  cv::exp(-logitMap, probMap);   // probMap = exp(-logits)
  probMap = 1.0F / (1.0F + probMap);  // probMap = 1 / (1 + exp(-logits)) = sigmoid(logits)

  return probMap;
}

std::pair<std::vector<std::array<cv::Point2f, 4>>, std::vector<float>>
StepDoctrDetection::extractPolygons(const cv::Mat& probMap,
                                    float scale, int paddedW, int paddedH,
                                    int padLeft, int padTop,
                                    int origW, int origH) {
  // Work on the FULL probability map (matching Python OnnxTR which does NOT crop before postprocessing)
  // The padded regions have near-zero probabilities and are filtered by box_thresh.
  int mapH = probMap.rows;
  int mapW = probMap.cols;

  // Binarize using >= threshold (matching Python: (proba_map >= bin_thresh).astype(np.uint8))
  // Note: cv::THRESH_BINARY uses >, so we subtract a tiny epsilon for >= behavior
  cv::Mat binary;
  cv::threshold(probMap, binary, BINARIZE_THRESHOLD - 1e-6F, 1.0, cv::THRESH_BINARY);
  binary.convertTo(binary, CV_8U);

  // Morphological opening to clean noise (matching Python: np.ones((3,3), uint8))
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
    // Filter by minimum size (matching Python: contour span < 2 in any dimension)
    cv::Rect bbox = cv::boundingRect(contour);
    if (bbox.width < MIN_SIZE_BOX || bbox.height < MIN_SIZE_BOX) {
      continue;
    }

    // Compute confidence score from rectangular region
    // (matching OnnxTR assume_straight_pages=True: score from boundingRect, not contour mask)
    float score = boxScore(probMap, bbox);
    if (score < BOX_THRESHOLD) {
      continue;
    }

    // Unclip: expand the bounding rect by distance = area * unclip_ratio / perimeter
    // (matching OnnxTR: polygon_to_box uses contourArea/arcLength of the RECTANGULAR points,
    //  then pyclipper expands each side by distance)
    double rectArea = static_cast<double>(bbox.width) * static_cast<double>(bbox.height);
    double rectPerimeter = 2.0 * (static_cast<double>(bbox.width) + static_cast<double>(bbox.height));
    double distance = rectArea * UNCLIP_RATIO / rectPerimeter;

    // Expand bounding rect by distance on each side (equivalent to pyclipper JT_ROUND on a rect)
    float ex0 = static_cast<float>(bbox.x) - static_cast<float>(distance);
    float ey0 = static_cast<float>(bbox.y) - static_cast<float>(distance);
    float ex1 = static_cast<float>(bbox.x + bbox.width) + static_cast<float>(distance);
    float ey1 = static_cast<float>(bbox.y + bbox.height) + static_cast<float>(distance);

    // Convert to normalized coordinates [0, 1] (matching Python's normalization by map dimensions)
    float nx0 = ex0 / static_cast<float>(mapW);
    float ny0 = ey0 / static_cast<float>(mapH);
    float nx1 = ex1 / static_cast<float>(mapW);
    float ny1 = ey1 / static_cast<float>(mapH);

    // Remove padding effect (matching Python's _remove_padding with symmetric_pad=True)
    // For h > w (tall image): x_new = (x_old - 0.5) * h/w + 0.5
    // For w > h (wide image): y_new = (y_old - 0.5) * w/h + 0.5
    if (origH > origW) {
      // Image is taller: horizontal padding was added, adjust x coordinates
      float ratio = static_cast<float>(origH) / static_cast<float>(origW);
      nx0 = (nx0 - 0.5F) * ratio + 0.5F;
      nx1 = (nx1 - 0.5F) * ratio + 0.5F;
    } else if (origW > origH) {
      // Image is wider: vertical padding was added, adjust y coordinates
      float ratio = static_cast<float>(origW) / static_cast<float>(origH);
      ny0 = (ny0 - 0.5F) * ratio + 0.5F;
      ny1 = (ny1 - 0.5F) * ratio + 0.5F;
    }

    // Clip to [0, 1] (matching Python's np.clip(loc_pred, 0, 1))
    nx0 = std::clamp(nx0, 0.0F, 1.0F);
    ny0 = std::clamp(ny0, 0.0F, 1.0F);
    nx1 = std::clamp(nx1, 0.0F, 1.0F);
    ny1 = std::clamp(ny1, 0.0F, 1.0F);

    // Convert to absolute pixel coordinates in original image
    float x0 = nx0 * static_cast<float>(origW);
    float y0 = ny0 * static_cast<float>(origH);
    float x1 = nx1 * static_cast<float>(origW);
    float y1 = ny1 * static_cast<float>(origH);

    if ((x1 - x0) < 1.0F || (y1 - y0) < 1.0F) {
      continue;
    }

    // Convert to 4-point polygon: top-left, top-right, bottom-right, bottom-left
    std::array<cv::Point2f, 4> polygon = {{
        cv::Point2f(x0, y0), cv::Point2f(x1, y0),
        cv::Point2f(x1, y1), cv::Point2f(x0, y1)
    }};

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

  auto [preprocessed, scale, paddedW, paddedH, padLeft, padTop] = preprocessImage(input.origImg);

  cv::Mat probMap = runInference(preprocessed);

  auto [polygons, confidences] = extractPolygons(
      probMap, scale, paddedW, paddedH, padLeft, padTop,
      input.origImg.cols, input.origImg.rows);

  Output output;
  output.context = input;
  output.polygons = std::move(polygons);
  output.polygonConfidences = std::move(confidences);
  output.probMap = probMap;
  output.paddedW = paddedW;
  output.paddedH = paddedH;
  output.padLeft = padLeft;
  output.padTop = padTop;

  return output;
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
