#include "StepDoctrRecognition.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include <opencv2/opencv.hpp>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "AndroidLog.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

// PARSeq vocabulary from HuggingFace config.json (french vocab)
// 126 characters + <eos>(126) — output dimension is 127
const std::string StepDoctrRecognition::VOCAB =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
    "\xC2\xB0"     // ° (U+00B0)
    "\xC2\xA3"     // £ (U+00A3)
    "\xE2\x82\xAC" // € (U+20AC)
    "\xC2\xA5"     // ¥ (U+00A5)
    "\xC2\xA2"     // ¢ (U+00A2)
    "\xE0\xB8\xBF" // ฿ (U+0E3F)
    "\xC3\xA0"     // à (U+00E0)
    "\xC3\xA2"     // â (U+00E2)
    "\xC3\xA9"     // é (U+00E9)
    "\xC3\xA8"     // è (U+00E8)
    "\xC3\xAA"     // ê (U+00EA)
    "\xC3\xAB"     // ë (U+00EB)
    "\xC3\xAE"     // î (U+00EE)
    "\xC3\xAF"     // ï (U+00EF)
    "\xC3\xB4"     // ô (U+00F4)
    "\xC3\xB9"     // ù (U+00F9)
    "\xC3\xBB"     // û (U+00FB)
    "\xC3\xBC"     // ü (U+00FC)
    "\xC3\xA7"     // ç (U+00E7)
    "\xC3\x80"     // À (U+00C0)
    "\xC3\x82"     // Â (U+00C2)
    "\xC3\x89"     // É (U+00C9)
    "\xC3\x88"     // È (U+00C8)
    "\xC3\x8A"     // Ê (U+00CA)
    "\xC3\x8B"     // Ë (U+00CB)
    "\xC3\x8E"     // Î (U+00CE)
    "\xC3\x8F"     // Ï (U+00CF)
    "\xC3\x94"     // Ô (U+00D4)
    "\xC3\x99"     // Ù (U+00D9)
    "\xC3\x9B"     // Û (U+00DB)
    "\xC3\x9C"     // Ü (U+00DC)
    "\xC3\x87";    // Ç (U+00C7)

namespace {

// DocTR recognition normalization (from HuggingFace config.json for parseq)
const cv::Scalar DOCTR_RECO_MEAN(0.694, 0.695, 0.693);
const cv::Scalar DOCTR_RECO_STD(0.299, 0.296, 0.301);
constexpr double PIXEL_MAX = 255.0;

// Parse the UTF-8 vocab string into individual character strings
std::vector<std::string> parseVocabToChars(const std::string& vocab) {
  std::vector<std::string> chars;
  size_t i = 0;
  while (i < vocab.size()) {
    int len = 1;
    unsigned char c = static_cast<unsigned char>(vocab[i]);
    if ((c & 0x80) == 0) {
      len = 1;
    } else if ((c & 0xE0) == 0xC0) {
      len = 2;
    } else if ((c & 0xF0) == 0xE0) {
      len = 3;
    } else if ((c & 0xF8) == 0xF0) {
      len = 4;
    }
    chars.push_back(vocab.substr(i, len));
    i += len;
  }
  return chars;
}

} // namespace

StepDoctrRecognition::StepDoctrRecognition(const ORTCHAR_T* pathRecognizer,
                                           bool useGPU, int batchSize,
                                           DecodingMethod decoding)
    : ortSession_(getSharedOrtEnv(), pathRecognizer, getOrtSessionOptions(useGPU)),
      batchSize_(batchSize),
      decodingMethod_(decoding),
      vocabChars_(parseVocabToChars(VOCAB)) {
  std::string decodingStr = (decoding == DecodingMethod::CTC) ? "CTC" : "ATTENTION";
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "[DoctrRecognition] ONNX session created, batchSize=" + std::to_string(batchSize) +
       ", decoding=" + decodingStr);
  ALOG_INFO(std::string("[DoctrRecognition] ONNX session created, decoding=" + decodingStr));
}

