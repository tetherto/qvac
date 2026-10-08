#pragma once

#include <algorithm>
#include <any>
#include <atomic>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "model-interface/model_factory.hpp"
#include "model-interface/vla_model.hpp"

namespace qvac_lib_infer_vla_ggml {

// One inference call's worth of input. The framework's JobRunner runs
// process() on a worker thread after the JS callback has already returned,
// so input buffers must be owned copies — we cannot rely on JS-paused-during-
// native-call semantics like the old sync `runVlaModel` did.
struct VlaInput {
  // images[i] is contiguous CHW float32 in [-1, 1], length
  // 3*imgWidth*imgHeight.
  std::vector<std::vector<float>> images;
  int imgWidth = 0;
  int imgHeight = 0;
  std::vector<float> state;    // length = state_dim
  std::vector<int32_t> tokens; // length = nTokens
  std::vector<uint8_t> mask;   // length = nTokens
  std::vector<float> noise;    // empty if no noise was provided
};

// Owns a loaded VLA model. Implements the canonical IModel interface so
// it plugs into the framework's job runner / output dispatch (same as
// LlamaModel, BertModel, TranslationModel). The concrete model
// implementation is chosen by `createVlaModelFromGguf` based on the GGUF
// `general.architecture` key — see model_factory.hpp.
class VlaModel : public qvac_lib_inference_addon_cpp::model::IModel {
public:
  // `forceCpu`: skip GPU device selection and run on the CPU backend only.
  // `backendsDir`: absolute path to the prebuilds folder; forwarded to the
  // backend implementation so ggml backends are loaded from an absolute
  // path rather than relative to process CWD (required on mobile).
  explicit VlaModel(
      const std::string& ggufPath, bool forceCpu = false,
      std::string backendsDir = {}, const VlaEmbodimentRequest& embodiment = {})
      : model_(createVlaModelFromGguf(
            ggufPath, forceCpu, backendsDir, embodiment)) {
    // Canonical `backendDevice` encoding used across the inference addons
    // (LlamaModel, BertModel): 0 = CPU, 1 = GPU. Captured at load time so
    // `runtimeStats()` can report it without re-querying ggml.
    runtimeBackendDevice_ = model_->hasGpu() ? 1 : 0;
  }

  VlaModel(const VlaModel&) = delete;
  VlaModel& operator=(const VlaModel&) = delete;

  ~VlaModel() override = default;

  const VlaHparamsGeneric& hparams() const { return model_->hparams(); }

  // Name of the ggml backend the model is currently running on (e.g. "CPU",
  // "Vulkan", "OpenCL", "Metal"). Surfaced to JS so the perf reporter can
  // tag each result with its execution provider. Implementation-specific
  // sentinel values ("none", "unknown") are passed through.
  std::string backendName() const { return model_->backendName(); }

  // Switch the active embodiment on the loaded model (multi-embodiment GR00T
  // only; throws otherwise). Called from the JS thread.
  //
  // Refuses while an inference is in flight, and that refusal — not the model's
  // embodiment mutex — is what makes the switch correct. The mutex SERIALIZES a
  // switch against the worker thread's process(), but it cannot reorder them: a
  // switch dispatched after runJob() was accepted but before process() reaches
  // infer() would win the mutex, and inference would then read the NEW weights
  // with input already validated against the OLD hparams. infer() derives its
  // whole layout from nImages, so a DROID row run against LIBERO's 2 buffers
  // returns plausible actions for an embodiment the caller never selected — no
  // error, no log. index.js has its own friendlier check on _hasActiveResponse,
  // but the guard has to exist HERE too: the SDK plugin, the Python bindings
  // and any direct test harness reach the binding without going through it.
  void setEmbodiment(const VlaEmbodimentRequest& embodiment) {
    if (jobsInFlight_.load(std::memory_order_acquire) != 0) {
      // PUBLIC ERROR-CODE CONTRACT: the JS wrapper matches "an inference job is
      // in flight" to report JOB_ALREADY_RUNNING rather than blaming the config
      // (see NATIVE_ERR_MARKERS in src/index.ts) — keep that substring
      // verbatim.
      throw std::runtime_error(
          "VlaModel::setEmbodiment: an inference job is in flight — await the "
          "in-flight run() response before switching embodiment");
    }
    model_->setEmbodiment(embodiment);
  }

  // Dispatch bookkeeping for the guard above. The framework version this addon
  // builds against exposes no in-flight predicate of its own (its AddonCpp has
  // only runJob/cancelJob), so the count is tracked here, where both ends are
  // visible: noteJobDispatched() is called by the runJob binding BEFORE the job
  // is handed over (so no switch can slip into the gap between acceptance and
  // the increment), released again if the job was refused, and cleared by
  // process() once inference has consumed the weights. VLA implements no
  // IModelCancel, so an accepted job always reaches process() and the count
  // cannot be stranded.
  //
  // acq_rel on both, not plain release: the count is read on one thread and
  // written on two (dispatch on the JS thread, completion on the worker), so
  // each update has to both publish itself to the guard's acquire load and see
  // every update that came before it. A release-only RMW gives the first half
  // and not the second.
  void noteJobDispatched() {
    jobsInFlight_.fetch_add(1, std::memory_order_acq_rel);
  }
  void noteJobSettled() {
    jobsInFlight_.fetch_sub(1, std::memory_order_acq_rel);
  }

  // ─── IModel interface ─────────────────────────────────────────────────────

