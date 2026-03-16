#include <cstdlib>

#include <bare.h>

#include "../addon/AddonJs.hpp"

// Immediately terminate the process, skipping static destructors and atexit
// handlers. Dynamically-loaded GPU backend libraries (Vulkan, Metal, etc.)
// register static destructors that SIGSEGV during normal exit when they
// reference the partially-destroyed ggml backend registry. Calling _Exit()
// from JS (before the runtime dlclose's this addon) avoids the crash.
// The OS reclaims all process resources.
static js_value_t* forceExit(js_env_t* env, js_callback_info_t* info) {
  int32_t code = 0;
  size_t argc = 1;
  js_value_t* argv[1];
  if (js_get_callback_info(env, info, &argc, argv, nullptr, nullptr) == 0 &&
      argc > 0) {
    js_get_value_int32(env, argv[0], &code);
  }
  _Exit(code);
  return nullptr; // unreachable
}

js_value_t*
qvacLibInferenceAddonLlamaExports(js_env_t* env, js_value_t* exports) {

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

BARE_MODULE(qvac_lib_inference_addon_llama, qvacLibInferenceAddonLlamaExports)
