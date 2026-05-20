#pragma once

// Shared pipeline types — lifted from `@qvac/ocr-onnx`'s
// `addon/pipeline/Steps.hpp`.
//
// Differences vs. the source:
//   - namespace renamed `qvac_lib_inference_addon_onnx_ocr_fasttext`
//     -> `easyocr::ggml::pipeline`.
//   - `qvac-onnx/OnnxSession.hpp` include and `deferWindowsSessionLeak`
//     declaration dropped (this repo does not use ONNX Runtime).
//   - `CONSTRUCT_FROM_TUPLE` macro and the `StepDoctrDetectionOutput`
//     struct dropped (we don't use the DOCTR / step-template patterns).
//
// Everything else is byte-for-byte the same so the post-processing math
// stays diffable against ocr-onnx.

#include <array>
#include <cstddef>
#include <optional>
#include <string>
#include <vector>

#include <opencv2/imgproc.hpp>

namespace easyocr::ggml::pipeline {

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

    AlignedBox() = default;
    AlignedBox(const std::array<float, 4>& c, bool multi)
        : coords(c), isMultiCharacter(multi) {}
};

struct UnalignedBox {
    std::array<cv::Point2f, 4> coords;
    bool isMultiCharacter{false};

    UnalignedBox() = default;
    UnalignedBox(const std::array<cv::Point2f, 4>& c, bool multi)
        : coords(c), isMultiCharacter(multi) {}
};

struct StepBoundingBoxesOutput {
    PipelineContext context;
    std::vector<AlignedBox>   alignedBoxes;
    std::vector<UnalignedBox> unalignedBoxes;
};

struct InferredText {
    std::array<cv::Point2f, 4> boxCoordinates;
    std::string                 text;
    double                      confidenceScore;

    [[nodiscard]] std::string toString() const;

    InferredText(const std::array<cv::Point2f, 4>& coords, std::string text,
                 double confidenceScore)
        : boxCoordinates{coords}
        , text{std::move(text)}
        , confidenceScore{confidenceScore} {}
};

cv::Mat fourPointTransform(const cv::Mat& image,
                           const std::array<cv::Point2f, 4>& rect);

// Pick a sensible default thread count for GGML's CPU backend on this host.
//
// On x86 with 2-way SMT (Intel HT, AMD SMT), running compute-bound AVX GEMM
// on every logical core is typically slower than running on every physical
// core, because SMT siblings contend for the same FP/SIMD execution units.
// A T=physical_cores baseline reliably matches or beats T=logical_cores on
// our CRAFT/CRNN graphs.
//
// Strategy:
//   - If std::thread::hardware_concurrency() returns > 1, treat that as the
//     logical-core count and assume 2-way SMT (i.e., return hc / 2).
//   - Floor at 1.
//   - Callers may override with an explicit n_threads argument.
//
// This is a coarse heuristic, not a /proc/cpuinfo parser.  Future refinement
// (e.g., real physical-vs-logical detection on multi-CCD AMD chips, or
// non-x86 platforms) belongs in this one function.
int defaultPhysicalThreadCount();

}  // namespace easyocr::ggml::pipeline
