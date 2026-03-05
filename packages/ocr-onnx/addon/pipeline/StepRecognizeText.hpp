#pragma once

#include "Steps.hpp"

// #include <onnxruntime_cxx_api.h>
#include <opencv2/imgproc.hpp>

#include <array>
#include <chrono>
#include <codecvt>
#include <locale>
#include <span>
#include <string>
#include <utility>
#include <vector>

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

struct StepRecognizeText {
public:
  using Input = StepBoundingBoxesOutput;
  using Output = std::vector<InferredText>;

  struct SubImage {
    std::array<cv::Point2f, 4> coords;
    cv::Mat image;
    bool isMultiCharacter;
    std::string text;
    double confidenceScore{};

    SubImage(std::array<cv::Point2f, 4> coords, cv::Mat image, bool isMultiCharacterFlag)
      : coords{coords}
      , image{std::move(image)}
      , isMultiCharacter{isMultiCharacterFlag} {}
  };

  struct Config {
    std::vector<int> defaultRotationAngles;           // Default rotation angles to try
    bool contrastRetry{false};                        // Retry low-confidence with contrast (disabled by default for mobile memory)
    float lowConfidenceThreshold{0.4F};               // Threshold for contrast retry
    int recognizerBatchSize{32};                      // Batch size for recognizer inference

    Config() : defaultRotationAngles{90, 270} {}
    Config(std::vector<int> angles, bool retry, float threshold, int batchSize = 32)
        : defaultRotationAngles(std::move(angles)), contrastRetry(retry), lowConfidenceThreshold(threshold), recognizerBatchSize(batchSize) {}
  };

  StepRecognizeText(
      const ORTCHAR_T* pathRecognizer, std::span<const std::string> langList,
      bool useGPU = false, const Config& config = Config{});

  CONSTRUCT_FROM_TUPLE(StepRecognizeText)

  /**
   * @brief main processing function to extract the text in the image for each bounding box
   *
   * @param input : bounding box output
   * @return StepRecognizeText::Output
   */
  Output process(Input input);

private:
  Config config_;
  Ort::Session ortSession_{nullptr};

  std::wstring_convert<std::codecvt_utf8<char32_t>, char32_t> converter_;
  std::u32string_view utf32Characters_;
  std::vector<bool> ignoreChars_;
  bool isLeftToRightScript_;

  std::vector<std::vector<SubImage>> imgListOfLists_;

  /**
   * @brief populates imgListOfLists_ with the SubImages from the original image based on bounding boxes information
   *
   * @param input : bounding box step output
   */
  void populateImageList(const Input &input);

  /**
   * @brief expands the SubImage list with versions of each SubImage rotated according to rotationAngles
   *
   * If rotationAngles is empty, expands with all [90, 180, 270]. The expection is if the image is known to be multi-character and is too wide (width
   * > 5 * height). In that case, do not expand to those angles
   *
   * @param rotationAngles : angles to rotate. If set, must be contain only angles in [90, 180, 270]. Leaves imgListOfLists_ unchanged if set but empty
   */
  void expandImgListWithRotatedImgs(std::optional<std::vector<int>> &rotationAngles);

  /**
   * @brief extracts text and confidence score from ONNX inference results
   *
   * @param preds : the predictions from the recognizer
   * @param batchIdx : index in batch (0 for single image inference)
   * @return std::pair<std::string, float> : the text and the confidence
   */
  std::pair<std::string, float> getTextAndConfidenceFromPreds(const cv::Mat &preds, int batchIdx = 0);

  /**
   * @brief runs ONXN inference on an image
   *
   * @param img : the recognizer input
   * @return cv::Mat : the recognizer predictions
   */
  cv::Mat runInferenceOnImg(const cv::Mat &img);

  /**
   * @brief runs ONNX batch inference on multiple images with dynamic width
   *
   * @param images : vector of prepared recognizer inputs
   * @param dynamicWidth : the width of input images (for dynamic-width models)
   * @return cv::Mat : the recognizer predictions with shape [batch, seq_len, num_chars]
   */
  cv::Mat runBatchInference(const std::vector<cv::Mat> &images, int dynamicWidth);

  /**
   * @brief processes the sub image to run recognizer inference and populate text and confidence score
   *
   * If the confidence score is too low with the original image, tries again with adjusted constrast
   *
   * @param subImage : image to be processed and populated with inference results
   */
  void processImg(SubImage &subImage);

  /**
   * @brief runs ONNX inference on the list of lists of images
   *
   * For each sublist, selects the best result and extracts InferredText
   *
   * @return std::vector<InferredText> : the extracted results
   */
  std::vector<InferredText> processImgList();

  /**
   * @brief decodes the textIndex outputed by the recognizer into characters, and create the string with those characters
   *
   * @param textIndex : the indexes of each character
   * @return std::string : the predicted text
   */
  std::string decodeGreedy(const std::vector<size_t> &textIndex);
};

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
