#include "model-interface/smolvla_adapter.hpp"

#include <stdexcept>

#include <ggml-backend.h>

namespace qvac_lib_infer_vla_ggml {

namespace {

// Project the SmolVLA-specific hparams onto the generic struct. SmolVLA
// always takes 2 cameras (`base_0_rgb` + `wrist_0_rgb`) and a continuous
// state vector projected by `state_proj` — see plan §3.
VlaHparamsGeneric projectHparams(const smolvla_hparams& hp) {
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
    const std::string& ggufPath,
    bool forceCpu,
    const std::string& backendsDir)
    : model_(new smolvla_model()) {
  if (!smolvla_load_model(ggufPath.c_str(), *model_, forceCpu, backendsDir)) {
    throw std::runtime_error(
        "failed to load SmolVLA model from: " + ggufPath);
  }
  hparamsGeneric_ = projectHparams(model_->hparams);
}

std::string SmolvlaModelAdapter::backendName() const {
  if (model_->backend == nullptr) return "none";
  const char* n = ggml_backend_name(model_->backend);
  return n != nullptr ? std::string(n) : std::string("unknown");
}

bool SmolvlaModelAdapter::infer(
    const float** images,
    int n_images,
    int img_width,
    int img_height,
    const float* state,
    int state_dim,
    const int32_t* lang_tokens,
    const bool* lang_mask,
    int lang_len,
    const float* noise,
    float* actions_out,
    int* n_actions_out,
    VlaTimingGeneric* timing_out) {
  smolvla_timing nativeTiming{};
  const bool ok = smolvla_inference_with_timing(
      model_.get(),
      images,
      n_images,
      img_width,
      img_height,
      state,
      state_dim,
      lang_tokens,
      lang_mask,
      lang_len,
      noise,
      actions_out,
      n_actions_out,
      &nativeTiming);

  if (timing_out != nullptr) {
    timing_out->vision_ms = nativeTiming.vision_ms;
    // SmolVLA's SmolLM2 prefill stage maps directly to the generic prefill
    // timings; the legacy `smollm2_*` names live on at the JS layer
    // (AddonCpp.hpp::runtimeStats) for back-compat.
    timing_out->prefill_compute_ms = nativeTiming.smollm2_compute_ms;
    timing_out->prefill_total_ms = nativeTiming.smollm2_total_ms;
    timing_out->ode_ms = nativeTiming.ode_ms;
    timing_out->total_ms = nativeTiming.total_ms;
  }
  return ok;
}

} // namespace qvac_lib_infer_vla_ggml