cv::Mat StepDoctrRecognition::preprocessCrop(const cv::Mat& origImg,
                                             const std::array<cv::Point2f, 4>& polygon) {
  // Perspective transform to rectified crop
  cv::Mat crop = fourPointTransform(origImg, polygon);

  if (crop.empty() || crop.cols == 0 || crop.rows == 0) {
    return cv::Mat::zeros(RECOG_HEIGHT, RECOG_WIDTH, CV_32FC3);
  }

  // Resize crop preserving aspect ratio (matching OnnxTR: preserve_aspect_ratio=True, symmetric_pad=False)
  // Scale to fit within 32x128 maintaining aspect ratio, pad with black at right/bottom
  int cropH = crop.rows;
  int cropW = crop.cols;
  float scaleH = static_cast<float>(RECOG_HEIGHT) / static_cast<float>(cropH);
  float scaleW = static_cast<float>(RECOG_WIDTH) / static_cast<float>(cropW);
  float cropScale = std::min(scaleH, scaleW);
  int newH = std::max(1, static_cast<int>(static_cast<float>(cropH) * cropScale));
  int newW = std::max(1, static_cast<int>(static_cast<float>(cropW) * cropScale));

  cv::Mat resized;
  cv::resize(crop, resized, cv::Size(newW, newH), 0, 0, cv::INTER_LINEAR);

  // Pad to RECOG_HEIGHT x RECOG_WIDTH with black (asymmetric: right/bottom padding)
  cv::Mat padded = cv::Mat::zeros(RECOG_HEIGHT, RECOG_WIDTH, resized.type());
  cv::Mat roi = padded(cv::Rect(0, 0, newW, newH));
  resized.copyTo(roi);

  // Image is already RGB from Pipeline - no color conversion needed
  // Convert to float and normalize
  cv::Mat floatImg;
  padded.convertTo(floatImg, CV_32FC3, 1.0 / PIXEL_MAX);

  // Apply docTR recognition normalization
  cv::subtract(floatImg, DOCTR_RECO_MEAN, floatImg);
  cv::divide(floatImg, DOCTR_RECO_STD, floatImg);

  return floatImg;
}

cv::Mat StepDoctrRecognition::runBatchInference(const std::vector<cv::Mat>& images) {
  if (images.empty()) {
    return cv::Mat();
  }

  const int batchSz = static_cast<int>(images.size());
  const int height = RECOG_HEIGHT;
  const int width = RECOG_WIDTH;
  const int numChannels = 3;

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DoctrRecognition] runBatchInference batch_size=" + std::to_string(batchSz));

  // Create batch tensor: [batch, channels, height, width] in CHW format
  std::vector<float> batchData(batchSz * numChannels * height * width);

  for (int b = 0; b < batchSz; b++) {
    const cv::Mat& img = images[b];
    CV_Assert(img.rows == height && img.cols == width);

    // Split into channels and copy in CHW format
    std::vector<cv::Mat> channels;
    cv::split(img, channels);
    for (int c = 0; c < numChannels; c++) {
      float* dest = batchData.data() + b * numChannels * height * width + c * height * width;
      CV_Assert(channels[c].isContinuous());
      std::memcpy(dest, channels[c].ptr<float>(), sizeof(float) * height * width);
    }
  }

  std::vector<int64_t> inputShape = {batchSz, numChannels, height, width};
  size_t inputTensorSize = batchData.size();

  Ort::MemoryInfo memInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  Ort::Value inputTensor = Ort::Value::CreateTensor<float>(
      memInfo, batchData.data(), inputTensorSize, inputShape.data(), inputShape.size());

  // Get input/output names from the model dynamically
  Ort::AllocatorWithDefaultOptions allocator;
  auto inputName = ortSession_.GetInputNameAllocated(0, allocator);
  auto outputName = ortSession_.GetOutputNameAllocated(0, allocator);

  const char* inputNames[] = {inputName.get()};
  const char* outputNames[] = {outputName.get()};

  std::array<Ort::Value, 1> inputTensors = {std::move(inputTensor)};

  auto outputTensors = ortSession_.Run(
      Ort::RunOptions{nullptr},
      inputNames, inputTensors.data(), 1,
      outputNames, 1);

  // Extract predictions
  Ort::Value& predsTensor = outputTensors[0];
  auto* predsData = predsTensor.GetTensorMutableData<float>();
  auto typeInfo = predsTensor.GetTypeInfo();
  auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();
  std::vector<int64_t> predsShape = tensorInfo.GetShape();

  auto predsDims = static_cast<int>(predsShape.size());
  std::vector<int> cvSizes(predsDims);
  for (size_t i = 0; i < predsShape.size(); i++) {
    cvSizes[i] = static_cast<int>(predsShape[i]);
  }

  {
    std::string shapeStr = "[";
    for (int i = 0; i < predsDims; i++) {
      if (i > 0) shapeStr += ", ";
      shapeStr += std::to_string(cvSizes[i]);
    }
    shapeStr += "]";
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "[DoctrRecognition] Output shape: " + shapeStr);
  }

  if (predsDims != 3) {
    throw std::runtime_error("[DoctrRecognition] Expected 3D output tensor [batch, seq_len, vocab], got " +
                             std::to_string(predsDims) + " dimensions");
  }

  cv::Mat preds(predsDims, cvSizes.data(), CV_32F, predsData);
  return preds.clone();
}

