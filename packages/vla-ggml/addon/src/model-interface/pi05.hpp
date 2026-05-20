#pragma once

// π₀.₅ model stub — Phase 1 wire-up only. The constructor throws
// std::runtime_error so the factory path is exercised by tests but no real
// loading or inference is attempted yet. Phase 3 fills in the implementation
// (SigLIP-So400m, Gemma-1 2B VLM, Gemma-1 300M action expert, joint
// attention, adaRMSNorm, …) per plan §4.

#include <string>

#include "model-interface/vla_model.hpp"

namespace qvac_lib_infer_vla_ggml {

class Pi05Model final : public IVlaModel {
public:
  // Phase 1 stub: constructing a Pi05Model immediately throws so callers
  // who try to use the factory against a `general.architecture=pi05` GGUF
  // get a clear, early failure rather than a corrupt half-loaded model.
  // Phase 3 will replace this with `pi05_load_model(...)`.
  Pi05Model(
      const std::string& ggufPath,
      bool forceCpu,
      const std::string& backendsDir);

  ~Pi05Model() override = default;

  Pi05Model(const Pi05Model&) = delete;
  Pi05Model& operator=(const Pi05Model&) = delete;

  // IVlaModel — these are unreachable in Phase 1 because the constructor
  // throws, but they exist so the symbol table is complete and Phase 3
  // can fill them in without churning the addon layer.
  const VlaHparamsGeneric& hparams() const override { return hparams_; }
  std::string backendName() const override { return "none"; }
  bool hasGpu() const override { return false; }

  bool infer(
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
      VlaTimingGeneric* timing_out) override;

private:
  VlaHparamsGeneric hparams_{};
};

} // namespace qvac_lib_infer_vla_ggml
