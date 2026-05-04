#include <bare.h>
#include <js.h>

#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"

namespace {

namespace js = qvac_lib_inference_addon_cpp::js;

js_value_t* createDouble(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* args[1];
  if (js_get_callback_info(env, info, &argc, args, nullptr, nullptr) != 0) {
    return nullptr;
  }

  double value = 0;
  if (argc >= 1 && js_get_value_double(env, args[0], &value) != 0) {
    return nullptr;
  }

  return js::Number::create(env, value);
}

js_value_t* createInt32(js_env_t* env, js_callback_info_t* info) {
  size_t argc = 1;
  js_value_t* args[1];
  if (js_get_callback_info(env, info, &argc, args, nullptr, nullptr) != 0) {
    return nullptr;
  }

  int32_t value = 0;
  if (argc >= 1 && js_get_value_int32(env, args[0], &value) != 0) {
    return nullptr;
  }

  js_value_t* result;
  if (js_create_int32(env, value, &result) != 0) {
    return nullptr;
  }
  return result;
}

js_value_t* jsCreateDoubleFirstCallExports(
    js_env_t* env,
    js_value_t* moduleExports) {
#define V(name, fn)                                                            \
  {                                                                            \
    js_value_t* val;                                                           \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {           \
      return nullptr;                                                          \
    }                                                                          \
    if (js_set_named_property(env, moduleExports, name, val) != 0) {           \
      return nullptr;                                                          \
    }                                                                          \
  }

  V("createDouble", createDouble)
  V("createInt32", createInt32)
#undef V

  return moduleExports;
}

} // namespace

BARE_MODULE(test_js_create_double_first_call, jsCreateDoubleFirstCallExports)