StepDoctrRecognition::SoftmaxResult StepDoctrRecognition::softmaxArgmax(
    const cv::Mat& preds, int batchIdx, int timestep, int vocabSize) {
  // Numerically stable softmax: subtract max before exp
  float maxVal = -std::numeric_limits<float>::infinity();
  for (int v = 0; v < vocabSize; v++) {
    maxVal = std::max(maxVal, preds.at<float>(batchIdx, timestep, v));
  }

  float sumExp = 0.0F;
  int bestIdx = 0;
  float bestExp = 0.0F;
  for (int v = 0; v < vocabSize; v++) {
    float expVal = std::exp(preds.at<float>(batchIdx, timestep, v) - maxVal);
    sumExp += expVal;
    if (expVal > bestExp) {
      bestExp = expVal;
      bestIdx = v;
    }
  }

  return {bestIdx, bestExp / sumExp};
}

std::pair<std::string, float> StepDoctrRecognition::decodeAttention(
    const cv::Mat& preds, int batchIdx) {
  // preds shape: [batch, seq_len, vocab_size + special_tokens]
  // Attention decoding (PARSeq/ViTSTR): argmax, stop at <eos>, confidence = mean of max softmax probs
  // Matches OnnxTR PARSeqPostProcessor: preds_prob[:len(word)].mean()
  assert(preds.dims == 3);
  const int seqLen = preds.size[1];
  const int vocabSize = preds.size[2]; // includes special tokens
  assert(batchIdx >= 0 && batchIdx < preds.size[0]);

  std::string decodedText;
  float confidenceSum = 0.0F;
  int numChars = 0;

  for (int t = 0; t < seqLen; t++) {
    auto [bestIdx, bestProb] = softmaxArgmax(preds, batchIdx, t, vocabSize);

    // Stop at <eos> token
    if (bestIdx >= SPECIAL_TOKEN_IDX) {
      break;
    }

    // Map index to character
    if (bestIdx >= 0 && bestIdx < static_cast<int>(vocabChars_.size())) {
      decodedText += vocabChars_[bestIdx];
      confidenceSum += std::min(bestProb, 1.0F);
      numChars++;
    }
  }

  // Confidence = arithmetic mean of per-position max softmax probs (matching OnnxTR PARSeq)
  float confidence = 0.0F;
  if (numChars > 0) {
    confidence = confidenceSum / static_cast<float>(numChars);
  }

  return {decodedText, confidence};
}

