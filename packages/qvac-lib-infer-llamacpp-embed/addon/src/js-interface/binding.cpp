#include <bare.h>

#include "../addon/AddonJs.hpp"
#include "../model-interface/LlamaLazyInitializeBackend.hpp"

// Explicitly unload all dynamically-loaded GPU backend libraries and free
// the llama backend. Called from JS at process exit (Bare 'exit' event)
// before the runtime dlclose's this addon, ensuring backend destructors
// run while ggml state is still alive.
static js_value_t*
shutdownBackends(js_env_t* /*env*/, js_callback_info_t* /*info*/) {
  LlamaLazyInitializeBackend::shutdownBackends();
  return nullptr;
}

js_value_t*
qvacLibInferLlamacppEmbedExports(js_env_t* env, js_value_t* exports) {

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

  V("createInstance", qvac_lib_inference_addon_embed::createInstance)
  V("runJob", qvac_lib_inference_addon_embed::runJob)

  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", qvac_lib_inference_addon_cpp::JsInterface::activate)
  V("cancel", qvac_lib_inference_addon_cpp::JsInterface::cancel)
  V("destroyInstance",
    qvac_lib_inference_addon_cpp::JsInterface::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)
  V("shutdownBackends", shutdownBackends)
#undef V
// NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE("qvac-lib-infer-llamacpp-embed", qvacLibInferLlamacppEmbedExports)
