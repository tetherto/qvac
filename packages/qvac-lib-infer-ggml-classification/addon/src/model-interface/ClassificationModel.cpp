#include "ClassificationModel.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <numeric>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <ggml.h>
#include <gguf.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/Logger.hpp>

#include "ImagePreprocessor.hpp"
#include "MobileNetGraph.hpp"

namespace qvac_lib_infer_ggml_classification {

using qvac_errors::StatusError;
using qvac_errors::general_error::InternalError;
using qvac_errors::general_error::InvalidArgument;

namespace {
constexpr const char* kModelName = "mobilenetv3-small-ggml-classification";
}

struct ClassificationModel::Impl {
  std::string modelPath;
  ggml_backend_t backend = nullptr;
  graph::WeightsBundle weights;
  graph::ComputeGraph compute;
  std::vector<std::string> labels;
  int numThreads = 0;
  bool loaded = false;
  uint64_t lastInferenceUs = 0;
};

ClassificationModel::ClassificationModel(std::string modelPath)
    : impl_(std::make_unique<Impl>()) {
  impl_->modelPath = std::move(modelPath);
}

ClassificationModel::~ClassificationModel() {
  if (!impl_) return;
  // ggml requires buffers to be freed strictly before the backend they were
  // allocated on. Explicitly reset the compute graph and weights bundle (both
  // own backend-allocated buffers) before releasing the backend itself.
  impl_->compute.reset();
  impl_->weights.reset();
  if (impl_->backend != nullptr) {
    ggml_backend_free(impl_->backend);
    impl_->backend = nullptr;
  }
}

std::string ClassificationModel::getName() const {
  return kModelName;
}

qvac_lib_inference_addon_cpp::RuntimeStats
ClassificationModel::runtimeStats() const {
  using qvac_lib_inference_addon_cpp::RuntimeStats;
  RuntimeStats stats;
  const double totalMs =
      static_cast<double>(impl_ ? impl_->lastInferenceUs : 0) / 1000.0;
  stats.emplace_back("total_time_ms", totalMs);
  return stats;
}

void ClassificationModel::setNumThreads(int threads) {
  std::scoped_lock lock(mutex_);
  if (!impl_) {
    return;
  }
  impl_->numThreads = threads;
}

namespace {

/// Numerically stable softmax over a short logits vector. Defensive
/// against non-finite inputs: if every logit is NaN/Inf we return a
/// uniform distribution rather than propagating the non-finite value;
/// if the exponential sum degenerates to zero or non-finite we also
/// fall back to uniform. The caller therefore always receives a
/// well-formed probability vector that sums to 1 in exactly one of
/// two ways (computed softmax, or uniform fallback).
std::vector<float> softmax(std::span<const float> logits) {
  if (logits.empty()) {
    return {};
  }

  // max_element on a span containing NaN is unspecified; walk by hand
  // and skip non-finite values so maxLogit stays finite whenever at
  // least one input is finite.
  float maxLogit = -std::numeric_limits<float>::infinity();
  for (const float logit : logits) {
    if (std::isfinite(logit) && logit > maxLogit) {
      maxLogit = logit;
    }
  }
  if (!std::isfinite(maxLogit)) {
    const float uniform = 1.0F / static_cast<float>(logits.size());
    return std::vector<float>(logits.size(), uniform);
  }

  std::vector<float> probs(logits.size());
  float sum = 0.0F;
  for (size_t i = 0; i < logits.size(); ++i) {
    const float diff = logits[i] - maxLogit;
    const float e = std::isfinite(diff) ? std::exp(diff) : 0.0F;
    probs[i] = e;
    sum += e;
  }

  if (std::isfinite(sum) && sum > 0.0F) {
    const float inv = 1.0F / sum;
    for (float& p : probs) {
      p *= inv;
    }
  } else {
    // Every diff saturated to -inf or the sum itself overflowed;
    // fall back to a uniform distribution so downstream code always
    // sees a valid probability vector.
    const float uniform = 1.0F / static_cast<float>(logits.size());
    std::fill(probs.begin(), probs.end(), uniform);
  }
  return probs;
}

/// Environment-variable-gated trace printer for per-inference
/// diagnostics. Off by default (no output). Turn on with
/// `QVAC_CLASSIFICATION_TRACE=1` to print raw logits, computed
/// probabilities, and sorted results to stderr. Invaluable for
/// debugging platform-specific numerical issues (e.g. the win32 CI
/// meal_1 anomaly) without changing the public logger wiring.
bool traceEnabled() {
  const char* v = std::getenv("QVAC_CLASSIFICATION_TRACE");
  return v != nullptr && v[0] == '1';
}

} // namespace

void ClassificationModel::load() {
  std::scoped_lock lock(mutex_);
  if (!impl_) {
    throw StatusError(InternalError, "ClassificationModel::load on destroyed instance");
  }
  if (impl_->loaded) {
    return;
  }
  if (impl_->modelPath.empty()) {
    throw StatusError(
        InvalidArgument,
        "ClassificationModel requires a path to mobilenetv3 FP16 GGUF weights");
  }

  impl_->backend = ggml_backend_cpu_init();
  if (impl_->backend == nullptr) {
    throw StatusError(InternalError, "Failed to initialize ggml CPU backend");
  }

  impl_->labels.clear();
  impl_->weights =
      graph::loadWeights(impl_->modelPath, impl_->backend, impl_->labels);
  if (impl_->labels.empty()) {
    impl_->labels = {"food", "report", "other"};
  }
  impl_->compute = graph::buildGraph(impl_->weights, impl_->backend);

  // Cold-inference warmup. The first user-visible classify() can observe
  // non-finite logits on some platforms (notably win32-x64 in CI:
  // meal_1.jpg -> NaN in result[0].confidence) because:
  //   - ggml's backend graph allocator leaves intermediate buffers
  //     uninitialised after buildGraph().
  //   - Some CPU backends lazily JIT or page in SIMD kernels on the
  //     first non-trivial input, and the cold path can interact badly
  //     with FP state (FTZ/denormals) left from earlier process work.
  //
  // To eliminate this deterministically, run one full forward pass
  // through the EXACT same pipeline classify() uses: synthesise a small
  // raw-RGB buffer with a deterministic non-zero gradient, push it
  // through preprocess::preprocessToTensor (resize + ImageNet
  // normalise), set the input tensor, compute the graph, and read the
  // output back. The warmup output is discarded; the goal is to leave
  // every backend buffer in a fully-written, deterministic state and to
  // exercise every lazy-init code path before any caller sees the
  // model. Cost: one synthetic inference at load() time.
  {
    constexpr uint32_t kWarmupSide = 32;  // resized to kInputSize
    std::vector<uint8_t> warmupRgb(
        static_cast<size_t>(kWarmupSide) * kWarmupSide * preprocess::kChannels);
    for (size_t i = 0; i < warmupRgb.size(); ++i) {
      warmupRgb[i] = static_cast<uint8_t>((i * 7) & 0xFFU);
    }
    std::vector<float> warmupTensor = preprocess::preprocessToTensor(
        std::span<const uint8_t>(warmupRgb.data(), warmupRgb.size()),
        kWarmupSide, kWarmupSide, preprocess::kChannels);
    ggml_backend_tensor_set(
        impl_->compute.input, warmupTensor.data(), 0,
        warmupTensor.size() * sizeof(float));
    if (impl_->numThreads > 0) {
      ggml_backend_cpu_set_n_threads(impl_->backend, impl_->numThreads);
    }
    (void)ggml_backend_graph_compute(impl_->backend, impl_->compute.graph);
    // Read the output back so the warmup is observably symmetric with
    // process(): on some backends the result of compute() only fully
    // materialises after the first tensor_get on the output buffer.
    float warmupLogits[graph::kNumClasses] = {0.0F};
    ggml_backend_tensor_get(
        impl_->compute.output, warmupLogits, 0, sizeof(warmupLogits));
    (void)warmupLogits;
  }

  impl_->loaded = true;

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      std::string("ClassificationModel loaded (") +
          std::to_string(impl_->labels.size()) + " classes)");
}

