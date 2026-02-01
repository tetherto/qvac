#include <iostream>
#include <vector>

#include <bare.h>
#include <js.h>

#include "qvac-lib-infer-whispercpp.hpp"

// NOLINTBEGIN(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
auto qvac_lib_inference_addon_whisper_exports(
    js_env_t* env,
    js_value_t* exports)
    -> js_value_t* { // NOLINT(readability-identifier-naming)

#define V(name, fn)                                                            \
  {                                                                            \
    js_value_t* val;                                                           \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {           \
      return nullptr;                                                          \
    }                                                                          \
    if (js_set_named_property(env, exports, name, val) != 0) {                 \
      return nullptr;                                                          \
    }                                                                          \
  }

  V("createInstance", qvac_lib_inference_addon_whisper::createInstance)
  V("unload", qvac_lib_inference_addon_whisper::unload)
  V("load", qvac_lib_inference_addon_whisper::load)
  V("reload", qvac_lib_inference_addon_whisper::reload)
  V("loadWeights", qvac_lib_inference_addon_whisper::loadWeights)
  V("unloadWeights", qvac_lib_inference_addon_whisper::unloadWeights)
  V("activate", qvac_lib_inference_addon_whisper::activate)
  V("append", qvac_lib_inference_addon_whisper::append)
  V("status", qvac_lib_inference_addon_whisper::status)
  V("pause", qvac_lib_inference_addon_whisper::pause)
  V("stop", qvac_lib_inference_addon_whisper::stop)
  V("cancel", qvac_lib_inference_addon_whisper::cancel)
  V("destroyInstance", qvac_lib_inference_addon_whisper::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_whisper::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_whisper::releaseLogger)
#undef V

  return exports;
}

BARE_MODULE(
    qvac_lib_inference_addon_whisper, qvac_lib_inference_addon_whisper_exports)
// NOLINTEND(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
