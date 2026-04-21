#pragma once

#include <js.h>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <string>
#include <unordered_map>

#include "model-interface/chatterbox/ChatterboxConfig.hpp"

namespace qvac::ttsggml {

/**
 * Converts a JS configuration object into a `ChatterboxConfig`.  String /
 * string-map layering mirrors the `@qvac/tts-onnx` addon so the two
 * back-ends share the same JS surface.
 */
class JSAdapter {
public:
  JSAdapter() = default;

  chatterbox::ChatterboxConfig buildConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  /** Flatten a JS object of string/boolean leaves into a key->string map. */
  static std::unordered_map<std::string, std::string> flattenToStringMap(
      qvac_lib_inference_addon_cpp::js::Object obj, js_env_t* env);

  /**
   * Per-request override applicator — layers values from a `{key: string}`
   * map onto an existing config (currently only `outputSampleRate`; extended
   * in future milestones as the engine exposes more knobs).
   */
  static void applyJobOverrides(
      chatterbox::ChatterboxConfig& cfg,
      const std::unordered_map<std::string, std::string>& overrides);
};

} // namespace qvac::ttsggml
