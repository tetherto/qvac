#pragma once

#include <js.h>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>

#include "model-interface/chatterbox/ChatterboxConfig.hpp"

namespace qvac::ttsggml {

/**
 * Converts a JS configuration object into a `ChatterboxConfig` at
 * addon construction time.  Reads each property with its native JS
 * type (String / Number / Boolean) and validates numeric fields so
 * malformed values surface as `StatusError(InvalidArgument)` rather
 * than being silently swallowed.
 *
 * There is no per-request override path — the engine is persistent and
 * all knobs are fixed for the instance's lifetime; call
 * `model.reload(newConfig)` to rebuild it with different options.
 */
class JSAdapter {
public:
  JSAdapter() = default;

  chatterbox::ChatterboxConfig buildConfig(
      qvac_lib_inference_addon_cpp::js::Object configurationParams,
      js_env_t* env);
};

} // namespace qvac::ttsggml
