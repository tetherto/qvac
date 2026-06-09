// std::wstring_convert (used by decodeGreedy → converter_.to_bytes) is
// deprecated in C++17+ but there is no drop-in replacement before C++26;
// switching to ICU/iconv is a separate refactor. Suppress the deprecation
// warning for the whole translation unit so the template instantiation is
// quiet regardless of where libc++ emits the diagnostic.
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

// Adapted from @qvac/ocr-onnx's addon/pipeline/StepRecognizeText.cpp.
// Most of the body (image cropping, contrast
// retry, rotation retry, CTC greedy decode, paragraph merge) is lifted
// verbatim — see git diff against the source for the trivial surface
// changes.  The substantive replacements are:
//
//   - the constructor (ONNX session -> GGUF loader + CrnnGen2Weights);
//   - runInferenceOnImg / runBatchInference (ONNX session.runRaw + Ort
//     value extraction -> build_crnn_gen2 + ggml_backend_graph_compute +
//     ggml_backend_tensor_get).
//
// The vocab string used by `decodeGreedy` is sourced from the GGUF's
// `crnn.vocab` metadata at load time; Lang.cpp's per-language table is
// consulted for the LTR flag and the ignore-mask, and asserted against
// the GGUF vocab to catch drift.

#include "step_recognize_text.hpp"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <future>
#include <mutex>
#include <ranges>
#include <span>
#include <stdexcept>
#include <string>
#include <thread>

#include <opencv2/opencv.hpp>

#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml.h"
#include "lang.hpp"
#include "model-interface/easyocr/crnn.hpp"
#include "model-interface/easyocr/crnn_weights.hpp"
#include "model-interface/easyocr/gguf_loader.hpp"
#include "qlog.hpp"

// NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access,cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers,readability-identifier-naming,readability-identifier-length,hicpp-use-auto,modernize-use-auto,bugprone-narrowing-conversions,cppcoreguidelines-narrowing-conversions,readability-implicit-bool-conversion,modernize-avoid-c-style-cast,cppcoreguidelines-pro-type-cstyle-cast,modernize-use-integer-sign-comparison)
// DSP / inference inner loops use raw pointer arithmetic on cv::Mat /
// std::vector row buffers, single-letter math identifiers, and
// architecture-defined magic numbers from upstream EasyOCR.