  [[nodiscard]] std::string getName() const final { return "VlaModel"; }

  // Invoked on the JobRunner worker thread. The std::any is unwrapped to a
  // VlaInput, the inference path runs synchronously, and the result is
  // wrapped in a std::vector<float> (length = chunk_size * action_dim) so
  // the framework's JsTypedArrayOutputHandler<float> can convert it to a JS
  // Float32Array. Stats are emitted separately by OutputQueue::queueJobEnded
  // calling our runtimeStats().
  std::any process(const std::any& input) final {
    // Release the in-flight count however this returns: a throwing process()
    // still ends the job, and a count stranded by an early return would block
    // every later setEmbodiment for the model's lifetime.
    const JobInFlightGuard settled(*this);
    const VlaInput* in = std::any_cast<VlaInput>(&input);
    if (in == nullptr) {
      throw std::invalid_argument("VlaModel::process: input is not a VlaInput");
    }
    return std::any{runInternal(*in)};
  }

  // Per-stage timings plus backendDevice (0=CPU, 1=GPU). Mirrors
  // LlamaModel::runtimeStats() / BertModel::runtimeStats() so consumers can
  // use a single read pattern across addons. The values reflect the most
  // recent process() call; before any run they are zeroed out.
  //
  // For SmolVLA back-compat we emit BOTH the new generic keys
  // (prefill_compute_ms / prefill_total_ms) AND the legacy SmolVLA-named
  // keys (smollm2_compute_ms / smollm2_total_ms) so existing JS integration
  // tests that assert on the smollm2_* names keep passing.
  // TODO(pi05): drop the SmolVLA-named duplicates once π₀.₅ ships and
  // consumers have migrated to the architecture-neutral keys.
  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final {
    return {
        {"vision_ms", lastTiming_.vision_ms},
        {"prefill_compute_ms", lastTiming_.prefill_compute_ms},
        {"prefill_total_ms", lastTiming_.prefill_total_ms},
        // Back-compat duplicates (TODO: drop after π₀.₅ ships).
        {"smollm2_compute_ms", lastTiming_.prefill_compute_ms},
        {"smollm2_total_ms", lastTiming_.prefill_total_ms},
        {"ode_ms", lastTiming_.ode_ms},
        {"total_ms", lastTiming_.total_ms},
        {"backendDevice", runtimeBackendDevice_}};
  }

private:
  // Releases one in-flight job on destruction, so process() clears the count on
  // every exit path including a throw.
  class JobInFlightGuard {
  public:
    explicit JobInFlightGuard(VlaModel& owner) : owner_(owner) {}
    ~JobInFlightGuard() { owner_.noteJobSettled(); }
    JobInFlightGuard(const JobInFlightGuard&) = delete;
    JobInFlightGuard& operator=(const JobInFlightGuard&) = delete;

  private:
    VlaModel& owner_;
  };

  // Real inference path. Validates input shape, builds the image-pointer
  // vector, copies the bool mask, runs IVlaModel::infer, and captures the
  // timing into lastTiming_ for runtimeStats().
  std::vector<float> runInternal(const VlaInput& in) {
    if (in.images.empty()) {
      throw std::invalid_argument("VlaModel::run: images must not be empty");
    }
    if (in.tokens.size() != in.mask.size()) {
      throw std::invalid_argument(
          "VlaModel::run: tokens and mask must be the same length");
    }
    const auto& hp = model_->hparams();
    if (!in.noise.empty()) {
      const auto required =
          static_cast<size_t>(hp.chunk_size) * hp.max_action_dim;
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

    const int chunkSize = hp.chunk_size;
    const int actionDim = hp.action_dim;
    std::vector<float> actions(
        static_cast<size_t>(chunkSize) * actionDim, 0.0f);
    int nActionsOut = 0;

    VlaTimingGeneric timing{};
    const float* noisePtr = in.noise.empty() ? nullptr : in.noise.data();
    // const_cast: IVlaModel::infer's `const float**` parameter inherits
    // from the SmolVLA C-style API that predates C++ const-correctness for
    // pointer-to-pointer args; the function only reads through these.
    const bool ok = model_->infer(
        const_cast<const float**>(imagePtrs.data()),
        static_cast<int>(in.images.size()),
        in.imgWidth,
        in.imgHeight,
        in.state.data(),
        static_cast<int>(in.state.size()),
        in.tokens.data(),
        maskCopy.get(),
        static_cast<int>(in.tokens.size()),
        noisePtr,
        actions.data(),
        &nActionsOut,
        &timing);

    if (!ok) {
      throw std::runtime_error("VLA inference failed");
    }

    // Worker thread is the only writer to lastTiming_; runtimeStats() is
    // called by OutputQueue::queueJobEnded immediately after process()
    // returns on the same thread, so no synchronisation needed.
    lastTiming_ = timing;
    actions.resize(static_cast<size_t>(nActionsOut) * actionDim);
    return actions;
  }

  std::unique_ptr<IVlaModel> model_;
  VlaTimingGeneric lastTiming_{};
  int64_t runtimeBackendDevice_ = 0;
  // Jobs accepted by the scheduler and not yet finished in process(). Written
  // from the JS thread (dispatch) and the worker thread (completion), read by
  // setEmbodiment on the JS thread — hence atomic.
  std::atomic<int> jobsInFlight_{0};
};

} // namespace qvac_lib_infer_vla_ggml
