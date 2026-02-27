#include "StepBoundingBox.hpp"

#include <opencv2/opencv.hpp>

#include <algorithm>
#include <string>
#include <numeric>
#include <limits>
#include <iterator>

#include <cmath>
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

namespace {

// low-text in python
constexpr float TEXT_CLIP_VALUE = 0.4F;

// link_threshold in python
constexpr float LINK_CLIP_VALUE = 0.4F;

// text_threshold in python
constexpr float MIN_TEXT_VALUE_REQUIRED_IN_COMPONENT = 0.7F;

// min text area to be considered a valid text during initial extraction
// Set very low to allow small words like "or" to be extracted and merged
// (ExecutorTorch approach: extract first, merge, then filter)
constexpr int MIN_TEXT_AREA_EXTRACT = 5;

// min_size in python - applied AFTER merging (like ExecutorTorch's removeSmallBoxesFromArray)
constexpr int MIN_SIZE = 20;

// slope_ths in python
constexpr float SLOPE_THRESHOLD = 0.1F;

// ycenter_ths in python
// Maximum shift in y direction. Boxes with different level should not be merged
constexpr float Y_CENTER_MAX_DEVIATION = 0.5F;
constexpr double DIAMOND_RATIO_TOL = 0.1;
constexpr int UINT8_MAX_VAL = 255;
constexpr float HALF = 0.5F;
constexpr float MARGIN_SCALE = 1.44F;
constexpr float MIN_DELTA_FOR_SLOPE = 10.0F;
// indices for aligned box metadata arrays
constexpr size_t IDX_X_MIN = 0;
constexpr size_t IDX_X_MAX = 1;
constexpr size_t IDX_Y_MIN = 2;
constexpr size_t IDX_Y_MAX = 3;
constexpr size_t IDX_Y_CENTER = 4;
constexpr size_t IDX_BOX_HEIGHT = 5;

// height_ths in python
// Maximum different in box height. Boxes with very different text size should not be merged.
constexpr float MAX_BOX_HEIGHT_DEVIATION = 0.5F;

// width_ths in python
// Maximum horizontal distance to merge boxes.
constexpr float MAX_BOX_HORIZONTAL_MERGE_DISTANCE = 0.5F;  // Match EasyOCR default (was 1.0F)

// Maximum width for merged boxes to prevent excessive compression in recognizer.
// Based on recognizer input 512x64, with 15% margin like ExecutorTorch.
// kMaxWidth = kLargeRecognizerWidth + (kLargeRecognizerWidth * 0.15) = 512 + 76.8 = 588
constexpr float MAX_MERGED_BOX_WIDTH = 588.0F;



/**
 * @brief scales the values of the points in box
 *
 * @param box : box to have the points coordinates scaled
 * @param ratio : ratio to scale the points
 */
void scaleCoordinates(std::array<cv::Point2f, 4> &box, float ratio) {
  for (auto &coordinate : box) {
    coordinate.x *= ratio;
    coordinate.y *= ratio;
  }
}

/**
 * @brief converts a generic cv::Point2f pointer into an std::array
 *
 * @param box : generic cv::Point2f pointer with 4 elements
 * @return std::array<cv::Point2f, 4>
 */
/**
 * @brief modifies the order of points in box so they are in clockwise order, starting with the top-left most point
 *
 * @param box : box to have the order of points rearranged
 */
void makeClockwiseOrder(std::array<cv::Point2f,4>& box) {
  float minSum = box.at(0).x + box.at(0).y;
  int startIndex = 0;
  for (int i = 1; i < 4; i++) {
    float currSum = box.at(i).x + box.at(i).y;
    if (minSum > currSum) {
      minSum = currSum;
      startIndex = i;
    }
  }
  std::rotate(box.begin(), box.begin() + startIndex, box.end());
}

/**
 * @brief transforms a polygon that may be in any orientation into a horizontally or vertically aligned box if it is already close to being aligned
 *
 * @param box : box to be populated with the results
 * @param poly : generic polygon to be transformed
 */
void alignDiamondShape(std::array<cv::Point2f,4>& box, std::vector<cv::Point> &segMapPoints) {
  const double width = cv::norm(box.at(0) - box.at(1));
  const double height = cv::norm(box.at(1) - box.at(2));
  const double boxRatio = std::max(width, height) / (std::min(width, height) + 1e-5);
  if (std::abs(1.0 - boxRatio) <= DIAMOND_RATIO_TOL /* NOLINT(readability-magic-numbers,cppcoreguidelines-avoid-magic-numbers) */) {
    const auto [minXIt, maxXIt] =
        std::minmax_element(segMapPoints.begin(), segMapPoints.end(), [](const cv::Point &pointA, const cv::Point &pointB) { return pointA.x < pointB.x; });
    const auto [minYIt, maxYIt] =
        std::minmax_element(segMapPoints.begin(), segMapPoints.end(), [](const cv::Point &pointA, const cv::Point &pointB) { return pointA.y < pointB.y; });
    box.at(0) = cv::Point2f(static_cast<float>(minXIt->x), static_cast<float>(minYIt->y));
    box.at(1) = cv::Point2f(static_cast<float>(maxXIt->x), static_cast<float>(minYIt->y));
    box.at(2) = cv::Point2f(static_cast<float>(maxXIt->x), static_cast<float>(maxYIt->y));
    box.at(3) = cv::Point2f(static_cast<float>(minXIt->x), static_cast<float>(maxYIt->y));
  } else {
    makeClockwiseOrder(box);
  }
}

} // namespace

