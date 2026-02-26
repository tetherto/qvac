#include "StepRecognizeText.hpp"

#include "Lang.hpp"

#include <opencv2/opencv.hpp>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <thread>
#include <future>
#include <mutex>
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "AndroidLog.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

using SubImage = StepRecognizeText::SubImage;

namespace {

// model_height and imgH in python
// specific per recognizer model. Not an API option
constexpr int RECOGNIZER_MODEL_HEIGHT = 64;

// not present in python
// specific per recognizer model. Had to be fixed since ONNX does not support exporting dynamic image width
constexpr int RECOGNIZER_MODEL_WIDTH = 512;
constexpr int ANGLE_90 = 90;
constexpr int ANGLE_180 = 180;
constexpr int ANGLE_270 = 270;
constexpr float HALF = 0.5F;


// contrast_ths in python
// ext box with contrast lower than this value will be passed into model 2 times. First is with original image and second with contrast adjusted to
// 'adjust_contrast' value. The one with more confident level will be returned as a result.
constexpr float LOW_CONF_THRESHOLD_FOR_INCREASED_CONTRAST = 0.8F;

// adjust_contrast in python
// target contrast level for low contrast text box
constexpr float TARGET_ADJUSTED_CONTRAST = 0.5F;

// x_ths in python
// Maximum horizontal distance to merge boxes (when paragraph = True).
constexpr float X_THRESHOLD_FOR_PARAGRAPH_MERGE = 1.0F;

// y_ths in python
// Maximum vertical distance to merge boxes (when paragraph = True).
constexpr float Y_THRESHOLD_FOR_PARAGRAPH_MERGE = 0.5F;
constexpr float PARAGRAPH_Y_DELTA = 0.4F;
constexpr float CONF_EXPONENT_NUM = 2.0F;
constexpr double ADJUST_RATIO_NUM = 200.0;
constexpr double ADJUST_RATIO_MIN_DEN = 10.0;
constexpr int ADJUST_SHIFT = 25;
constexpr int PIXEL_MAX_INT = 255;

/**
 * @brief calculates ratio between width and height, always returns >=1.
 */
float calculateRatio(float width, float height) {
  float ratioLocal = width / height;
  if (ratioLocal < 1.0F) {
    ratioLocal = 1.0F / ratioLocal;
  }
  return ratioLocal;
}

/**
 * @brief resizes the image according to RECOGNIZER_MODEL_HEIGHT and keeping the ratio betwen width and height
 *
 * If the width is smaller than the height, the width is set as RECOGNIZER_MODEL_HEIGHT, and height is adjusted according to the ratio.
 * Otherwise, if width is greater than height, the height is set as RECOGNIZER_MODEL_HEIGHT, and width is adjusted according to the ratio
 *
 * @param img : image to be resized (not modified)
 * @param width : image width
 * @param height : image height
 * @return cv::Mat : the resized image
 */
cv::Mat resizeImgForRecognizerInput(const cv::Mat &img, float width, float height) {
  float ratioLocal = width / height;
  cv::Mat resizedImg;
  if (ratioLocal < 1.0F) {
    ratioLocal = calculateRatio(width, height);
    cv::resize(img, resizedImg, cv::Size(RECOGNIZER_MODEL_HEIGHT, static_cast<int>(RECOGNIZER_MODEL_HEIGHT * ratioLocal)), 0, 0, cv::INTER_LANCZOS4);
  } else {
    cv::resize(img, resizedImg, cv::Size(static_cast<int>(RECOGNIZER_MODEL_HEIGHT * ratioLocal), RECOGNIZER_MODEL_HEIGHT), 0, 0, cv::INTER_LANCZOS4);
  }
  return resizedImg;
}

/**
 * @brief : gets a horizontally/vertically aligned subimage from rectangle coordinates that are not aligned
 *
 * @param image : original image to extract the sub image from
 * @param rect : rectangle coordinates that may not be horizontally/vertically aligned
 * @return cv::Mat : the horizontally/vertically aligned subimage
 */
cv::Mat fourPointTransform(const cv::Mat &image, const std::array<cv::Point2f, 4> &rect) {
  cv::Point2f topLeft = rect[0];
  cv::Point2f topRight = rect[1];
  cv::Point2f bottomRight = rect[2];
  cv::Point2f bottomLeft = rect[3];

  const auto widthA = static_cast<float>(std::sqrt(std::pow(bottomRight.x - bottomLeft.x, 2) + std::pow(bottomRight.y - bottomLeft.y, 2)));
  const auto widthB = static_cast<float>(std::sqrt(std::pow(topRight.x - topLeft.x, 2) + std::pow(topRight.y - topLeft.y, 2)));
  const int maxWidth = std::max(static_cast<int>(widthA), static_cast<int>(widthB));

  const auto heightA = static_cast<float>(std::sqrt(std::pow(topRight.x - bottomRight.x, 2) + std::pow(topRight.y - bottomRight.y, 2)));
  const auto heightB = static_cast<float>(std::sqrt(std::pow(topLeft.x - bottomLeft.x, 2) + std::pow(topLeft.y - bottomLeft.y, 2)));
  const int maxHeight = std::max(static_cast<int>(heightA), static_cast<int>(heightB));

  std::array<cv::Point2f, 4> destination = {
      {cv::Point2f(0.0F, 0.0F), cv::Point2f(static_cast<float>(maxWidth - 1), 0.0F), cv::Point2f(static_cast<float>(maxWidth - 1), static_cast<float>(maxHeight - 1)), cv::Point2f(0.0F, static_cast<float>(maxHeight - 1))}};

  cv::Mat perspectiveTransform = cv::getPerspectiveTransform(rect.data(), destination.data());
  cv::Mat warpedImg;
  cv::warpPerspective(image, warpedImg, perspectiveTransform, cv::Size(maxWidth, maxHeight));
  return warpedImg;
}

/**
 * @brief get the Confidence Score from recognizer prediction probability vector
 *
 * Ignores entries in predsMaxProb that are 0
 *
 * @param predsMaxProb : recognizer prediction probability vector
 * @return float : the calculated final probability
 */
float getConfidenceScoreFromPredsProb(const std::vector<float> &predsMaxProb) {
  if (predsMaxProb.empty()) {
    return 0.0F;
  }
  float prod = 1.0F;
  int size = 0;
  for (const auto &prob : predsMaxProb) {
    if (prob > 0) {
      prod *= prob;
      size++;
    }
  }
  if (size == 0) {
    return 0.0F;
  }
  float exponent = CONF_EXPONENT_NUM / static_cast<float>(std::sqrt(static_cast<double>(size)));
  return std::pow(prod, exponent);
}

/**
 * @brief gets contrast information from an image
 *
 * @param img : source image
 * @return std::tuple<double, double, double> : respectively,
 *  - the contrast
 *  - 90% percentile of brightness values (high)
 *  - 10% percentile of brightness values (low)
 */
std::tuple<double, double, double> contrastGrey(const cv::Mat &img) {
  CV_Assert(img.channels() == 1);
  std::vector<uchar> pixels;
  if (img.isContinuous()) {
    pixels.assign(img.datastart, img.dataend);
  } else {
    for (int i = 0; i < img.rows; i++) {
      pixels.insert(pixels.end(), img.ptr<uchar>(i), img.ptr<uchar>(i) + img.cols); /* NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic) */
    }
  }
  std::sort(pixels.begin(), pixels.end());
  const int numPixels = static_cast<int>(pixels.size());
  const int idx10 = static_cast<int>(0.1 * (numPixels - 1));
  const int idx90 = static_cast<int>(0.9 * (numPixels - 1));
  const double low = pixels[idx10];
  const double high = pixels[idx90];
  const double contrast = (high - low) / std::max(10.0, high + low);
  return std::make_tuple(contrast, high, low);
}

/**
 * @brief Adjusts the contrast of an image if it is below the target value
 *
 * @param img : source image to have contrast adjusted (not modified)
 * @param target : target contrast value
 * @return cv::Mat : image with contrast adjusted
 */
cv::Mat adjustContrastGrey(const cv::Mat &img, double target = PARAGRAPH_Y_DELTA) {
  double contrast = 0.0;
  double high = 0.0;
  double low = 0.0;
  std::tie(contrast, high, low) = contrastGrey(img);
  if (contrast < target) {
    cv::Mat imgInt;
    img.convertTo(imgInt, CV_32S);
    double diff = high - low;
    double ratio = ADJUST_RATIO_NUM / std::max(ADJUST_RATIO_MIN_DEN, diff);
    cv::Mat adjusted = (imgInt - static_cast<int>(low) + ADJUST_SHIFT) * ratio;
    cv::Mat clipped;
    cv::min(cv::max(adjusted, 0), PIXEL_MAX_INT, clipped);
    clipped.convertTo(clipped, CV_8U);
    return clipped;
  }
  return img.clone();
}

/**
 * @brief normalizes image with absolute black/white values, and pads the last column so it reaches maxWidth
 *
 * @param img : source image (not modified)
 * @param channels : target number of channels
 * @param height : target height
 * @param maxWidth : target width
 * @return cv::Mat : normalized and padded image
 */
constexpr double PIXEL_MAX_DOUBLE = 255.0;

cv::Mat normalizeAndPad(const cv::Mat &img, int channels, int height, int maxWidth) {
  cv::Mat gray;
  if (img.channels() == 3 && channels == 1) {
    // Use RGB2GRAY since image is in RGB format (converted from BGR in Pipeline.cpp)
    cv::cvtColor(img, gray, cv::COLOR_RGB2GRAY);
  } else {
    gray = img.clone();
  }

  cv::Mat imgFloat;
  if (gray.type() != CV_32F) {
    gray.convertTo(imgFloat, CV_32F, 1.0 / PIXEL_MAX_DOUBLE);
  } else {
    imgFloat = gray;
  }

  imgFloat = (imgFloat - HALF) / HALF;
  cv::Mat padImg(height, maxWidth, CV_MAKETYPE(CV_32F, channels), cv::Scalar(0));

  int imgW = std::min(imgFloat.cols, maxWidth);
  int imgH = std::min(imgFloat.rows, height);

  // Copy the image to top-left of padImg
  cv::Mat roi = padImg(cv::Rect(0, 0, imgW, imgH));
  imgFloat(cv::Rect(0, 0, imgW, imgH)).copyTo(roi);

  // Replicate the last column for width padding
  if (imgW < maxWidth) {
    for (int col = imgW; col < maxWidth; col++) {
      for (int row = 0; row < imgH; row++) {
        padImg.at<float>(row, col) = padImg.at<float>(row, imgW - 1);
      }
    }
  }

  // Replicate the last row for height padding
  if (imgH < height) {
    for (int row = imgH; row < height; row++) {
      for (int col = 0; col < maxWidth; col++) {
        padImg.at<float>(row, col) = padImg.at<float>(imgH - 1, col);
      }
    }
  }

  return padImg;
}

/**
 * @brief calculates the proportional width for EasyOCR-style resizing
 *
 * Always scales height to RECOGNIZER_MODEL_HEIGHT, width is proportional to aspect ratio.
 * This matches EasyOCR's preprocessing approach.
 *
 * @param width : original image width
 * @param height : original image height
 * @return int : the proportional width after resizing to model height
 */
int calculateProportionalWidth(int width, int height) {
  float ratio = static_cast<float>(width) / static_cast<float>(height);
  int newWidth = static_cast<int>(std::ceil(RECOGNIZER_MODEL_HEIGHT * ratio));
  return std::max(1, newWidth);  // Ensure at least 1 pixel width
}

/**
 * @brief resizes the image to fit recognizer input sizes (EasyOCR-style)
 *
 * Always scales height to RECOGNIZER_MODEL_HEIGHT (64), width is proportional.
 * The image is then padded to targetWidth for batching.
 *
 * It also receives contrast treatment according to adjustContrast
 *
 * @param subImage : image to be treated
 * @param targetWidth : target width for padding (typically max width in batch)
 * @param adjustContrast : target contrast
 * @return adjusted image
 */
cv::Mat alignAndCollate(const SubImage &subImage, int targetWidth, double adjustContrast = 0.0) {
  cv::Mat image = subImage.image;
  int width = image.cols;
  int height = image.rows;
  if (adjustContrast > 0) {
    if (image.channels() > 1) {
      // Use RGB2GRAY since image is in RGB format (converted from BGR in Pipeline.cpp)
      cv::cvtColor(image, image, cv::COLOR_RGB2GRAY);
    }
    image = adjustContrastGrey(image, adjustContrast);
  }

  // EasyOCR-style resize: always scale height to model height, width proportional
  int proportionalWidth = calculateProportionalWidth(width, height);

  // Use LANCZOS interpolation like EasyOCR
  cv::Mat resizedImage;
  cv::resize(image, resizedImage, cv::Size(proportionalWidth, RECOGNIZER_MODEL_HEIGHT), 0, 0, cv::INTER_LANCZOS4);

  return normalizeAndPad(resizedImage, 1 /*grayscale*/, RECOGNIZER_MODEL_HEIGHT, targetWidth);
}

/**
 * @brief Legacy version for backward compatibility - uses fixed RECOGNIZER_MODEL_WIDTH
 */
cv::Mat alignAndCollate(const SubImage &subImage, double adjustContrast = 0.0) {
  return alignAndCollate(subImage, RECOGNIZER_MODEL_WIDTH, adjustContrast);
}

/**
 * @brief Groups results into paragraphs based on box proximity
 *
 * @param rawResult : per-line results
 * @param isLeftToRightScript : mode to group boxes (left to right or right to left)
 * @return std::vector<InferredText> : the adjusted results grouped into paragraphs
 */
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
std::vector<InferredText> getParagraph(const std::vector<InferredText> &rawResult, bool isLeftToRightScript) {
  struct BoxGroup {
    std::string text;
    int minX{};
    int maxX{};
    int minY{};
    int maxY{};
    int height{};
    float yCenter{};
    int group{}; // 0 means not assigned
    float confidence{};
  };

  std::vector<BoxGroup> boxGroupList;
  boxGroupList.reserve(rawResult.size());

  for (const auto &res : rawResult) {
    BoxGroup boxGroup;
    int minX = std::numeric_limits<int>::max();
    int maxX = std::numeric_limits<int>::min();
    int minY = std::numeric_limits<int>::max();
    int maxY = std::numeric_limits<int>::min();
    for (const auto &point : res.boxCoordinates) {
      int pointX = static_cast<int>(std::round(point.x));
      int pointY = static_cast<int>(std::round(point.y));
      minX = std::min(minX, pointX);
      maxX = std::max(maxX, pointX);
      minY = std::min(minY, pointY);
      maxY = std::max(maxY, pointY);
    }
    boxGroup.minX = minX;
    boxGroup.maxX = maxX;
    boxGroup.minY = minY;
    boxGroup.maxY = maxY;
    boxGroup.height = maxY - minY;
    boxGroup.yCenter = HALF * static_cast<float>(minY + maxY);
    boxGroup.group = 0;
    boxGroup.text = res.text;
    boxGroup.confidence = static_cast<float>(res.confidenceScore);
    boxGroupList.push_back(std::move(boxGroup));
  }

  int currentGroup = 1;
  // Group boxes until every box has been assigned a group
  while (std::any_of(boxGroupList.begin(), boxGroupList.end(), [](const BoxGroup &boxGroup) { return boxGroup.group == 0; })) {
    std::vector<BoxGroup *> unassigned;
    for (auto &boxGroup : boxGroupList) {
      if (boxGroup.group == 0) {
        unassigned.push_back(&boxGroup);
      }
    }

    bool hasCurrent =
        std::any_of(boxGroupList.begin(), boxGroupList.end(), [currentGroup](const BoxGroup &boxGroup) { return boxGroup.group == currentGroup; });
    if (!hasCurrent && !unassigned.empty()) {
      unassigned[0]->group = currentGroup;
    } else {
      std::vector<BoxGroup *> currentBoxes;
      for (auto &boxGroup : boxGroupList) {
        if (boxGroup.group == currentGroup) {
          currentBoxes.push_back(&boxGroup);
        }
      }
      float sumHeight = 0.0F;
      for (auto *boxGroup : currentBoxes) {
        sumHeight += static_cast<float>(boxGroup->height);
      }
      float meanHeight = sumHeight / static_cast<float>(currentBoxes.size());

      int groupMinX =
          (*std::min_element(currentBoxes.begin(), currentBoxes.end(), [](const BoxGroup *boxA, const BoxGroup *boxB) { return boxA->minX < boxB->minX; }))->minX;
      int groupMaxX =
          (*std::max_element(currentBoxes.begin(), currentBoxes.end(), [](const BoxGroup *boxA, const BoxGroup *boxB) { return boxA->maxX < boxB->maxX; }))->maxX;
      int groupMinY =
          (*std::min_element(currentBoxes.begin(), currentBoxes.end(), [](const BoxGroup *boxA, const BoxGroup *boxB) { return boxA->minY < boxB->minY; }))->minY;
      int groupMaxY =
          (*std::max_element(currentBoxes.begin(), currentBoxes.end(), [](const BoxGroup *boxA, const BoxGroup *boxB) { return boxA->maxY < boxB->maxY; }))->maxY;

      const int minGx = groupMinX - static_cast<int>(X_THRESHOLD_FOR_PARAGRAPH_MERGE * meanHeight);
      const int maxGx = groupMaxX + static_cast<int>(X_THRESHOLD_FOR_PARAGRAPH_MERGE * meanHeight);
      const int minGy = groupMinY - static_cast<int>(Y_THRESHOLD_FOR_PARAGRAPH_MERGE * meanHeight);
      const int maxGy = groupMaxY + static_cast<int>(Y_THRESHOLD_FOR_PARAGRAPH_MERGE * meanHeight);

      bool added = false;
      for (auto *boxGroup : unassigned) {
        bool sameHorizontal = (minGx <= boxGroup->minX && boxGroup->minX <= maxGx) || (minGx <= boxGroup->maxX && boxGroup->maxX <= maxGx);
        bool sameVertical = (minGy <= boxGroup->minY && boxGroup->minY <= maxGy) || (minGy <= boxGroup->maxY && boxGroup->maxY <= maxGy);
        if (sameHorizontal && sameVertical) {
          boxGroup->group = currentGroup;
          added = true;
          break;
        }
      }
      if (!added) {
        ++currentGroup;
      }
    }
  }

  std::vector<InferredText> result;
  std::set<int> groups;
  for (const auto &boxGroup : boxGroupList) {
    groups.insert(boxGroup.group);
  }
  for (int grp : groups) {
    std::vector<BoxGroup *> groupBoxes;
    for (auto &boxGroup : boxGroupList) {
      if (boxGroup.group == grp) {
        groupBoxes.push_back(&boxGroup);
      }
    }
    int groupMinX = groupBoxes[0]->minX;
    int groupMaxX = groupBoxes[0]->maxX;
    int groupMinY = groupBoxes[0]->minY;
    int groupMaxY = groupBoxes[0]->maxY;
    float sumHeight = 0.0F;
    for (auto *boxGroup : groupBoxes) {
      groupMinX = std::min(groupMinX, boxGroup->minX);
      groupMaxX = std::max(groupMaxX, boxGroup->maxX);
      groupMinY = std::min(groupMinY, boxGroup->minY);
      groupMaxY = std::max(groupMaxY, boxGroup->maxY);
      sumHeight += static_cast<float>(boxGroup->height);
    }
    float meanHeight = sumHeight / static_cast<float>(groupBoxes.size());

    std::string combinedText;
    float finalConfidence = 1.0F;
    std::vector<BoxGroup *> remaining = groupBoxes;
    while (!remaining.empty()) {
      float lowest = remaining[0]->yCenter;
      for (auto *boxGroup : remaining) {
        lowest = std::min(lowest, boxGroup->yCenter);
      }
      std::vector<BoxGroup *> candidates;
      for (auto *boxGroup : remaining) {
        if (boxGroup->yCenter < lowest + PARAGRAPH_Y_DELTA * meanHeight) {
          candidates.push_back(boxGroup);
        }
      }
      BoxGroup *bestBox = nullptr;
      if (isLeftToRightScript) {
        bestBox = *std::min_element(candidates.begin(), candidates.end(), [](const BoxGroup *boxA, const BoxGroup *boxB) { return boxA->minX < boxB->minX; });
      } else {
        bestBox = *std::max_element(candidates.begin(), candidates.end(), [](const BoxGroup *boxA, const BoxGroup *boxB) { return boxA->maxX < boxB->maxX; });
      }
      combinedText += " " + bestBox->text;
      finalConfidence = std::min(finalConfidence, bestBox->confidence);
      remaining.erase(std::remove(remaining.begin(), remaining.end(), bestBox), remaining.end());
    }
    if (!combinedText.empty() && combinedText.front() == ' ') {
      combinedText.erase(0, 1);
    }
    if (combinedText.empty()) {
      finalConfidence = 0.0F;
    }
    std::array<cv::Point2f, 4> finalBox = {
        cv::Point2f(static_cast<float>(groupMinX), static_cast<float>(groupMinY)), cv::Point2f(static_cast<float>(groupMaxX), static_cast<float>(groupMinY)), cv::Point2f(static_cast<float>(groupMaxX), static_cast<float>(groupMaxY)), cv::Point2f(static_cast<float>(groupMinX), static_cast<float>(groupMaxY))};
    result.emplace_back(finalBox, combinedText, finalConfidence);
  }
  return result;
}

/**
 * @brief shifts the box coordinates based on angle
 *
 * Required so box[0] always points to the top-left most point in relation to the text
 *
 * @param box : source box (assumed to be in horizontal position)
 * @param angle : angle to rotate (one of 90, 180, 270)
 * @return std::array<cv::Point2f, 4> : the rotated box
 */
std::array<cv::Point2f, 4> rotateBox(const std::array<cv::Point2f, 4> &box, int angle) {
  std::array<cv::Point2f, 4> newBox;
  if (angle == ANGLE_90) {
    newBox[0] = box[3];
    newBox[1] = box[0];
    newBox[2] = box[1];
    newBox[3] = box[2];
  } else if (angle == ANGLE_180) {
    newBox[0] = box[2];
    newBox[1] = box[3];
    newBox[2] = box[0];
    newBox[3] = box[1];
  } else if (angle == ANGLE_270) {
    newBox[0] = box[1];
    newBox[1] = box[2];
    newBox[2] = box[3];
    newBox[3] = box[0];
  }
  return newBox;
}

} // end unnamed namespace

