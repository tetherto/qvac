#include <bare.h>
#include <js.h>

#include "inference-addon-cpp/JsUtils.hpp"

// Unified native binding for the on-device (iOS/Android) integration tests.
//
// The desktop integration suite lives in ../tests/integration_js/* as three
// standalone Bare addons. The mobile test harness (qvac-test-addon-mobile) is
// strictly one-addon-per-app, so the device port aggregates those bindings'
// native hooks into this single Bare module. Export names are kept identical to
// the originals so the ported JS tests read the same.
//
// Phase 1 ships the js-create-double hooks only; the logger hooks
// (setLogger/cppLog/... + test_logger.cpp) drop into the export block below in
// phase 2. See ../mobile/README.md.

namespace {

namespace js = qvac_lib_inference_addon_cpp::js;

// --- js-create-double-first-call -------------------------------------------

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

js_value_t* inferenceAddonCppMobileTestsExports(
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

BARE_MODULE(inference_addon_cpp_mobile_tests, inferenceAddonCppMobileTestsExports)
