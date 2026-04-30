#include <bare.h>

#include "src/addon/AddonJs.hpp"

js_value_t *qvac_lib_inference_addon_tts_exports(js_env_t *env,
                                                 js_value_t *exports) {

#define V(name, fn)                                                            \
  {                                                                            \
    js_value_t *val;                                                           \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {           \
      return nullptr;                                                          \
    }                                                                          \
    if (js_set_named_property(env, exports, name, val) != 0) {                 \
      return nullptr;                                                          \
    }                                                                          \
  }

  V("createInstance", qvac_lib_inference_addon_tts::createInstance)
  V("runJob", qvac_lib_inference_addon_tts::runJob)

  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", qvac_lib_inference_addon_cpp::JsInterface::activate)
  V("cancel", qvac_lib_inference_addon_cpp::JsInterface::cancel)
  V("destroyInstance", qvac_lib_inference_addon_cpp::JsInterface::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)
#undef V

  return exports;
}

BARE_MODULE(qvac_lib_inference_addon_tts, qvac_lib_inference_addon_tts_exports)