namespace easyocr::ggml::pipeline {

using SubImage = StepRecognizeText::SubImage;

namespace {

// model_height and imgH in python
// specific per recognizer model. Not an API option
// Lower bound on the CRNN ggml node budget passed to ggml_new_graph_custom
// in ggml_run_one_T / ggml_run_recognizer_t. The LSTM unroll is linear in
// the recognizer time dimension, so very wide crops need a larger budget.
constexpr size_t kMinCrnnRunGraphSize = static_cast<size_t>(32) * 1024;
constexpr size_t kCrnnRunGraphBaseSize = static_cast<size_t>(4) * 1024;
constexpr size_t kCrnnRunGraphNodesPerTimestep = 256;
constexpr int kCrnnWidthDownsample = 4;

constexpr int RECOGNIZER_MODEL_HEIGHT = 64;

// not present in python
// specific per recognizer model. Had to be fixed since ONNX does not support
// exporting dynamic image width
constexpr int RECOGNIZER_MODEL_WIDTH = 512;
constexpr int ANGLE_90 = 90;
constexpr int ANGLE_180 = 180;
constexpr int ANGLE_270 = 270;
constexpr float HALF = 0.5F;

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
 * @brief resizes the image according to RECOGNIZER_MODEL_HEIGHT and keeping the
 * ratio betwen width and height
 *
 * If the width is smaller than the height, the width is set as
 * RECOGNIZER_MODEL_HEIGHT, and height is adjusted according to the ratio.
 * Otherwise, if width is greater than height, the height is set as
 * RECOGNIZER_MODEL_HEIGHT, and width is adjusted according to the ratio
 *
 * @param img : image to be resized (not modified)
 * @param width : image width
 * @param height : image height
 * @return cv::Mat : the resized image
 */
cv::Mat
resizeImgForRecognizerInput(const cv::Mat& img, float width, float height) {
  float ratioLocal = width / height;
  cv::Mat resizedImg;
  if (ratioLocal < 1.0F) {
    ratioLocal = calculateRatio(width, height);
    cv::resize(
        img,
        resizedImg,
        cv::Size(
            RECOGNIZER_MODEL_HEIGHT,
            static_cast<int>(RECOGNIZER_MODEL_HEIGHT * ratioLocal)),
        0,
        0,
        cv::INTER_LINEAR);
  } else {
    cv::resize(
        img,
        resizedImg,
        cv::Size(
            static_cast<int>(RECOGNIZER_MODEL_HEIGHT * ratioLocal),
            RECOGNIZER_MODEL_HEIGHT),
        0,
        0,
        cv::INTER_LINEAR);
  }
  return resizedImg;
}

/**
 * @brief get the Confidence Score from recognizer prediction probability vector
 *
 * Ignores entries in predsMaxProb that are 0
 *
 * @param predsMaxProb : recognizer prediction probability vector
 * @return float : the calculated final probability
 */
float getConfidenceScoreFromPredsProb(const std::vector<float>& predsMaxProb) {
  if (predsMaxProb.empty()) {
    return 0.0F;
  }
  float prod = 1.0F;
  int size = 0;
  for (const auto& prob : predsMaxProb) {
    if (prob > 0) {
      prod *= prob;
      size++;
    }
  }
  if (size == 0) {
    return 0.0F;
  }
  float exponent = CONF_EXPONENT_NUM /
                   static_cast<float>(std::sqrt(static_cast<double>(size)));
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
std::tuple<double, double, double> contrastGrey(const cv::Mat& img) {
  CV_Assert(img.channels() == 1);

  // Build a 256-bin histogram of the uchar image. We only need the 10th and
  // 90th percentiles, so a histogram scan is O(N) with no allocations beyond
  // the fixed-size bin array — replaces an O(N log N) full sort.
  std::array<size_t, 256> hist{};
  size_t numPixels = 0;
  if (img.isContinuous()) {
    const auto total = static_cast<size_t>(img.total());
    const uchar* data = img.ptr<uchar>();
    for (size_t i = 0; i < total; ++i) {
      ++hist[data[i]];
    }
    numPixels = total;
  } else {
    for (int row = 0; row < img.rows; ++row) {
      const uchar* rowPtr = img.ptr<uchar>(row);
      for (int col = 0; col < img.cols; ++col) {
        ++hist[rowPtr[col]];
      }
    }
    numPixels = static_cast<size_t>(img.rows) * img.cols;
  }
  if (numPixels == 0) {
    return std::make_tuple(0.0, 0.0, 0.0);
  }

  // Match the original index math: idx = floor(p * (N - 1)).
  const size_t idx10 = static_cast<size_t>(0.1 * (numPixels - 1));
  const size_t idx90 = static_cast<size_t>(0.9 * (numPixels - 1));
  size_t cumulative = 0;
  int low = 0;
  int high = 0;
  bool gotLow = false;
  for (int bin = 0; bin < 256; ++bin) {
    cumulative += hist[bin];
    if (!gotLow && cumulative > idx10) {
      low = bin;
      gotLow = true;
    }
    if (cumulative > idx90) {
      high = bin;
      break;
    }
  }
  const double contrast =
      static_cast<double>(high - low) / std::max(10.0, static_cast<double>(high + low));
  return std::make_tuple(contrast, high, low);
}

/**
 * @brief Adjusts the contrast of an image if it is below the target value
 *
 * @param img : source image to have contrast adjusted (not modified)
 * @param target : target contrast value
 * @return cv::Mat : image with contrast adjusted
 */
cv::Mat
adjustContrastGrey(const cv::Mat& img, double target = PARAGRAPH_Y_DELTA) {
  double contrast = 0.0;
  double high = 0.0;
  double low = 0.0;
  std::tie(contrast, high, low) = contrastGrey(img);
  if (contrast < target) {
    cv::Mat imgFloat;
    img.convertTo(imgFloat, CV_32F);
    double diff = high - low;
    double ratio = ADJUST_RATIO_NUM / std::max(ADJUST_RATIO_MIN_DEN, diff);
    cv::Mat adjusted = (imgFloat - low + ADJUST_SHIFT) * ratio;
    cv::Mat result;
    adjusted.convertTo(result, CV_8U); // auto-saturates to [0,255]
    return result;
  }
  return img; // shallow copy — caller resizes into a new Mat downstream
}

/**
 * @brief normalizes image with absolute black/white values, and pads the last
 * column so it reaches maxWidth
 *
 * @param img : source image (not modified)
 * @param channels : target number of channels
 * @param height : target height
 * @param maxWidth : target width
 * @return cv::Mat : normalized and padded image
 */
constexpr double PIXEL_MAX_DOUBLE = 255.0;

cv::Mat normalizeAndPad(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    const cv::Mat& img, int channels, int height, int maxWidth) {
  cv::Mat gray;
  if (img.channels() == 3 && channels == 1) {
    // Use RGB2GRAY since image is in RGB format (converted from BGR in
    // Pipeline.cpp)
    cv::cvtColor(img, gray, cv::COLOR_RGB2GRAY);
  } else {
    gray = img;
  }

  cv::Mat imgFloat;
  if (gray.type() != CV_32F) {
    gray.convertTo(imgFloat, CV_32F, 1.0 / PIXEL_MAX_DOUBLE);
  } else {
    imgFloat = gray;
  }

  imgFloat = (imgFloat - HALF) / HALF;
  int imgW = std::min(imgFloat.cols, maxWidth);
  int imgH = std::min(imgFloat.rows, height);
  cv::Mat cropped = imgFloat(cv::Rect(0, 0, imgW, imgH));

  cv::Mat padImg;
  cv::copyMakeBorder(
      cropped,
      padImg,
      0,
      height - imgH,
      0,
      maxWidth - imgW,
      cv::BORDER_REPLICATE);

  return padImg;
}

/**
 * @brief calculates the proportional width for EasyOCR-style resizing
 *
 * Always scales height to RECOGNIZER_MODEL_HEIGHT, width is proportional to
 * aspect ratio. This matches EasyOCR's preprocessing approach.
 *
 * @param width : original image width
 * @param height : original image height
 * @return int : the proportional width after resizing to model height
 */
int calculateProportionalWidth(int width, int height) {
  float ratio = static_cast<float>(width) / static_cast<float>(height);
  int newWidth = static_cast<int>(std::ceil(RECOGNIZER_MODEL_HEIGHT * ratio));
  return std::max(1, newWidth); // Ensure at least 1 pixel width
}

size_t crnnGraphSizeForWidth(int width) {
  if (width <= 0) {
    throw std::runtime_error("CRNN recognizer input width must be positive");
  }

  // build_crnn_gen2 produces roughly width / 4 timesteps after the feature
  // extractor. Each timestep unrolls two bidirectional LSTM layers, so the
  // ggml tensor/node count scales linearly with T. Keep the old 32k floor for
  // normal crops, but grow the graph budget for very wide text rows instead
  // of letting ggml abort when the fixed-size graph fills up.
  const size_t timesteps = std::max<size_t>(
      1,
      (static_cast<size_t>(width) + kCrnnWidthDownsample - 1) /
          kCrnnWidthDownsample);
  return std::max(
      kMinCrnnRunGraphSize,
      kCrnnRunGraphBaseSize + (timesteps * kCrnnRunGraphNodesPerTimestep));
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
cv::Mat alignAndCollate(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    const SubImage& subImage, int targetWidth, double adjustContrast = 0.0) {
  cv::Mat image = subImage.image;
  int width = image.cols;
  int height = image.rows;

  // Convert to grayscale once early to avoid redundant conversions downstream
  if (image.channels() > 1) {
    cv::cvtColor(image, image, cv::COLOR_RGB2GRAY);
  }

  if (adjustContrast > 0) {
    image = adjustContrastGrey(image, adjustContrast);
  }

  // EasyOCR-style resize: always scale height to model height, width
  // proportional
  int proportionalWidth = calculateProportionalWidth(width, height);

  cv::Mat resizedImage;
  cv::resize(
      image,
      resizedImage,
      cv::Size(proportionalWidth, RECOGNIZER_MODEL_HEIGHT),
      0,
      0,
      cv::INTER_LINEAR);

  return normalizeAndPad(
      resizedImage, 1 /*grayscale*/, RECOGNIZER_MODEL_HEIGHT, targetWidth);
}

/**
 * @brief Legacy version for backward compatibility - uses fixed
 * RECOGNIZER_MODEL_WIDTH
 */
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
cv::Mat alignAndCollate(const SubImage& subImage, double adjustContrast = 0.0) {
  return alignAndCollate(subImage, RECOGNIZER_MODEL_WIDTH, adjustContrast);
}

/**
 * @brief Groups results into paragraphs based on box proximity
 *
 * @param rawResult : per-line results
 * @param isLeftToRightScript : mode to group boxes (left to right or right to
 * left)
 * @return std::vector<InferredText> : the adjusted results grouped into
 * paragraphs
 */
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
std::vector<InferredText> getParagraph(
    const std::vector<InferredText>& rawResult, bool isLeftToRightScript) {
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

  for (const auto& res : rawResult) {
    BoxGroup boxGroup;
    int minX = std::numeric_limits<int>::max();
    int maxX = std::numeric_limits<int>::min();
    int minY = std::numeric_limits<int>::max();
    int maxY = std::numeric_limits<int>::min();
    for (const auto& point : res.boxCoordinates) {
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
  while (std::ranges::any_of(boxGroupList, [](const BoxGroup& boxGroup) {
    return boxGroup.group == 0;
  })) {
    std::vector<BoxGroup*> unassigned;
    for (auto& boxGroup : boxGroupList) {
      if (boxGroup.group == 0) {
        unassigned.push_back(&boxGroup);
      }
    }

    bool hasCurrent = std::ranges::any_of(
        boxGroupList, [currentGroup](const BoxGroup& boxGroup) {
          return boxGroup.group == currentGroup;
        });
    if (!hasCurrent && !unassigned.empty()) {
      unassigned[0]->group = currentGroup;
    } else {
      std::vector<BoxGroup*> currentBoxes;
      for (auto& boxGroup : boxGroupList) {
        if (boxGroup.group == currentGroup) {
          currentBoxes.push_back(&boxGroup);
        }
      }
      float sumHeight = 0.0F;
      for (auto* boxGroup : currentBoxes) {
        sumHeight += static_cast<float>(boxGroup->height);
      }
      float meanHeight = sumHeight / static_cast<float>(currentBoxes.size());

      int groupMinX = (*std::ranges::min_element(
                           currentBoxes,
                           [](const BoxGroup* boxA, const BoxGroup* boxB) {
                             return boxA->minX < boxB->minX;
                           }))
                          ->minX;
      int groupMaxX = (*std::ranges::max_element(
                           currentBoxes,
                           [](const BoxGroup* boxA, const BoxGroup* boxB) {
                             return boxA->maxX < boxB->maxX;
                           }))
                          ->maxX;
      int groupMinY = (*std::ranges::min_element(
                           currentBoxes,
                           [](const BoxGroup* boxA, const BoxGroup* boxB) {
                             return boxA->minY < boxB->minY;
                           }))
                          ->minY;
      int groupMaxY = (*std::ranges::max_element(
                           currentBoxes,
                           [](const BoxGroup* boxA, const BoxGroup* boxB) {
                             return boxA->maxY < boxB->maxY;
                           }))
                          ->maxY;

      const int minGx =
          groupMinX -
          static_cast<int>(X_THRESHOLD_FOR_PARAGRAPH_MERGE * meanHeight);
      const int maxGx =
          groupMaxX +
          static_cast<int>(X_THRESHOLD_FOR_PARAGRAPH_MERGE * meanHeight);
      const int minGy =
          groupMinY -
          static_cast<int>(Y_THRESHOLD_FOR_PARAGRAPH_MERGE * meanHeight);
      const int maxGy =
          groupMaxY +
          static_cast<int>(Y_THRESHOLD_FOR_PARAGRAPH_MERGE * meanHeight);

      bool added = false;
      for (auto* boxGroup : unassigned) {
        bool sameHorizontal =
            (minGx <= boxGroup->minX && boxGroup->minX <= maxGx) ||
            (minGx <= boxGroup->maxX && boxGroup->maxX <= maxGx);
        bool sameVertical =
            (minGy <= boxGroup->minY && boxGroup->minY <= maxGy) ||
            (minGy <= boxGroup->maxY && boxGroup->maxY <= maxGy);
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
  for (const auto& boxGroup : boxGroupList) {
    groups.insert(boxGroup.group);
  }
  for (int grp : groups) {
    std::vector<BoxGroup*> groupBoxes;
    for (auto& boxGroup : boxGroupList) {
      if (boxGroup.group == grp) {
        groupBoxes.push_back(&boxGroup);
      }
    }
    int groupMinX = groupBoxes[0]->minX;
    int groupMaxX = groupBoxes[0]->maxX;
    int groupMinY = groupBoxes[0]->minY;
    int groupMaxY = groupBoxes[0]->maxY;
    float sumHeight = 0.0F;
    for (auto* boxGroup : groupBoxes) {
      groupMinX = std::min(groupMinX, boxGroup->minX);
      groupMaxX = std::max(groupMaxX, boxGroup->maxX);
      groupMinY = std::min(groupMinY, boxGroup->minY);
      groupMaxY = std::max(groupMaxY, boxGroup->maxY);
      sumHeight += static_cast<float>(boxGroup->height);
    }
    float meanHeight = sumHeight / static_cast<float>(groupBoxes.size());

    std::string combinedText;
    float finalConfidence = 1.0F;
    std::vector<BoxGroup*> remaining = groupBoxes;
    while (!remaining.empty()) {
      float lowest = remaining[0]->yCenter;
      for (auto* boxGroup : remaining) {
        lowest = std::min(lowest, boxGroup->yCenter);
      }
      std::vector<BoxGroup*> candidates;
      for (auto* boxGroup : remaining) {
        if (boxGroup->yCenter < lowest + (PARAGRAPH_Y_DELTA * meanHeight)) {
          candidates.push_back(boxGroup);
        }
      }
      BoxGroup* bestBox = nullptr;
      if (isLeftToRightScript) {
        bestBox = *std::ranges::min_element(
            candidates, [](const BoxGroup* boxA, const BoxGroup* boxB) {
              return boxA->minX < boxB->minX;
            });
      } else {
        bestBox = *std::ranges::max_element(
            candidates, [](const BoxGroup* boxA, const BoxGroup* boxB) {
              return boxA->maxX < boxB->maxX;
            });
      }
      combinedText += " " + bestBox->text;
      finalConfidence = std::min(finalConfidence, bestBox->confidence);
      const auto eraseRange = std::ranges::remove(remaining, bestBox);
      remaining.erase(eraseRange.begin(), eraseRange.end());
    }
    if (!combinedText.empty() && combinedText.front() == ' ') {
      combinedText.erase(0, 1);
    }
    if (combinedText.empty()) {
      finalConfidence = 0.0F;
    }
    std::array<cv::Point2f, 4> finalBox = {
        cv::Point2f(
            static_cast<float>(groupMinX), static_cast<float>(groupMinY)),
        cv::Point2f(
            static_cast<float>(groupMaxX), static_cast<float>(groupMinY)),
        cv::Point2f(
            static_cast<float>(groupMaxX), static_cast<float>(groupMaxY)),
        cv::Point2f(
            static_cast<float>(groupMinX), static_cast<float>(groupMaxY))};
    result.emplace_back(finalBox, combinedText, finalConfidence);
  }
  return result;
}

/**
 * @brief shifts the box coordinates based on angle
 *
 * Required so box[0] always points to the top-left most point in relation to
 * the text
 *
 * @param box : source box (assumed to be in horizontal position)
 * @param angle : angle to rotate (one of 90, 180, 270)
 * @return std::array<cv::Point2f, 4> : the rotated box
 */
std::array<cv::Point2f, 4>
rotateBox(const std::array<cv::Point2f, 4>& box, int angle) {
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
    const std::string& gguf_path, std::span<const std::string> langList,
    Config config)
    : config_(std::move(config)), backendsHandle_(config_.backendsDir) {
  ggml_backend_dev_t dev =
      (config_.backendDevice != nullptr)
          ? config_.backendDevice
          : ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  backend_ = dev ? ggml_backend_dev_init(dev, nullptr) : nullptr;
  if (backend_ == nullptr) {
    throw std::runtime_error("StepRecognizeText: failed to init ggml backend");
  }
  // Thread-count tuning only applies to the CPU backend; GPU backends (Vulkan)
  // ignore it, so gate the call on the selected device being CPU.
  const bool isCpu = ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_CPU;
  if (isCpu && config_.nThreads >= 0) {
    const int effective = (config_.nThreads == 0)
                              ? defaultPhysicalThreadCount()
                              : config_.nThreads;
    ggml_backend_reg_t cpuReg = ggml_backend_dev_backend_reg(dev);
    auto* fn_set_n_threads =
        cpuReg ? (ggml_backend_set_n_threads_t)ggml_backend_reg_get_proc_address(
                     cpuReg, "ggml_backend_set_n_threads")
               : nullptr;
    if (fn_set_n_threads) {
      fn_set_n_threads(backend_, effective);
    }
  }

  loader_ = std::make_unique<easyocr::ggml::GgufLoader>(
      gguf_path, /*load_tensor_data=*/true);
  if (!loader_->ok()) {
    throw std::runtime_error(
        "StepRecognizeText: failed to open GGUF: " + gguf_path);
  }

  // Gen-2-only runtime: this binary supports english_g2/latin_g2-family
  // recognizers and always constructs the VGG-backed weights.
  gen2_weights_ =
      std::make_unique<easyocr::ggml::CrnnGen2Weights>(*loader_, backend_);
  if (!gen2_weights_->ok()) {
    throw std::runtime_error(
        "StepRecognizeText: CrnnGen2Weights load failed: " +
        gen2_weights_->err());
  }

  validateUnknownLanguages(langList);
  std::u32string_view langChars;
  std::tie(langChars, ignoreChars_, isLeftToRightScript_) =
      getCharsInfoFromLangList(langList);

  // Source the runtime vocab from the GGUF.  The Lang.cpp
  // table for `langList` is asserted to match — if a future custom GGUF
  // is loaded against a wrong language list we want a loud failure.
  if (auto vocab_utf8 = loader_->get_string("crnn.vocab")) {
    // ocr-onnx's Lang.cpp character strings start with a leading space
    // at index 0 as the CTC blank placeholder; decodeGreedy maps index 0
    // to blank (skips it) and index N to characters_[N]. The GGUF
    // crnn.vocab is the bare character set without that leading blank, so
    // we prepend U' ' to make the indices line up.
    utf32Owned_ = U" "; // blank at position 0
    utf32Owned_ += converter_.from_bytes(
        vocab_utf8->data(), vocab_utf8->data() + vocab_utf8->size());
    utf32Characters_ = utf32Owned_;

    if (utf32Characters_ != langChars) {
      // We don't hard-fail in release builds — the lang table may be
      // a superset/subset for some script families. Log loud and
      // trust the GGUF (which is what the model was trained on).
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::WARN,
          std::string("[Recognition] GGUF crnn.vocab differs from "
                      "Lang.cpp table for the requested language "
                      "list (sizes: gguf=") +
              std::to_string(utf32Characters_.size()) +
              ", lang=" + std::to_string(langChars.size()) +
              ") — using GGUF as the runtime vocab.");
    }
  } else {
    // GGUF didn't carry crnn.vocab — fall back to the Lang table.
    utf32Characters_ = langChars;
  }
}

StepRecognizeText::~StepRecognizeText() {
  destroyRecognizerGraph();
  gen2_weights_.reset();
  loader_.reset();
  if (backend_ != nullptr) {
    ggml_backend_free(backend_);
  }
}

StepRecognizeText::Output StepRecognizeText::process(
    StepRecognizeText::Input input, const std::atomic<bool>* cancelFlag) {
  using clock = std::chrono::high_resolution_clock;
  using msd = std::chrono::duration<double, std::milli>;

  lastTimings_ = RecognitionStageTimings{};

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[Recognition] process() called - starting recognition");
  const auto tPopulate0 = clock::now();
  populateImageList(input);
  expandImgListWithRotatedImgs(input.context.rotationAngles);
  const auto tPopulate1 = clock::now();
  lastTimings_.populateMs = msd(tPopulate1 - tPopulate0).count();
  for (const auto& list : imgListOfLists_) {
    lastTimings_.numBoxes += static_cast<int>(list.size());
  }

  std::vector<InferredText> inferenceResult = processImgList(cancelFlag);
  imgListOfLists_.clear();

  if (input.context.paragraph) {
    const auto tPara0 = clock::now();
    inferenceResult = getParagraph(inferenceResult, isLeftToRightScript_);
    const auto tPara1 = clock::now();
    lastTimings_.paragraphMs = msd(tPara1 - tPara0).count();
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
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "[Recognition] Scaled coordinates back by factor " +
            std::to_string(scaleBack));
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[Recognition] process() completed - returning " +
          std::to_string(inferenceResult.size()) + " results");
  return inferenceResult;
}

void StepRecognizeText::populateImageList(const Input& input) {
  const cv::Mat& img = input.context.origImg;
  int maximumY = img.rows;
  int maximumX = img.cols;

  imgListOfLists_.clear();
  imgListOfLists_.reserve(
      input.unalignedBoxes.size() + input.alignedBoxes.size());

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[Recognition] populateImageList: processing " +
          std::to_string(input.unalignedBoxes.size()) + " unaligned, " +
          std::to_string(input.alignedBoxes.size()) + " aligned boxes");

  for (const auto& box : input.unalignedBoxes) {
    cv::Mat transformedImg = fourPointTransform(img, box.coords);
    float ratioLocal = calculateRatio(
        static_cast<float>(transformedImg.cols),
        static_cast<float>(transformedImg.rows));
    int newWidth = static_cast<int>(RECOGNIZER_MODEL_HEIGHT * ratioLocal);
    if (newWidth == 0) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "[Recognition] Skipped unaligned box: newWidth=0 (ratio=" +
              std::to_string(ratioLocal) + ")");
      continue;
    }

    auto cropImg = resizeImgForRecognizerInput(
        transformedImg,
        static_cast<float>(transformedImg.cols),
        static_cast<float>(transformedImg.rows));
    std::vector<SubImage> imgList;
    imgList.emplace_back(box.coords, cropImg, box.isMultiCharacter);
    imgListOfLists_.push_back(imgList);
  }

  for (const auto& box : input.alignedBoxes) {
    int xMin = std::max(0, static_cast<int>(box.coords[0]));
    int xMax = std::min(static_cast<int>(box.coords[1]), maximumX);
    int yMin = std::max(0, static_cast<int>(box.coords[2]));
    int yMax = std::min(static_cast<int>(box.coords[3]), maximumY);
    if (xMax <= xMin || yMax <= yMin) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "[Recognition] Skipped aligned box: invalid coords xMin=" +
              std::to_string(xMin) + " xMax=" + std::to_string(xMax) +
              " yMin=" + std::to_string(yMin) +
              " yMax=" + std::to_string(yMax));
      continue;
    }

    int width = xMax - xMin;
    int height = yMax - yMin;
    float ratioLocal =
        calculateRatio(static_cast<float>(width), static_cast<float>(height));
    int newWidth = static_cast<int>(RECOGNIZER_MODEL_HEIGHT * ratioLocal);
    if (newWidth == 0) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "[Recognition] Skipped aligned box: newWidth=0 (w=" +
              std::to_string(width) + " h=" + std::to_string(height) +
              " ratio=" + std::to_string(ratioLocal) + ")");
      continue;
    }

