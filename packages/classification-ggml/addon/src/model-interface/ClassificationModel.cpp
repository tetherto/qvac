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

#if defined(__ANDROID__)
#include <filesystem>
#endif

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <ggml.h>
#include <gguf.h>
#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/Logger.hpp>

#include "ImagePreprocessor.hpp"
#include "MobileNetGraph.hpp"

namespace classification_ggml {

using qvac_errors::StatusError;
using qvac_errors::general_error::InternalError;
using qvac_errors::general_error::InvalidArgument;

namespace {
constexpr const char* MODEL_NAME = "mobilenetv3-small-ggml-classification";
} // namespace

ClassificationModel::ClassificationModel(std::string modelPath)
    : modelPath_(std::move(modelPath)) {}

ClassificationModel::~ClassificationModel() {
  // ggml requires buffers to be freed strictly before the backend they were
  // allocated on; reset both before ggml_backend_free.
  compute_.reset();
  weights_.reset();
  if (backend_ != nullptr) {
    ggml_backend_free(backend_);
    backend_ = nullptr;
  }
}

std::string ClassificationModel::getName() const { return MODEL_NAME; }

qvac_lib_inference_addon_cpp::RuntimeStats
ClassificationModel::runtimeStats() const {
  using qvac_lib_inference_addon_cpp::RuntimeStats;
  RuntimeStats stats;
  const double totalMs = static_cast<double>(lastInferenceUs_) / 1000.0;
  stats.emplace_back("total_time_ms", totalMs);
  return stats;
}

void ClassificationModel::setBackendsDir(std::string backendsDir) {
  std::scoped_lock lock(mutex_);
  backendsDir_ = std::move(backendsDir);
}

namespace {

/// Numerically stable softmax. Falls back to a uniform distribution if
/// every logit is non-finite or the exp sum overflows, so downstream
/// code always sees a probability vector that sums to 1.
std::vector<float> softmax(std::span<const float> logits) {
  if (logits.empty()) {
    return {};
  }

  // std::max_element on a span containing NaN is unspecified.
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
    const float uniform = 1.0F / static_cast<float>(logits.size());
    std::fill(probs.begin(), probs.end(), uniform);
  }
  return probs;
}

bool traceEnabled() {
  const char* v = std::getenv("QVAC_CLASSIFICATION_TRACE");
  return v != nullptr && v[0] == '1';
}

} // namespace

void ClassificationModel::load() {
  std::scoped_lock lock(mutex_);
  if (loaded_) {
    return;
  }
  if (modelPath_.empty()) {
    throw StatusError(
        InvalidArgument,
        "ClassificationModel requires a path to mobilenetv3 FP16 GGUF weights");
  }

#if defined(__ANDROID__)
  // qvac-fabric on Android ships per-microarch CPU variants as MODULE
  // .so files loaded at runtime via dlopen. ggml_backend_cpu_init() is
  // not statically linkable here (symbol lives inside the variant .so),
  // so we open the variants from <backendsDir>/<BACKENDS_SUBDIR>/ and
  // pick a CPU device through the generic registry API.
  //
  // backendsDir comes from JS (`path.join(__dirname, 'prebuilds')`,
  // mirroring the llamacpp-llm addon) and BACKENDS_SUBDIR is the
  // compile-time `<bare_target>/<module_name>` relative path.
  if (backendsDir_.empty()) {
    throw StatusError(
        InvalidArgument,
        "Configuration 'config.backendsDir' is required on Android");
  }
  std::filesystem::path variantsDir =
      std::filesystem::path(backendsDir_) / BACKENDS_SUBDIR;
  ggml_backend_load_all_from_path(variantsDir.string().c_str());

  ggml_backend_dev_t cpuDev =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (cpuDev == nullptr) {
    throw StatusError(
        InternalError,
        "No CPU backend device registered after loading variants from " +
            variantsDir.string());
  }
  backend_ = ggml_backend_dev_init(cpuDev, /*params=*/nullptr);
#else
  backend_ = ggml_backend_cpu_init();
#endif
  if (backend_ == nullptr) {
    throw StatusError(InternalError, "Failed to initialize ggml CPU backend");
  }

  labels_.clear();
  weights_ = graph::loadWeights(modelPath_, backend_, labels_);
  if (labels_.empty()) {
    labels_ = {"food", "report", "other"};
  }
  compute_ = graph::buildGraph(weights_, backend_);

  // One full forward pass at load() time. Without it, the first
  // user-visible classify() can return NaN logits on win32-x64 CI
  // because some backend allocator buffers are uninitialised after
  // buildGraph() and CPU backends can JIT SIMD kernels on cold input.
  // Symmetric with process(): set, compute, read back, discard.
  {
    constexpr uint32_t kWarmupSide = 32;
    std::vector<uint8_t> warmupRgb(
        static_cast<size_t>(kWarmupSide) * kWarmupSide * preprocess::CHANNELS);
    for (size_t i = 0; i < warmupRgb.size(); ++i) {
      warmupRgb[i] = static_cast<uint8_t>((i * 7) & 0xFFU);
    }
    std::vector<float> warmupTensor = preprocess::preprocessToTensor(
        std::span<const uint8_t>(warmupRgb.data(), warmupRgb.size()),
        kWarmupSide,
        kWarmupSide,
        preprocess::CHANNELS);
    ggml_backend_tensor_set(
        compute_.input, warmupTensor.data(), 0,
        warmupTensor.size() * sizeof(float));
    (void)ggml_backend_graph_compute(backend_, compute_.graph);
    float warmupLogits[graph::NUM_CLASSES] = {0.0F};
    ggml_backend_tensor_get(
        compute_.output, warmupLogits, 0, sizeof(warmupLogits));
    (void)warmupLogits;
  }

  loaded_ = true;

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      std::string("ClassificationModel loaded (") +
          std::to_string(labels_.size()) + " classes)");
}