std::any ClassificationModel::process(const std::any& input) {
  std::scoped_lock lock(mutex_);

  const auto* inPtr = std::any_cast<ClassifyInput>(&input);
  if (inPtr == nullptr) {
    throw StatusError(InvalidArgument, "ClassificationModel: invalid input type");
  }
  if (!impl_ || !impl_->loaded) {
    throw StatusError(
        InternalError,
        "ClassificationModel: classify() called before load() or after unload()");
  }

  const auto t0 = std::chrono::steady_clock::now();

  // Preprocess: image buffer -> FP32 WHCN tensor (224x224x3).
  std::vector<float> inputTensor = preprocess::preprocessToTensor(
      std::span<const uint8_t>(inPtr->data.data(), inPtr->data.size()),
      inPtr->width, inPtr->height, inPtr->channels);

  const size_t expected = static_cast<size_t>(preprocess::kInputSize) *
                          preprocess::kInputSize * preprocess::kChannels;
  if (inputTensor.size() != expected) {
    throw StatusError(
        InternalError, "ClassificationModel: preprocessed tensor has wrong size");
  }

  ggml_backend_tensor_set(
      impl_->compute.input, inputTensor.data(), 0,
      inputTensor.size() * sizeof(float));

  // Configure CPU threads if requested; otherwise libggml picks a sensible
  // default based on hardware concurrency.
  if (impl_->numThreads > 0) {
    ggml_backend_cpu_set_n_threads(impl_->backend, impl_->numThreads);
  }

  ggml_status status =
      ggml_backend_graph_compute(impl_->backend, impl_->compute.graph);
  if (status != GGML_STATUS_SUCCESS) {
    throw StatusError(
        InternalError, "ggml_backend_graph_compute failed with status " +
                           std::to_string(static_cast<int>(status)));
  }

  // Retrieve logits.
  float logits[graph::kNumClasses] = {0.0F};
  ggml_backend_tensor_get(
      impl_->compute.output, logits, 0, sizeof(logits));

  std::vector<float> probs = softmax(std::span<const float>(logits, graph::kNumClasses));

  // Build sorted result list. Use labels parsed from GGUF metadata (or the
  // hardcoded fallback) so caller receives human-readable names.
  ClassifyOutput output;
  output.results.reserve(probs.size());
  for (size_t i = 0; i < probs.size(); ++i) {
    const std::string label = i < impl_->labels.size()
                                  ? impl_->labels[i]
                                  : std::string("class_") + std::to_string(i);
    output.results.push_back({label, probs[i]});
  }

  // Sort descending by confidence, with explicit handling of non-finite
  // values (NaN/Inf): treat them as smaller than any finite value so
  // the ordering remains strict-weak even with degenerate inputs.
  // The defensive softmax above should never produce non-finite
  // probabilities, but we keep the guard so a future upstream bug or
  // numerical edge case in the ggml CPU backend cannot break sort and
  // silently land a non-maximum-confidence class at index 0.
  std::sort(
      output.results.begin(),
      output.results.end(),
      [](const ClassifyResult& a, const ClassifyResult& b) {
        const bool aFinite = std::isfinite(a.confidence);
        const bool bFinite = std::isfinite(b.confidence);
        if (aFinite != bFinite) {
          return aFinite;
        }
        if (!aFinite && !bFinite) {
          return false;
        }
        return a.confidence > b.confidence;
      });

  // Optional per-inference trace. Off unless QVAC_CLASSIFICATION_TRACE=1
  // in the environment. Designed to give us actionable data for
  // platform-specific numerical issues (e.g. win32 CI meal_1 anomaly)
  // without requiring any rebuild or workflow change -- a test job
  // can simply set the env var to get the full picture.
  if (traceEnabled()) {
    std::fprintf(
        stderr,
        "[qvac-classify] logits=[%.6f, %.6f, %.6f] "
        "probs_before_sort=[%.6f, %.6f, %.6f] "
        "sorted=[{%s:%.6f}, {%s:%.6f}, {%s:%.6f}]\n",
        static_cast<double>(logits[0]),
        static_cast<double>(logits[1]),
        static_cast<double>(logits[2]),
        static_cast<double>(probs[0]),
        static_cast<double>(probs[1]),
        static_cast<double>(probs[2]),
        output.results.size() > 0 ? output.results[0].label.c_str() : "-",
        output.results.size() > 0
            ? static_cast<double>(output.results[0].confidence)
            : 0.0,
        output.results.size() > 1 ? output.results[1].label.c_str() : "-",
        output.results.size() > 1
            ? static_cast<double>(output.results[1].confidence)
            : 0.0,
        output.results.size() > 2 ? output.results[2].label.c_str() : "-",
        output.results.size() > 2
            ? static_cast<double>(output.results[2].confidence)
            : 0.0);
    std::fflush(stderr);
  }

  // Apply topK filter if requested and within bounds.
  if (inPtr->topK > 0 && inPtr->topK < output.results.size()) {
    output.results.resize(inPtr->topK);
  }

  const auto t1 = std::chrono::steady_clock::now();
  impl_->lastInferenceUs = static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count());

  return std::any(std::move(output));
}

} // namespace qvac_lib_infer_ggml_classification