    cv::Rect roi(xMin, yMin, xMax - xMin, yMax - yMin);
    cv::Mat cropImg = img(roi);
    cv::Mat resizedImg = resizeImgForRecognizerInput(
        cropImg, static_cast<float>(width), static_cast<float>(height));
    std::array<cv::Point2f, 4> rect = {
        {cv::Point2f(static_cast<float>(xMin), static_cast<float>(yMin)),
         cv::Point2f(static_cast<float>(xMax), static_cast<float>(yMin)),
         cv::Point2f(static_cast<float>(xMax), static_cast<float>(yMax)),
         cv::Point2f(static_cast<float>(xMin), static_cast<float>(yMax))}};
    std::vector<SubImage> imgList;
    imgList.emplace_back(rect, resizedImg, box.isMultiCharacter);
    imgListOfLists_.push_back(imgList);
  }

  // Sort boxes in reading order: top-to-bottom, left-to-right (matches EasyOCR
  // ordering) First, calculate mean box height for row threshold
  float sumHeight = 0.0F;
  for (const auto& imgList : imgListOfLists_) {
    const auto& coords = imgList[0].coords;
    float height = coords[3].y - coords[0].y; // bottom.y - top.y
    sumHeight += height;
  }
  float meanHeight =
      imgListOfLists_.empty()
          ? 1.0F
          : sumHeight / static_cast<float>(imgListOfLists_.size());
  constexpr float yCenterThreshold = 0.5F; // Same as EasyOCR's ycenter_ths
  float rowThreshold = yCenterThreshold * meanHeight;

