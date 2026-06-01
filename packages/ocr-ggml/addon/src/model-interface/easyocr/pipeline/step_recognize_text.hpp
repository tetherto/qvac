#pragma once

// CRNN gen-2 recognition step.
//
// Adapted from @qvac/ocr-onnx's addon/pipeline/StepRecognizeText.hpp.
// Differences vs. the source:
//   - namespace renamed `qvac_lib_inference_addon_onnx_ocr_fasttext`
//     -> `easyocr::ggml::pipeline`;
//   - the ONNX session is replaced with a GGML graph (`build_crnn_gen2`)
//     plus a CPU backend the step owns;
//   - `runInferenceOnImg` and `runBatchInference` return `cv::Mat` directly
//     (the ocr-onnx versions also returned `std::vector<Ort::Value>` to
//     extend the lifetime of the Ort tensor backing the cv::Mat header);
//   - `Lang.cpp`'s character set for the requested language is asserted at
//     load time to match the GGUF's `crnn.vocab` metadata, but the runtime
//     vocab string is read from the GGUF (so custom-trained recognizers
//     work without code changes);
//   - dropped: the `CONSTRUCT_FROM_TUPLE` macro use, the Windows ORT-leak
//     workaround.
//
// Public process() output is `std::vector<InferredText>`, exactly the same
// type ocr-onnx exposes, so downstream code (paragraph merge, etc.) works
// unchanged.

#include <array>
#include <atomic>
#include <codecvt>
#include <cstddef>
#include <cstdint>
#include <locale>
#include <memory>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <opencv2/imgproc.hpp>

#include "model-interface/OcrLazyInitializeBackend.hpp"
#include "steps.hpp"

using ggml_backend_t = struct ggml_backend*;
using ggml_gallocr_t = struct ggml_gallocr*;
using OcrGgmlCGraphPtr = struct ggml_cgraph*;
using OcrGgmlContextPtr = struct ggml_context*;
// NOLINTNEXTLINE(readability-identifier-naming)
using OcrGgmlTensorPtr = struct ggml_tensor*;

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length,readability-redundant-member-init)
// StepRecognizeText header uses snake_case to mirror upstream EasyOCR
// recognizer API and contains architecture-defined constants (batch=32,
// rotation 90/270).

namespace easyocr::ggml {

class GgufLoader;
class CrnnGen2Weights;

namespace pipeline {

// Per-stage wall-clock timings for one StepRecognizeText::process() call.
// Makes the recognizer half of the pipeline observable.
//
// Field semantics:
//   populateMs     populateImageList + expandImgListWithRotatedImgs
//                  (perspective-warp + crop + rotation expansion, all
//                  CPU/OpenCV)
//   batchPrepMs    cumulative alignAndCollate (resize + normalize) across all
//                  batches in processImgList (primary + contrast-retry pass)
//   inferenceMs    cumulative runBatchInference (GGML compute side) across
//                  all batches
//   ctcDecodeMs    cumulative getTextAndConfidenceFromPreds (CTC argmax +
//                  best-path text reconstruction)
//   paragraphMs    optional getParagraph merge (only when context.paragraph)
//   numBoxes       total sub-images (boxes × rotation_variants) processed
//   numBatches     number of runBatchInference invocations (primary pass)
//   numContrastRetryBatches    number of contrast-retry runBatchInference calls
struct RecognitionStageTimings {
  double populateMs = 0.0;
  double batchPrepMs = 0.0;
  double inferenceMs = 0.0;
  double ctcDecodeMs = 0.0;
  double paragraphMs = 0.0;
  int numBoxes = 0;
  int numBatches = 0;
  int numContrastRetryBatches = 0;

  [[nodiscard]] double totalMs() const {
    return populateMs + batchPrepMs + inferenceMs + ctcDecodeMs + paragraphMs;
  }
};

class StepRecognizeText {
public:
  using Input = StepBoundingBoxesOutput;
  using Output = std::vector<InferredText>;

  struct SubImage {
    std::array<cv::Point2f, 4> coords;
    cv::Mat image;
    bool isMultiCharacter;
    std::string text;
    double confidenceScore{};

    SubImage(
        std::array<cv::Point2f, 4> coords, cv::Mat image,
        bool isMultiCharacterFlag)
        : coords{coords}, image{std::move(image)},
          isMultiCharacter{isMultiCharacterFlag} {}
  };

