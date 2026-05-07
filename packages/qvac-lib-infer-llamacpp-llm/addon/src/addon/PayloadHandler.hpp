#pragma once

#include <any>
#include <memory>
#include <string>

#include <js.h>

#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputQueue.hpp>

#include "addon/LlmErrors.hpp"

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

/// Stateless helpers for pre-allocated JS streaming payloads, one per
/// sequence id.
///
/// Each entry carries the constant `type` and `id` properties baked in
/// at allocation time; the per-token streaming path only mutates
/// `output` and returns the same JS object every time, eliminating the
/// per-token `js_create_object` + `type`/`id` `js_create_string_utf8`
/// round-trips.
///
/// Operations work directly on the raw `js_ref_t*` handle threaded
/// through the streaming closure into the consumer event struct, so the
/// hot path is a single `js_get_reference_value` per token with zero
/// container bookkeeping.
///
/// Lifetime is governed by the streaming protocol invariant that every
/// admitted sequence fires `release()` exactly once (e.g. via the
/// scheduler's per-slot `onDone` callback under
/// `ContinuousBatchScheduler`, including its cancel / decode-error /
/// scheduler-teardown paths).
///
/// All operations run on the JS thread, so no locking is required.
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
    if (js_create_reference(env, payload, 1, &handle) != 0 || handle == nullptr) {
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

/// One per-token streaming event. Carries the pre-allocated payload
/// handle (resolved by `PayloadHandler::resolve`) instead of re-encoding
/// the `id` on every call. `finished == true` is the explicit done
/// signal driven by the scheduler's per-slot `onDone` callback; the JS
/// handler then drops the corresponding payload via
/// `PayloadHandler::release`.
struct BatchTokenOutput {
  js_ref_t* payloadHandle = nullptr;
  std::string output;
  bool finished = false;
};

} // namespace qvac_lib_inference_addon_llama