  // Sort by y_center first, then by x for boxes on same row
  std::ranges::sort(
      imgListOfLists_,
      // clang-analyzer-cplusplus.Move false positive: the analyzer traces
      // through libc++'s std::sort introsort partition (which uses
      // __iter_move(__first) to extract a pivot value) and incorrectly
      // attributes the moved-from state to the comparator's by-const-ref
      // arguments. The lambda only reads listA/listB[0].coords; no actual
      // use-after-move occurs. Same root cause hits step_bounding_box.cpp.
      [rowThreshold](
          const std::vector<SubImage>& listA,
          const std::vector<SubImage>& listB) {
        constexpr float kQuadEdgeMidpointDivisor = 2.0F;
        const auto& coordsA = listA[0].coords;
        // NOLINTNEXTLINE(clang-analyzer-cplusplus.Move)
        const auto& coordsB = listB[0].coords;
        float yCenterA =
            (coordsA[0].y + coordsA[3].y) / kQuadEdgeMidpointDivisor;
        float yCenterB =
            (coordsB[0].y + coordsB[3].y) / kQuadEdgeMidpointDivisor;
        // If y_centers are within threshold, consider them on same row and sort
        // by x
        if (std::abs(yCenterA - yCenterB) < rowThreshold) {
          return coordsA[0].x < coordsB[0].x;
        }
        // Otherwise sort by y_center
        return yCenterA < yCenterB;
      });

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[Recognition] populateImageList: result=" +
          std::to_string(imgListOfLists_.size()) + " image lists");
}

