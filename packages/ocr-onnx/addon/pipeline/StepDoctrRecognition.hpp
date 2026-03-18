#pragma once

#include <atomic>
#include <string>
#include <utility>
#include <vector>

#include <opencv2/imgproc.hpp>
#include <qvac-onnx/OnnxSession.hpp>

#include "Steps.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

enum class DecodingMethod { CTC, ATTENTION };

struct StepDoctrRecognition {
public:
  using Input = StepDoctrDetectionOutput;
  using Output = std::vector<InferredText>;

  static constexpr int RECOG_HEIGHT = 32;
  static constexpr int RECOG_WIDTH = 128;

  StepDoctrRecognition(
      const std::string& pathRecognizer,
      const onnx_addon::SessionConfig& sessionConfig = {}, int batchSize = 32,
      DecodingMethod decoding = DecodingMethod::CTC);

#if defined(_WIN32) || defined(_WIN64)
  // On Windows, defer session destruction to avoid the ORT global-state crash.
  ~StepDoctrRecognition() { deferWindowsSessionLeak(std::move(session_)); }
#endif

  /**
   * @param input : detection output with polygons to recognize
   * @param cancelFlag : optional pointer to an atomic cancel flag; breaks early between batches and returns partial results
   */
  Output process(Input input, const std::atomic<bool>* cancelFlag = nullptr);

private:
  struct SoftmaxResult {
    int bestIdx;
    float bestProb;
  };

  onnx_addon::OnnxSession session_;
  int batchSize_;
  DecodingMethod decodingMethod_;

  // OnnxTR vocabulary (french vocab shared by all models)
  static const std::string VOCAB;
  // Index 126 = <eos> for attention models, blank token for CTC models
  static constexpr int SPECIAL_TOKEN_IDX = 126;
  // Parsed vocab characters (initialized once in constructor)
  std::vector<std::string> vocabChars_;
  std::vector<float> batchBuffer_;

  // Crop, perspective-transform, and preprocess a text region for recognition
  cv::Mat preprocessCrop(const cv::Mat& origImg, const std::array<cv::Point2f, 4>& polygon);

  // Run batch ONNX inference, returns raw logits [batch, seq_len, vocab_size+3]
  std::pair<std::vector<Ort::Value>, cv::Mat>
  runBatchInference(const std::vector<cv::Mat>& images);

  // Softmax + argmax for a single timestep, returns best index and its probability
  SoftmaxResult softmaxArgmax(const cv::Mat& preds, int batchIdx, int timestep, int vocabSize);

  // Decode attention-based predictions (PARSeq, SAR, ViTSTR, MASTER): softmax + argmax, stop at <eos>
  std::pair<std::string, float> decodeAttention(const cv::Mat& preds, int batchIdx);

  // Decode CTC predictions (CRNN, VIPTR): softmax + argmax, remove blanks, collapse duplicates
  std::pair<std::string, float> decodeCTC(const cv::Mat& preds, int batchIdx);
};

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
