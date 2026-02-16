#include <bare.h>
#include <js.h>

#include "JsOnnxSession.hpp"

js_value_t* onnxAddonExports(js_env_t* env, js_value_t* exports) {
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define V(name, fn)                                              \
  {                                                              \
    js_value_t* val;                                             \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) { \
      return nullptr;                                            \
    }                                                            \
    if (js_set_named_property(env, exports, name, val) != 0) {   \
      return nullptr;                                            \
    }                                                            \
  }

  V("createSession", onnx_addon::js::createSession)
  V("destroySession", onnx_addon::js::destroySession)
  V("getInputInfo", onnx_addon::js::getInputInfo)
  V("getOutputInfo", onnx_addon::js::getOutputInfo)
  V("run", onnx_addon::js::run)
  V("getCacheStats", onnx_addon::js::getCacheStats)

#undef V
// NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE(onnx_addon, onnxAddonExports)
