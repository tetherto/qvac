#include <js.h>
#include <bare.h>
#include "qvac-lib-infer-onnx-vad.hpp"

auto qvac_lib_inference_addon_onnx_silerovad_exports(js_env_t* env, js_value_t* exports) -> js_value_t* {

// NOLINTBEGIN(cppcoreguidelines-macro-usage, modernize-use-trailing-return-type)
#define V(name, fn) \
  { \
    js_value_t *val; \
    if ( js_create_function(env, name, -1, fn, nullptr, &val) != 0) { \
      return nullptr; \
    } \
    if ( js_set_named_property(env, exports, name, val) != 0) { \
      return nullptr; \
    } \
  }

  V("createInstance", qvac_lib_inference_addon_onnx_silerovad::createInstance)
  V("activate", qvac_lib_inference_addon_onnx_silerovad::activate)
  V("append", qvac_lib_inference_addon_onnx_silerovad::append)
  V("status", qvac_lib_inference_addon_onnx_silerovad::status)
  V("pause", qvac_lib_inference_addon_onnx_silerovad::pause)
  V("stop", qvac_lib_inference_addon_onnx_silerovad::stop)
  V("cancel", qvac_lib_inference_addon_onnx_silerovad::cancel)
  V("destroyInstance", qvac_lib_inference_addon_onnx_silerovad::destroyInstance)
#undef V

  return exports;
}

BARE_MODULE(qvac_lib_inference_addon_onnx_silerovad, qvac_lib_inference_addon_onnx_silerovad_exports)
// NOLINTEND(cppcoreguidelines-macro-usage, modernize-use-trailing-return-type)

