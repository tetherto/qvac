#pragma once

#include "model-interface/WhisperTypes.hpp"
#include "model-interface/whisper.cpp/WhisperModel.hpp"
#include "qvac-lib-inference-addon-cpp/Addon.hpp"

namespace qvac_lib_inference_addon_cpp {

template <>
template <>
Addon<qvac_lib_inference_addon_whisper::WhisperModel>::Addon(
    js_env_t* env, js_value_t* jsHandle, js_value_t* outputCb,
    js_value_t* transitionCb,
    const qvac_lib_inference_addon_whisper::WhisperConfig& whisperConfig,
    bool enableStats);

template <>
void Addon<qvac_lib_inference_addon_whisper::WhisperModel>::process();

template <>
void Addon<qvac_lib_inference_addon_whisper::WhisperModel>::jsOutputCallback(
    uv_async_t* handle);

template <>
uint32_t Addon<qvac_lib_inference_addon_whisper::WhisperModel>::endOfJob();

template <>
template <>
void Addon<qvac_lib_inference_addon_whisper::WhisperModel>::reload(
    const qvac_lib_inference_addon_whisper::WhisperConfig& whisperConfig);

} // namespace qvac_lib_inference_addon_cpp

namespace qvac_lib_inference_addon_whisper {

using Addon = qvac_lib_inference_addon_cpp::Addon<WhisperModel>;
}
