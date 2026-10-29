#include <bare.h>
#include <qvac-addon/fabric-bind.h>

#include "addon/AddonJs.hpp"

// NOLINTNEXTLINE(readability-identifier-naming)
js_value_t* classification_ggml_exports(js_env_t* env, js_value_t* exports) {
  if (!qvacAddonBindFabric()) {
    js_throw_error(env, nullptr, "failed to bind " QVAC_FABRIC_MODULE_NAME);
    return nullptr;
  }

// NOLINTBEGIN(cppcoreguidelines-macro-usage)
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

  V("createInstance", classification_ggml::bindings::createInstance)
  V("runJob", classification_ggml::bindings::runJob)

  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", classification_ggml::bindings::activate)
  V("cancel", qvac_lib_inference_addon_cpp::JsInterface::cancel)
  V("destroyInstance",
    qvac_lib_inference_addon_cpp::JsInterface::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)

#undef V
  // NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE(classification_ggml, classification_ggml_exports)
