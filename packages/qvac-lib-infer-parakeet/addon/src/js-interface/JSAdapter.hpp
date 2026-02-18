#pragma once
// JSAdapter - bridges between JavaScript objects and ParakeetConfig
// This class handles the conversion from JS parameters to ParakeetConfig
// without requiring ParakeetConfig to know about JavaScript types

#include <functional>
#include <map>
#include <string>
#include <unordered_map>

#include <js.h>

#include "addon/ParakeetErrors.hpp"
#include "model-interface/parakeet/ParakeetConfig.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"

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

private:
  void loadMap(
      qvac_lib_inference_addon_cpp::js::Object jsObject, js_env_t* env,
      std::map<std::string, qvac_lib_infer_parakeet::JSValueVariant>& output);
};

} // namespace qvac_lib_infer_parakeet

