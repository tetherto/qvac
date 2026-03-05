#pragma once

#include "Steps.hpp"

#include <onnxruntime_cxx_api.h>
#include <opencv2/imgproc.hpp>

#include <string>
#include <vector>

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

enum class DecodingMethod { CTC, ATTENTION };

struct StepDoctrRecognition {
public:
  using Input = StepDoctrDetectionOutput;
  using Output = std::vector<InferredText>;

  static constexpr int RECOG_HEIGHT = 32;
  static constexpr int RECOG_WIDTH = 128;

  StepDoctrRecognition(const ORTCHAR_T* pathRecognizer, bool useGPU = true,
                       int batchSize = 32,
                       DecodingMethod decoding = DecodingMethod::CTC);

#if defined(_WIN32) || defined(_WIN64)
  // On Windows, defer session destruction to avoid the ORT global-state crash.
  ~StepDoctrRecognition() { deferWindowsSessionLeak(std::move(ortSession_)); }
#endif

  Output process(Input input);

private:
  struct SoftmaxResult {
    int bestIdx;
    float bestProb;
  };

  Ort::Session ortSession_{nullptr};
  int batchSize_;
  DecodingMethod decodingMethod_;

  // OnnxTR vocabulary (french vocab shared by all models)
  static const std::string VOCAB;
  // Index 126 = <eos> for attention models, blank token for CTC models
  static constexpr int SPECIAL_TOKEN_IDX = 126;
  // Parsed vocab characters (initialized once in constructor)
  std::vector<std::string> vocabChars_;

  // Crop, perspective-transform, and preprocess a text region for recognition
  cv::Mat preprocessCrop(const cv::Mat& origImg, const std::array<cv::Point2f, 4>& polygon);

  // Run batch ONNX inference, returns raw logits [batch, seq_len, vocab_size+3]
  cv::Mat runBatchInference(const std::vector<cv::Mat>& images);

  // Softmax + argmax for a single timestep, returns best index and its probability
  SoftmaxResult softmaxArgmax(const cv::Mat& preds, int batchIdx, int timestep, int vocabSize);

  // Decode attention-based predictions (PARSeq, SAR, ViTSTR, MASTER): softmax + argmax, stop at <eos>
  std::pair<std::string, float> decodeAttention(const cv::Mat& preds, int batchIdx);

  // Decode CTC predictions (CRNN, VIPTR): softmax + argmax, remove blanks, collapse duplicates
  std::pair<std::string, float> decodeCTC(const cv::Mat& preds, int batchIdx);
};

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