void StepBoundingBox::loadConnectedComponents(const cv::Mat &textMap, const cv::Mat &linkMap) { /* NOLINT(bugprone-easily-swappable-parameters) */
  cv::threshold(textMap, textMapBinary_, TEXT_CLIP_VALUE, 1, cv::THRESH_BINARY);
  cv::threshold(linkMap, linkMapBinary_, LINK_CLIP_VALUE, 1, cv::THRESH_BINARY);
  cv::Mat textScoreComb;
  cv::bitwise_or(textMapBinary_, linkMapBinary_, textScoreComb);
  cv::Mat textScoreComb8U;
  textScoreComb.convertTo(textScoreComb8U, CV_8U, UINT8_MAX_VAL);
  cv::Mat centroids;
  nLabels_ = cv::connectedComponentsWithStats(textScoreComb8U, labels_, stats_, centroids, 4);
}

StepBoundingBox::Output StepBoundingBox::process(StepBoundingBox::Input input) {
  loadConnectedComponents(input.textMap, input.linkMap);

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[BoundingBox] nLabels=" + std::to_string(nLabels_) + ", textMap size=" +
       std::to_string(input.textMap.cols) + "x" + std::to_string(input.textMap.rows) +
       ", linkMap size=" + std::to_string(input.linkMap.cols) + "x" + std::to_string(input.linkMap.rows));

  // ExecutorTorch approach: extract all components first (with low area threshold),
  // merge them, then filter small boxes after merging.
  // This allows small words like "or" to be merged with adjacent text before filtering.
  std::vector<std::array<cv::Point2f, 4>> listOfBoxes;
  for (int i = 1; i < nLabels_; i++) {
    // Use low area threshold to allow small components to be extracted and merged
    if (stats_.at<int>(i, cv::CC_STAT_AREA) < MIN_TEXT_AREA_EXTRACT) {
      continue;
    }

    double maxVal = std::numeric_limits<double>::quiet_NaN();
    cv::minMaxLoc(input.textMap, nullptr, &maxVal, nullptr, nullptr, (labels_ == i));

    if (maxVal < MIN_TEXT_VALUE_REQUIRED_IN_COMPONENT) {
      continue;
    }

    listOfBoxes.push_back(getBoxFromComponent(input, i));
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[BoundingBox] Found " + std::to_string(listOfBoxes.size()) + " raw boxes from components");

  auto [alignedBoxes, unalignedBoxes] = turnPolysIntoBoxes(listOfBoxes, input.context.boxMarginMultiplier);
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[BoundingBox] After turnPolysIntoBoxes: " + std::to_string(alignedBoxes.size()) +
       " aligned, " + std::to_string(unalignedBoxes.size()) + " unaligned");

  std::vector<std::array<float, 4>> mergedAlignedBoxes = groupAndMergeAlignedBoxes(alignedBoxes, input.context.boxMarginMultiplier);
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[BoundingBox] After merge: " + std::to_string(mergedAlignedBoxes.size()) + " merged aligned boxes");

  std::vector<AlignedBox> outputAlignedBoxes = getOutputAlignedBoxes(input.imgResizeRatio, mergedAlignedBoxes);
  std::vector<UnalignedBox> outputUnalignedBoxes = getOutputUnalignedBoxes(input.imgResizeRatio, unalignedBoxes);

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[BoundingBox] Final output: " + std::to_string(outputAlignedBoxes.size()) + " aligned, " +
       std::to_string(outputUnalignedBoxes.size()) + " unaligned (imgResizeRatio=" +
       std::to_string(input.imgResizeRatio) + ")");

  return {input.context, outputAlignedBoxes, outputUnalignedBoxes};
}

