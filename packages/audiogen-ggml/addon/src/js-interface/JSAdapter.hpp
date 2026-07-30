#pragma once

#include <js.h>
#include <inference-addon-cpp/JsUtils.hpp>

#include "model-interface/acestep/AcestepConfig.hpp"

namespace qvac::audiogenggml {

// Translates the JS `configuration` object into the C++ AcestepConfig.
// Mirrors ttsggml::JSAdapter (flat keys, read via inference-addon-cpp JsUtils).
class JSAdapter {
public:
  acestep::AcestepConfig buildAcestepConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);
};

}  // namespace qvac::audiogenggml
