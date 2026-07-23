#pragma once

// CRAFT detection step.
//
// Adapted from @qvac/ocr-onnx's `addon/pipeline/StepDetectionInference.hpp`.
// The pre-processing (resize + ImageNet
// normalize) is the same; the inference glue is replaced with our GGML
// graph (`build_craft`) instead of ONNX Runtime.
//
// Lifetime / threading
//   - The step owns a CPU `ggml_backend`, a `GgufLoader`, and a
//     `CraftWeights` containing the BN-folded weights.
//   - A `process()` call builds a ggml graph the first time it sees an
//     input shape (so any image dim is supported), caches the graph +
//     allocator + I/O tensor pointers, and reuses them on subsequent
//     calls with the same `(H, W)`.  Calls with a new shape rebuild
//     once and re-cache.  Not thread-safe.

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <opencv2/imgproc.hpp>

#include "model-interface/OcrLazyInitializeBackend.hpp"
#include "steps.hpp"

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length)
using ggml_backend_t = struct ggml_backend*;
using ggml_backend_dev_t = struct ggml_backend_device*;
using ggml_gallocr_t = struct ggml_gallocr*;
struct ggml_cgraph;
struct ggml_context;
struct ggml_tensor;

// StepDetectionInference header uses snake_case (gguf_path) to mirror the
// upstream EasyOCR API and contains CRAFT magic numbers (mag_ratio=1.5,
// warmup_per_tap=1, runs_per_tap=3).

namespace easyocr::ggml {

class GgufLoader;
class CraftWeights;

namespace pipeline {

// Per-stage wall-clock timings populated by every StepDetectionInference::
// process() call.  Used by the `detect --profile` CLI mode.  Field semantics:
//   preprocessMs       resize + ImageNet normalize (CPU/OpenCV)
//   graphBuildMs       ggml_init + build_craft + ggml_build_forward_expand
//   graphAllocMs       ggml_gallocr_new + ggml_gallocr_alloc_graph
//   graphComputeMs     ggml_backend_graph_compute (the actual inference)
//   tensorGetMs        ggml_backend_tensor_get (device->host copy)
//   deinterleaveMs     NHWC->[textMap,linkMap] scalar deinterleave loop
struct DetectionStageTimings {
  double preprocessMs = 0.0;
  double graphBuildMs = 0.0;
  double graphAllocMs = 0.0;
  double graphComputeMs = 0.0;
  double tensorGetMs = 0.0;
  double deinterleaveMs = 0.0;

  [[nodiscard]] double outputCopyMs() const {
    return tensorGetMs + deinterleaveMs;
  }
  [[nodiscard]] double totalMs() const {
    return preprocessMs + graphBuildMs + graphAllocMs + graphComputeMs +
           outputCopyMs();
  }
};

// Per-block cumulative timing produced by StepDetectionInference::
// profileBlocks().  `tapName` is one of `easyocr::ggml::craft_taps::*`;
// `cumulativeMs` is the *minimum* wall-clock time observed to compute the
// sub-graph from `input` up to (and including) that tap, across
// `runsPerTap` measured passes (after `warmupPerTap` warmup passes per
// tap to settle cache / OpenMP / CPU-boost state).
//
// Why min over median? Performance has a hard floor (best-case
// hot-cache, no OS jitter) but unbounded slowdowns (IRQs, scheduling,
// thermal, page-allocator stalls). With small N the median is too easily
// dragged by a single slow outlier, but the min converges quickly to the
// steady-state cost. Median + max are reported in `samplesMs` for
// jitter visibility but should not be used for cross-tap delta math.
//
// Per-block delta is recovered as `cumulative_ms[i] - cumulative_ms[i-1]`;
// at defaults (warmupPerTap=1, runsPerTap=3) deltas are monotonic
// non-decreasing within sub-200 ms noise.
struct BlockTiming {
  std::string tapName;
  double cumulativeMs;           // == min of samplesMs
  std::vector<double> samplesMs; // all measured samples; size == runsPerTap
};

class StepDetectionInference {
public:
  using Input = PipelineContext;
  using Output = StepDetectionInferenceOutput;

  // Default detection canvas cap (EasyOCR `canvas_size`), matching
  // @qvac/ocr-onnx and EasyOCR.
  static constexpr int kDefaultCanvasSize = 2560;