std::array<cv::Point2f, 4> StepBoundingBox::getBoxFromComponent(Input &input, int component) {
  cv::Mat segmap = createSegmentationMap(input.textMap.size(), component);

  std::vector<cv::Point> nonZeroPoints;
  cv::findNonZero(segmap, nonZeroPoints);
  cv::RotatedRect rectangle = cv::minAreaRect(nonZeroPoints);
  std::array<cv::Point2f,4> box;
  cv::Point2f tmp[4]; /* NOLINT(modernize-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays,hicpp-avoid-c-arrays) */
  rectangle.points(tmp); /* NOLINT(hicpp-no-array-decay) */
  std::copy(std::begin(tmp), std::end(tmp), box.begin());

  alignDiamondShape(box, nonZeroPoints);
  std::array<cv::Point2f, 4> convertedBox = box;
  scaleCoordinates(convertedBox, input.imgResizeRatio);
  return convertedBox;
}

cv::Mat StepBoundingBox::createSegmentationMap(cv::Size imgSize, int component) {
  cv::Mat segmap = cv::Mat::zeros(imgSize, CV_8U);
  cv::Mat mask = (labels_ == component);
  segmap.setTo(UINT8_MAX_VAL, mask);

  cv::Mat linkMask = (linkMapBinary_ == UINT8_MAX_VAL) & (textMapBinary_ == 0);
  segmap.setTo(0, linkMask);

  const int leftX = stats_.at<int>(component, cv::CC_STAT_LEFT);
  const int topY = stats_.at<int>(component, cv::CC_STAT_TOP);
  const int width = stats_.at<int>(component, cv::CC_STAT_WIDTH);
  const int height = stats_.at<int>(component, cv::CC_STAT_HEIGHT);
  const int area = stats_.at<int>(component, cv::CC_STAT_AREA);

  const int niter = static_cast<const int>(sqrt(area * std::min(width, height) / (width * height)) * 2);

  const int startX = std::max(leftX - niter, 0);
  const int endX = std::min(leftX + width + niter + 1, imgSize.width);
  const int startY = std::max(topY - niter, 0);
  const int endY = std::min(topY + height + niter + 1, imgSize.height);

  cv::Mat kernel = cv::getStructuringElement(cv::MORPH_RECT, {1 + niter, 1 + niter});
  cv::Rect regionOfInterest(startX, startY, endX - startX, endY - startY);
  cv::Mat segRoi = segmap(regionOfInterest);
  cv::dilate(segRoi, segRoi, kernel);
  return segmap;
}

