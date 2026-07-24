#include <bare.h>
#include <js.h>

#include "inference-addon-cpp/JsUtils.hpp"
#include "test_logger.hpp"

// Unified native binding for the on-device (iOS/Android) integration tests.
//
// The desktop integration suite lives in ../tests/integration_js/* as three
// standalone Bare addons. The mobile test harness (qvac-test-addon-mobile) is
// strictly one-addon-per-app, so the device port aggregates those bindings'
// native hooks into this single Bare module. Export names are kept identical to
// the originals so the ported JS tests read the same.
//
// MANUAL PORT — KEEP IN SYNC. The hooks below are hand-copied from
// tests/integration_js/*/binding.cpp (phase 1: js-create-double-first-call).
// There is no automated check tying them to the desktop originals yet, so if a
// desktop binding's signature/behaviour changes, update the copy here too or
// the on-device test silently stops matching what desktop asserts. An automated
// normalized drift-check in scripts/validate-mobile-tests.js is tracked for the
// phase-2 port (when several bindings aggregate). See README.md.
//
// Phase 1: js-create-double hooks. Phase 2: the logger hooks
// (setLogger/cppLog/... implemented in test_logger.cpp, JS_LOGGER-gated). The
// output-callback-lifetime UAF stress test stays desktop-Linux-x64-ASan-only —
// no signal without ASan, which is unavailable on device. See README.md.

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

  // js-create-double-first-call
  V("createDouble", createDouble)
  V("createInt32", createInt32)

  // logger (implemented in test_logger.cpp; native std::thread only — no
  // bare-thread — so the on-device bridge test is portable)
  V("setLogger", test_logger::setLogger)
  V("cppLog", test_logger::cppLog)
  V("dummyCppLogWork", test_logger::dummyCppLogWork)
  V("dummyMultiThreadedCppLogWork", test_logger::dummyMultiThreadedCppLogWork)
  V("releaseLogger", test_logger::releaseLogger)
#undef V

  return moduleExports;
}

} // namespace

BARE_MODULE(inference_addon_cpp_mobile_tests, inferenceAddonCppMobileTestsExports)
