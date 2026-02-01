#include <bare.h>
#include <js.h>

#include "qvac-lib-inference-addon-tts.hpp"

js_value_t* qvac_lib_inference_addon_tts_exports(js_env_t *env, js_value_t *exports) {

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

  V("createInstance", qvac_lib_inference_addon_tts::createInstance)
  V("unload", qvac_lib_inference_addon_tts::unload)
  V("load", qvac_lib_inference_addon_tts::load)
  V("reload", qvac_lib_inference_addon_tts::reload)
  V("loadWeights", qvac_lib_inference_addon_tts::loadWeights)
  V("unloadWeights", qvac_lib_inference_addon_tts::unloadWeights)
  V("activate", qvac_lib_inference_addon_tts::activate)
  V("append", qvac_lib_inference_addon_tts::append)
  V("status", qvac_lib_inference_addon_tts::status)
  V("pause", qvac_lib_inference_addon_tts::pause)
  V("stop", qvac_lib_inference_addon_tts::stop)
  V("cancel", qvac_lib_inference_addon_tts::cancel)
  V("destroyInstance", qvac_lib_inference_addon_tts::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_tts::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_tts::releaseLogger)
#undef V

  return exports;
}

BARE_MODULE(qvac_lib_inference_addon_tts, qvac_lib_inference_addon_tts_exports)



