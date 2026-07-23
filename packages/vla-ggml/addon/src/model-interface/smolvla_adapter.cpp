#include "model-interface/smolvla_adapter.hpp"

#include <stdexcept>

#include <ggml-backend.h>

namespace qvac_lib_infer_vla_ggml {

namespace {

// Project the SmolVLA-specific hparams onto the generic struct. SmolVLA
// always takes 2 cameras (`base_0_rgb` + `wrist_0_rgb`) and a continuous
// state vector projected by `state_proj` — see plan §3.
VlaHparamsGeneric projectHparams(const SmolvlaHparams& hp) {
  VlaHparamsGeneric out{};
  out.chunk_size = hp.chunk_size;
  out.action_dim = hp.action_dim;
  out.max_action_dim = hp.max_action_dim;
  out.max_state_dim = hp.max_state_dim;
  out.tokenizer_max_length = hp.tokenizer_max_length;
  out.vision_image_size = hp.vision_image_size;
  out.num_cameras = 2;
  out.state_input_mode = VlaHparamsGeneric::StateInputMode::Continuous;
  return out;
}

} // namespace

SmolvlaModelAdapter::SmolvlaModelAdapter(
    const std::string& ggufPath, bool forceCpu, const std::string& backendsDir)
    : model_(new SmolvlaModel()) {
  if (!smolvlaLoadModel(ggufPath.c_str(), *model_, forceCpu, backendsDir)) {
    throw std::runtime_error("failed to load SmolVLA model from: " + ggufPath);
  }
  hparamsGeneric_ = projectHparams(model_->hparams);
}

std::string SmolvlaModelAdapter::backendName() const {
  if (model_->backend == nullptr)
    return "none";
  const char* n = ggml_backend_name(model_->backend);
  return n != nullptr ? std::string(n) : std::string("unknown");
}

bool SmolvlaModelAdapter::infer(
    const float** images, int nImages, int imgWidth, int imgHeight,
    const float* state, int stateDim, const int32_t* langTokens,
    const bool* langMask, int langLen, const float* noise, float* actionsOut,
    int* nActionsOut, VlaTimingGeneric* timingOut) {
  SmolvlaTiming nativeTiming{};
  const bool ok = smolvlaInferenceWithTiming(
      model_.get(),
      images,
      nImages,
      imgWidth,
      imgHeight,
      state,
      stateDim,
      langTokens,
      langMask,
      langLen,
      noise,
      actionsOut,
      nActionsOut,
      &nativeTiming);

  if (timingOut != nullptr) {
    timingOut->vision_ms = nativeTiming.vision_ms;
    // SmolVLA's SmolLM2 prefill stage maps directly to the generic prefill
    // timings; the legacy `smollm2_*` names live on at the JS layer
    // (AddonCpp.hpp::runtimeStats) for back-compat.
    timingOut->prefill_compute_ms = nativeTiming.smollm2_compute_ms;
    timingOut->prefill_total_ms = nativeTiming.smollm2_total_ms;
    timingOut->ode_ms = nativeTiming.ode_ms;
    timingOut->total_ms = nativeTiming.total_ms;
  }
  return ok;
}

} // namespace qvac_lib_infer_vla_ggml
