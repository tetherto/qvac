#pragma once

#include "model-interface/TranslationModel.hpp"
#include "qvac-lib-inference-addon-cpp/Addon.hpp"

namespace qvac_lib_inference_addon_mlc_marian {

using Addon = qvac_lib_inference_addon_cpp::Addon<TranslationModel>;

}

// Helper functions for batch processing - allows accessing the model without
// modifying base Addon
namespace qvac_lib_inference_addon_cpp {
void registerModelForAddon(
    void* addonPtr,
    qvac_lib_inference_addon_mlc_marian::TranslationModel* modelPtr);
void unregisterModelForAddon(void* addonPtr);
qvac_lib_inference_addon_mlc_marian::TranslationModel*
getModelForAddon(void* addonPtr);
} // namespace qvac_lib_inference_addon_cpp

namespace qvac_lib_inference_addon_cpp {

template <>
void qvac_lib_inference_addon_mlc_marian::Addon::loadWeights(
    js_env_t* env, js_value_t* weightsData);

template <> std::string qvac_lib_inference_addon_mlc_marian::Addon::getNextPiece(std::string &input, size_t lastPieceEnd);

template <>
void qvac_lib_inference_addon_mlc_marian::Addon::processSignalUnloadWeights(
    std::string& input);

template <>
void qvac_lib_inference_addon_mlc_marian::Addon::processSignalFinetune(
    std::string& input);

template <>
template <>
void qvac_lib_inference_addon_mlc_marian::Addon::load(
    std::string modelPath,
    std::unordered_map<std::string, std::variant<double, int64_t, std::string>> config);

template <>
template <>
void qvac_lib_inference_addon_mlc_marian::Addon::reload(
    std::string modelPath,
    std::unordered_map<std::string, std::variant<double, int64_t, std::string>> config);

} // namespace qvac_lib_inference_addon_cpp