std::pair<std::vector<std::array<float, ALIGNED_META_SIZE>>, std::vector<std::array<cv::Point2f, 4>>>
StepBoundingBox::turnPolysIntoBoxes(const std::vector<std::array<cv::Point2f, 4>> &polys, float boxMarginMultiplier) {
  std::vector<std::array<float, ALIGNED_META_SIZE>> alignedBoxes;
  std::vector<std::array<cv::Point2f, 4>> unalignedBoxes;

  for (const auto &poly : polys) {
    const float slopeUp = (poly[1].y - poly[0].y) / std::max(MIN_DELTA_FOR_SLOPE, poly[1].x - poly[0].x);
    const float slopeDown = (poly[2].y - poly[3].y) / std::max(MIN_DELTA_FOR_SLOPE, poly[2].x - poly[3].x);

    if (std::max(std::abs(slopeUp), std::abs(slopeDown)) < SLOPE_THRESHOLD) {
      const float xMax = std::max({poly[0].x, poly[1].x, poly[2].x, poly[3].x});
      const float xMin = std::min({poly[0].x, poly[1].x, poly[2].x, poly[3].x});
      const float yMax = std::max({poly[0].y, poly[1].y, poly[2].y, poly[3].y});
      const float yMin = std::min({poly[0].y, poly[1].y, poly[2].y, poly[3].y});
      const float yCenter = HALF * (yMin + yMax);
      const float boxHeight = yMax - yMin;
      alignedBoxes.push_back({xMin, xMax, yMin, yMax, yCenter, boxHeight});
    } else {
      const auto heightVal = static_cast<float>(std::sqrt(std::pow(poly[3].x - poly[0].x, 2) + std::pow(poly[3].y - poly[0].y, 2)));
      const auto widthVal = static_cast<float>(std::sqrt(std::pow(poly[1].x - poly[0].x, 2) + std::pow(poly[1].y - poly[0].y, 2)));

      int margin = static_cast<int>(MARGIN_SCALE * boxMarginMultiplier * std::min(widthVal, heightVal));

      const float theta13 = std::abs(std::atan((poly[0].y - poly[2].y) / std::max(MIN_DELTA_FOR_SLOPE, poly[0].x - poly[2].x)));
      const float theta24 = std::abs(std::atan((poly[1].y - poly[3].y) / std::max(MIN_DELTA_FOR_SLOPE, poly[1].x - poly[3].x)));

      const float xOne = poly[0].x - std::cos(theta13) * static_cast<float>(margin);
      const float yOne = poly[0].y - std::sin(theta13) * static_cast<float>(margin);
      const float xTwo = poly[1].x + std::cos(theta24) * static_cast<float>(margin);
      const float yTwo = poly[1].y - std::sin(theta24) * static_cast<float>(margin);
      const float xThree = poly[2].x + std::cos(theta13) * static_cast<float>(margin);
      const float yThree = poly[2].y + std::sin(theta13) * static_cast<float>(margin);
      const float xFour = poly[3].x - std::cos(theta24) * static_cast<float>(margin);
      const float yFour = poly[3].y + std::sin(theta24) * static_cast<float>(margin);

      unalignedBoxes.push_back({cv::Point2f(xOne, yOne), cv::Point2f(xTwo, yTwo), cv::Point2f(xThree, yThree), cv::Point2f(xFour, yFour)});
    }
  }

  auto isSmallerYCenter = [](const std::array<float, ALIGNED_META_SIZE> &boxA, const std::array<float, ALIGNED_META_SIZE> &boxB) { return boxA[IDX_Y_CENTER] < boxB[IDX_Y_CENTER]; };
  std::sort(alignedBoxes.begin(), alignedBoxes.end(), isSmallerYCenter);

  return {alignedBoxes, unalignedBoxes};
}

