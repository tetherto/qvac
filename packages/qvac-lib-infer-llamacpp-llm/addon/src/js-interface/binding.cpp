#include <bare.h>

#include "../addon/AddonJs.hpp"

// NOLINTBEGIN(readability-identifier-naming)

js_value_t*
qvac_lib_inference_addon_llama_exports(js_env_t* env, js_value_t* exports) {

// NOLINTNEXTLINE(cppcoreguidelines-macro-usage)
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

  V("createInstance", qvac_lib_inference_addon_llama::createInstance)
  V("runJob", qvac_lib_inference_addon_llama::runJob)

  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", qvac_lib_inference_addon_llama::activate)
  V("cancel", qvac_lib_inference_addon_llama::cancel)
  V("finetune", qvac_lib_inference_addon_llama::finetune)
  V("destroyInstance",
    qvac_lib_inference_addon_cpp::JsInterface::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)

#undef V
  return exports;
}

BARE_MODULE(
    qvac_lib_inference_addon_llama, qvac_lib_inference_addon_llama_exports)

// NOLINTEND(readability-identifier-naming)
