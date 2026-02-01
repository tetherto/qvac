#pragma once

#include "Steps.hpp"

#include <onnxruntime_cxx_api.h>
#include <opencv2/imgproc.hpp>

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

struct StepDetectionInference {
public:
  using Input = PipelineContext;
  using Output = StepDetectionInferenceOutput;

  explicit StepDetectionInference(
      const ORTCHAR_T* pathDetector, bool useGPU = true, float magRatio = 1.5F);

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
  Ort::Env ortEnv_;
  Ort::Session ortSession_{nullptr};

  /**
   * @brief runs ONNX inference on an image
   *
   * @param inputBlob : detector input
   * @return std::vector<Ort::Value> : ONNX inference results
   */
  std::vector<Ort::Value> runInference(cv::Mat inputBlob);
};

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
