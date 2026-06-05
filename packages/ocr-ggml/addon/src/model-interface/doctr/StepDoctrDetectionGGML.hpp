#pragma once

#include <memory>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include <ggml-backend.h>
#include <ggml.h>
#include <opencv2/imgproc.hpp>

#include "DoctrPipelineTypes.hpp"
#include "MobileNetGraph.hpp"

namespace doctr::ggml::pipeline {

// DBNet text detection step backed by the GGML MobileNetV3-Large+FPN graph.
// Mirrors the pre/post-processing of @qvac/ocr-onnx's StepDoctrDetection so
// results are directly comparable between the two pipelines.
class StepDoctrDetectionGGML {
public:
  using Input = PipelineContext;
  using Output = StepDoctrDetectionOutput;

  static constexpr int DBNET_INPUT_SIZE =
      qvac_lib_infer_ggml_classification::graph::kInputHw;
  static constexpr float BINARIZE_THRESHOLD = 0.3F;
  static constexpr float BOX_THRESHOLD = 0.1F;
  static constexpr float UNCLIP_RATIO = 1.5F;
  static constexpr int MIN_SIZE_BOX = 2;

  StepDoctrDetectionGGML(StepDoctrDetectionGGML&&) = delete;
  StepDoctrDetectionGGML& operator=(StepDoctrDetectionGGML&&) = delete;

  // backendDevice: ggml device the DBNet graph runs on (selected by `Pipeline`
  // via `ocr_backend_selection`). nullptr -> CPU device (historical default).
  explicit StepDoctrDetectionGGML(
      const std::string& pathDetector, int nThreads = 0,
      ggml_backend_dev_t backendDevice = nullptr);
  ~StepDoctrDetectionGGML();

  StepDoctrDetectionGGML(const StepDoctrDetectionGGML&) = delete;
  StepDoctrDetectionGGML& operator=(const StepDoctrDetectionGGML&) = delete;

  Output process(const Input& input);

private:
  std::vector<ggml_backend_t> backends_;
  qvac_lib_infer_ggml_classification::graph::WeightsBundle weights_;
  qvac_lib_infer_ggml_classification::graph::ComputeGraph computeGraph_;
  std::vector<float> inputBuffer_;
  std::vector<float> logitBuffer_;

  // Resize + symmetric-pad to DBNET_INPUT_SIZE × DBNET_INPUT_SIZE, normalise.
  // Returns {processedMat, scale, newW, newH, padLeft, padTop}.
  static std::tuple<cv::Mat, float, int, int, int, int>
  preprocessImage(const cv::Mat& img);

  // Run the GGML DBNet graph on a preprocessed 1024×1024 float mat.
  // Returns the sigmoid probability map (single-channel CV_32F, same size).
  cv::Mat runInference(const cv::Mat& preprocessed);

  // Post-process the probability map to axis-aligned quad polygons.
  static std::pair<std::vector<std::array<cv::Point2f, 4>>, std::vector<float>>
  extractPolygons(
      const cv::Mat& probMap, float scale, int paddedW, int paddedH,
      int padLeft, int padTop, int origW, int origH);
};

} // namespace doctr::ggml::pipeline