StepRecognizeText::StepRecognizeText(
    const ORTCHAR_T* pathRecognizer, std::span<const std::string> langList,
    bool useGPU, const Config& config)
    : config_(config),
      ortEnv_(ORT_LOGGING_LEVEL_WARNING, "OnnxInferenceRecognizer"),
      ortSession_(ortEnv_, pathRecognizer, getOrtSessionOptions(useGPU)),
      isLeftToRightScript_{true} {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, "[Recognition] Constructor: ONNX session created, validating languages...");
  ALOG_INFO(std::string("[Recognition] Constructor: ONNX session created, validating languages..."));
  validateUnknownLanguages(langList);
  std::tie(utf32Characters_, ignoreChars_, isLeftToRightScript_) = getCharsInfoFromLangList(langList);
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, "[Recognition] Constructor: completed successfully");
  ALOG_INFO(std::string("[Recognition] Constructor: completed successfully"));
}

StepRecognizeText::Output StepRecognizeText::process(StepRecognizeText::Input input) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Recognition] process() called - starting recognition");
  populateImageList(input);
  expandImgListWithRotatedImgs(input.context.rotationAngles);
  std::vector<InferredText> inferenceResult = processImgList();
  imgListOfLists_.clear();

  if (input.context.paragraph) {
    inferenceResult = getParagraph(inferenceResult, isLeftToRightScript_);
  }

  // Scale coordinates back to original image space
  if (input.context.initialResizeRatio != 1.0F) {
    float scaleBack = 1.0F / input.context.initialResizeRatio;
    for (auto& result : inferenceResult) {
      for (auto& point : result.boxCoordinates) {
        point.x *= scaleBack;
        point.y *= scaleBack;
      }
    }
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "[Recognition] Scaled coordinates back by factor " + std::to_string(scaleBack));
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[Recognition] process() completed - returning " + std::to_string(inferenceResult.size()) + " results");
  return inferenceResult;
}

