#pragma once

#include "model-interface/BertModel.h"
#include "qvac-lib-inference-addon-cpp/Addon.hpp"

namespace qvac_lib_inference_addon_cpp {

namespace output_handler {
/// @brief Handles models that output arrays.
template <>
js_value_t *createOutputData(js_env_t *env,
                             const std::vector<std::vector<float>> &data);
} // namespace output_handler

// Specialization declarations for Addon<BertModel>
template <>
template <>
Addon<BertModel>::Addon(
    js_env_t* env, std::reference_wrapper<const std::string> modelPath,
    std::reference_wrapper<const std::string> config,
    std::reference_wrapper<const std::string> backendsDir, js_value_t* jsHandle,
    js_value_t* outputCb, js_value_t* transitionCb);

template <>
BertModel::Input
Addon<BertModel>::getNextPiece(BertModel::Input& input, size_t lastPieceEnd);

template <>
uint32_t Addon<BertModel>::append(int priority, BertModel::InputView input);

template <> void Addon<BertModel>::process();

} // namespace qvac_lib_inference_addon_cpp

namespace qvac_lib_infer_llamacpp_embed {
using Addon = qvac_lib_inference_addon_cpp::Addon<BertModel>;
}
