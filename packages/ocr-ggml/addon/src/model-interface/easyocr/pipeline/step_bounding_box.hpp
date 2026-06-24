#pragma once

// Lifted from @qvac/ocr-onnx's addon/pipeline/StepBoundingBox.hpp.
// Differences vs. the source:
//   - namespace renamed to `easyocr::ggml::pipeline`,
//   - the `CONSTRUCT_FROM_TUPLE(StepBoundingBox)` macro use is dropped
//     (this repo does not use the step-template construction pattern).

#include <array>
#include <utility>
#include <vector>

#include <opencv2/imgproc.hpp>

#include "steps.hpp"

// number of meta fields for aligned box arrays
static constexpr size_t ALIGNED_META_SIZE = 6;

namespace easyocr::ggml::pipeline {

struct StepBoundingBox {
public:
  using Input = StepDetectionInferenceOutput;
  using Output = StepBoundingBoxesOutput;

  StepBoundingBox() = default;

  /**
   * @brief main processing function, transforms pixels that are likely
   * to be text and space between text into bounding boxes information.
   */
  Output process(Input input);

private:
  cv::Mat textMapBinary_;
  cv::Mat linkMapBinary_;
  int nLabels_{0};
  cv::Mat labels_;
  cv::Mat stats_;
  cv::Mat segmap_;
  cv::Rect prevSegmapROI_;

  void loadConnectedComponents(const cv::Mat& textMap, const cv::Mat& linkMap);

  std::array<cv::Point2f, 4> getBoxFromComponent(Input& input, int component);

  cv::Mat createSegmentationMap(cv::Size imgSize, int component);

  static std::pair<
      std::vector<std::array<float, ALIGNED_META_SIZE>>,
      std::vector<std::array<cv::Point2f, 4>>>
  turnPolysIntoBoxes(
      const std::vector<std::array<cv::Point2f, 4>>& polys,
      float boxMarginMultiplier);

  static std::vector<std::vector<std::array<float, ALIGNED_META_SIZE>>>
  getListOfBoxesToMerge(
      const std::vector<std::array<float, ALIGNED_META_SIZE>>& alignedBoxes);

  static std::vector<std::array<float, 4>> groupAndMergeAlignedBoxes(
      const std::vector<std::array<float, ALIGNED_META_SIZE>>& alignedBoxes,
      float boxMarginMultiplier);

  std::vector<AlignedBox> getOutputAlignedBoxes(
      float imgResizeRatio,
      const std::vector<std::array<float, 4>>& mergedList);

  std::vector<UnalignedBox> getOutputUnalignedBoxes(
      float imgResizeRatio,
      const std::vector<std::array<cv::Point2f, 4>>& unalignedBoxes);
};

} // namespace easyocr::ggml::pipeline