void StepRecognizeText::populateImageList(const Input &input) {
  const cv::Mat &img = input.context.origImg;
  int maximumY = img.rows;
  int maximumX = img.cols;

  imgListOfLists_.clear();
  imgListOfLists_.reserve(input.unalignedBoxes.size() + input.alignedBoxes.size());

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[Recognition] populateImageList: processing " + std::to_string(input.unalignedBoxes.size()) +
       " unaligned, " + std::to_string(input.alignedBoxes.size()) + " aligned boxes");

  for (const auto &box : input.unalignedBoxes) {
    cv::Mat transformedImg = fourPointTransform(img, box.coords);
    float ratioLocal = calculateRatio(static_cast<float>(transformedImg.cols), static_cast<float>(transformedImg.rows));
    int newWidth = static_cast<int>(RECOGNIZER_MODEL_HEIGHT * ratioLocal);
    if (newWidth == 0) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
           "[Recognition] Skipped unaligned box: newWidth=0 (ratio=" + std::to_string(ratioLocal) + ")");
      continue;
    }

    auto cropImg = resizeImgForRecognizerInput(transformedImg, static_cast<float>(transformedImg.cols), static_cast<float>(transformedImg.rows));
    std::vector<SubImage> imgList;
    imgList.emplace_back(box.coords, cropImg, box.isMultiCharacter);
    imgListOfLists_.push_back(imgList);
  }

  for (const auto &box : input.alignedBoxes) {
    int xMin = std::max(0, static_cast<int>(box.coords[0]));
    int xMax = std::min(static_cast<int>(box.coords[1]), maximumX);
    int yMin = std::max(0, static_cast<int>(box.coords[2]));
    int yMax = std::min(static_cast<int>(box.coords[3]), maximumY);
    if (xMax <= xMin || yMax <= yMin) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
           "[Recognition] Skipped aligned box: invalid coords xMin=" + std::to_string(xMin) +
           " xMax=" + std::to_string(xMax) + " yMin=" + std::to_string(yMin) + " yMax=" + std::to_string(yMax));
      continue;
    }

    int width = xMax - xMin;
    int height = yMax - yMin;
    float ratioLocal = calculateRatio(static_cast<float>(width), static_cast<float>(height));
    int newWidth = static_cast<int>(RECOGNIZER_MODEL_HEIGHT * ratioLocal);
    if (newWidth == 0) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
           "[Recognition] Skipped aligned box: newWidth=0 (w=" + std::to_string(width) +
           " h=" + std::to_string(height) + " ratio=" + std::to_string(ratioLocal) + ")");
      continue;
    }

    cv::Rect roi(xMin, yMin, xMax - xMin, yMax - yMin);
    cv::Mat cropImg = img(roi);
    cv::Mat resizedImg = resizeImgForRecognizerInput(cropImg, static_cast<float>(width), static_cast<float>(height));
    std::array<cv::Point2f, 4> rect = {{cv::Point2f(static_cast<float>(xMin), static_cast<float>(yMin)),
                                        cv::Point2f(static_cast<float>(xMax), static_cast<float>(yMin)),
                                        cv::Point2f(static_cast<float>(xMax), static_cast<float>(yMax)),
                                        cv::Point2f(static_cast<float>(xMin), static_cast<float>(yMax))}};
    std::vector<SubImage> imgList;
    imgList.emplace_back(rect, resizedImg, box.isMultiCharacter);
    imgListOfLists_.push_back(imgList);
  }

  // Sort boxes in reading order: top-to-bottom, left-to-right (matches EasyOCR ordering)
  // First, calculate mean box height for row threshold
  float sumHeight = 0.0F;
  for (const auto &imgList : imgListOfLists_) {
    const auto &coords = imgList[0].coords;
    float height = coords[3].y - coords[0].y; // bottom.y - top.y
    sumHeight += height;
  }
  float meanHeight = imgListOfLists_.empty() ? 1.0F : sumHeight / static_cast<float>(imgListOfLists_.size());
  constexpr float yCenterThreshold = 0.5F; // Same as EasyOCR's ycenter_ths
  float rowThreshold = yCenterThreshold * meanHeight;

  // Sort by y_center first, then by x for boxes on same row
  std::sort(imgListOfLists_.begin(), imgListOfLists_.end(), [rowThreshold](const std::vector<SubImage> &listA, const std::vector<SubImage> &listB) {
    const auto &coordsA = listA[0].coords;
    const auto &coordsB = listB[0].coords;
    float yCenterA = (coordsA[0].y + coordsA[3].y) / 2.0F;
    float yCenterB = (coordsB[0].y + coordsB[3].y) / 2.0F;
    // If y_centers are within threshold, consider them on same row and sort by x
    if (std::abs(yCenterA - yCenterB) < rowThreshold) {
      return coordsA[0].x < coordsB[0].x;
    }
    // Otherwise sort by y_center
    return yCenterA < yCenterB;
  });

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[Recognition] populateImageList: result=" + std::to_string(imgListOfLists_.size()) + " image lists");
}

