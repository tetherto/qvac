#include "qvac-lib-inference-addon-llama.hpp"

#include <bare.h>

js_value_t*
qvacLibInferenceAddonLlamaExports(js_env_t* env, js_value_t* exports) {

// NOLINTNEXTLINE(cppcoreguidelines-macro-usage)
#define V(name, fn) \
  { \
    js_value_t *val; \
    if ( js_create_function(env, name, -1, fn, nullptr, &val) != 0) { \
      return nullptr; \
    } \
    if ( js_set_named_property(env, exports, name, val) != 0) { \
      return nullptr; \
    } \
  }

  V("createInstance", qvac_lib_inference_addon_llama::createInstance) 
  V("loadWeights", qvac_lib_inference_addon_llama::loadWeights) 
  V("activate", qvac_lib_inference_addon_llama::activate) 
  V("append", qvac_lib_inference_addon_llama::append) 
  V("status", qvac_lib_inference_addon_llama::status) 
  V("pause", qvac_lib_inference_addon_llama::pause) 
  V("stop", qvac_lib_inference_addon_llama::stop) 
  V("cancel", qvac_lib_inference_addon_llama::cancel) 
  V("destroyInstance", qvac_lib_inference_addon_llama::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_llama::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_llama::releaseLogger)

#undef V
  return exports;
}

BARE_MODULE(qvac_lib_inference_addon_llama, qvacLibInferenceAddonLlamaExports)
