#include "StepDetectionInference.hpp"

#include <opencv2/opencv.hpp>

#include <algorithm>
#include <chrono>
#include <string>
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "AndroidLog.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

namespace {

// canvas_size in python
constexpr int MAX_IMAGE_SIZE = 2560;

// ratio_net in python
// not an API parameter. Controls what is the ratio in which the Detector model shrinks images
constexpr float RATIO_DETECTOR_NET = 2.0F;

constexpr int SIZE_MULTIPLE = 32;
const cv::Scalar DEFAULT_MEAN(0.485, 0.456, 0.406);
const cv::Scalar DEFAULT_VARIANCE(0.229, 0.224, 0.225);
constexpr double PIXEL_INTENSITY_MAX = 255.0;

/**
 * @brief extract textMap and linkMap from the ONNX inference results
 *
 * @param outTensor : the ONNX inference results
 * @return std::pair<cv::Mat, cv::Mat> : respectively, textMap and linkMap
 *
 * @throws std::runtime_error if the Detector inference results are not in expected format
 */
std::pair<cv::Mat, cv::Mat> extractOutputFromOrtValue(Ort::Value& ortOutput) {
  auto typeInfo = ortOutput.GetTypeInfo();
  auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();
  auto outputShape = tensorInfo.GetShape();
  float* outData = ortOutput.GetTensorMutableData<float>();

  if (outputShape.size() != 4) {
    throw std::runtime_error("Expected output tensor with 4 dimensions, got " + std::to_string(outputShape.size()));
  }

  int batch = static_cast<int>(outputShape[0]);
  int height = static_cast<int>(outputShape[1]);
  int width = static_cast<int>(outputShape[2]);
  int channels = static_cast<int>(outputShape[3]);

  if (batch != 1 || channels != 2) {
    throw std::runtime_error("Expected batch == 1 and channels == 2, got batch = " + std::to_string(batch) +
                             ", channels = " + std::to_string(channels));
  }

  std::array<int, 4> dims = {batch, height, width, channels};
  cv::Mat output4d(4, dims.data(), CV_32F, outData);

  // Remove batch dimension
  std::vector<int> newShape = {height, width};
  cv::Mat sample = output4d.reshape(channels, newShape);

  // cv::split copies data into new Mats, so ortOutput can be freed after this
  std::vector<cv::Mat> outChannels;
  cv::split(sample, outChannels);

  if (outChannels.size() != 2) {
    throw std::runtime_error("Expected exactly 2 channels after split, got " + std::to_string(outChannels.size()));
  }

  return {outChannels[0], outChannels[1]};
}

/**
 * @brief Resizes an image while preserving its aspect ratio and pads it to a
 * size that's a multiple of 32.  Returns the resized image in its original
 * depth (typically CV_8U) — float conversion is deferred to the CHW pass.
 */
std::tuple<cv::Mat, float> resizeAspectRatio(const cv::Mat &img, float magRatio) {
  int height = img.rows;
  int width = img.cols;

  float targetSize = magRatio * static_cast<float>(std::max(height, width));

  if (targetSize > MAX_IMAGE_SIZE) {
    targetSize = MAX_IMAGE_SIZE;
  }

  float inputResizeRatio = targetSize / static_cast<float>(std::max(height, width));
  int targetH = static_cast<int>(static_cast<float>(height) * inputResizeRatio);
  int targetW = static_cast<int>(static_cast<float>(width) * inputResizeRatio);

  cv::Mat proc;
  cv::resize(img, proc, cv::Size(targetW, targetH), 0, 0, cv::INTER_LINEAR);

  int targetH32 = targetH;
  int targetW32 = targetW;
  if (targetH % SIZE_MULTIPLE != 0) {
    targetH32 = targetH + (SIZE_MULTIPLE - targetH % SIZE_MULTIPLE);
  }
  if (targetW % SIZE_MULTIPLE != 0) {
    targetW32 = targetW + (SIZE_MULTIPLE - targetW % SIZE_MULTIPLE);
  }

  cv::Mat resized;
  cv::copyMakeBorder(
      proc,
      resized,
      0,
      targetH32 - targetH,
      0,
      targetW32 - targetW,
      cv::BORDER_CONSTANT,
      cv::Scalar::all(0));

  return {resized, inputResizeRatio};
}

/**
 * @brief Single-pass: uint8 HWC padded image → float32 NCHW blob with
 *        mean/variance normalization baked in.
 *
 * Replaces the previous sequence of convertTo(float) → copyMakeBorder →
 * normalizeMeanVariance (2 temp Mats from scalar ops) → cv::split (3 Mat
 * allocs) → memcpy loop, collapsing ~5 passes + ~8 temporary allocations
 * into one pass and one allocation.
 */
cv::Mat normalizeAndBuildCHW(const cv::Mat& img) {
  const int height = img.rows;
  const int width = img.cols;
  const int numChannels = img.channels();
  CV_Assert(numChannels == 3);
  const size_t totalPixels = static_cast<size_t>(height) * width;

  // Pre-compute normalization constants: result = (pixel - mean*255) * (1 /
  // (var*255))
  const float meanVals[3] = {
      static_cast<float>(DEFAULT_MEAN[0] * PIXEL_INTENSITY_MAX),
      static_cast<float>(DEFAULT_MEAN[1] * PIXEL_INTENSITY_MAX),
      static_cast<float>(DEFAULT_MEAN[2] * PIXEL_INTENSITY_MAX)};
  const float invVarVals[3] = {
      static_cast<float>(1.0 / (DEFAULT_VARIANCE[0] * PIXEL_INTENSITY_MAX)),
      static_cast<float>(1.0 / (DEFAULT_VARIANCE[1] * PIXEL_INTENSITY_MAX)),
      static_cast<float>(1.0 / (DEFAULT_VARIANCE[2] * PIXEL_INTENSITY_MAX))};

  cv::Mat chwBlob(numChannels, static_cast<int>(totalPixels), CV_32F);
  float* planes[3] = {
      chwBlob.ptr<float>(0), chwBlob.ptr<float>(1), chwBlob.ptr<float>(2)};

  if (img.depth() == CV_8U) {
    const uint8_t* src = img.ptr<uint8_t>();
    for (size_t i = 0; i < totalPixels; ++i) {
      const size_t si = i * 3;
      planes[0][i] =
          (static_cast<float>(src[si]) - meanVals[0]) * invVarVals[0];
      planes[1][i] =
          (static_cast<float>(src[si + 1]) - meanVals[1]) * invVarVals[1];
      planes[2][i] =
          (static_cast<float>(src[si + 2]) - meanVals[2]) * invVarVals[2];
    }
  } else {
    const float* src = img.ptr<float>();
    for (size_t i = 0; i < totalPixels; ++i) {
      const size_t si = i * 3;
      planes[0][i] = (src[si] - meanVals[0]) * invVarVals[0];
      planes[1][i] = (src[si + 1] - meanVals[1]) * invVarVals[1];
      planes[2][i] = (src[si + 2] - meanVals[2]) * invVarVals[2];
    }
  }

  return chwBlob.reshape(1, {1, numChannels, height, width});
}

} // namespace

