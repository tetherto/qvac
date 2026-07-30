#include <bare.h>

#include "addon/AddonJs.hpp"

// NOLINTBEGIN(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
auto qvac_audiogen_ggml_exports(js_env_t* env, js_value_t* exports) -> js_value_t* {

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

  V("createInstance", qvac::audiogenggml::addon_js::createInstance)
  V("runJob", qvac::audiogenggml::addon_js::runJob)
  V("reload", qvac::audiogenggml::addon_js::reload)
  // Async load wrapper (deferred multi-stage GGUF parse on a worker thread).
  V("activate", qvac::audiogenggml::addon_js::activate)

  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("cancel", qvac_lib_inference_addon_cpp::JsInterface::cancel)
  V("destroyInstance",
    qvac_lib_inference_addon_cpp::JsInterface::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger",
    qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)

#undef V

  return exports;
}

BARE_MODULE(qvac_audiogen_ggml, qvac_audiogen_ggml_exports)
// NOLINTEND(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
