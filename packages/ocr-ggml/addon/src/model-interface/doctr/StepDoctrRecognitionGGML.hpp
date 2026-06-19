#pragma once

#include <atomic>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <ggml-backend.h>
#include <opencv2/imgproc.hpp>

#include "DoctrPipelineTypes.hpp"
#include "StepDoctrRecognition.hpp"

namespace doctr::ggml::pipeline {

struct StepDoctrRecognitionGGML {
public:
  using Input = StepDoctrDetectionOutput;
  using Output = std::vector<InferredText>;

  static constexpr int RECOG_HEIGHT = StepDoctrRecognition::RECOG_HEIGHT;
  static constexpr int RECOG_WIDTH = StepDoctrRecognition::RECOG_WIDTH;
  static constexpr int DEFAULT_BATCH_SIZE = 4;

  // backendDevice: ggml device the MobileNetV3 feature-extractor graph AND the
  // bidirectional LSTM + linear classifier run on (selected by `Pipeline` via
  // `ocr_backend_selection`). nullptr -> CPU device. The recurrent tail is a
  // batched ggml graph; set OCR_DOCTR_LSTM_CPU=1 to force the scalar CPU path.
  //
  // assistDevice: optional second ggml device that runs the feature extractor
  // concurrently with `backendDevice` on disjoint crop chunks (work-stealing).
  // Used on Mali, where the CPU is otherwise idle while the Vulkan recognizer
  // computes; per-crop math is unchanged, only the executing backend differs.
  explicit StepDoctrRecognitionGGML(
      const std::string& pathRecognizer, int batchSize = DEFAULT_BATCH_SIZE,
      DecodingMethod decoding = DecodingMethod::CTC,
      ggml_backend_dev_t backendDevice = nullptr, int nThreads = 0,
      ggml_backend_dev_t assistDevice = nullptr, int assistBatchSize = 0);
  ~StepDoctrRecognitionGGML();

  StepDoctrRecognitionGGML(const StepDoctrRecognitionGGML&) = delete;
  StepDoctrRecognitionGGML& operator=(const StepDoctrRecognitionGGML&) = delete;
  StepDoctrRecognitionGGML(StepDoctrRecognitionGGML&&) = delete;
  StepDoctrRecognitionGGML& operator=(StepDoctrRecognitionGGML&&) = delete;

  /**
   * @param input      detection output with polygons to recognise
   * @param cancelFlag optional pointer to an atomic cancel flag; breaks early
   *                   between batches and returns partial results
   */
  Output process(Input input, const std::atomic<bool>* cancelFlag = nullptr);

private:
  struct SoftmaxResult {
    int bestIdx;
    float bestProb;
  };

  struct Impl;
  std::unique_ptr<Impl> impl_;
  // Second feature-extractor instance on `assistDevice` (see constructor).
  std::unique_ptr<Impl> assistImpl_;

  int batchSize_;
  DecodingMethod decodingMethod_;
  int nThreads_;

  static const std::string VOCAB;
  static constexpr int SPECIAL_TOKEN_IDX = 126;

  std::vector<std::string> vocabChars_;

  static cv::Mat preprocessCrop(
      const cv::Mat& origImg, const std::array<cv::Point2f, 4>& polygon);

  // Pack a preprocessed crop (CV_32FC3, RECOG_HEIGHT x RECOG_WIDTH) into the
  // WHCN feature-extractor input buffer at the given batch slot.
  static void packCropIntoBatch(
      const cv::Mat& image, std::vector<float>& batchInput, int slot);

  // Decode the LSTM+linear logits for one crop into (text, confidence).
  std::pair<std::string, float> decodeLogits(const std::vector<float>& logits);

  // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
  static SoftmaxResult softmaxArgmax(
      const cv::Mat& preds, int batchIdx, int timestep, int vocabSize);
  std::pair<std::string, float>
  decodeAttention(const cv::Mat& preds, int batchIdx);
  std::pair<std::string, float> decodeCTC(const cv::Mat& preds, int batchIdx);
};

} // namespace doctr::ggml::pipeline