std::vector<std::vector<std::array<float, ALIGNED_META_SIZE>>> StepBoundingBox::getListOfBoxesToMerge(const std::vector<std::array<float, ALIGNED_META_SIZE>> &alignedBoxes) {
  std::vector<std::vector<std::array<float, ALIGNED_META_SIZE>>> combinedList;
  std::vector<std::array<float, ALIGNED_META_SIZE>> currentGroup;
  float sumBoxHeight = 0.0F;
  float sumBoxYCenter = 0.0F;
  size_t count = 0;

  for (const auto &box : alignedBoxes) {
    if (currentGroup.empty()) {
      currentGroup.push_back(box);
      sumBoxHeight = box[IDX_BOX_HEIGHT];
      sumBoxYCenter = box[IDX_Y_CENTER];
      count = 1;
    } else {
      float meanBoxYCenter = sumBoxYCenter / static_cast<float>(count);
      float meanBoxHeight = sumBoxHeight / static_cast<float>(count);

      if (std::abs(meanBoxYCenter - box[IDX_Y_CENTER]) < Y_CENTER_MAX_DEVIATION * meanBoxHeight) {
        currentGroup.push_back(box);
        sumBoxHeight += box[IDX_BOX_HEIGHT];
        sumBoxYCenter += box[IDX_Y_CENTER];
        count++;
      } else {
        combinedList.push_back(std::move(currentGroup));
        currentGroup.clear();
        currentGroup.push_back(box);
        sumBoxHeight = box[IDX_BOX_HEIGHT];
        sumBoxYCenter = box[IDX_Y_CENTER];
        count = 1;
      }
    }
  }
  if (!currentGroup.empty()) {
    combinedList.push_back(std::move(currentGroup));
  }
  return combinedList;
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
std::vector<std::array<float, 4>> StepBoundingBox::groupAndMergeAlignedBoxes(const std::vector<std::array<float, ALIGNED_META_SIZE>> &alignedBoxes, float boxMarginMultiplier) {
  auto combinedList = getListOfBoxesToMerge(alignedBoxes);
  std::vector<std::array<float, 4>> mergedList;

  for (auto &boxes : combinedList) {
    if (boxes.size() == 1) {
      const auto &box = boxes[0];
      const int margin = static_cast<int>(boxMarginMultiplier * std::min(box[1] - box[0], box[IDX_BOX_HEIGHT]));
      mergedList.push_back({box[0] - static_cast<float>(margin), box[1] + static_cast<float>(margin), box[2] - static_cast<float>(margin), box[3] + static_cast<float>(margin)});
    } else {
      std::sort(boxes.begin(), boxes.end(), [](const std::array<float, ALIGNED_META_SIZE> &boxA, const std::array<float, ALIGNED_META_SIZE> &boxB) { return boxA[0] < boxB[0]; });

      std::vector<std::vector<std::array<float, ALIGNED_META_SIZE>>> mergedGroups;
      std::vector<std::array<float, ALIGNED_META_SIZE>> currentGroup;
      float sumGroupHeight = 0.0F;
      size_t groupCount = 0;
      float currentXMax = 0.0F;

      for (const auto &box : boxes) {
        if (currentGroup.empty()) {
          currentGroup.push_back(box);
          sumGroupHeight = box[IDX_BOX_HEIGHT];
          groupCount = 1;
          currentXMax = box[1];
        } else {
          const float meanGroupHeight = sumGroupHeight / static_cast<float>(groupCount);
          bool heightSimilar = (std::abs(meanGroupHeight - box[IDX_BOX_HEIGHT]) < MAX_BOX_HEIGHT_DEVIATION * meanGroupHeight);
          bool horizontallyClose = ((box[0] - currentXMax) < MAX_BOX_HORIZONTAL_MERGE_DISTANCE * (box[3] - box[2]));

          // Check if merged width would exceed max (ExecutorTorch approach)
          float mergedWidth = box[1] - currentGroup[0][0];  // xMax of new box - xMin of first box
          bool widthWithinLimit = (mergedWidth <= MAX_MERGED_BOX_WIDTH);

          if (heightSimilar && horizontallyClose && widthWithinLimit) {
            currentGroup.push_back(box);
            sumGroupHeight += box[IDX_BOX_HEIGHT];
            groupCount++;
            currentXMax = box[1];
          } else {
            mergedGroups.push_back(std::move(currentGroup));
            currentGroup.clear();
            currentGroup.push_back(box);
            sumGroupHeight = box[IDX_BOX_HEIGHT];
            groupCount = 1;
            currentXMax = box[1];
          }
        }
      }
      if (!currentGroup.empty()) {
        mergedGroups.push_back(std::move(currentGroup));
      }

      for (const auto &group : mergedGroups) {
        if (group.size() == 1) {
          const auto &box = group[0];
          const float width = box[1] - box[0];
          const float height = box[3] - box[2];
          const int margin = static_cast<int>(boxMarginMultiplier * std::min(width, height));
          mergedList.push_back({box[0] - static_cast<float>(margin), box[1] + static_cast<float>(margin), box[2] - static_cast<float>(margin), box[3] + static_cast<float>(margin)});
        } else {
          float xMin = group[0][0];
          float xMax = group[0][1];
          float yMin = group[0][2];
          float yMax = group[0][3];
          for (const auto &boxMeta : group) {
            if (boxMeta[0] < xMin) {
              xMin = boxMeta[0];
            }
            if (boxMeta[1] > xMax) {
              xMax = boxMeta[1];
            }
            if (boxMeta[2] < yMin) {
              yMin = boxMeta[2];
            }
            if (boxMeta[3] > yMax) {
              yMax = boxMeta[3];
            }
          }
          const float boxWidth = xMax - xMin;
          const float boxHeight = yMax - yMin;
          const int margin = static_cast<int>(boxMarginMultiplier * std::min(boxWidth, boxHeight));
          mergedList.push_back({xMin - static_cast<float>(margin), xMax + static_cast<float>(margin), yMin - static_cast<float>(margin), yMax + static_cast<float>(margin)});
        }
      }
    }
  }
  return mergedList;
}

std::vector<AlignedBox> StepBoundingBox::getOutputAlignedBoxes(const float imgResizeRatio, const std::vector<std::array<float, 4>> &mergedList) {
  std::vector<AlignedBox> filtered;
  int skippedMinSize = 0;
  int skippedInvalidRoi = 0;

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[getOutputAlignedBoxes] Processing " + std::to_string(mergedList.size()) +
       " boxes, linkMapBinary size=" + std::to_string(linkMapBinary_.cols) + "x" +
       std::to_string(linkMapBinary_.rows));

  for (const auto &box : mergedList) {
    float width = box[1] - box[0];
    float height = box[3] - box[2];
    if (std::max(width, height) > MIN_SIZE) {
      const float linkXmin = box[0] / imgResizeRatio;
      const float linkXmax = box[1] / imgResizeRatio;
      const float linkYmin = box[2] / imgResizeRatio;
      const float linkYmax = box[3] / imgResizeRatio;

      int roiX = std::max(0, static_cast<int>(linkXmin));
      int roiY = std::max(0, static_cast<int>(linkYmin));
      int roiWidth = static_cast<int>(linkXmax - linkXmin);
      int roiHeight = static_cast<int>(linkYmax - linkYmin);

      // Clamp ROI to image bounds
      if (roiX + roiWidth > linkMapBinary_.cols) {
        roiWidth = linkMapBinary_.cols - roiX;
      }
      if (roiY + roiHeight > linkMapBinary_.rows) {
        roiHeight = linkMapBinary_.rows - roiY;
      }

      // Check if ROI is valid after clamping
      if (roiWidth <= 0 || roiHeight <= 0) {
        skippedInvalidRoi++;
        QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
             "[getOutputAlignedBoxes] Skipped box: invalid ROI after clamp (roiX=" + std::to_string(roiX) +
             ", roiY=" + std::to_string(roiY) + ", roiW=" + std::to_string(roiWidth) +
             ", roiH=" + std::to_string(roiHeight) + ")");
        continue;
      }

      cv::Rect roi(roiX, roiY, roiWidth, roiHeight);

      cv::Mat cropImg = linkMapBinary_(roi);

      double maxVal = std::numeric_limits<double>::quiet_NaN();
      cv::minMaxLoc(cropImg, nullptr, &maxVal, nullptr, nullptr);
      filtered.emplace_back(box, maxVal >= HALF);
    } else {
      skippedMinSize++;
    }
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[getOutputAlignedBoxes] Result: " + std::to_string(filtered.size()) + " filtered, skipped " +
       std::to_string(skippedMinSize) + " (min size), " + std::to_string(skippedInvalidRoi) + " (invalid ROI)");

  return filtered;
}