StepDetectionInference::StepDetectionInference(
    const std::string& pathDetector,
    const onnx_addon::SessionConfig& sessionConfig, float magRatio)
    : magRatio_(magRatio), session_(pathDetector, sessionConfig) {}

std::vector<Ort::Value>
StepDetectionInference::runInference(cv::Mat inputBlob) {
  int dims = inputBlob.dims;
  std::vector<int64_t> inputShape(dims);
  for (int i = 0; i < dims; i++) {
    inputShape[i] = inputBlob.size[i];
  }
  assert(sizeof(float) == inputBlob.elemSize());

  onnx_addon::InputTensor input;
  input.name = "input";
  input.shape = inputShape;
  input.type = onnx_addon::TensorType::FLOAT32;
  input.data = inputBlob.ptr<float>();
  input.dataSize = inputBlob.total() * sizeof(float);

  return session_.runRaw(input);
}

StepDetectionInference::Output StepDetectionInference::process(const StepDetectionInference::Input &input) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DetectionInference] Starting - origImg size=" + std::to_string(input.origImg.cols) + "x" +
       std::to_string(input.origImg.rows) + ", channels=" + std::to_string(input.origImg.channels()) +
       ", magRatio=" + std::to_string(magRatio_));

  auto [imgResized, imgResizeRatio] = resizeAspectRatio(input.origImg, magRatio_);
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DetectionInference] After resize - size=" + std::to_string(imgResized.cols) + "x" +
       std::to_string(imgResized.rows) + ", ratio=" + std::to_string(imgResizeRatio));

  cv::Mat inputBlob = normalizeAndBuildCHW(imgResized);

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[DetectionInference] Running ONNX inference...");
  ALOG_DEBUG(std::string("[DetectionInference] Running ONNX inference..."));
  auto t0 = std::chrono::high_resolution_clock::now();
  auto ortOutputs = runInference(inputBlob);
  auto t1 = std::chrono::high_resolution_clock::now();
  auto detectionMs = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
  std::string inferenceMsg = "[DetectionInference] ONNX inference: " + std::to_string(detectionMs) + " ms";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, inferenceMsg);
  ALOG_DEBUG(inferenceMsg);

  auto [scoreText, scoreLink] = extractOutputFromOrtValue(ortOutputs[0]);
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DetectionInference] Output extracted - scoreText=" + std::to_string(scoreText.cols) + "x" +
       std::to_string(scoreText.rows) + ", scoreLink=" + std::to_string(scoreLink.cols) + "x" +
       std::to_string(scoreLink.rows));

  return {input, scoreText, scoreLink, RATIO_DETECTOR_NET / imgResizeRatio};
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
