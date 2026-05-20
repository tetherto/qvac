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
//   - One `process()` call rebuilds a graph for the input's spatial size
//     (so any image dim is supported).  Not thread-safe.

#include "steps.hpp"

#include <memory>
#include <string>
#include <vector>

#include <opencv2/imgproc.hpp>

typedef struct ggml_backend* ggml_backend_t;

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
    double preprocessMs   = 0.0;
    double graphBuildMs   = 0.0;
    double graphAllocMs   = 0.0;
    double graphComputeMs = 0.0;
    double tensorGetMs    = 0.0;
    double deinterleaveMs = 0.0;

    double outputCopyMs() const { return tensorGetMs + deinterleaveMs; }
    double totalMs() const {
        return preprocessMs + graphBuildMs + graphAllocMs +
               graphComputeMs + outputCopyMs();
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
    std::string         tapName;
    double              cumulativeMs;  // == min of samplesMs
    std::vector<double> samplesMs;     // all measured samples; size == runsPerTap
};

class StepDetectionInference {
public:
    using Input  = PipelineContext;
    using Output = StepDetectionInferenceOutput;

    // nThreads:
    //   - 0 (default): auto-detect via
    //     `easyocr::ggml::pipeline::defaultPhysicalThreadCount()`.  On x86
    //     with 2-way SMT this picks the physical-core count, which beats
    //     both T=1 and T=logical for our compute-bound GEMM graphs.
    //   - >0:          call ggml_backend_cpu_set_n_threads(backend, nThreads)
    //                  with the given value, overriding auto-detection.
    //   - <0:          leave the GGML CPU backend's built-in default
    //                  unchanged (escape hatch for thread-scaling
    //                  experiments).
    explicit StepDetectionInference(const std::string& gguf_path,
                                    float magRatio = 1.5F,
                                    int   nThreads = 0);
    ~StepDetectionInference();

    StepDetectionInference(const StepDetectionInference&)            = delete;
    StepDetectionInference& operator=(const StepDetectionInference&) = delete;

    /**
     * @brief Run the detector on a real image: resize -> normalize ->
     *        CRAFT GGML graph -> textMap, linkMap.
     */
    Output process(const Input& input);

    // Diagnostic: returns the NCHW float32 tensor produced by
    // `normalizeAndBuildCHW` for `image`.  Used by the pre-proc bit-equality
    // test against the committed `craft_real_<stem>_input.npy` references.
    static cv::Mat preprocess(const cv::Mat& image, float magRatio,
                              float* outResizeRatio = nullptr);

    // Wall-clock timings from the most recent process() call.  Stable
    // between calls; reset on every process().
    const DetectionStageTimings& lastTimings() const { return lastTimings_; }

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
        const Input&                        input,
        const std::vector<std::string>&     tapNames,
        int                                 warmupPerTap = 1,
        int                                 runsPerTap   = 3);

private:
    // Run build_craft on `inputBlob` ([1,3,H,W] CV_32F NCHW).
    // Returns (textMap, linkMap) as 2D CV_32F mats sized [H/2, W/2].
    std::pair<cv::Mat, cv::Mat> runInference(const cv::Mat& inputBlob);

    float                          magRatio_;
    ggml_backend_t                 backend_  = nullptr;
    std::unique_ptr<GgufLoader>    loader_;
    std::unique_ptr<CraftWeights>  weights_;
    DetectionStageTimings          lastTimings_{};
};

}  // namespace pipeline
}  // namespace easyocr::ggml
