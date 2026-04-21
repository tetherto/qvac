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
  explicit VlaModel(const std::string& ggufPath) : model_(new smolvla_model()) {
    if (!smolvla_load_model(ggufPath.c_str(), model_.get())) {
      throw std::runtime_error("failed to load SmolVLA model from: " + ggufPath);
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

  // Run one inference call. Image buffers must be contiguous CHW float32 in
  // [-1, 1], already resized+padded to (imgWidth × imgHeight). Tokens +
  // mask describe the instruction; noise is an optional (chunkSize ×
  // maxActionDim) float32 buffer (null -> model-internal random).
  //
  // Returns a (chunkSize × actionDim) row-major float32 vector.
  std::vector<float> run(
      const std::vector<std::vector<float>>& images,
      int imgWidth,
      int imgHeight,
      const std::vector<float>& state,
      const std::vector<int32_t>& tokens,
      const std::vector<uint8_t>& mask,
      const std::vector<float>& noise) {
    if (images.empty()) {
      throw std::invalid_argument("VlaModel::run: images must not be empty");
    }
    if (tokens.size() != mask.size()) {
      throw std::invalid_argument(
          "VlaModel::run: tokens and mask must be the same length");
    }

    std::vector<const float*> imagePtrs;
    imagePtrs.reserve(images.size());
    for (const auto& img : images) {
      imagePtrs.push_back(img.data());
    }

    std::vector<bool_as_char> maskCopy(mask.begin(), mask.end());
    static_assert(sizeof(bool_as_char) == sizeof(bool),
                  "bool sizing assumption violated");

    const int chunkSize = model_->hparams.chunk_size;
    const int actionDim = model_->hparams.action_dim;
    std::vector<float> actionsBuf(static_cast<size_t>(chunkSize) * actionDim);
    int nActionsOut = 0;

    const float* noisePtr = noise.empty() ? nullptr : noise.data();

    const bool ok = smolvla_inference(
        model_.get(),
        imagePtrs.data(),
        static_cast<int>(imagePtrs.size()),
        imgWidth,
        imgHeight,
        state.data(),
        static_cast<int>(state.size()),
        tokens.data(),
        reinterpret_cast<const bool*>(maskCopy.data()),
        static_cast<int>(tokens.size()),
        noisePtr,
        actionsBuf.data(),
        &nActionsOut);

    if (!ok) {
      throw std::runtime_error("SmolVLA inference failed");
    }

    actionsBuf.resize(static_cast<size_t>(nActionsOut) * actionDim);
    return actionsBuf;
  }

 private:
  // std::vector<bool> is a bitset; keep a regular char buffer so we can
  // hand a real C bool pointer to the inference code.
  using bool_as_char = unsigned char;

  std::unique_ptr<smolvla_model> model_;
};

} // namespace qvac_lib_infer_vla