void StepRecognizeText::expandImgListWithRotatedImgs(
    std::optional<std::vector<int>>& rotationAngles) {
  constexpr int ratioDifferenceToIgnoreRotation = 5;
  bool canBypassRotations = !rotationAngles.has_value();
  constexpr int angle90 = 90;
  constexpr int angle180 = 180;
  constexpr int angle270 = 270;
  // Use per-image rotationAngles if provided, otherwise use config default
  const std::vector<int>& angles =
      rotationAngles ? *rotationAngles : config_.defaultRotationAngles;

  for (int angle : angles) {
    for (auto& imageList : imgListOfLists_) {
      cv::Mat& baseImg = imageList[0].image;
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
        throw std::invalid_argument(
            "Unexpected angle " + std::to_string(angle) +
            " received with rotationAngles. Angles must be one of [90, 180, "
            "270]");
      }
      std::array<cv::Point2f, 4> rotatedBox =
          rotateBox(imageList[0].coords, angle);
      imageList.emplace_back(
          rotatedBox, rotatedImg, imageList[0].isMultiCharacter);
    }
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
std::pair<std::string, float> StepRecognizeText::getTextAndConfidenceFromPreds(
    const cv::Mat& preds, int batchIdx) {
  assert(preds.dims == 3);
  const int imgSubcolumnsSize = preds.size[1];
  const int charSpaceSize = preds.size[2];
  assert(batchIdx >= 0 && batchIdx < preds.size[0]);

  // Use pointer arithmetic instead of .at<>() for performance
  const size_t batchStride = preds.step[0] / sizeof(float);
  const size_t subcolStride = preds.step[1] / sizeof(float);
  const float* batchBase = preds.ptr<float>() + (batchIdx * batchStride);

  // Use flat vector instead of vector<vector<float>> to reduce allocations
  std::vector<float> predsProb(
      static_cast<size_t>(imgSubcolumnsSize) * charSpaceSize, 0.0F);

  for (int subcolumn = 0; subcolumn < imgSubcolumnsSize; subcolumn++) {
    const float* subcolBase =
        batchBase + (static_cast<size_t>(subcolumn) * subcolStride);
    float* probRow =
        predsProb.data() + (static_cast<size_t>(subcolumn) * charSpaceSize);

    float maxVal = -std::numeric_limits<float>::infinity();
    for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
      maxVal = std::max(subcolBase[charIndex], maxVal);
    }

    float subcolumnSumExp = 0.0F;
    for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
      float expVal = std::exp(subcolBase[charIndex] - maxVal);
      probRow[charIndex] = expVal;
      subcolumnSumExp += expVal;
    }
    for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
      probRow[charIndex] /= subcolumnSumExp;
    }
  }

  for (int subcolumn = 0; subcolumn < imgSubcolumnsSize; subcolumn++) {
    float* probRow =
        predsProb.data() + (static_cast<size_t>(subcolumn) * charSpaceSize);
    // Guard against vocab/charSpaceSize mismatch: ignoreChars_ is sized by the
    // language table while charSpaceSize comes from the GGUF model. Mismatches
    // are warned about during construction but not hard-failed.
    const size_t ignoreSize = ignoreChars_.size();
    for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
      if (static_cast<size_t>(charIndex) < ignoreSize &&
          ignoreChars_[charIndex]) {
        probRow[charIndex] = 0.0F;
      }
    }
    float subcolumnSum = 0.0F;
    for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
      subcolumnSum += probRow[charIndex];
    }
    if (subcolumnSum > 0.0F) {
      for (int charIndex = 0; charIndex < charSpaceSize; charIndex++) {
        probRow[charIndex] /= subcolumnSum;
      }
    }
  }

  std::vector<size_t> predsIndex(imgSubcolumnsSize, 0);
  std::vector<float> predsMaxProb(imgSubcolumnsSize, 0.0F);
  for (int subcolumn = 0; subcolumn < imgSubcolumnsSize; subcolumn++) {
    const float* probRow =
        predsProb.data() + (static_cast<size_t>(subcolumn) * charSpaceSize);
    size_t charIndexMax = 0;
    float maxProbVal = probRow[0];
    for (size_t charIndex = 1; std::cmp_less(charIndex, charSpaceSize);
         charIndex++) {
      if (probRow[charIndex] > maxProbVal) {
        maxProbVal = probRow[charIndex];
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

// --- GGML inference helpers --------------------------------------------------
//
// build_crnn_gen2 currently collapses the batch axis at the AAP stage, so a
// batch is still computed one image at a time and the [T, classes] logits are
// stacked into a [N, T, classes] cv::Mat. The graph topology is identical for
// all images with the same (height, width), so StepRecognizeText caches the
// ggml context / graph / allocator / I/O tensors and only swaps input bytes
// between computes.

void StepRecognizeText::destroyRecognizerGraph() {
  if (recognizerGraphCache_.gallocr != nullptr) {
    ggml_gallocr_free(recognizerGraphCache_.gallocr);
    recognizerGraphCache_.gallocr = nullptr;
  }
  if (recognizerGraphCache_.gctx != nullptr) {
    ggml_free(recognizerGraphCache_.gctx);
    recognizerGraphCache_.gctx = nullptr;
  }
  recognizerGraphCache_.graph = nullptr;
  recognizerGraphCache_.input = nullptr;
  recognizerGraphCache_.output = nullptr;
  recognizerGraphCache_.height = 0;
  recognizerGraphCache_.width = 0;
  recognizerGraphCache_.graphSize = 0;
  recognizerGraphCache_.ctxBuf.clear();
}

void StepRecognizeText::ensureRecognizerGraph(
    int height, int width, size_t graphSize) {
  if (recognizerGraphCache_.gctx != nullptr &&
      recognizerGraphCache_.height == height &&
      recognizerGraphCache_.width == width &&
      recognizerGraphCache_.graphSize == graphSize) {
    return;
  }

  // Free only the size-specific graph context; deliberately KEEP
  // recognizerGraphCache_.gallocr so its backing backend buffer is reused (and
  // resized in place by ggml_gallocr_alloc_graph below) across region sizes.
  // EasyOCR rebuilds this graph once per distinct text-region width, so
  // freeing+reallocating the gallocr buffer every time is the heaviest source
  // of backend-heap churn — which fragments the Metal heap and can trigger
  // out-of-memory command-buffer failures on memory-constrained devices.
  if (recognizerGraphCache_.gctx != nullptr) {
    ggml_free(recognizerGraphCache_.gctx);
    recognizerGraphCache_.gctx = nullptr;
  }
  recognizerGraphCache_.graph = nullptr;
  recognizerGraphCache_.input = nullptr;
  recognizerGraphCache_.output = nullptr;

  const size_t graphCtxSize = (ggml_tensor_overhead() * graphSize) +
                              ggml_graph_overhead_custom(graphSize, false);
  recognizerGraphCache_.ctxBuf.assign(graphCtxSize, 0);
  ggml_init_params init{
      .mem_size = graphCtxSize,
      .mem_buffer = recognizerGraphCache_.ctxBuf.data(),
      .no_alloc = true,
  };

  recognizerGraphCache_.gctx = ggml_init(init);
  recognizerGraphCache_.input = ggml_new_tensor_4d(
      recognizerGraphCache_.gctx, GGML_TYPE_F32, width, height, 1, 1);
  recognizerGraphCache_.output = easyocr::ggml::build_crnn_gen2(
      recognizerGraphCache_.gctx,
      *gen2_weights_,
      recognizerGraphCache_.input,
      nullptr);
  ggml_set_output(recognizerGraphCache_.output);

  recognizerGraphCache_.graph =
      ggml_new_graph_custom(recognizerGraphCache_.gctx, graphSize, false);
  ggml_build_forward_expand(
      recognizerGraphCache_.graph, recognizerGraphCache_.output);

  if (recognizerGraphCache_.gallocr == nullptr) {
    recognizerGraphCache_.gallocr =
        ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend_));
  }
  if (!ggml_gallocr_alloc_graph(
          recognizerGraphCache_.gallocr, recognizerGraphCache_.graph)) {
    destroyRecognizerGraph();
    throw std::runtime_error(
        "StepRecognizeText: ggml_gallocr_alloc_graph failed");
  }

  recognizerGraphCache_.height = height;
  recognizerGraphCache_.width = width;
  recognizerGraphCache_.graphSize = graphSize;
}

cv::Mat StepRecognizeText::runRecognizerOneCached(
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
    const float* inputData, int height, int width, size_t graphSize) {
  ensureRecognizerGraph(height, width, graphSize);
  ggml_backend_tensor_set(
      recognizerGraphCache_.input,
      inputData,
      0,
      ggml_nbytes(recognizerGraphCache_.input));

  if (ggml_backend_graph_compute(backend_, recognizerGraphCache_.graph) !=
      GGML_STATUS_SUCCESS) {
    throw std::runtime_error(
        "StepRecognizeText: ggml_backend_graph_compute failed");
  }

  const int numClasses = static_cast<int>(recognizerGraphCache_.output->ne[0]);
  const int numTimesteps =
      static_cast<int>(recognizerGraphCache_.output->ne[1]);
  cv::Mat preds(numTimesteps, numClasses, CV_32F);
  ggml_backend_tensor_get(
      recognizerGraphCache_.output,
      preds.ptr<float>(),
      0,
      ggml_nbytes(recognizerGraphCache_.output));
  return preds;
}

cv::Mat StepRecognizeText::runInferenceOnImg(const cv::Mat& img) {
  int height = img.rows;
  int width = img.cols;
  int numChannels = img.channels();
  CV_Assert(numChannels == 1);
  CV_Assert(img.isContinuous());
  CV_Assert(img.type() == CV_32F);

  return runRecognizerOneCached(
      img.ptr<float>(), height, width, crnnGraphSizeForWidth(width));
}

cv::Mat StepRecognizeText::runBatchInference(
    const std::vector<cv::Mat>& images, int dynamicWidth) {
  auto t0 = std::chrono::high_resolution_clock::now();
  if (images.empty()) {
    return {};
  }

  const auto batchSize = static_cast<int>(images.size());
  const int height = RECOGNIZER_MODEL_HEIGHT;
  const int width = dynamicWidth;
  const int numChannels = 1;

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[Recognition] runBatchInference called with batch_size=" +
          std::to_string(batchSize) +
          ", dynamic_width=" + std::to_string(width));

  batchBuffer_.resize(
      static_cast<size_t>(batchSize) * numChannels * height * width);
  for (int b = 0; b < batchSize; b++) {
    const cv::Mat& img = images[b];
    CV_Assert(
        img.rows == height && img.cols == width &&
        img.channels() == numChannels);
    CV_Assert(img.type() == CV_32F);
    const auto* imgPtr = img.ptr<float>();
    float* destPtr = batchBuffer_.data() +
                     (static_cast<size_t>(b) * numChannels * height * width);
    std::memcpy(destPtr, imgPtr, sizeof(float) * height * width);
  }

  const size_t graphSize = crnnGraphSizeForWidth(width);
  cv::Mat first =
      runRecognizerOneCached(batchBuffer_.data(), height, width, graphSize);
  const int numTimesteps = first.rows;
  const int numClasses = first.cols;
  const size_t perImageFloats =
      static_cast<size_t>(numChannels) * height * width;
  const size_t perImageLogits = static_cast<size_t>(numTimesteps) * numClasses;

  std::array<int, 3> dims = {batchSize, numTimesteps, numClasses};
  cv::Mat preds(3, dims.data(), CV_32F);
  std::memcpy(
      preds.ptr<float>(), first.ptr<float>(), perImageLogits * sizeof(float));
  for (int b = 1; b < batchSize; ++b) {
    cv::Mat one = runRecognizerOneCached(
        batchBuffer_.data() + (static_cast<size_t>(b) * perImageFloats),
        height,
        width,
        graphSize);
    std::memcpy(
        preds.ptr<float>() + (static_cast<size_t>(b) * perImageLogits),
        one.ptr<float>(),
        perImageLogits * sizeof(float));
  }

  auto t1 = std::chrono::high_resolution_clock::now();
  auto batchMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[Recognition] runBatchInference took " + std::to_string(batchMs) +
          " ms for batch_size=" + std::to_string(batchSize));
  return preds;
}