void StepRecognizeText::expandImgListWithRotatedImgs(std::optional<std::vector<int>> &rotationAngles) {
  constexpr int ratioDifferenceToIgnoreRotation = 5;
  bool canBypassRotations = !rotationAngles.has_value();
  constexpr int angle90 = 90;
  constexpr int angle180 = 180;
  constexpr int angle270 = 270;
  // Use per-image rotationAngles if provided, otherwise use config default
  const std::vector<int> &angles = rotationAngles ? *rotationAngles : config_.defaultRotationAngles;

  for (int angle : angles) {
    for (auto &imageList : imgListOfLists_) {
      cv::Mat &baseImg = imageList[0].image;
      cv::Mat rotatedImg;
      if (angle == angle90) {
        if (canBypassRotations && imageList[0].isMultiCharacter &&
            baseImg.cols > ratioDifferenceToIgnoreRotation * baseImg.rows) {
          continue;
        }
        cv::rotate(baseImg, rotatedImg, cv::ROTATE_90_CLOCKWISE);
      } else if (angle == angle180) {
        if (canBypassRotations && imageList[0].isMultiCharacter &&
            baseImg.rows > ratioDifferenceToIgnoreRotation * baseImg.cols) {
          continue;
        }
        cv::rotate(baseImg, rotatedImg, cv::ROTATE_180);
      } else if (angle == angle270) {
        if (canBypassRotations && imageList[0].isMultiCharacter &&
            baseImg.cols > ratioDifferenceToIgnoreRotation * baseImg.rows) {
          continue;
        }
        cv::rotate(baseImg, rotatedImg, cv::ROTATE_90_COUNTERCLOCKWISE);
      } else {
        throw std::invalid_argument("Unexpected angle " + std::to_string(angle) +
                                    " received with rotationAngles. Angles must be one of [90, 180, 270]");
      }
      std::array<cv::Point2f, 4> rotatedBox = rotateBox(imageList[0].coords, angle);
      imageList.emplace_back(rotatedBox, rotatedImg, imageList[0].isMultiCharacter);
    }
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
std::pair<std::string, float> StepRecognizeText::getTextAndConfidenceFromPreds(const cv::Mat &preds, int batchIdx) {
  assert(preds.dims == 3);
  const int imgSubcolumnsSize = preds.size[1];
  const int charSpaceSize = preds.size[2];
  assert(batchIdx >= 0 && batchIdx < preds.size[0]);

  std::vector<std::vector<float>> predsProb(
      imgSubcolumnsSize, std::vector<float>(charSpaceSize, 0.0F));
  for (int subcolumn = 0; subcolumn < imgSubcolumnsSize; subcolumn++) {
    float maxVal = -std::numeric_limits<float>::infinity();
    for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
      float val = preds.at<float>(batchIdx, subcolumn, charIndex);
      maxVal = std::max(val, maxVal);
    }

    float subcolumnSumExp = 0.0F;
    for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
      float val = preds.at<float>(batchIdx, subcolumn, charIndex);
      float expVal = std::exp(val - maxVal);
      predsProb[subcolumn][charIndex] = expVal;
      subcolumnSumExp += expVal;
    }
    for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
      predsProb[subcolumn][charIndex] /= subcolumnSumExp;
    }
  }

  for (int subcolumn = 0; subcolumn < imgSubcolumnsSize; subcolumn++) {
    for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
      if (ignoreChars_[charIndex]) {
        predsProb[subcolumn][charIndex] = 0.0F;
      }
    }
    float subcolumnSum = 0.0F;
    for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
      subcolumnSum += predsProb[subcolumn][charIndex];
    }
    if (subcolumnSum > 0.0F) {
      for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
        predsProb[subcolumn][charIndex] /= subcolumnSum;
      }
    }
  }

  std::vector<size_t> predsIndex(imgSubcolumnsSize, 0);
  std::vector<float> predsMaxProb(imgSubcolumnsSize, 0.0F);
  for (int subcolumn = 0; subcolumn < imgSubcolumnsSize; subcolumn++) {
    size_t charIndexMax = 0;
    float maxProbVal = predsProb[subcolumn][0];
    for (size_t charIndex = 1; charIndex < static_cast<size_t>(charSpaceSize);
         charIndex++) {
      if (predsProb[subcolumn][charIndex] > maxProbVal) {
        maxProbVal = predsProb[subcolumn][charIndex];
        charIndexMax = charIndex;
      }
    }
    predsIndex[subcolumn] = charIndexMax;
    predsMaxProb[subcolumn] = (charIndexMax != 0) ? maxProbVal : 0.0F;
  }

  std::string predictedText = decodeGreedy(predsIndex);
  float confidenceScore = getConfidenceScoreFromPredsProb(predsMaxProb);

  return {predictedText, confidenceScore};
}

