#pragma once

#include <string>

#include <inference-addon-cpp/JsUtils.hpp>
#include <js.h>

#include "model-interface/chatterbox/ChatterboxConfig.hpp"
#include "model-interface/parler/ParlerConfig.hpp"
#include "model-interface/supertonic/SupertonicConfig.hpp"

namespace qvac::ttsggml {

enum class EngineType {
  Chatterbox,
  Supertonic,
  Parler,
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

  parler::ParlerConfig buildParlerConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);

  // Shared by buildParlerConfig and the per-call runJob path (the same
  // description/template properties are legal on both objects).
  parler::ParlerDescriptionFields readParlerDescriptionFields(
      qvac_lib_inference_addon_cpp::js::Object obj, js_env_t* env);
};

}