std::vector<UnalignedBox> StepBoundingBox::getOutputUnalignedBoxes(const float imgResizeRatio,
                                                                   const std::vector<std::array<cv::Point2f, 4>> &unalignedBoxes) {
  std::vector<UnalignedBox> filtered;
  for (const auto &poly : unalignedBoxes) {
    const float xMin = std::min({poly[0].x, poly[1].x, poly[2].x, poly[3].x});
    const float xMax = std::max({poly[0].x, poly[1].x, poly[2].x, poly[3].x});
    const float yMin = std::min({poly[0].y, poly[1].y, poly[2].y, poly[3].y});
    const float yMax = std::max({poly[0].y, poly[1].y, poly[2].y, poly[3].y});
    const float diffX = xMax - xMin;
    const float diffY = yMax - yMin;
    if (std::max(diffX, diffY) > MIN_SIZE) {
      cv::Mat mask = cv::Mat::zeros(linkMapBinary_.size(), CV_8UC1);
      std::vector<cv::Point> adjustedPoly;
      adjustedPoly.reserve(4);
      for (const auto &point : poly) {
        // Clamp polygon points to image bounds
        int px = std::max(0, std::min(linkMapBinary_.cols - 1, cvRound(point.x / imgResizeRatio)));
        int py = std::max(0, std::min(linkMapBinary_.rows - 1, cvRound(point.y / imgResizeRatio)));
        adjustedPoly.emplace_back(px, py);
      }

      std::vector<std::vector<cv::Point>> pts{adjustedPoly};
      cv::fillPoly(mask, pts, cv::Scalar(UINT8_MAX_VAL));

      double maxVal = std::numeric_limits<double>::quiet_NaN();
      cv::minMaxLoc(linkMapBinary_, nullptr, &maxVal, nullptr, nullptr, mask);

      filtered.emplace_back(poly, maxVal >= HALF);
    }
  }
  return filtered;
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