cv::Mat StepRecognizeText::runInferenceOnImg(const cv::Mat &img) {
  std::vector<cv::Mat> channels;
  cv::split(img, channels);

  int height = img.rows;
  int width = img.cols;
  int numChannels = static_cast<int>(channels.size());
  cv::Mat chwBlob(numChannels, height * width, CV_32F);
  for (int i = 0; i < numChannels; i++) {
    CV_Assert(channels[i].isContinuous());
    memcpy(chwBlob.ptr<float>(i), channels[i].data, sizeof(float) * height * width);
  }

  cv::Mat inputBlob = chwBlob.reshape(1, {1, numChannels, height, width});

  int dims = inputBlob.dims;
  assert(dims == 4 && "the input blob dimension should be 4: [batchSize, 1, imgH, imgW]");
  std::vector<int64_t> imageShape(dims);
  for (int i = 0; i < dims; i++) {
    imageShape[i] = inputBlob.size[i];
  }
  size_t imageTensorSize = inputBlob.total();
  assert(sizeof(float) == inputBlob.elemSize());
  auto *imageData = inputBlob.ptr<float>();
  Ort::MemoryInfo memoryInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  Ort::Value imageTensor = Ort::Value::CreateTensor<float>(memoryInfo, imageData, imageTensorSize, imageShape.data(), imageShape.size());

  constexpr std::array<const char*, 1> inputNames = {"image"};
  constexpr std::array<const char*, 1> outputNames = {"output"};

  std::array<Ort::Value, 1> inputTensors = {std::move(imageTensor)};

  auto outputTensors = ortSession_.Run(
      Ort::RunOptions{nullptr},
      inputNames.data(),
      inputTensors.data(),
      1,
      outputNames.data(),
      1);

  Ort::Value &predsTensor = outputTensors[0];
  auto *predsData = predsTensor.GetTensorMutableData<float>();
  Ort::TypeInfo typeInfo = predsTensor.GetTypeInfo();
  auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();
  std::vector<int64_t> predsShape = tensorInfo.GetShape();

  auto predsDims = static_cast<int>(predsShape.size());
  std::vector<int> cvSizes(predsDims);
  for (size_t i = 0; i < predsShape.size(); i++) {
    cvSizes[i] = static_cast<int>(predsShape[i]);
  }

  cv::Mat preds(predsDims, cvSizes.data(), CV_32F, predsData);

  return preds.clone();
}

