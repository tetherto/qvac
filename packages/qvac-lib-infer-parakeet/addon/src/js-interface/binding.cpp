#include <iostream>
#include <vector>

#include <bare.h>
#include <js.h>

#include "qvac-lib-infer-parakeet.hpp"

// NOLINTBEGIN(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
auto qvac_lib_infer_parakeet_exports(js_env_t* env, js_value_t* exports)
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

  V("createInstance", qvac_lib_infer_parakeet::createInstance)
  V("unload", qvac_lib_infer_parakeet::unload)
  V("load", qvac_lib_infer_parakeet::load)
  V("reload", qvac_lib_infer_parakeet::reload)
  V("loadWeights", qvac_lib_infer_parakeet::loadWeights)
  V("unloadWeights", qvac_lib_infer_parakeet::unloadWeights)
  V("activate", qvac_lib_infer_parakeet::activate)
  V("append", qvac_lib_infer_parakeet::append)
  V("status", qvac_lib_infer_parakeet::status)
  V("pause", qvac_lib_infer_parakeet::pause)
  V("stop", qvac_lib_infer_parakeet::stop)
  V("cancel", qvac_lib_infer_parakeet::cancel)
  V("destroyInstance", qvac_lib_infer_parakeet::destroyInstance)
  V("setLogger", qvac_lib_infer_parakeet::setLogger)
  V("releaseLogger", qvac_lib_infer_parakeet::releaseLogger)
#undef V

  return exports;
}

BARE_MODULE(qvac_lib_infer_parakeet, qvac_lib_infer_parakeet_exports)
// NOLINTEND(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
