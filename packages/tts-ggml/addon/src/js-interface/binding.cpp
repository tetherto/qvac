#include <bare.h>

#include "addon/AddonJs.hpp"

// NOLINTBEGIN(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
auto qvac_tts_ggml_exports(js_env_t* env, js_value_t* exports) -> js_value_t* {

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

  V("createInstance", qvac::ttsggml::addon_js::createInstance)
  V("runJob", qvac::ttsggml::addon_js::runJob)
  V("reload", qvac::ttsggml::addon_js::reload)
  // Override the framework's sync JsInterface::activate with our
  // JsAsyncTask::run-wrapped version so the deferred GGUF parse
  // (IModelAsyncLoad::waitForLoadInitialization) runs on a worker thread.
  V("activate", qvac::ttsggml::addon_js::activate)

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

BARE_MODULE(qvac_tts_ggml, qvac_tts_ggml_exports)
// NOLINTEND(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