std::vector<InferredText>
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
StepRecognizeText::processImgList(const std::atomic<bool>* cancelFlag) {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "[Recognition] processImgList: starting with " +
          std::to_string(imgListOfLists_.size()) + " image lists");
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
    auto& imgList = imgListOfLists_[listIdx];
    for (size_t imgIdx = 0; imgIdx < imgList.size(); imgIdx++) {
      allIndices.push_back({.listIdx = listIdx, .imgIdx = imgIdx});
    }
  }

  if (allIndices.empty()) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "[Recognition] processImgList: no images to process, returning early");
    return inferredTextList;
  }

  // Process in batches - prepare images ON-DEMAND to prevent OOM
  const int batchSize = config_.recognizerBatchSize;
  std::string batchInfoMsg =
      "[Recognition] Processing " + std::to_string(allIndices.size()) +
      " items in batches of " + std::to_string(batchSize) +
      " (on-demand preparation)";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, batchInfoMsg);
  ALOG_INFO(batchInfoMsg);

  for (size_t batchStart = 0; batchStart < allIndices.size();
       batchStart += batchSize) {
    // Check for cancellation between batches — break and return partial results
    if (cancelFlag != nullptr && cancelFlag->load(std::memory_order_relaxed)) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "[Recognition] Cancelled between batches at batch offset " +
              std::to_string(batchStart));
      break;
    }

    size_t batchEnd = std::min(
        batchStart + static_cast<size_t>(batchSize), allIndices.size());
    size_t currentBatchSize = batchEnd - batchStart;

    // Calculate max proportional width for this batch (EasyOCR-style dynamic
    // batching)
    int maxProportionalWidth = 0;
    for (size_t i = batchStart; i < batchEnd; i++) {
      auto& idx = allIndices[i];
      auto& subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
      int propWidth =
          calculateProportionalWidth(subImage.image.cols, subImage.image.rows);
      maxProportionalWidth = std::max(maxProportionalWidth, propWidth);
    }
    // Ensure minimum width for model stability
    maxProportionalWidth =
        std::max(maxProportionalWidth, RECOGNIZER_MODEL_HEIGHT);

    // Prepare images ONLY for this batch, using dynamic max width
    using clock = std::chrono::high_resolution_clock;
    using msd = std::chrono::duration<double, std::milli>;

    std::vector<cv::Mat> preparedImages;
    preparedImages.reserve(currentBatchSize);
    const auto tPrep0 = clock::now();
    for (size_t i = batchStart; i < batchEnd; i++) {
      auto& idx = allIndices[i];
      auto& subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
      cv::Mat preparedImg =
          alignAndCollate(subImage, maxProportionalWidth, 0.0);
      preparedImages.push_back(preparedImg);
    }
    const auto tPrep1 = clock::now();
    lastTimings_.batchPrepMs += msd(tPrep1 - tPrep0).count();

    const auto tInf0 = clock::now();
    cv::Mat batchPreds =
        runBatchInference(preparedImages, maxProportionalWidth);
    const auto tInf1 = clock::now();
    lastTimings_.inferenceMs += msd(tInf1 - tInf0).count();
    lastTimings_.numBatches += 1;

    // Decode results and populate SubImages for this batch
    const auto tDec0 = clock::now();
    for (size_t i = 0; i < currentBatchSize; i++) {
      auto& idx = allIndices[batchStart + i];
      auto& subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
      std::tie(subImage.text, subImage.confidenceScore) =
          getTextAndConfidenceFromPreds(batchPreds, static_cast<int>(i));
    }
    const auto tDec1 = clock::now();
    lastTimings_.ctcDecodeMs += msd(tDec1 - tDec0).count();

    // Clear prepared images to free memory before next batch
    preparedImages.clear();
    preparedImages.shrink_to_fit();

    std::string batchProgressMsg =
        "[Recognition] Processed batch " + std::to_string(batchStart) + "-" +
        std::to_string(batchEnd) + " of " + std::to_string(allIndices.size());
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        batchProgressMsg);
    ALOG_DEBUG(batchProgressMsg);
  }

  // Second pass: handle low confidence with contrast adjustment (if enabled)
  if (config_.contrastRetry) {
    std::vector<BatchIndex> lowConfidenceIndices;
    for (auto& idx : allIndices) {
      auto& subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
      if (subImage.confidenceScore < config_.lowConfidenceThreshold) {
        lowConfidenceIndices.push_back(idx);
      }
    }

    if (!lowConfidenceIndices.empty()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
          "[Recognition] Processing " +
              std::to_string(lowConfidenceIndices.size()) +
              " low-confidence items with contrast adjustment");

      // Process contrast retries in batches too
      for (size_t batchStart = 0; batchStart < lowConfidenceIndices.size();
           batchStart += batchSize) {
        // Check for cancellation between contrast retry batches
        if (cancelFlag != nullptr &&
            cancelFlag->load(std::memory_order_relaxed)) {
          QLOG(
              qvac_lib_inference_addon_cpp::logger::Priority::INFO,
              "[Recognition] Cancelled during contrast retry at batch offset " +
                  std::to_string(batchStart));
          break;
        }

        size_t batchEnd = std::min(
            batchStart + static_cast<size_t>(batchSize),
            lowConfidenceIndices.size());

        // Calculate max proportional width for contrast batch
        int maxProportionalWidth = 0;
        for (size_t j = batchStart; j < batchEnd; j++) {
          auto& idx = lowConfidenceIndices[j];
          auto& subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
          int propWidth = calculateProportionalWidth(
              subImage.image.cols, subImage.image.rows);
          maxProportionalWidth = std::max(maxProportionalWidth, propWidth);
        }
        maxProportionalWidth =
            std::max(maxProportionalWidth, RECOGNIZER_MODEL_HEIGHT);

        using clock = std::chrono::high_resolution_clock;
        using msd = std::chrono::duration<double, std::milli>;

        std::vector<cv::Mat> contrastImages;
        contrastImages.reserve(batchEnd - batchStart);
        const auto tPrep0 = clock::now();
        for (size_t j = batchStart; j < batchEnd; j++) {
          auto& idx = lowConfidenceIndices[j];
          auto& subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
          cv::Mat contrastImg = alignAndCollate(
              subImage, maxProportionalWidth, TARGET_ADJUSTED_CONTRAST);
          contrastImages.push_back(contrastImg);
        }
        const auto tPrep1 = clock::now();
        lastTimings_.batchPrepMs += msd(tPrep1 - tPrep0).count();

        const auto tInf0 = clock::now();
        cv::Mat contrastPreds =
            runBatchInference(contrastImages, maxProportionalWidth);
        const auto tInf1 = clock::now();
        lastTimings_.inferenceMs += msd(tInf1 - tInf0).count();
        lastTimings_.numContrastRetryBatches += 1;

        const auto tDec0 = clock::now();
        for (size_t j = 0; j < contrastImages.size(); j++) {
          auto& idx = lowConfidenceIndices[batchStart + j];
          auto& subImage = imgListOfLists_[idx.listIdx][idx.imgIdx];
          auto [newText, newConfidenceScore] =
              getTextAndConfidenceFromPreds(contrastPreds, static_cast<int>(j));
          if (newConfidenceScore > subImage.confidenceScore) {
            subImage.text = newText;
            subImage.confidenceScore = newConfidenceScore;
          }
        }
        const auto tDec1 = clock::now();
        lastTimings_.ctcDecodeMs += msd(tDec1 - tDec0).count();

        // Clear to free memory
        contrastImages.clear();
        contrastImages.shrink_to_fit();
      }
    }
  }

  // Apply single-character filter and find best result per imgList
  for (auto& imgList : imgListOfLists_) {
    double highestConfidence = 0.0;
    size_t highestConfidenceIndex = 0;

    for (size_t i = 0; i < imgList.size();
         i++) { // NOLINT(modernize-loop-convert) - index `i` is tracked
      auto& subImage = imgList[i];

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

    const auto& bestImg = imgList[highestConfidenceIndex];
    inferredTextList.emplace_back(
        bestImg.coords, bestImg.text, bestImg.confidenceScore);
  }

  auto t1 = std::chrono::high_resolution_clock::now();
  auto recognitionMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
  std::string timingMsg =
      "[Recognition] Total recognition time: " + std::to_string(recognitionMs) +
      " ms for " + std::to_string(inferredTextList.size()) + " text regions";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO, timingMsg);
  ALOG_INFO(timingMsg);

  return inferredTextList;
}

std::string
StepRecognizeText::decodeGreedy(const std::vector<size_t>& textIndex) {
  std::u32string text;
  if (!textIndex.empty()) {
    size_t first = textIndex[0];
    if (first != 0) {
      assert(first < utf32Characters_.size());
      text.push_back(utf32Characters_[first]);
    }

    for (size_t i = 1; i < textIndex.size(); ++i) {
      size_t prev = textIndex[i - 1];
      size_t curr = textIndex[i];
      if (curr != prev && curr != 0) {
        assert(curr < utf32Characters_.size());
        text.push_back(utf32Characters_[curr]);
      }
    }
  }

  return converter_.to_bytes(text);
}

} // namespace easyocr::ggml::pipeline

// NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,cppcoreguidelines-pro-bounds-avoid-unchecked-container-access,cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers,readability-identifier-naming,readability-identifier-length,hicpp-use-auto,modernize-use-auto,bugprone-narrowing-conversions,cppcoreguidelines-narrowing-conversions,readability-implicit-bool-conversion,modernize-avoid-c-style-cast,cppcoreguidelines-pro-type-cstyle-cast,modernize-use-integer-sign-comparison)
