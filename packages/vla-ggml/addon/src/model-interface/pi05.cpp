#include "model-interface/pi05.hpp"

#include <stdexcept>

namespace qvac_lib_infer_vla_ggml {

Pi05Model::Pi05Model(
    const std::string& /*ggufPath*/,
    bool /*forceCpu*/,
    const std::string& /*backendsDir*/) {
  // Pre-populate sentinel hparams matching the spec in plan §2 so any
  // accessor that fires before this throw — e.g. an over-eager unit test —
  // sees the right shape. Once the load path is implemented, these will be
  // overwritten from the GGUF metadata keys (pi05.action_horizon,
  // pi05.image_resolution, pi05.num_cameras, …).
  hparams_.chunk_size = 50;
  hparams_.action_dim = 32;
  hparams_.max_action_dim = 32;
  hparams_.max_state_dim = 32;
  hparams_.tokenizer_max_length = 200;
  hparams_.vision_image_size = 224;
  hparams_.num_cameras = 3;
  hparams_.state_input_mode = VlaHparamsGeneric::StateInputMode::Discrete;

  throw std::runtime_error(
      "pi05 model loading not yet implemented (Phase 1 stub); "
      "see plan.md Phase 3 for the milestone breakdown");
}

bool Pi05Model::infer(
    const float** /*images*/,
    int /*n_images*/,
    int /*img_width*/,
    int /*img_height*/,
    const float* /*state*/,
    int /*state_dim*/,
    const int32_t* /*lang_tokens*/,
    const bool* /*lang_mask*/,
    int /*lang_len*/,
    const float* /*noise*/,
    float* /*actions_out*/,
    int* /*n_actions_out*/,
    VlaTimingGeneric* /*timing_out*/) {
  throw std::runtime_error("pi05 inference not yet implemented");
}

} // namespace qvac_lib_infer_vla_ggml