  // nThreads:
  //   - 0 (default): auto-detect via
  //     `easyocr::ggml::pipeline::defaultPhysicalThreadCount()`.  On x86
  //     with 2-way SMT this picks the physical-core count, which beats
  //     both T=1 and T=logical for our compute-bound GEMM graphs.
  //   - >0:          apply the given value via the runtime-resolved
  //                  `ggml_backend_set_n_threads` proc-address, overriding
  //                  auto-detection.
  //   - <0:          leave the GGML CPU backend's built-in default
  //                  unchanged (escape hatch for thread-scaling
  //                  experiments).
  // maxImageSize is EasyOCR's `canvas_size`: the cap (long side, px) applied
  // after magRatio scaling. It bounds the CRAFT graph's peak compute buffer
  // (which scales with canvas area). Default 2560 matches @qvac/ocr-onnx and
  // EasyOCR; lower it on memory-constrained targets (e.g. mobile) to avoid the
  // dense-page OOM in QVAC-19340. Values <= 0 fall back to the 2560 default.
  // backendDevice: the ggml device the CRAFT graph runs on (selected by
  // `Pipeline` via `ocr_backend_selection`). nullptr resolves to the CPU
  // device, preserving the historical CPU-only behaviour for direct callers.
  explicit StepDetectionInference(
      // NOLINTNEXTLINE(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
      const std::string& gguf_path, float magRatio = 1.5F, int nThreads = 0,
      const std::string& backendsDir = "",
      int maxImageSize = kDefaultCanvasSize,
      ggml_backend_dev_t backendDevice = nullptr);
  ~StepDetectionInference();

  StepDetectionInference(const StepDetectionInference&) = delete;
  StepDetectionInference& operator=(const StepDetectionInference&) = delete;
  StepDetectionInference(StepDetectionInference&&) = delete;
  StepDetectionInference& operator=(StepDetectionInference&&) = delete;

  /**
   * @brief Run the detector on a real image: resize -> normalize ->
   *        CRAFT GGML graph -> textMap, linkMap.
   */
  Output process(const Input& input);

  // Diagnostic: returns the NCHW float32 tensor produced by
  // `normalizeAndBuildCHW` for `image`.  Used by the pre-proc bit-equality
  // test against the committed `craft_real_<stem>_input.npy` references.
  static cv::Mat preprocess(
      const cv::Mat& image, float magRatio, float* outResizeRatio = nullptr);

  // Wall-clock timings from the most recent process() call.  Stable
  // between calls; reset on every process().
  [[nodiscard]] const DetectionStageTimings& lastTimings() const {
    return lastTimings_;
  }

  // Run one forward pass per requested tap, with per-tap warmup and
  // multiple measured samples, and return the median cumulative
  // ms-to-each-tap.  For each tap:
  //   - build one ggml_context + sub-cgraph + gallocr (independent from
  //     other taps),
  //   - run `warmupPerTap` warmup computes on it (untimed; settles cache,
  //     OpenMP pool, CPU boost state),
  //   - run `runsPerTap` measured computes on it (timed individually),
  //   - report the median of the measured samples as `cumulativeMs`.
  // Defaults (warmupPerTap=1, runsPerTap=3) give trustworthy deltas at
  // 4× the single-shot cost; pass (0, 1) to recover the old behaviour.
  // `tapNames` must be valid entries from `easyocr::ggml::craft_taps::*`.
  // Used by `detect --profile-blocks` to map out which block of the CRAFT
  // graph consumes the most time.
  std::vector<BlockTiming> profileBlocks(
      const Input& input, const std::vector<std::string>& tapNames,
      int warmupPerTap = 1, int runsPerTap = 3);

private:
  // Run build_craft on `inputBlob` ([1,3,H,W] CV_32F NCHW).
  // Returns (textMap, linkMap) as 2D CV_32F mats sized [H/2, W/2].
  std::pair<cv::Mat, cv::Mat> runInference(const cv::Mat& inputBlob);

  // The CRAFT graph is fully determined by the input spatial shape (H,W);
  // weights and ops are otherwise identical across calls.  Keep the
  // context / allocator / graph / input+output tensor pointers live so
  // that back-to-back inferences on same-sized inputs (the common case
  // when batching a single document's pages) skip the per-call
  // `ggml_init` + `build_craft` + `gallocr_alloc_graph` cost.
  // Rebuild lazily when (H,W) changes; tear down in the destructor.
  struct CraftGraphCache {
    int lastW = 0;
    int lastH = 0;
    std::vector<uint8_t> ctxBuf;
    ggml_context* gctx = nullptr;
    ggml_gallocr_t gallocr = nullptr;
    ggml_cgraph* gf = nullptr;
    ggml_tensor* x = nullptr;   // input tensor
    ggml_tensor* out = nullptr; // output tensor
  };
  void ensureGraph(int H, int W);
  void destroyGraph();

  float magRatio_;
  int maxImageSize_;                 // EasyOCR canvas_size cap; see ctor docs
  OcrBackendsHandle backendsHandle_; // must be declared before backend_
  ggml_backend_t backend_ = nullptr;
  std::unique_ptr<GgufLoader> loader_;
  std::unique_ptr<CraftWeights> weights_;
  CraftGraphCache graphCache_{};
  // Reusable host buffer for ggml_backend_tensor_get of the NHWC output.
  std::vector<float> nhwcScratch_;
  DetectionStageTimings lastTimings_{};
};

} // namespace pipeline
} // namespace easyocr::ggml

// NOLINTEND(readability-identifier-naming,readability-identifier-length)
