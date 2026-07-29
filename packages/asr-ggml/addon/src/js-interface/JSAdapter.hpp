#pragma once
// JSAdapter -- bridges between JavaScript objects and the per-engine config
// structs (whisper::WhisperConfig / parakeet::ParakeetConfig) without
// requiring either config to know about JavaScript types. Engine selection
// (readEngineType) follows the tts-ggml pattern: explicit `engineType`
// string -> hard error on unknown -> file-key inference -> default engine.

#include <map>
#include <string>

#include <js.h>

#include "model-interface/parakeet/ParakeetConfig.hpp"
#include "model-interface/whisper/WhisperConfig.hpp"

namespace qvac_lib_inference_addon_cpp::js {
class Object;
}

namespace qvac::asrggml {

enum class EngineType {
  Whisper,
  Parakeet,
};

class JSAdapter {
public:
  JSAdapter() = default;

  // Resolves which engine `configurationParams` describes. An explicit
  // `engineType: 'whisper' | 'parakeet'` always wins; any other non-empty
  // string throws InvalidArgument. Without it, a top-level model path key
  // (`modelPath`/`path`) infers Parakeet -- whisper's model arrives via
  // loadWeights and its config nests under whisperConfig/contextParams/
  // miscConfig -- and the fallback is Whisper (the default engine).
  EngineType readEngineType(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  // == the old whisper JSAdapter::loadFromJSObject, verbatim.
  whisper::WhisperConfig buildWhisperConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  // == the old parakeet JSAdapter::loadFromJSObject, verbatim.
  parakeet::ParakeetConfig buildParakeetConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

private:
  void loadVadParams(
      qvac_lib_inference_addon_cpp::js::Object vadParamsObj, js_env_t* env,
      whisper::WhisperConfig& whisperConfig);

  void loadContextParams(
      qvac_lib_inference_addon_cpp::js::Object contextParamsObj, js_env_t* env,
      whisper::WhisperConfig& whisperConfig);

  void loadMiscParams(
      qvac_lib_inference_addon_cpp::js::Object miscParamsObj, js_env_t* env,
      whisper::WhisperConfig& whisperConfig);

  void loadMap(
      qvac_lib_inference_addon_cpp::js::Object jsObject, js_env_t* env,
      std::map<std::string, whisper::JSValueVariant>& output);
};

} // namespace qvac::asrggml
