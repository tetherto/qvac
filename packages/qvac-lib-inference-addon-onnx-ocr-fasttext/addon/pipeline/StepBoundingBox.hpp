#pragma once

#include "Steps.hpp"

#include <opencv2/imgproc.hpp>

#include <array>
#include <utility>
#include <vector>

// number of meta fields for aligned box arrays
static constexpr size_t ALIGNED_META_SIZE = 6;

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

struct StepBoundingBox {
public:
  using Input = StepDetectionInferenceOutput;
  using Output = StepBoundingBoxesOutput;

  StepBoundingBox() = default;

  CONSTRUCT_FROM_TUPLE(StepBoundingBox)

  /**
   * @brief main processing function, transforms pixels that are likely to be text and space between text into bounding boxes information
   *
   * @param input : detector output
   * @return StepBoundingBox::Output, respectively
   *  - context: pipeline context
   *  - alignedBoxes: a vector of boxes that fit into horizontal/vertical orientation. Hence only 4 numbers are required to describe them: xStart,
   * xEnd, yStart, yEnd
   *  - unalignedBoxes: a vector of boxes that don't fit into horizontal/vertical orientation. Hence needs 8 numbers to describe them, 4 pairs of
   * coordinates
   */
  Output process(Input input);

private:
  cv::Mat textMapBinary_;
  cv::Mat linkMapBinary_;
  int nLabels_{0};
  cv::Mat labels_;
  cv::Mat stats_;

  /**
   * @brief loads connected components information to private variables.
   *
   * Each connected component is a word in the original image, created from the pixels that are likely to be text (textMap) and pixels that are likely
   * to be space connecting text (linkMap)
   *
   * @param textMap : output of detector. Matrix containing pixels that are likely to be text
   * @param linkMap : output of detector. Matrix containing pixels that are likely to be space connecting text
   */
  void loadConnectedComponents(const cv::Mat &textMap, const cv::Mat &linkMap);

  /**
   * @brief creates a box from a connected component
   *
   * @param input : detector output
   * @param component : which compoenent to extract the box from
   * @return std::array<cv::Point2f, 4> : the extracted box
   */
  std::array<cv::Point2f, 4> getBoxFromComponent(Input &input, int component);

  /**
   * @brief Creates a segmentation map for the specified component.
   *
   * The region for dilation is computed using the component's bounding box and a dynamically calculated
   * number of iterations (niter) based on the component's area and dimensions.
   *
   * @param input : image size of the detector output
   * @param component : which compoenent to extract the segmentation map from
   * @return cv::Mat The resulting binary segmentation map.
   */
  cv::Mat createSegmentationMap(cv::Size imgSize, int component);

  /**
   * @brief splits the poly list into the list of horizontally/vertically aligned boxes and the ones that aren't
   *
   * Calculates the slope between consecutive points in the poly to determine whether they can be considered as aligned or not according to
   * slopeThreshold
   *
   * Sorts the polys that are aligned according to their y center
   *
   * Further adjusts the coordinates of polys that are not aligned so that they are a rectangle
   *
   * @param polys : original list of polys
   * @return std::pair<std::vector<std::array<float, ALIGNED_META_SIZE>>, std::vector<std::array<cv::Point2f, 4>>>, respectively
   *  - the polys that are aligned. The array contains [xMin, xMax, yMin, yMax, yCenter, boxHeight]
   *  - the polys that are not aligned
   */
  std::pair<std::vector<std::array<float, ALIGNED_META_SIZE>>, std::vector<std::array<cv::Point2f, 4>>>
  static turnPolysIntoBoxes(const std::vector<std::array<cv::Point2f, 4>> &polys, float boxMarginMultiplier);

  /**
   * @brief get lists of horizontally/vertically aligned boxes that are too close together, so that they can be merged
   *
   * @param alignedBoxes : the list of aligned boxes
   * @return std::vector<std::vector<std::array<float, ALIGNED_META_SIZE>>>
   */
  std::vector<std::vector<std::array<float, ALIGNED_META_SIZE>>> static getListOfBoxesToMerge(const std::vector<std::array<float, ALIGNED_META_SIZE>> &alignedBoxes);

  /**
   * @brief merges horizontally/vertically aligned boxes that are too close together
   *
   * @param alignedBoxes
   * @return std::vector<std::array<float, 4>>
   */
  std::vector<std::array<float, 4>> static groupAndMergeAlignedBoxes(const std::vector<std::array<float, ALIGNED_META_SIZE>> &alignedBoxes, float boxMarginMultiplier);

  /**
   * @brief filters out horizontally/vertically aligned boxes that are too small
   * 
   * Also populates isMulticharacter according to the information in linkMapBinary_ in that region
   *
   * @param imgResizeRatio : the scaling ratio between linkMapBinary_ and the provided coordinates
   * @param alignedBoxes : list of aligned boxes
   * @return std::vector<AlignedBox>
   */
  std::vector<AlignedBox> getOutputAlignedBoxes(float imgResizeRatio, const std::vector<std::array<float, 4>> &mergedList);

  /**
   * @brief filters out horizontally/vertically aligned boxes, already in rectangle shape, that are too small
   * 
   * Also populates isMulticharacter according to the information in linkMapBinary_ in that region
   *
   * @param imgResizeRatio : the scaling ratio between linkMapBinary_ and the provided coordinates
   * @param unalignedBoxes : list of unaligned boxes
   * @return std::vector<UnalignedBox>
   */
  std::vector<UnalignedBox> getOutputUnalignedBoxes(float imgResizeRatio, const std::vector<std::array<cv::Point2f, 4>> &unalignedBoxes);
};

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext