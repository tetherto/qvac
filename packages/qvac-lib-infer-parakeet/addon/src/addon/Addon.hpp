#pragma once

#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"
#include "qvac-lib-inference-addon-cpp/Addon.hpp"

namespace qvac_lib_inference_addon_cpp {

// Declare getNextPiece specialization
template <>
auto Addon<qvac_lib_infer_parakeet::ParakeetModel>::getNextPiece(
    qvac_lib_infer_parakeet::ParakeetModel::Input& input, size_t lastPieceEnd)
    -> qvac_lib_infer_parakeet::ParakeetModel::Input;

// Declare constructor specialization - const reference version
template <>
template <>
Addon<qvac_lib_infer_parakeet::ParakeetModel>::Addon(
    js_env_t* env, js_value_t* jsHandle, js_value_t* outputCb,
    js_value_t* transitionCb,
    const qvac_lib_infer_parakeet::ParakeetConfig& parakeetConfig,
    bool enableStats);

// Declare constructor specialization - by value version
template <>
template <>
Addon<qvac_lib_infer_parakeet::ParakeetModel>::Addon(
    js_env_t* env, js_value_t* jsHandle, js_value_t* outputCb,
    js_value_t* transitionCb,
    qvac_lib_infer_parakeet::ParakeetConfig parakeetConfig,
    bool enableStats);

// Declare process specialization
template <>
void Addon<qvac_lib_infer_parakeet::ParakeetModel>::process();

// Declare jsOutputCallback specialization
template <>
void Addon<qvac_lib_infer_parakeet::ParakeetModel>::jsOutputCallback(
    uv_async_t* handle);

// Declare endOfJob specialization
template <>
uint32_t Addon<qvac_lib_infer_parakeet::ParakeetModel>::endOfJob();

} // namespace qvac_lib_inference_addon_cpp

namespace qvac_lib_infer_parakeet {

using Addon = qvac_lib_inference_addon_cpp::Addon<ParakeetModel>;

}
