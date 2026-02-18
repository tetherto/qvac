#pragma once

#include <js.h>

#include "IOnnxSession.hpp"

namespace onnx_addon {
namespace js {

/**
 * Helper function to unwrap IOnnxSession from JS external value.
 * This is a header-only inline function so other addons can use it
 * without needing to link against the ONNX addon.
 *
 * The virtual method dispatch on IOnnxSession* will work because
 * the vtable pointer is stored in the object created by the ONNX addon.
 */
inline IOnnxSession* unwrapSession(js_env_t* env, js_value_t* external) {
  void* data = nullptr;
  js_get_value_external(env, external, &data);
  return static_cast<IOnnxSession*>(data);
}

}  // namespace js
}  // namespace onnx_addon
