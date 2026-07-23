#pragma once

#include <any>
#include <memory>
#include <string>

#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/queue/OutputQueue.hpp>
#include <js.h>

#include "addon/LlmErrors.hpp"

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

/// Stateless helpers for pre-allocated JS streaming payloads, one per
/// sequence id. `type`/`id` are baked in at allocate time so the per-token
/// path only mutates `output`, avoiding per-token object/string creation.
///
/// Lifetime invariant: every admitted sequence fires `release()` exactly
/// once (via the scheduler's per-slot `onDone`, including cancel /
/// decode-error / teardown paths). All ops run on the JS thread; no locking.
class PayloadHandler {
public:
  /// Creates a payload object `{ type: TypeName, id }` and returns the
  /// underlying ref handle. `TypeName` is a `constexpr char[]` with
  /// static storage and external linkage (an `inline constexpr`
  /// variable). The returned `js_ref_t*` stays valid until exactly one
  /// matching `release()` call.
  template <const char* TypeName>
  static js_ref_t* allocate(js_env_t* env, const std::string& id) {
    js::Object payload = js::Object::create(env);
    payload.setProperty(env, "type", js::String::create(env, TypeName));
    payload.setProperty(env, "id", js::String::create(env, id));
    js_ref_t* handle = nullptr;
    if (js_create_reference(env, payload, 1, &handle) != 0 ||
        handle == nullptr) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "PayloadHandler: js_create_reference failed");
    }
    return handle;
  }

  /// Resolves a previously-allocated handle to its live JS object inside
  /// the current handle scope. Caller must own a JS handle scope.
  static js::Object resolve(js_env_t* env, js_ref_t* handle) {
    js_value_t* value = nullptr;
    if (js_get_reference_value(env, handle, &value) != 0 || value == nullptr) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InternalError,
          "PayloadHandler: js_get_reference_value failed");
    }
    return js::Object{env, value};
  }

  /// Drops the JS reference. Must be called exactly once per matching
  /// `allocate()`. Caller guarantees `env` and `handle` are non-null.
  static void release(js_env_t* env, js_ref_t* handle) {
    js_delete_reference(env, handle);
  }
};

/// One per-token streaming event, carrying the pre-allocated payload handle
/// instead of re-encoding `id` each call. `finished == true` is the done
/// signal; the JS handler then calls `PayloadHandler::release`.
struct BatchTokenOutput {
  js_ref_t* payloadHandle = nullptr;
  std::string output;
  bool finished = false;
};

} // namespace qvac_lib_inference_addon_llama