cv::Mat StepRecognizeText::runBatchInference(const std::vector<cv::Mat> &images, int dynamicWidth) {
  auto t0 = std::chrono::high_resolution_clock::now();
  if (images.empty()) {
    return cv::Mat();
  }

  const int batchSize = static_cast<int>(images.size());
  const int height = RECOGNIZER_MODEL_HEIGHT;
  const int width = dynamicWidth;
  const int numChannels = 1;

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[Recognition] runBatchInference called with batch_size=" + std::to_string(batchSize) +
       ", dynamic_width=" + std::to_string(width));

  // Create batch tensor: [batch, channels, height, width]
  std::vector<float> batchData(batchSize * numChannels * height * width);

  for (int b = 0; b < batchSize; b++) {
    const cv::Mat& img = images[b];
    CV_Assert(img.rows == height && img.cols == width && img.channels() == numChannels);
    CV_Assert(img.type() == CV_32F);

    // Copy image data in CHW format
    const float* imgPtr = img.ptr<float>();
    float* destPtr = batchData.data() + b * numChannels * height * width;
    std::memcpy(destPtr, imgPtr, sizeof(float) * height * width);
  }

  std::vector<int64_t> inputShape = {batchSize, numChannels, height, width};
  size_t inputTensorSize = batchSize * numChannels * height * width;

  Ort::MemoryInfo memoryInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
      memoryInfo, batchData.data(), inputTensorSize, inputShape.data(), inputShape.size());

  constexpr std::array<const char*, 1> inputNames = {"image"};
  constexpr std::array<const char*, 1> outputNames = {"output"};

  std::array<Ort::Value, 1> inputTensors = {std::move(inputTensor)};

  auto outputTensors = ortSession_.Run(
      Ort::RunOptions{nullptr},
      inputNames.data(),
      inputTensors.data(),
      1,
      outputNames.data(),
      1);

  Ort::Value &predsTensor = outputTensors[0];
  auto *predsData = predsTensor.GetTensorMutableData<float>();
  Ort::TypeInfo typeInfo = predsTensor.GetTypeInfo();
  auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();
  std::vector<int64_t> predsShape = tensorInfo.GetShape();

  auto predsDims = static_cast<int>(predsShape.size());
  std::vector<int> cvSizes(predsDims);
  for (size_t i = 0; i < predsShape.size(); i++) {
    cvSizes[i] = static_cast<int>(predsShape[i]);
  }

  cv::Mat preds(predsDims, cvSizes.data(), CV_32F, predsData);
  auto t1 = std::chrono::high_resolution_clock::now();
  auto batchMs = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[Recognition] runBatchInference took " + std::to_string(batchMs) + " ms for batch_size=" + std::to_string(batchSize));
  return preds.clone();
}

