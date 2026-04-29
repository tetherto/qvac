#pragma once

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "model-interface/smolvla.hpp"

namespace qvac_lib_infer_vla {

// Owns a loaded SmolVLA model plus scratch buffers for an inference call.
class VlaModel {
public:
  // `forceCpu`: skip GPU device selection and run on the CPU backend only.
  // Wired up so the integration test can compare CPU vs GPU on the same
  // runner without spinning up a second CI job.
  explicit VlaModel(const std::string& ggufPath, bool forceCpu = false)
      : model_(new smolvla_model()) {
    if (!smolvla_load_model(ggufPath.c_str(), model_.get(), forceCpu)) {
      throw std::runtime_error(
          "failed to load SmolVLA model from: " + ggufPath);
    }
  }

  VlaModel(const VlaModel&) = delete;
  VlaModel& operator=(const VlaModel&) = delete;

  ~VlaModel() {
    if (model_) {
      smolvla_free_model(model_.get());
    }
  }

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

  // Output of a single inference call.  Keeps the action chunk and the
  // per-stage wall-clock timings together so the JS layer can surface them
  // to the test harness / perf reporter.
  struct RunResult {
    std::vector<float> actions;
    smolvla_timing timing;
  };

  // Run one inference call. Image buffers must be contiguous CHW float32 in
  // [-1, 1], already resized+padded to (imgWidth × imgHeight). Tokens + mask
  // describe the instruction; noise is an optional (chunkSize × maxActionDim)
  // float32 buffer (null -> model-internal random).
  //
  // Buffers are not copied: the caller owns each pointer for the duration of
  // the call. The mask is copied once into a small `bool` buffer because
  // `smolvla_inference_with_timing` expects `const bool*` — values >1 in
  // `maskBytes` collapse to `true`.
  //
  // Returns a (chunkSize × actionDim) row-major float32 vector plus the
  // per-stage timing captured during the call.
  RunResult run(
      const float* const* images, int nImages, int imgWidth, int imgHeight,
      const float* state, int stateDim, const int32_t* tokens, int nTokens,
      const uint8_t* maskBytes, int nMask, const float* noise,
      int /*noiseLen*/) {
    if (nImages <= 0 || images == nullptr) {
      throw std::invalid_argument("VlaModel::run: images must not be empty");
    }
    if (nTokens != nMask) {
      throw std::invalid_argument(
          "VlaModel::run: tokens and mask must be the same length");
    }

    static_assert(
        sizeof(bool) == sizeof(unsigned char),
        "bool sizing assumption violated");
    std::vector<bool_as_char> maskCopy(maskBytes, maskBytes + nMask);

    const int chunkSize = model_->hparams.chunk_size;
    const int actionDim = model_->hparams.action_dim;
    RunResult result;
    result.actions.assign(static_cast<size_t>(chunkSize) * actionDim, 0.0f);
    int nActionsOut = 0;

    // const_cast: smolvla_inference_with_timing's `const float**` parameter
    // matches an extern "C" header that predates C++ const-correctness for
    // pointer-to-pointer args; the function only reads through these.
    const bool ok = smolvla_inference_with_timing(
        model_.get(), const_cast<const float**>(images), nImages, imgWidth,
        imgHeight, state, stateDim, tokens,
        reinterpret_cast<const bool*>(maskCopy.data()), nTokens, noise,
        result.actions.data(), &nActionsOut, &result.timing);

    if (!ok) {
      throw std::runtime_error("SmolVLA inference failed");
    }

    result.actions.resize(static_cast<size_t>(nActionsOut) * actionDim);
    return result;
  }

private:
  // std::vector<bool> is a bitset; keep a regular char buffer so we can
  // hand a real C bool pointer to the inference code.
  using bool_as_char = unsigned char;

  std::unique_ptr<smolvla_model> model_;
};

} // namespace qvac_lib_infer_vla
