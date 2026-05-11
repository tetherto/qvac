#pragma once

#include <string>

#include <js.h>
#include <inference-addon-cpp/JsUtils.hpp>

#include "model-interface/chatterbox/ChatterboxConfig.hpp"
#include "model-interface/supertonic/SupertonicConfig.hpp"

namespace qvac::ttsggml {

enum class EngineType {
  Chatterbox,
  Supertonic,
};

class JSAdapter {
public:
  JSAdapter() = default;

  EngineType readEngineType(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  chatterbox::ChatterboxConfig buildChatterboxConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  supertonic::SupertonicConfig buildSupertonicConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);
};

}
