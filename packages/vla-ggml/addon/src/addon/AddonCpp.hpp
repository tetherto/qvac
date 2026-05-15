#pragma once

#include <algorithm>
#include <any>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "model-interface/smolvla.hpp"

namespace qvac_lib_infer_vla_ggml {

// One inference call's worth of input. The framework's JobRunner runs
// process() on a worker thread after the JS callback has already returned,
// so input buffers must be owned copies — we cannot rely on JS-paused-during-
// native-call semantics like the old sync `runVlaModel` did.
struct VlaInput {
  // images[i] is contiguous CHW float32 in [-1, 1], length 3*imgWidth*imgHeight.
  std::vector<std::vector<float>> images;
  int imgWidth = 0;
  int imgHeight = 0;
  std::vector<float> state;     // length = state_dim
  std::vector<int32_t> tokens;  // length = nTokens
  std::vector<uint8_t> mask;    // length = nTokens
  std::vector<float> noise;     // empty if no noise was provided
};

// Owns a loaded SmolVLA model. Implements the canonical IModel interface so
// it plugs into the framework's job runner / output dispatch (same as
// LlamaModel, BertModel, TranslationModel).
class VlaModel : public qvac_lib_inference_addon_cpp::model::IModel {
public:
  // `forceCpu`: skip GPU device selection and run on the CPU backend only.
  // `backendsDir`: absolute path to the prebuilds folder; forwarded to
  // smolvla_load_model so ggml backends are loaded from an absolute path
  // rather than relative to process CWD (required on mobile).
  explicit VlaModel(
      const std::string& ggufPath,
      bool forceCpu = false,
      std::string backendsDir = {})
      : model_(new smolvla_model()) {
    if (!smolvla_load_model(ggufPath.c_str(), *model_, forceCpu, backendsDir)) {
      throw std::runtime_error(
          "failed to load SmolVLA model from: " + ggufPath);
    }
    // Canonical `backendDevice` encoding used across the inference addons
    // (LlamaModel, BertModel): 0 = CPU, 1 = GPU. Captured at load time so
    // `runtimeStats()` can report it without re-querying ggml.
    runtimeBackendDevice_ = model_->has_gpu ? 1 : 0;
  }

  VlaModel(const VlaModel&) = delete;
  VlaModel& operator=(const VlaModel&) = delete;

  // smolvla_model has its own destructor that calls smolvla_free_model
  ~VlaModel() override = default;

  const smolvla_hparams& hparams() const { return model_->hparams; }

  // Name of the ggml backend the model is currently running on (e.g. "CPU",
  // "Vulkan", "OpenCL", "Metal"). Surfaced to JS so the perf reporter can tag
  // each result with its execution provider. Returns "none" if no backend is
  // initialised, "unknown" if ggml didn't supply a name.
  std::string backendName() const {
    if (model_->backend == nullptr) return "none";
    const char* n = ggml_backend_name(model_->backend);
    return n != nullptr ? std::string(n) : std::string("unknown");
  }

  // ─── IModel interface ─────────────────────────────────────────────────────

  [[nodiscard]] std::string getName() const final { return "VlaModel"; }

  // Invoked on the JobRunner worker thread. The std::any is unwrapped to a
  // VlaInput, the SmolVLA inference path runs synchronously, and the result
  // is wrapped in a std::vector<float> (length = chunk_size * action_dim) so
  // the framework's JsTypedArrayOutputHandler<float> can convert it to a JS
  // Float32Array. Stats are emitted separately by OutputQueue::queueJobEnded
  // calling our runtimeStats().
  std::any process(const std::any& input) final {
    const VlaInput* in = std::any_cast<VlaInput>(&input);
    if (in == nullptr) {
      throw std::invalid_argument(
          "VlaModel::process: input is not a VlaInput");
    }
    return std::any{runInternal(*in)};
  }

  // Per-stage timings (vision_ms, smollm2_*_ms, ode_ms, total_ms) plus
  // backendDevice (0=CPU, 1=GPU). Mirrors LlamaModel::runtimeStats() and
  // BertModel::runtimeStats() so consumers can use a single read pattern
  // across addons. The values reflect the most recent process() call;
  // before any run they are zeroed out.
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final {
    return {
        {"vision_ms", lastTiming_.vision_ms},
        {"smollm2_compute_ms", lastTiming_.smollm2_compute_ms},
        {"smollm2_total_ms", lastTiming_.smollm2_total_ms},
        {"ode_ms", lastTiming_.ode_ms},
        {"total_ms", lastTiming_.total_ms},
        {"backendDevice", runtimeBackendDevice_}};
  }

private:
  // Real inference path. Validates input shape, builds the image-pointer
  // vector, copies the bool mask, runs smolvla_inference_with_timing, and
  // captures the timing into lastTiming_ for runtimeStats().
  std::vector<float> runInternal(const VlaInput& in) {
    if (in.images.empty()) {
      throw std::invalid_argument("VlaModel::run: images must not be empty");
    }
    if (in.tokens.size() != in.mask.size()) {
      throw std::invalid_argument(
          "VlaModel::run: tokens and mask must be the same length");
    }
    if (!in.noise.empty()) {
      const auto required = static_cast<size_t>(model_->hparams.chunk_size) *
                            model_->hparams.max_action_dim;
      if (in.noise.size() < required) {
        throw std::invalid_argument(
            "VlaModel::run: noise buffer is shorter than chunk_size * "
            "max_action_dim");
      }
    }

    auto maskCopy = std::make_unique<bool[]>(in.mask.size());
    std::copy(in.mask.begin(), in.mask.end(), maskCopy.get());

    std::vector<const float*> imagePtrs(in.images.size());
    for (size_t i = 0; i < in.images.size(); i++) {
      imagePtrs[i] = in.images[i].data();
    }

    const int chunkSize = model_->hparams.chunk_size;
    const int actionDim = model_->hparams.action_dim;
    std::vector<float> actions(
        static_cast<size_t>(chunkSize) * actionDim, 0.0f);
    int nActionsOut = 0;

    smolvla_timing timing{};
    const float* noisePtr = in.noise.empty() ? nullptr : in.noise.data();
    // const_cast: smolvla_inference_with_timing's `const float**` parameter
    // matches an extern "C" header that predates C++ const-correctness for
    // pointer-to-pointer args; the function only reads through these.
    const bool ok = smolvla_inference_with_timing(
        model_.get(), const_cast<const float**>(imagePtrs.data()),
        static_cast<int>(in.images.size()), in.imgWidth, in.imgHeight,
        in.state.data(), static_cast<int>(in.state.size()), in.tokens.data(),
        maskCopy.get(), static_cast<int>(in.tokens.size()), noisePtr,
        actions.data(), &nActionsOut, &timing);

    if (!ok) {
      throw std::runtime_error("SmolVLA inference failed");
    }

    // Worker thread is the only writer to lastTiming_; runtimeStats() is
    // called by OutputQueue::queueJobEnded immediately after process()
    // returns on the same thread, so no synchronisation needed.
    lastTiming_ = timing;
    actions.resize(static_cast<size_t>(nActionsOut) * actionDim);
    return actions;
  }

  std::unique_ptr<smolvla_model> model_;
  smolvla_timing lastTiming_{};
  int64_t runtimeBackendDevice_ = 0;
};

} // namespace qvac_lib_infer_vla_ggml