std::pair<std::string, float> StepDoctrRecognition::decodeCTC(
    const cv::Mat& preds, int batchIdx) {
  // preds shape: [batch, seq_len, vocab_size + 1]
  // CTC best-path decoding (matching OnnxTR CRNNPostProcessor.ctc_best_path):
  //   - argmax per timestep, remove blanks (index 126), collapse duplicates
  //   - confidence = min of per-timestep max softmax probs
  assert(preds.dims == 3);
  const int seqLen = preds.size[1];
  const int vocabSize = preds.size[2];
  assert(batchIdx >= 0 && batchIdx < preds.size[0]);

  std::string decodedText;
  float minConfidence = 1.0F;
  int prevIdx = -1;

  for (int t = 0; t < seqLen; t++) {
    auto [bestIdx, bestProb] = softmaxArgmax(preds, batchIdx, t, vocabSize);

    // Track minimum confidence across all timesteps (matching OnnxTR: .max(-1).min(1))
    minConfidence = std::min(minConfidence, bestProb);

    // Skip blank tokens
    if (bestIdx >= SPECIAL_TOKEN_IDX) {
      prevIdx = -1;
      continue;
    }

    // Collapse consecutive duplicates
    if (bestIdx == prevIdx) {
      continue;
    }

    // Map index to character
    if (bestIdx >= 0 && bestIdx < static_cast<int>(vocabChars_.size())) {
      decodedText += vocabChars_[bestIdx];
    }

    prevIdx = bestIdx;
  }

  // Confidence = minimum of per-timestep max softmax probs (matching OnnxTR)
  float confidence = decodedText.empty() ? 0.0F : minConfidence;

  return {decodedText, confidence};
}

StepDoctrRecognition::Output StepDoctrRecognition::process(Input input) {
  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "[DoctrRecognition] Processing " + std::to_string(input.polygons.size()) + " text regions");

  const cv::Mat& origImg = input.context.origImg;
  Output results;
  results.reserve(input.polygons.size());

  if (input.polygons.empty()) {
    return results;
  }

  // Process in batches
  for (size_t batchStart = 0; batchStart < input.polygons.size();
       batchStart += static_cast<size_t>(batchSize_)) {
    size_t batchEnd = std::min(batchStart + static_cast<size_t>(batchSize_),
                               input.polygons.size());
    size_t currentBatchSize = batchEnd - batchStart;

    // Prepare batch of preprocessed crops
    std::vector<cv::Mat> preparedImages;
    preparedImages.reserve(currentBatchSize);
    for (size_t i = batchStart; i < batchEnd; i++) {
      cv::Mat crop = preprocessCrop(origImg, input.polygons[i]);
      preparedImages.push_back(crop);
    }

    // Run batch inference
    cv::Mat batchPreds = runBatchInference(preparedImages);

    if (batchPreds.empty()) {
      continue;
    }

    // Decode each prediction in the batch
    for (size_t i = 0; i < currentBatchSize; i++) {
      auto [text, confidence] = (decodingMethod_ == DecodingMethod::CTC)
          ? decodeCTC(batchPreds, static_cast<int>(i))
          : decodeAttention(batchPreds, static_cast<int>(i));

      // Scale coordinates back to original image space if needed
      std::array<cv::Point2f, 4> polygon = input.polygons[batchStart + i];
      if (input.context.initialResizeRatio != 1.0F) {
        float scaleBack = 1.0F / input.context.initialResizeRatio;
        for (auto& pt : polygon) {
          pt.x *= scaleBack;
          pt.y *= scaleBack;
        }
      }

      results.emplace_back(polygon, text, confidence);
    }

    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "[DoctrRecognition] Processed batch " + std::to_string(batchStart) +
         "-" + std::to_string(batchEnd) + " of " + std::to_string(input.polygons.size()));
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "[DoctrRecognition] Completed recognition of " + std::to_string(results.size()) + " regions");

  return results;
}

} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
