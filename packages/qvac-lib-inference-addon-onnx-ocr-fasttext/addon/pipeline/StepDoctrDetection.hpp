#pragma once

#include "Steps.hpp"

#include <onnxruntime_cxx_api.h>
#include <opencv2/imgproc.hpp>

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

struct StepDoctrDetection {
public:
  using Input = PipelineContext;
  using Output = StepDoctrDetectionOutput;

  static constexpr int DBNET_INPUT_SIZE = 1024;
  static constexpr float BINARIZE_THRESHOLD = 0.3F;
  static constexpr float BOX_THRESHOLD = 0.1F;
  static constexpr float UNCLIP_RATIO = 1.5F;
  static constexpr int MIN_SIZE_BOX = 2;

  explicit StepDoctrDetection(const ORTCHAR_T* pathDetector, bool useGPU = true);

  Output process(const Input& input);

private:
  Ort::Env ortEnv_;
  Ort::Session ortSession_{nullptr};

  // Preprocess: resize with aspect ratio + pad to 1024x1024, normalize with docTR stats
  // Returns: {preprocessed mat, scale, padded width, padded height}
  std::tuple<cv::Mat, float, int, int> preprocessImage(const cv::Mat& img);

  // Run ONNX inference, returns probability map
  cv::Mat runInference(const cv::Mat& preprocessed);

  // Post-process: binarize, contours, unclip, extract polygons
  // Returns polygons and their confidence scores in original image space
  std::pair<std::vector<std::array<cv::Point2f, 4>>, std::vector<float>>
  extractPolygons(const cv::Mat& probMap, const cv::Mat& origProbMap,
                  float scale, int paddedW, int paddedH,
                  int origW, int origH);
};

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
