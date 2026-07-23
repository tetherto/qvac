#pragma once

// SmolVLA → IVlaModel adapter.
//
// Thin wrapper around the existing `smolvla_model` + the C-style
// `smolvla_load_model` / `smolvla_inference_with_timing` entry points. The
// adapter exists only so the rest of the addon can hold a single
// `IVlaModel*` regardless of the underlying architecture; the ~2 500 LOC of
// `smolvla.cpp` are untouched.

#include <memory>
#include <string>

#include "model-interface/smolvla.hpp"
#include "model-interface/vla_model.hpp"

namespace qvac_lib_infer_vla_ggml {

class SmolvlaModelAdapter final : public IVlaModel {
public:
  // Loads the model from `ggufPath`. Throws std::runtime_error on failure
  // (mirrors the previous VlaModel constructor behaviour). `forceCpu` and
  // `backendsDir` are forwarded verbatim to `smolvla_load_model`.
  SmolvlaModelAdapter(
      const std::string& ggufPath, bool forceCpu,
      const std::string& backendsDir);

  ~SmolvlaModelAdapter() override = default;

  SmolvlaModelAdapter(const SmolvlaModelAdapter&) = delete;
  SmolvlaModelAdapter& operator=(const SmolvlaModelAdapter&) = delete;

  // IVlaModel
  const VlaHparamsGeneric& hparams() const override { return hparamsGeneric_; }
  std::string backendName() const override;
  bool hasGpu() const override { return model_->has_gpu; }

  bool infer(
      const float** images, int nImages, int imgWidth, int imgHeight,
      const float* state, int stateDim, const int32_t* langTokens,
      const bool* langMask, int langLen, const float* noise, float* actionsOut,
      int* nActionsOut, VlaTimingGeneric* timingOut) override;

private:
  std::unique_ptr<SmolvlaModel> model_;
  VlaHparamsGeneric hparamsGeneric_{};
};

} // namespace qvac_lib_infer_vla_ggml
