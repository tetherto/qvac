#include <iostream>
#include <vector>
#include <bare.h>
#include <js.h>

#include "qvac-lib-infer-nmtcpp.hpp"

// NOLINTBEGIN(readability-function-cognitive-complexity, cppcoreguidelines-macro-usage)
js_value_t* qvacLibInferenceAddonMlcMarianExports(js_env_t *env, js_value_t *exports) {

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

  V("createInstance", qvac_lib_inference_addon_mlc_marian::createInstance)
  V("unload", qvac_lib_inference_addon_mlc_marian::unload)
  V("load", qvac_lib_inference_addon_mlc_marian::load)
  V("reload", qvac_lib_inference_addon_mlc_marian::reload)
  V("loadWeights", qvac_lib_inference_addon_mlc_marian::loadWeights)
  V("unloadWeights", qvac_lib_inference_addon_mlc_marian::unloadWeights)
  V("activate", qvac_lib_inference_addon_mlc_marian::activate)
  V("append", qvac_lib_inference_addon_mlc_marian::append)
  V("status", qvac_lib_inference_addon_mlc_marian::status)
  V("pause", qvac_lib_inference_addon_mlc_marian::pause)
  V("stop", qvac_lib_inference_addon_mlc_marian::stop)
  V("cancel", qvac_lib_inference_addon_mlc_marian::cancel)
  V("destroyInstance", qvac_lib_inference_addon_mlc_marian::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_mlc_marian::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_mlc_marian::releaseLogger)
  V("processBatch", qvac_lib_inference_addon_mlc_marian::processBatch)
#undef V

  return exports;
}

BARE_MODULE(qvac_lib_inference_addon_mlc_marian, qvacLibInferenceAddonMlcMarianExports)
// NOLINTEND(readability-function-cognitive-complexity,
// cppcoreguidelines-macro-usage)
