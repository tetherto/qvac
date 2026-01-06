// Mocked js.h interface, un-implemented, mainly useful for testing
// metaprogamming compilation/instantiation

#pragma once

#include <cstddef>
#include <cstdint>
#include <stdexcept>

// Forward declarations for opaque types
struct js_env_t {};
struct js_value_t {};
struct js_ref_t {};
struct js_callback_info_t {};
struct js_handle_scope_t {};
struct uv_async_t {};
struct uv_handle_t {};
struct uv_loop_t {};

// js_loop_t is an alias for uv_loop_t in the real implementation
typedef uv_loop_t js_loop_t;

struct js_threadsafe_function_t {};

// Type definitions
typedef char utf8_t;
typedef char16_t utf16_t;

// Value type enumeration
typedef enum {
  js_undefined,
  js_null,
  js_boolean,
  js_number,
  js_string,
  js_symbol,
  js_object,
  js_function,
  js_external,
  js_bigint
} js_value_type_t;

// Mock implementations that throw runtime errors
inline void
js_throw_error(js_env_t* env, const char* code, const char* message) {
  throw std::runtime_error("js_throw_error: Mock implementation called");
}

inline int
js_typeof(js_env_t* env, js_value_t* value, js_value_type_t* result) {
  return -1;
}

// Type checking functions
inline int js_is_undefined(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_null(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_boolean(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_string(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_number(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_int32(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_uint32(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_bigint(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_object(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_external(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_function(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_typedarray(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_int8array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_uint8array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_int16array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_uint16array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_int32array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_uint32array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_float32array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_float64array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_is_bigint64array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int
js_is_biguint64array(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

// TypedArray type enumeration (moved before usage)
typedef enum {
  js_int8array = 0,
  js_uint8array = 1,
  js_uint8clampedarray = 2,
  js_int16array = 3,
  js_uint16array = 4,
  js_int32array = 5,
  js_uint32array = 6,
  js_float16array = 11,
  js_float32array = 7,
  js_float64array = 8,
  js_bigint64array = 9,
  js_biguint64array = 10,
} js_typedarray_type_t;

// Value creation functions
inline int js_get_undefined(js_env_t* env, js_value_t** result) { return -1; }

inline int js_create_string_utf8(
    js_env_t* env, const utf8_t* data, size_t length, js_value_t** result) {
  return 0;
}

inline int js_create_string_utf16le(
    js_env_t* env, const utf16_t* data, size_t length, js_value_t** result) {
  return 0;
}

inline int js_create_double(js_env_t* env, double value, js_value_t** result) {
  return 0;
}

inline int js_create_int32(js_env_t* env, int32_t value, js_value_t** result) {
  return 0;
}

inline int
js_create_uint32(js_env_t* env, uint32_t value, js_value_t** result) {
  return 0;
}

inline int js_create_int64(js_env_t* env, int64_t value, js_value_t** result) {
  return 0;
}

inline int
js_create_bigint_int64(js_env_t* env, int64_t value, js_value_t** result) {
  return 0;
}

inline int
js_create_bigint_uint64(js_env_t* env, uint64_t value, js_value_t** result) {
  return 0;
}

inline int js_create_object(js_env_t* env, js_value_t** result) { return 0; }

inline int js_create_array(js_env_t* env, js_value_t** result) { return 0; }

inline int
js_create_array_with_length(js_env_t* env, size_t length, js_value_t** result) {
  return 0;
}

inline int js_create_external(
    js_env_t* env, void* data,
    void (*finalize_cb)(js_env_t* env, void* data, void* hint),
    void* finalize_hint, js_value_t** result) {
  return 0;
}

// Value access functions
inline int js_get_value_bool(js_env_t* env, js_value_t* value, bool* result) {
  return -1;
}

inline int js_get_value_string_utf8(
    js_env_t* env, js_value_t* value, utf8_t* buf, size_t bufsize,
    size_t* result) {
  return -1;
}

inline int js_get_value_string_utf16le(
    js_env_t* env, js_value_t* value, utf16_t* buf, size_t bufsize,
    size_t* result) {
  return -1;
}

inline int
js_get_value_double(js_env_t* env, js_value_t* value, double* result) {
  return -1;
}

inline int
js_get_value_int32(js_env_t* env, js_value_t* value, int32_t* result) {
  return -1;
}

inline int
js_get_value_uint32(js_env_t* env, js_value_t* value, uint32_t* result) {
  return -1;
}

inline int
js_get_value_int64(js_env_t* env, js_value_t* value, int64_t* result) {
  return -1;
}

inline int js_get_value_bigint_int64(
    js_env_t* env, js_value_t* value, int64_t* result, bool* lossless) {
  return -1;
}

inline int js_get_value_bigint_uint64(
    js_env_t* env, js_value_t* value, uint64_t* result, bool* lossless) {
  return -1;
}

inline int
js_get_value_external(js_env_t* env, js_value_t* value, void** result) {
  return -1;
}

// Object property functions
inline int js_set_named_property(
    js_env_t* env, js_value_t* object, const char* utf8name,
    js_value_t* value) {
  return -1;
}

inline int js_get_named_property(
    js_env_t* env, js_value_t* object, const char* utf8name,
    js_value_t** result) {
  return -1;
}

inline int js_get_property(
    js_env_t* env, js_value_t* object, js_value_t* key, js_value_t** result) {
  return -1;
}

inline int
js_get_property_names(js_env_t* env, js_value_t* object, js_value_t** result) {
  return -1;
}

// Array functions
inline int
js_get_array_length(js_env_t* env, js_value_t* value, uint32_t* result) {
  return -1;
}

inline int js_has_element(
    js_env_t* env, js_value_t* object, uint32_t index, bool* result) {
  return -1;
}

inline int js_get_element(
    js_env_t* env, js_value_t* object, uint32_t index, js_value_t** result) {
  return -1;
}

inline int js_set_array_elements(
    js_env_t* env, js_value_t* object, const js_value_t** values, size_t count,
    size_t offset) {
  return -1;
}

inline int js_set_element(
    js_env_t* env, js_value_t* object, uint32_t index, js_value_t* value) {
  return -1;
}

inline int js_delete_element(
    js_env_t* env, js_value_t* object, uint32_t index, bool* result) {
  return -1;
}

inline int js_get_array_elements(
    js_env_t* env, js_value_t* value, js_value_t** elements, size_t count,
    size_t offset, size_t* result) {
  return -1;
}

// TypedArray functions
inline int js_get_typedarray_info(
    js_env_t* env, js_value_t* typedarray, js_typedarray_type_t* type,
    void** data, size_t* length, js_value_t** arraybuffer,
    size_t* byte_offset) {
  return -1;
}

inline int js_create_arraybuffer(
    js_env_t* env, size_t byte_length, void** data, js_value_t** result) {
  return 0;
}

inline int js_create_typedarray(
    js_env_t* env, js_typedarray_type_t type, size_t length,
    js_value_t* arraybuffer, size_t byte_offset, js_value_t** result) {
  return 0;
}

// Callback functions
inline int js_get_callback_info(
    js_env_t* env, js_callback_info_t* cbinfo, size_t* argc, js_value_t** argv,
    js_value_t** this_arg, void** data) {
  return -1;
}

// Reference functions
inline int js_create_reference(
    js_env_t* env, js_value_t* value, uint32_t initial_refcount,
    js_ref_t** result) {
  return 0;
}

inline int js_delete_reference(js_env_t* env, js_ref_t* ref) { return -1; }

inline int
js_get_reference_value(js_env_t* env, js_ref_t* ref, js_value_t** result) {
  return -1;
}

// Handle scope functions
inline int js_open_handle_scope(js_env_t* env, js_handle_scope_t** result) {
  return -1;
}

inline int js_close_handle_scope(js_env_t* env, js_handle_scope_t* scope) {
  return -1;
}

// Global and function call functions
inline int js_get_global(js_env_t* env, js_value_t** result) { return -1; }

inline int js_call_function(
    js_env_t* env, js_value_t* recv, js_value_t* func, size_t argc,
    js_value_t* argv[], js_value_t** result) {
  return -1;
}

// Loop functions
inline int js_get_env_loop(js_env_t* env, js_loop_t** result) { return -1; }

inline int js_get_null(js_env_t* env, js_value_t** result) { return -1; }

inline int js_get_boolean(js_env_t* env, bool value, js_value_t** result) {
  return -1;
}

// Additional functions needed for OutputCallbackJs
inline int js_is_exception_pending(js_env_t* env, bool* result) { return -1; }

inline int js_get_and_clear_last_exception(js_env_t* env, js_value_t** result) {
  return -1;
}

// UV/libuv functions (minimal stubs for compilation)
inline int
uv_async_init(uv_loop_t* loop, uv_async_t* handle, void (*cb)(uv_async_t*)) {
  return 0;
}

inline int uv_async_send(uv_async_t* handle) { return 0; }

inline void* uv_handle_get_data(uv_handle_t* handle) { return nullptr; }

inline void uv_handle_set_data(uv_handle_t* handle, void* data) {}

inline void uv_close(uv_handle_t* handle, void (*cb)(uv_handle_t*)) {}
