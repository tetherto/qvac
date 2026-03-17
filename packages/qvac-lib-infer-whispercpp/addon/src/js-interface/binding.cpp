#include <cstdlib>

#include <bare.h>

#include "src/addon/AddonJs.hpp"

namespace {
js_value_t* forceExit(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* argv[1];
  js_get_callback_info(env, info, &argc, argv, nullptr, nullptr);
  int32_t code = 0;
  if (argc > 0) {
    js_get_value_int32(env, argv[0], &code);
  }
  _Exit(code);
}
} // namespace

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
  V("runJob", qvac_lib_inference_addon_whisper::runJob)
  V("reload", qvac_lib_inference_addon_whisper::reload)
  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", qvac_lib_inference_addon_cpp::JsInterface::activate)
  V("cancel", qvac_lib_inference_addon_cpp::JsInterface::cancel)
  V("destroyInstance",
    qvac_lib_inference_addon_cpp::JsInterface::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)
  V("forceExit", forceExit)
#undef V

  return exports;
}

BARE_MODULE(
    qvac_lib_inference_addon_whisper, qvac_lib_inference_addon_whisper_exports)
// NOLINTEND(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
