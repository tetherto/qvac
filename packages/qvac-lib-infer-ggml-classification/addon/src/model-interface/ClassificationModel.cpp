#include "ClassificationModel.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <span>
#include <stdexcept>
#include <string>

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

/// Numerically stable softmax over a short logits vector.
std::vector<float> softmax(std::span<const float> logits) {
  const float maxLogit = *std::max_element(logits.begin(), logits.end());
  std::vector<float> probs(logits.size());
  float sum = 0.0F;
  for (size_t i = 0; i < logits.size(); ++i) {
    const float e = std::exp(logits[i] - maxLogit);
    probs[i] = e;
    sum += e;
  }
  if (sum > 0.0F) {
    const float inv = 1.0F / sum;
    for (float& p : probs) {
      p *= inv;
    }
  }
  return probs;
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

  // Cold-inference warmup. ggml's backend graph allocator leaves the
  // intermediate tensor buffers and the input/output tensors in an
  // uninitialised state after `buildGraph` returns. The very first
  // inference can therefore observe stale heap residue and produce
  // non-finite logits on some platforms (notably observed on win32-x64
  // in CI: meal_1.jpg -> probabilities NaN, sort comparison fails).
  // Run one zero-input forward pass here so every backend buffer is
  // written deterministically before any user-visible classify() call.
  {
    const size_t inputElems =
        static_cast<size_t>(preprocess::kInputSize) *
        preprocess::kInputSize * preprocess::kChannels;
    std::vector<float> zeros(inputElems, 0.0F);
    ggml_backend_tensor_set(
        impl_->compute.input, zeros.data(), 0,
        zeros.size() * sizeof(float));
    if (impl_->numThreads > 0) {
      ggml_backend_cpu_set_n_threads(impl_->backend, impl_->numThreads);
    }
    // Result is intentionally discarded; the only goal is to populate
    // every backend buffer with deterministic values.
    (void)ggml_backend_graph_compute(impl_->backend, impl_->compute.graph);
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
  std::sort(
      output.results.begin(), output.results.end(),
      [](const ClassifyResult& a, const ClassifyResult& b) {
        return a.confidence > b.confidence;
      });

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

