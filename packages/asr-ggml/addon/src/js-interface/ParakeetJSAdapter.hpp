#pragma once
// JSAdapter - bridges between JavaScript objects and ParakeetConfig
// This class handles the conversion from JS parameters to ParakeetConfig
// without requiring ParakeetConfig to know about JavaScript types.

#include <js.h>

#include "model-interface/parakeet/ParakeetConfig.hpp"

namespace qvac_lib_inference_addon_cpp::js {
class Object;
}

namespace qvac_lib_infer_parakeet {

class JSAdapter {
public:
  JSAdapter() = default;

  auto loadFromJSObject(
      qvac_lib_inference_addon_cpp::js::Object jsObject, js_env_t* env)
      -> qvac_lib_infer_parakeet::ParakeetConfig;

  auto loadModelParams(
      qvac_lib_inference_addon_cpp::js::Object modelParamsObj, js_env_t* env,
      qvac_lib_infer_parakeet::ParakeetConfig& parakeetConfig)
      -> qvac_lib_infer_parakeet::ParakeetConfig;

  auto loadAudioParams(
      qvac_lib_inference_addon_cpp::js::Object audioParamsObj, js_env_t* env,
      qvac_lib_infer_parakeet::ParakeetConfig& parakeetConfig)
      -> qvac_lib_infer_parakeet::ParakeetConfig;
};

} // namespace qvac_lib_infer_parakeet