  // NOLINTBEGIN(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
  struct Config {
    std::vector<int> defaultRotationAngles;
    bool contrastRetry{false};
    float lowConfidenceThreshold{0.4F};
    int recognizerBatchSize{32};
    // Thread count for the CPU backend: 0 = auto-detect physical cores,
    // negative = leave at GGML default, positive = exact count.
    int nThreads{-1};
    std::string backendsDir{};

    Config() : defaultRotationAngles{90, 270} {}
    Config(
        // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
        std::vector<int> angles, bool retry, float threshold,
        int batchSize = 32, int nThreads = -1,
        std::string backendsDir = "")
        : defaultRotationAngles(std::move(angles)), contrastRetry(retry),
          lowConfidenceThreshold(threshold), recognizerBatchSize(batchSize),
          nThreads(nThreads), backendsDir(std::move(backendsDir)) {}
  };
  // NOLINTEND(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)

  // Construct with the recognizer GGUF and a list of language codes for vocab
  // / LTR / ignore-list lookup. The step owns its CPU backend.
  StepRecognizeText(
      const std::string& gguf_path, std::span<const std::string> langList,
      Config config = Config{});
  ~StepRecognizeText();

  StepRecognizeText(const StepRecognizeText&) = delete;
  StepRecognizeText& operator=(const StepRecognizeText&) = delete;
  StepRecognizeText(StepRecognizeText&&) = delete;
  StepRecognizeText& operator=(StepRecognizeText&&) = delete;

  Output process(Input input, const std::atomic<bool>* cancelFlag = nullptr);

  // Wall-clock timings from the most recent process() call.  Stable
  // between calls; reset on every process().
  [[nodiscard]] const RecognitionStageTimings& lastTimings() const {
    return lastTimings_;
  }

private:
  Config config_;

  // GGML state: backend handle (ref-counted global init) must be declared
  // before backend_ so backends are loaded before the device is queried, and
  // the handle's ref is released only after the backend is freed.
  OcrBackendsHandle backendsHandle_;
  std::unique_ptr<GgufLoader> loader_;
  std::unique_ptr<CrnnGen2Weights> gen2_weights_;
  ggml_backend_t backend_ = nullptr;

  // std::wstring_convert is deprecated in C++17+ but there is no drop-in
  // replacement before C++26; switching to ICU/iconv is a separate refactor.
  // The deprecation warning is emitted at template instantiation inside
  // libc++ so a NOLINT on the field decl is not enough — gate with a
  // pragma push/pop instead.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  std::wstring_convert<std::codecvt_utf8<char32_t>, char32_t> converter_;
#pragma clang diagnostic pop
  std::u32string_view utf32Characters_;
  std::u32string utf32Owned_; // backs the view when sourced from GGUF
  std::vector<bool> ignoreChars_;
  bool isLeftToRightScript_{true};

  std::vector<std::vector<SubImage>> imgListOfLists_;
  std::vector<float> batchBuffer_;
  RecognitionStageTimings lastTimings_{};

  struct RecognizerGraphCache {
    int height = 0;
    int width = 0;
    size_t graphSize = 0;
    std::vector<std::uint8_t> ctxBuf;
    OcrGgmlContextPtr gctx = nullptr;
    ggml_gallocr_t gallocr = nullptr;
    OcrGgmlCGraphPtr graph = nullptr;
    OcrGgmlTensorPtr input = nullptr;
    OcrGgmlTensorPtr output = nullptr;
  };

  RecognizerGraphCache recognizerGraphCache_{};

  void populateImageList(const Input& input);
  void
  expandImgListWithRotatedImgs(std::optional<std::vector<int>>& rotationAngles);

  std::pair<std::string, float>
  getTextAndConfidenceFromPreds(const cv::Mat& preds, int batchIdx = 0);

  cv::Mat runInferenceOnImg(const cv::Mat& img);
  cv::Mat
  runBatchInference(const std::vector<cv::Mat>& images, int dynamicWidth);
  cv::Mat runRecognizerOneCached(
      const float* inputData, int height, int width, size_t graphSize);
  void ensureRecognizerGraph(int height, int width, size_t graphSize);
  void destroyRecognizerGraph();

  std::vector<InferredText> processImgList(const std::atomic<bool>* cancelFlag);
  std::string decodeGreedy(const std::vector<size_t>& textIndex);
};

} // namespace pipeline
} // namespace easyocr::ggml

// NOLINTEND(readability-identifier-naming,readability-identifier-length,readability-redundant-member-init)
