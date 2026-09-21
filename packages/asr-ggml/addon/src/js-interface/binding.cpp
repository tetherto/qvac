#include <cstdlib>

#include <bare.h>

#include "src/addon/AddonJs.hpp"
#include "src/addon/StreamingSessionRegistry.hpp"

namespace {
void atexitCleanup() {
  // Abortive teardown for every surviving streaming session (both engines):
  // cancel() bounds the worker join, then the sessions are destroyed.
  qvac::asrggml::clearAllStreamingSessions();
}
} // namespace

// NOLINTBEGIN(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
auto qvac_asr_ggml_exports(js_env_t* env, js_value_t* exports)
    -> js_value_t* { // NOLINT(readability-identifier-naming)

  static bool registered = false;
  if (!registered) {
    std::atexit(atexitCleanup);
    registered = true;
  }

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

  V("createInstance", qvac::asrggml::addon_js::createInstance)
  V("runJob", qvac::asrggml::addon_js::runJob)
  V("reload", qvac::asrggml::addon_js::reload)
  V("getBackendInfo", qvac::asrggml::addon_js::getBackendInfo)
  V("startStreaming", qvac::asrggml::addon_js::startStreaming)
  V("appendStreamingAudio", qvac::asrggml::addon_js::appendStreamingAudio)
  V("endStreaming", qvac::asrggml::addon_js::endStreaming)
  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", qvac_lib_inference_addon_cpp::JsInterface::activate)
  V("cancel", qvac::asrggml::addon_js::cancelWithStreaming)
  V("destroyInstance", qvac::asrggml::addon_js::destroyInstanceWithStreaming)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)
#undef V

  return exports;
}

BARE_MODULE(qvac_asr_ggml, qvac_asr_ggml_exports)
// NOLINTEND(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
