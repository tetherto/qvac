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
std::pair<cv::Mat, cv::Mat> extractOutputFromOrtValue(Ort::Value &outTensor) {
  auto *outData = outTensor.GetTensorMutableData<float>();
  Ort::TypeInfo typeInfo = outTensor.GetTypeInfo();
  auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();
  std::vector<int64_t> outputShape = tensorInfo.GetShape();

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

  std::vector<cv::Mat> outChannels;
  cv::split(sample, outChannels);

  if (outChannels.size() != 2) {
    throw std::runtime_error("Expected exactly 2 channels after split, got " + std::to_string(outChannels.size()));
  }

  return {outChannels[0], outChannels[1]};
}

/**
 * @brief Resizes an image while preserving its aspect ratio and pads it to a size that's a multiple of 32.
 *
 * The image is adjusted so it fits the expected format expected by the detector model
 *
 * @param img : the input image to be resized (not modified)
 * @param magRatio : magnification ratio (1.0-2.0, higher = better for small text, slower)
 * @return std::tuple<cv::Mat, float>, respectively:
 *  - The resized and padded image
 *  - The input resizing ratio
 */
std::tuple<cv::Mat, float> resizeAspectRatio(const cv::Mat &img, float magRatio) {
  int height = img.rows;
  int width = img.cols;
  int channels = img.channels();

  float targetSize = magRatio * static_cast<float>(std::max(height, width));

  if (targetSize > MAX_IMAGE_SIZE) {
    targetSize = MAX_IMAGE_SIZE;
  }

  float inputResizeRatio = targetSize / static_cast<float>(std::max(height, width));
  float targetHf = static_cast<float>(height) * inputResizeRatio;
  int targetH = static_cast<int>(targetHf);
  float targetWf = static_cast<float>(width) * inputResizeRatio;
  int targetW = static_cast<int>(targetWf);

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

  cv::Mat resized = cv::Mat::zeros(targetH32, targetW32, CV_MAKETYPE(CV_32F, channels));

  cv::Mat procFloat;
  if (proc.type() != CV_MAKETYPE(CV_32F, channels)) {
    proc.convertTo(procFloat, CV_MAKETYPE(CV_32F, channels));
  } else {
    procFloat = proc;
  }

  cv::Mat topLeftOfResized = resized(cv::Rect(0, 0, targetW, targetH));
  procFloat.copyTo(topLeftOfResized);

  return {resized, inputResizeRatio};
}

/**
 * @brief normalize the mean and the variance of the input image
 *
 * @param inputImage : image to be normalized
 * @param mean : mean information of input image
 * @param variance : variance information of input image
 */
void normalizeMeanVariance(cv::Mat &inputImage,
                           // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                           const cv::Scalar &mean = DEFAULT_MEAN,
                           const cv::Scalar &variance = DEFAULT_VARIANCE) { /* NOLINT(bugprone-easily-swappable-parameters) */
  if (inputImage.type() != CV_MAKETYPE(CV_32F, inputImage.channels())) {
    inputImage.convertTo(inputImage, CV_MAKETYPE(CV_32F, inputImage.channels()));
  }
  cv::Scalar meanScalar(mean[0] * PIXEL_INTENSITY_MAX, mean[1] * PIXEL_INTENSITY_MAX, mean[2] * PIXEL_INTENSITY_MAX);
  cv::Scalar varianceScalar(variance[0] * PIXEL_INTENSITY_MAX, variance[1] * PIXEL_INTENSITY_MAX, variance[2] * PIXEL_INTENSITY_MAX);
  inputImage = (inputImage - meanScalar) / varianceScalar;
}

} // namespace

StepDetectionInference::StepDetectionInference(
    const ORTCHAR_T* pathDetector, bool useGPU, float magRatio)
    : magRatio_(magRatio),
      ortSession_(getSharedOrtEnv(), pathDetector, getOrtSessionOptions(useGPU)) {}

std::vector<Ort::Value> StepDetectionInference::runInference(cv::Mat inputBlob) {
  int dims = inputBlob.dims;
  std::vector<int64_t> inputShape(dims);
  for (int i = 0; i < dims; i++) {
    inputShape[i] = inputBlob.size[i];
  }
  size_t inputTensorSize = inputBlob.total();
  assert(sizeof(float) == inputBlob.elemSize());
  auto *inputData = inputBlob.ptr<float>();

  Ort::MemoryInfo memoryInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  Ort::Value inputTensor = Ort::Value::CreateTensor<float>(memoryInfo, inputData, inputTensorSize, inputShape.data(), inputShape.size());

  constexpr std::array<const char*, 1> inputNames = {"input"};
  constexpr std::array<const char*, 2> outputNames = {"output", "feature"};

  return ortSession_.Run(
      Ort::RunOptions{nullptr},
      inputNames.data(),
      &inputTensor,
      1,
      outputNames.data(),
      2);
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

  normalizeMeanVariance(imgResized);

  std::vector<cv::Mat> channels;
  cv::split(imgResized, channels);

  int height = imgResized.rows;
  int width = imgResized.cols;
  int numChannels = static_cast<int>(channels.size());
  cv::Mat chwBlob(numChannels, height * width, CV_32F);
  for (int i = 0; i < numChannels; i++) {
    CV_Assert(channels[i].isContinuous());
    memcpy(chwBlob.ptr<float>(i), channels[i].data, sizeof(float) * height * width);
  }

  cv::Mat inputBlob = chwBlob.reshape(1, {1, numChannels, height, width});

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[DetectionInference] Running ONNX inference...");
  ALOG_DEBUG(std::string("[DetectionInference] Running ONNX inference..."));
  auto t0 = std::chrono::high_resolution_clock::now();
  std::vector<Ort::Value> outputTensors = runInference(inputBlob);
  auto t1 = std::chrono::high_resolution_clock::now();
  auto detectionMs = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
  std::string inferenceMsg = "[DetectionInference] ONNX inference: " + std::to_string(detectionMs) + " ms";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, inferenceMsg);
  ALOG_DEBUG(inferenceMsg);

  auto [scoreText, scoreLink] = extractOutputFromOrtValue(outputTensors[0]);
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DetectionInference] Output extracted - scoreText=" + std::to_string(scoreText.cols) + "x" +
       std::to_string(scoreText.rows) + ", scoreLink=" + std::to_string(scoreLink.cols) + "x" +
       std::to_string(scoreLink.rows));

  return {input, scoreText, scoreLink, RATIO_DETECTOR_NET / imgResizeRatio};
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
