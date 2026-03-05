#pragma once

#include <onnxruntime_c_api.h>
#include <onnxruntime_cxx_api.h>

#ifdef __ANDROID__
#include <onnxruntime/nnapi_provider_factory.h>
#endif

#include <opencv2/imgproc.hpp>

#include <cstddef>
#include <optional>
#include <variant>
#include <tuple>

/* NOLINTBEGIN(cppcoreguidelines-macro-usage) */
#define CONSTRUCT_FROM_TUPLE(Class)                          template <class... Ts>                                   explicit Class(std::tuple<Ts...>&& tup)                      : Class(std::move(tup), std::index_sequence_for<Ts...>{})       { } /* NOLINT(cppcoreguidelines-rvalue-reference-param-not-moved) */                                                                                                               template <class Tuple, size_t... Is>                     Class(Tuple&& tup, std::index_sequence<Is...>)               : Class(std::forward<decltype(std::get<Is>(tup))>(std::get<Is>(tup))...)     { } /* NOLINT(cppcoreguidelines-missing-std-forward,cppcoreguidelines-rvalue-reference-param-not-moved) */
/* NOLINTEND(cppcoreguidelines-macro-usage) */
namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

struct PipelineContext {
  cv::Mat origImg;
  bool paragraph{false};
  std::optional<std::vector<int>> rotationAngles;
  float boxMarginMultiplier{};
  float initialResizeRatio{1.0F};
};

struct StepDetectionInferenceOutput {
  PipelineContext context;
  cv::Mat textMap;
  cv::Mat linkMap;
  float imgResizeRatio;
};

struct AlignedBox {
  std::array<float, 4> coords{};
  bool isMultiCharacter{false};
};

struct UnalignedBox {
  std::array<cv::Point2f, 4> coords;
  bool isMultiCharacter{false};
};

struct StepBoundingBoxesOutput {
  PipelineContext context;
  std::vector<AlignedBox> alignedBoxes;
  std::vector<UnalignedBox> unalignedBoxes;
};

struct InferredText {
  std::array<cv::Point2f, 4> boxCoordinates;
  std::string text;
  double confidenceScore;

  [[nodiscard]] std::string toString() const;

  InferredText(const std::array<cv::Point2f, 4>& coords, std::string text, double confidenceScore)
    : boxCoordinates{ coords }
    , text{std::move(text)}
    , confidenceScore{confidenceScore} {}
};

struct StepDoctrDetectionOutput {
  PipelineContext context;
  std::vector<std::array<cv::Point2f, 4>> polygons;
  std::vector<float> polygonConfidences;
  cv::Mat probMap;  // Raw probability map for straighten_pages orientation estimation
  int paddedW{0};   // Width of the actual image region in the prob map
  int paddedH{0};   // Height of the actual image region in the prob map
  int padLeft{0};   // Left padding offset (symmetric padding)
  int padTop{0};    // Top padding offset (symmetric padding)
};

Ort::SessionOptions getOrtSessionOptions(bool useGPU = false);

// Shared ONNX Runtime environment (one per process, as recommended by ONNX Runtime).
Ort::Env& getSharedOrtEnv();

cv::Mat fourPointTransform(const cv::Mat &image, const std::array<cv::Point2f, 4> &rect);

#if defined(_WIN32) || defined(_WIN64)
// On Windows, ~Ort::Session() corrupts global ORT state after the 1st call — a known
// ORT bug — causing SIGSEGV on all subsequent session destructions.  Work around it by
// moving the session into a heap-allocated object via a raw (non-owning) pointer that is
// intentionally never deleted.  The OS reclaims the memory when the process exits.
// Call this from step destructors instead of letting Ort::Session be destroyed normally.
void deferWindowsSessionLeak(Ort::Session session);
#endif

}