void StepRecognizeText::processImg(SubImage &subImage) {
  cv::Mat resizedImg = alignAndCollate(subImage, 0.0);
  cv::Mat preds = runInferenceOnImg(resizedImg);
  std::tie(subImage.text, subImage.confidenceScore) = getTextAndConfidenceFromPreds(preds);

  if (subImage.confidenceScore < LOW_CONF_THRESHOLD_FOR_INCREASED_CONTRAST) {
    cv::Mat resizedImg = alignAndCollate(subImage, TARGET_ADJUSTED_CONTRAST);
    cv::Mat preds = runInferenceOnImg(resizedImg);
    auto [newText, newConfidenceScore] = getTextAndConfidenceFromPreds(preds);
    if (newConfidenceScore > subImage.confidenceScore) {
      subImage.text = newText;
      subImage.confidenceScore = newConfidenceScore;
    }
  }

  std::u32string utf32Text = converter_.from_bytes(subImage.text);
  if (utf32Text.size() <= 1 && subImage.isMultiCharacter) {
    subImage.confidenceScore = 0;
  }
}

std::vector<InferredText> StepRecognizeText::processImgList() {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[Recognition] processImgList: starting with " + std::to_string(imgListOfLists_.size()) + " image lists");
  auto t0 = std::chrono::high_resolution_clock::now();
  std::vector<InferredText> inferredTextList;
  inferredTextList.reserve(imgListOfLists_.size());

  // Build index of all SubImages WITHOUT preparing images (to save memory)
  struct BatchIndex {
    size_t listIdx;
    size_t imgIdx;
  };
  std::vector<BatchIndex> allIndices;

  for (size_t listIdx = 0; listIdx < imgListOfLists_.size(); listIdx++) {
    auto &imgList = imgListOfLists_[listIdx];
    for (size_t imgIdx = 0; imgIdx < imgList.size(); imgIdx++) {
      allIndices.push_back({listIdx, imgIdx});
    }
  }

  if (allIndices.empty()) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, "[Recognition] processImgList: no images to process, returning early");
    return inferredTextList;
  }

  // Process in batches - prepare images ON-DEMAND to prevent OOM
  const int batchSize = config_.recognizerBatchSize;
  std::string batchInfoMsg = "[Recognition] Processing " + std::to_string(allIndices.size()) + " items in batches of " + std::to_string(batchSize) + " (on-demand preparation)";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, batchInfoMsg);
  ALOG_INFO(batchInfoMsg);

  for (size_t batchStart = 0; batchStart < allIndices.size(); batchStart += batchSize) {
    size_t batchEnd = std::min(batchStart + static_cast<size_t>(batchSize), allIndices.size());
    size_t currentBatchSize = batchEnd - batchStart;

    // Calculate max proportional width for this batch (EasyOCR-style dynamic batching)
    int maxProportionalWidth = 0;
    for (size_t i = batchStart; i < batchEnd; i++) {
      auto &idx = allIndices[i];
      auto &subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
      int propWidth = calculateProportionalWidth(subImage.image.cols, subImage.image.rows);
      maxProportionalWidth = std::max(maxProportionalWidth, propWidth);
    }
    // Ensure minimum width for model stability
    maxProportionalWidth = std::max(maxProportionalWidth, RECOGNIZER_MODEL_HEIGHT);

    // Prepare images ONLY for this batch, using dynamic max width
    std::vector<cv::Mat> preparedImages;
    preparedImages.reserve(currentBatchSize);
    for (size_t i = batchStart; i < batchEnd; i++) {
      auto &idx = allIndices[i];
      auto &subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
      cv::Mat preparedImg = alignAndCollate(subImage, maxProportionalWidth, 0.0);
      preparedImages.push_back(preparedImg);
    }

    cv::Mat batchPreds = runBatchInference(preparedImages, maxProportionalWidth);

    // Decode results and populate SubImages for this batch
    for (size_t i = 0; i < currentBatchSize; i++) {
      auto &idx = allIndices[batchStart + i];
      auto &subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
      std::tie(subImage.text, subImage.confidenceScore) =
          getTextAndConfidenceFromPreds(batchPreds, static_cast<int>(i));
    }

    // Clear prepared images to free memory before next batch
    preparedImages.clear();
    preparedImages.shrink_to_fit();

    std::string batchProgressMsg = "[Recognition] Processed batch " + std::to_string(batchStart) + "-" + std::to_string(batchEnd) + " of " + std::to_string(allIndices.size());
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG, batchProgressMsg);
    ALOG_DEBUG(batchProgressMsg);
  }

  // Second pass: handle low confidence with contrast adjustment (if enabled)
  if (config_.contrastRetry) {
    std::vector<BatchIndex> lowConfidenceIndices;
    for (size_t i = 0; i < allIndices.size(); i++) {
      auto &idx = allIndices[i];
      auto &subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
      if (subImage.confidenceScore < config_.lowConfidenceThreshold) {
        lowConfidenceIndices.push_back(idx);
      }
    }

    if (!lowConfidenceIndices.empty()) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
           "[Recognition] Processing " + std::to_string(lowConfidenceIndices.size()) + " low-confidence items with contrast adjustment");

      // Process contrast retries in batches too
      for (size_t batchStart = 0; batchStart < lowConfidenceIndices.size(); batchStart += batchSize) {
        size_t batchEnd = std::min(batchStart + static_cast<size_t>(batchSize), lowConfidenceIndices.size());

        // Calculate max proportional width for contrast batch
        int maxProportionalWidth = 0;
        for (size_t j = batchStart; j < batchEnd; j++) {
          auto &idx = lowConfidenceIndices[j];
          auto &subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
          int propWidth = calculateProportionalWidth(subImage.image.cols, subImage.image.rows);
          maxProportionalWidth = std::max(maxProportionalWidth, propWidth);
        }
        maxProportionalWidth = std::max(maxProportionalWidth, RECOGNIZER_MODEL_HEIGHT);

        std::vector<cv::Mat> contrastImages;
        contrastImages.reserve(batchEnd - batchStart);
        for (size_t j = batchStart; j < batchEnd; j++) {
          auto &idx = lowConfidenceIndices[j];
          auto &subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
          cv::Mat contrastImg = alignAndCollate(subImage, maxProportionalWidth, TARGET_ADJUSTED_CONTRAST);
          contrastImages.push_back(contrastImg);
        }

        cv::Mat contrastPreds = runBatchInference(contrastImages, maxProportionalWidth);

        for (size_t j = 0; j < contrastImages.size(); j++) {
          auto &idx = lowConfidenceIndices[batchStart + j];
          auto &subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
          auto [newText, newConfidenceScore] =
              getTextAndConfidenceFromPreds(contrastPreds, static_cast<int>(j));
          if (newConfidenceScore > subImage.confidenceScore) {
            subImage.text = newText;
            subImage.confidenceScore = newConfidenceScore;
          }
        }

        // Clear to free memory
        contrastImages.clear();
        contrastImages.shrink_to_fit();
      }
    }
  }

  // Apply single-character filter and find best result per imgList
  for (size_t listIdx = 0; listIdx < imgListOfLists_.size(); listIdx++) {
    auto &imgList = imgListOfLists_[listIdx];
    double highestConfidence = 0.0;
    size_t highestConfidenceIndex = 0;

    for (size_t i = 0; i < imgList.size(); i++) {
      auto &subImage = imgList[i];

      // Apply single-character filter
      std::u32string utf32Text = converter_.from_bytes(subImage.text);
      if (utf32Text.size() <= 1 && subImage.isMultiCharacter) {
        subImage.confidenceScore = 0;
      }

      if (subImage.confidenceScore > highestConfidence) {
        highestConfidence = subImage.confidenceScore;
        highestConfidenceIndex = i;
      }
    }

    const auto &bestImg = imgList[highestConfidenceIndex];
    inferredTextList.emplace_back(bestImg.coords, bestImg.text, bestImg.confidenceScore);
  }

  auto t1 = std::chrono::high_resolution_clock::now();
  auto recognitionMs = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
  std::string timingMsg = "[Recognition] Total recognition time: " + std::to_string(recognitionMs) + " ms for " + std::to_string(inferredTextList.size()) + " text regions";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, timingMsg);
  ALOG_INFO(timingMsg);

  return inferredTextList;
}

std::string StepRecognizeText::decodeGreedy(const std::vector<size_t> &textIndex) {
  std::u32string text;
  if (!textIndex.empty()) {
    size_t first = textIndex[0];
    if (first != 0) {
      assert(first >= 0 && first < utf32Characters_.size());
      text.push_back(utf32Characters_[first]);
    }

    for (size_t i = 1; i < textIndex.size(); ++i) {
      size_t prev = textIndex[i - 1];
      size_t curr = textIndex[i];
      if (curr != prev && curr != 0) {
        assert(curr >= 0 && curr < utf32Characters_.size());
        text.push_back(utf32Characters_[curr]);
      }
    }
  }

  return converter_.to_bytes(text);
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
