#pragma once

#include "qvac-lib-inference-addon-cpp/Addon.hpp"
#include "model-interface/SileroVadIterator.hpp"

#include "js.h"
#include "uv.h"
#include <functional>

namespace qvac_lib_inference_addon_cpp {

template<> template<>
Addon<qvac_lib_inference_addon_onnx_silerovad::VadIterator>::Addon(
  js_env_t* env,
  js_value_t* jsHandle,
  js_value_t* outputCb,
  js_value_t* transitionCb,
  std::reference_wrapper<const std::string> path
);

template<>
void Addon<qvac_lib_inference_addon_onnx_silerovad::VadIterator>::process();

template<>
void Addon<qvac_lib_inference_addon_onnx_silerovad::VadIterator>::jsOutputCallback(uv_async_t* handle);

}

namespace qvac_lib_inference_addon_onnx_silerovad {

using VadAddon = qvac_lib_inference_addon_cpp::Addon<VadIterator>;

}

