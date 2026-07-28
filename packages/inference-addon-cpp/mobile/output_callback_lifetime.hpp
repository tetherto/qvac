#pragma once

// GENERATED-BY-HAND PORT — KEEP IN SYNC with
// ../tests/integration_js/output-callback-lifetime/binding.cpp.
//
// The desktop binding implements these in an anonymous namespace and registers
// its own BARE_MODULE. Here the implementations live in a named namespace so the
// unified mobile binding can aggregate them alongside the other sub-packages'
// hooks. `destroyInstance` is not re-declared: the desktop binding exports
// qvac_lib_inference_addon_cpp::JsInterface::destroyInstance directly, and the
// unified binding does the same.

#include <js.h>

namespace output_callback_lifetime {

js_value_t* createInstance(js_env_t* env, js_callback_info_t* info);
js_value_t* createMultiInstance(js_env_t* env, js_callback_info_t* info);
js_value_t* runJob(js_env_t* env, js_callback_info_t* info);
js_value_t* cancelJob(js_env_t* env, js_callback_info_t* info);
js_value_t* onJsThread(js_env_t* env, js_callback_info_t* info);
js_value_t* blockEventLoop(js_env_t* env, js_callback_info_t* info);

// Records the module-init thread id so onJsThread() can report whether a call
// arrived on the JS thread. Called once from the unified module's exports fn.
void recordModuleInitThread();

} // namespace output_callback_lifetime
