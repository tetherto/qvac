#include <bare.h>
#include <inference-addon-cpp/JsInterface.hpp>

#include "../addon/AddonJs.hpp"

js_value_t* qvacLibInferVlaExports(js_env_t* env, js_value_t* exports) {

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

  // Canonical surface — same shape as the LLM / embed / NMT addons. The
  // model lifecycle (createInstance / loadWeights / activate / cancel /
  // destroyInstance) and dispatch (runJob) are handled by the framework's
  // JsInterface; outputs flow back through OutputCallBackJs.
  V("createInstance", qvac_lib_infer_vla_ggml::createInstance)
  V("runJob", qvac_lib_infer_vla_ggml::runJob)
  V("loadWeights", qvac_lib_inference_addon_cpp::JsInterface::loadWeights)
  V("activate", qvac_lib_inference_addon_cpp::JsInterface::activate)
  V("cancel", qvac_lib_inference_addon_cpp::JsInterface::cancel)
  V("destroyInstance",
    qvac_lib_inference_addon_cpp::JsInterface::destroyInstance)
  V("setLogger", qvac_lib_inference_addon_cpp::JsInterface::setLogger)
  V("releaseLogger", qvac_lib_inference_addon_cpp::JsInterface::releaseLogger)

  // VLA-specific accessors. RuntimeStats covers the numeric `backendDevice`
  // (0/1) but the perf reporter wants the human-readable backend name; the
  // hparams object is needed JS-side for input validation.
  V("getVlaHparams", qvac_lib_infer_vla_ggml::getVlaHparams)
  V("getVlaBackendName", qvac_lib_infer_vla_ggml::getVlaBackendName)
  V("setVerbosity", qvac_lib_infer_vla_ggml::setVerbosity)
#undef V
  // NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE("qvac-lib-infer-vla", qvacLibInferVlaExports)
