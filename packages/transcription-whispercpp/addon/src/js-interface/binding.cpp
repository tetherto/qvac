#include <cstdlib>

#include <bare.h>

#include "src/addon/AddonJs.hpp"

namespace {
void atexitCleanup() {
  std::lock_guard lock(qvac_lib_inference_addon_whisper::g_streamingMtx);
  qvac_lib_inference_addon_whisper::g_streamingSessions.clear();
}
} // namespace

// NOLINTBEGIN(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
auto qvac_lib_inference_addon_whisper_exports(
    js_env_t* env,
    js_value_t* exports)
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

  V("createInstance", qvac_lib_inference_addon_whisper::createInstance)
  V("runJob", qvac_lib_inference_addon_whisper::runJob)
  V("reload", qvac_lib_inference_addon_whisper::reload)
  V("startStreaming", qvac_lib_inference_addon_whisper::startStreaming)
  V("appendStreamingAudio",
    qvac_lib_inference_addon_whisper::appendStreamingAudio)
  V("endStreaming", qvac_lib_inference_addon_whisper::endStreaming)
  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", qvac_lib_inference_addon_cpp::JsInterface::activate)
  V("cancel", qvac_lib_inference_addon_whisper::cancelWithStreaming)
  V("destroyInstance",
    qvac_lib_inference_addon_whisper::destroyInstanceWithStreaming)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)
#undef V

  return exports;
}

BARE_MODULE(
    qvac_lib_inference_addon_whisper, qvac_lib_inference_addon_whisper_exports)
// NOLINTEND(cppcoreguidelines-macro-usage,readability-function-cognitive-complexity,modernize-use-trailing-return-type,readability-identifier-naming)
