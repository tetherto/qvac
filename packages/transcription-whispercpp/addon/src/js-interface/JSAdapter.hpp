#pragma once
// JSAdapter - bridges between JavaScript objects and WhisperConfig
// This class handles the conversion from JS parameters to WhisperConfig
// without requiring WhisperConfig to know about JavaScript types

#include <functional>
#include <map>
#include <string>
#include <unordered_map>

#include <js.h>
#include <whisper.h>

#include "addon/WhisperErrors.hpp"
#include "model-interface/whisper.cpp/WhisperConfig.hpp"
#include "model-interface/whisper.cpp/WhisperHandlers.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac_lib_inference_addon_cpp::js {
class Object;
}

namespace qvac_lib_inference_addon_whisper {

class JSAdapter {
public:
  JSAdapter() = default;

  auto loadFromJSObject(
      qvac_lib_inference_addon_cpp::js::Object jsObject, js_env_t* env)
      -> qvac_lib_inference_addon_whisper::WhisperConfig;

  auto loadVadParams(
      qvac_lib_inference_addon_cpp::js::Object vadParamsObj, js_env_t* env,
      qvac_lib_inference_addon_whisper::WhisperConfig& whisperConfig)
      -> qvac_lib_inference_addon_whisper::WhisperConfig;

  auto loadContextParams(
      qvac_lib_inference_addon_cpp::js::Object contextParamsObj, js_env_t* env,
      qvac_lib_inference_addon_whisper::WhisperConfig& whisperConfig)
      -> qvac_lib_inference_addon_whisper::WhisperConfig;

  auto loadMiscParams(
      qvac_lib_inference_addon_cpp::js::Object miscParamsObj, js_env_t* env,
      qvac_lib_inference_addon_whisper::WhisperConfig& whisperConfig)
      -> qvac_lib_inference_addon_whisper::WhisperConfig;

private:
  void loadMap(
      qvac_lib_inference_addon_cpp::js::Object jsObject, js_env_t* env,
      std::map<std::string, qvac_lib_inference_addon_whisper::JSValueVariant>&
          output);
};

} // namespace qvac_lib_inference_addon_whisper