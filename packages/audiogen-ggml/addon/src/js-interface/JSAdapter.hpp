#pragma once

#include <inference-addon-cpp/JsUtils.hpp>
#include <js.h>

#include "model-interface/acestep/AcestepConfig.hpp"
#include "model-interface/minimax/MinimaxConfig.hpp"

namespace qvac::audiogenggml {

enum class EngineType { Acestep, Minimax };

class JSAdapter {
public:
  EngineType readEngineType(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);
  acestep::AcestepConfig buildAcestepConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);
  minimax::MinimaxConfig buildMinimaxConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);
};

} // namespace qvac::audiogenggml
