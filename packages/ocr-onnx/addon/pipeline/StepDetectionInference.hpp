#pragma once

#include <opencv2/imgproc.hpp>
#include <qvac-onnx/OnnxSession.hpp>

#include "Steps.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

struct StepDetectionInference {
public:
  using Input = PipelineContext;
  using Output = StepDetectionInferenceOutput;

  explicit StepDetectionInference(
      const std::string& pathDetector,
      const onnx_addon::SessionConfig& sessionConfig = {},
      float magRatio = 1.5F);

#if defined(_WIN32) || defined(_WIN64)
  // On Windows, defer session destruction to avoid the ORT global-state crash.
  ~StepDetectionInference() { deferWindowsSessionLeak(std::move(session_)); }
#endif

  CONSTRUCT_FROM_TUPLE(StepDetectionInference)

  /**
   * @brief main processing function. Transforms an image into two maps containing pixels that are likely to, respectively, be text and space
   * connecting text
   *
   * @param input
   * @return StepDetectionInference::Output, respectively:
   *  - pipeline context
   *  - textMap (pixels that are likely to be text)
   *  - linkMap (pixels that are likely to be space between text)
   *  - ratioW: the horizontal ratio in which textMap and linkMap are resized according to the original image
   *  - ratioH: the vertical ratio in which textMap and linkMap are resized according to the original image
   */
  Output process(const Input &input);

private:
  float magRatio_;
  onnx_addon::OnnxSession session_;

  /**
   * @brief runs ONNX inference on an image
   *
   * @param inputBlob : detector input
   * @return std::vector<Ort::Value> : raw ONNX inference results (zero-copy)
   */
  std::vector<Ort::Value> runInference(cv::Mat inputBlob);
};

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