std::any ClassificationModel::process(const std::any& input) {
  std::scoped_lock lock(mutex_);

  const auto* inPtr = std::any_cast<ClassifyInput>(&input);
  if (inPtr == nullptr) {
    throw StatusError(InvalidArgument, "ClassificationModel: invalid input type");
  }
  if (!loaded_) {
    throw StatusError(
        InternalError,
        "ClassificationModel: classify() called before load() or after unload()");
  }

  const auto t0 = std::chrono::steady_clock::now();

  // The preprocessor's legacy encoded-path sentinel is `uint32_t == 0`;
  // collapse the optional<RawRgbDims> to that triplet at this boundary.
  const uint32_t rawW = inPtr->rawRgb.has_value() ? inPtr->rawRgb->width : 0;
  const uint32_t rawH = inPtr->rawRgb.has_value() ? inPtr->rawRgb->height : 0;
  const uint32_t rawC =
      inPtr->rawRgb.has_value() ? inPtr->rawRgb->channels : 0;
  std::vector<float> inputTensor = preprocess::preprocessToTensor(
      std::span<const uint8_t>(inPtr->data.data(), inPtr->data.size()),
      rawW, rawH, rawC);

  const size_t expected = static_cast<size_t>(preprocess::INPUT_SIZE) *
                          preprocess::INPUT_SIZE * preprocess::CHANNELS;
  if (inputTensor.size() != expected) {
    throw StatusError(
        InternalError, "ClassificationModel: preprocessed tensor has wrong size");
  }

  ggml_backend_tensor_set(
      compute_.input, inputTensor.data(), 0,
      inputTensor.size() * sizeof(float));

  ggml_status status =
      ggml_backend_graph_compute(backend_, compute_.graph);
  if (status != GGML_STATUS_SUCCESS) {
    throw StatusError(
        InternalError, "ggml_backend_graph_compute failed with status " +
                           std::to_string(static_cast<int>(status)));
  }

  float logits[graph::NUM_CLASSES] = {0.0F};
  ggml_backend_tensor_get(
      compute_.output, logits, 0, sizeof(logits));

  std::vector<float> probs =
      softmax(std::span<const float>(logits, graph::NUM_CLASSES));

  ClassifyOutput output;
  output.results.reserve(probs.size());
  for (size_t i = 0; i < probs.size(); ++i) {
    const std::string label = i < labels_.size()
                                  ? labels_[i]
                                  : std::string("class_") + std::to_string(i);
    output.results.push_back({label, probs[i]});
  }

  // Treat NaN/Inf as smaller than any finite value so the ordering
  // stays strict-weak even if a future ggml regression slips a
  // non-finite past the defensive softmax above.
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

  if (inPtr->topK > 0 && inPtr->topK < output.results.size()) {
    output.results.resize(inPtr->topK);
  }

  const auto t1 = std::chrono::steady_clock::now();
  lastInferenceUs_ = static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count());

  return std::any(std::move(output));
}

} // namespace classification_ggml

