#pragma once

#include <atomic>
#include <memory>
#include <string>
#include <utility>
#include <vector>

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
  static constexpr int DEFAULT_BATCH_SIZE = 32;

  explicit StepDoctrRecognitionGGML(
      const std::string& pathRecognizer, int batchSize = DEFAULT_BATCH_SIZE,
      DecodingMethod decoding = DecodingMethod::CTC);
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

  int batchSize_;
  DecodingMethod decodingMethod_;

  static const std::string VOCAB;
  static constexpr int SPECIAL_TOKEN_IDX = 126;

  std::vector<std::string> vocabChars_;
  std::vector<float> inputBuffer_;
  std::vector<float> logitsBuffer_;

  static cv::Mat preprocessCrop(
      const cv::Mat& origImg, const std::array<cv::Point2f, 4>& polygon);
  cv::Mat runSingleInference(const cv::Mat& image);

  static SoftmaxResult softmaxArgmax(
      const cv::Mat& preds, int batchIdx, int timestep, int vocabSize);
  std::pair<std::string, float>
  decodeAttention(const cv::Mat& preds, int batchIdx);
  std::pair<std::string, float> decodeCTC(const cv::Mat& preds, int batchIdx);
};

} // namespace doctr::ggml::pipeline
