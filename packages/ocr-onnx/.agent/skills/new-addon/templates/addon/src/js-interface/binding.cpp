#include <bare.h>

#include "../addon/AddonJs.hpp"

js_value_t*
{{EXPORT_FN_NAME}}(js_env_t* env, js_value_t* exports) {

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

  V("sayHello", {{CPP_NAMESPACE}}::sayHello)

  V("createInstance", {{CPP_NAMESPACE}}::createInstance)
  V("runJob", {{CPP_NAMESPACE}}::runJob)

  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", qvac_lib_inference_addon_cpp::JsInterface::activate)
  V("cancel", qvac_lib_inference_addon_cpp::JsInterface::cancel)
  V("destroyInstance",
    qvac_lib_inference_addon_cpp::JsInterface::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)
#undef V
// NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE("{{PACKAGE_NAME}}", {{EXPORT_FN_NAME}})
