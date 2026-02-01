#pragma once

#include <cstdint>
#include <cstring>
#include <mutex>
#include <optional>
#include <span>
#include <stdexcept>
#include <type_traits>
#include <vector>

#include <js.h>

#ifndef NDEBUG
#include <cassert>
#include <thread>
#endif

#include "Errors.hpp"

static_assert(std::is_same_v<utf8_t, char> || std::is_same_v<utf8_t, unsigned char>,
  "This library requires utf8_t to be implemented as char or unsigned char.");

static_assert(sizeof(std::uintptr_t) == 8,
 "This library requires uintptr_t to be implemented with 64 bits.");

#define JSCATCH  catch(const qvac_errors::StatusError& e) { \
  if (!e.isJSError()) js_throw_error(env, e.codeString().c_str(), e.what()); \
  return nullptr; \
} catch(const std::exception& e) { \
  js_throw_error(env, "INTERNAL_ERROR", e.what()); \
  return nullptr; \
} catch(...) { \
  js_throw_error(env, "INTERNAL_ERROR", "Unknown error"); \
  return nullptr; \
}

#define JS( jscall ) if ( jscall != 0 ) throw qvac_errors::StatusError(qvac_errors::general_error::JSLibraryError, "");

namespace qvac_lib_inference_addon_cpp::js {

constexpr std::string_view typeName(js_value_type_t type) {
  switch (type) {
    case js_undefined: return "undefined";
    case js_null: return "null";
    case js_boolean: return "boolean";
    case js_number: return "number";
    case js_string: return "string";
    case js_symbol: return "symbol";
    case js_object: return "object";
    case js_function: return "function";
    case js_external: return "external";
    case js_bigint: return "bigint";
  }
  throw std::logic_error{"invalid js_value_type_t value"};
}

inline js_value_type_t typeOf(js_env_t* env, js_value_t* value) {
  js_value_type_t result;
  JS(js_typeof(env, value, &result));
  return result;
}

template <typename JsType>
bool is(js_env_t* env, js_value_t* value);

struct Undefined;
struct Null;
struct Boolean;
struct String;
struct Number;
struct BigInt;
struct Object;
struct Array;
struct External;
struct Function;

template <typename SubType>
struct TypedArray;

struct Int32;
struct Uint32;

struct TypedArrayT;

template <typename JsType>
bool is(js_env_t* env, js_value_t* value) {
  bool result;
  if constexpr (std::is_same_v<JsType, Undefined>) { JS(js_is_undefined(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, Null>) { JS(js_is_null(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, Boolean>) { JS(js_is_boolean(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, String>) { JS(js_is_string(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, Number>) { JS(js_is_number(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, Int32>) { JS(js_is_int32(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, Uint32>) { JS(js_is_uint32(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, BigInt>) { JS(js_is_bigint(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, Object>) { JS(js_is_object(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, Array>) { JS(js_is_array(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, External>) { JS(js_is_external(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, Function>) { JS(js_is_function(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArrayT>) { JS(js_is_typedarray(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArray<int8_t>>) { JS(js_is_int8array(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArray<uint8_t>>) { JS(js_is_uint8array(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArray<int16_t>>) { JS(js_is_int16array(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArray<uint16_t>>) { JS(js_is_uint16array(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArray<int32_t>>) { JS(js_is_int32array(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArray<uint32_t>>) { JS(js_is_uint32array(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArray<float>>) { JS(js_is_float32array(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArray<double>>) { JS(js_is_float64array(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArray<int64_t>>) { JS(js_is_bigint64array(env, value, &result)); }
  else if constexpr (std::is_same_v<JsType, TypedArray<uint64_t>>) { JS(js_is_biguint64array(env, value, &result)); }
  else {
    static_assert(sizeof(JsType)==0, "Invalid js type");
  }
  return result;
}

template <typename JsType>
bool is(JsType value) {
  return value.template is<JsType>();
}

template <typename CppType, typename JsType>
auto as(js_env_t* env, JsType value) {
  return value.template as<CppType>(env);
}

template <typename JsType>
struct Value {

  static JsType create(js_env_t* env) {
    js_value_t* result;
    JS(JsType::create_(env, &result));
    return JsType{result};
  }

  template <typename CppType>
  static JsType create(js_env_t* env, CppType value) {
    js_value_t* result;
    JS(JsType::create_(env, value, &result));
    return JsType{result};
  }

  static JsType fromValue(js_value_t* value) {
    return JsType{value};
  }

  operator js_value_t*() const { return value_; }

  template <typename OtherType>
  constexpr bool is() const {
    if constexpr (std::is_same_v<JsType, OtherType>)
      return true;
    else
      return false;
  }

  template <typename CppType>
  CppType as(js_env_t* env) {
    CppType result;
    JS(JsType::as_(env, value_, &result));
    return result;
  }

protected:
  js_value_t* value_;

  explicit Value(js_value_t* value) : value_{value} {}

  Value(js_env_t* env, js_value_t* value) : value_{value} {
    if (!js::is<JsType>(env, value)) {
      throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, std::string{"Value is not "}.append(JsType::typeName()).data());
    }
  }

};

struct Undefined : Value<Undefined> {
  friend struct Value<Undefined>;
  Undefined(js_env_t* env, js_value_t* value) : Value<Undefined>{env, value} {}

  static constexpr std::string_view typeName() { return js::typeName(js_undefined); }

protected:
  explicit Undefined(js_value_t* value) : Value<Undefined>{value} {}

  static int create_(js_env_t* env, js_value_t** result) {
    return js_get_undefined(env, result);
  }
};

struct Null : Value<Null> {
  friend struct Value<Null>;
  Null(js_env_t* env, js_value_t* value) : Value<Null>{env, value} {}

  static constexpr std::string_view typeName() { return js::typeName(js_null); }

protected:
  explicit Null(js_value_t* value) : Value<Null>{value} {}

  static int create_(js_env_t* env, js_value_t** result) {
    return js_get_null(env, result);
  }
};

struct Boolean : Value<Boolean> {
  friend struct Value<Boolean>;
  Boolean(js_env_t* env, js_value_t* value) : Value<Boolean>{env, value} {}

  static constexpr std::string_view typeName() { return js::typeName(js_boolean); }

protected:
  explicit Boolean(js_value_t* value) : Value<Boolean>{value} {}

  static int create_(js_env_t* env, bool value, js_value_t** result) {
    return js_get_boolean(env, value, result);
  }

  static int as_(js_env_t* env, js_value_t* value, bool* result) {
    return js_get_value_bool(env, value, result);
  }

};

struct String : Value<String> {
  friend struct Value<String>;
  String(js_env_t* env, js_value_t* value) : Value<String>{env, value} {}

  static constexpr std::string_view typeName() { return js::typeName(js_string); }

  template <typename CppType>
  CppType as(js_env_t* env) {
    if constexpr (std::is_same_v<CppType, std::string>) {
      size_t length;
      JS(js_get_value_string_utf8(env, value_, nullptr, 0, &length));
      std::string result(length, '\0');
      JS(js_get_value_string_utf8(env, value_, (utf8_t*)result.data(), length, nullptr));
      return result;
    } else if constexpr (std::is_same_v<CppType, std::u16string>) {
      size_t length;
      JS(js_get_value_string_utf16le(env, value_, nullptr, 0, &length));
      std::u16string result(length, '\0');
      JS(js_get_value_string_utf16le(env, value_, (utf16_t*)result.data(), length, nullptr));
      return result;
    } else {
      static_assert(std::is_same_v<CppType, std::string> || std::is_same_v<CppType, std::u16string>,
                    "Unsupported string type");
    }
  }

protected:
  explicit String(js_value_t* value) : Value<String>{value} {}

  static int create_(js_env_t* env, std::string_view value, js_value_t** result) {
    return js_create_string_utf8(env, (const utf8_t*)value.data(), value.size(), result);
  }
  static int create_(js_env_t* env, std::u16string_view value, js_value_t** result) {
    return js_create_string_utf16le(env, (const utf16_t*)value.data(), value.size(), result);
  }

};

struct Number : Value<Number> {
  friend struct Value<Number>;
  Number(js_env_t* env, js_value_t* value) : Value<Number>{env, value} {}

  static constexpr std::string_view typeName() { return js::typeName(js_number); }

  using Value<Number>::as;

  template <typename CppType>
  CppType as(js_env_t* env, bool& lossless) {
    CppType result;
    JS(this->as_(env, value_, &result, &lossless));
    return result;
  };

protected:
  explicit Number(js_value_t* value) : Value<Number>{value} {}

  static int create_(js_env_t* env, double value, js_value_t** result) {
    return js_create_double(env, value, result);
  }
  static int create_(js_env_t* env, int32_t value, js_value_t** result) {
    return js_create_int32(env, value, result);
  }
  static int create_(js_env_t* env, uint32_t value, js_value_t** result) {
    return js_create_uint32(env, value, result);
  }
  static int create_(js_env_t* env, int64_t value, js_value_t** result) {
    return js_create_int64(env, value, result);
  }
  static int create_(js_env_t* env, uint64_t value, js_value_t** result) {
    return js_create_double(env, static_cast<double>(value), result);
  }

  static int as_(js_env_t* env, js_value_t* value, double* result) {
    return js_get_value_double(env, value, result);
  }
  static int as_(js_env_t* env, js_value_t* value, int32_t* result) {
    return js_get_value_int32(env, value, result);
  }
  static int as_(js_env_t* env, js_value_t* value, uint32_t* result) {
    return js_get_value_uint32(env, value, result);
  }
  static int as_(js_env_t* env, js_value_t* value, int64_t* result) {
    return js_get_value_int64(env, value, result);
  }
  static int as_(js_env_t* env, js_value_t* value, uint64_t* result) {
    double underlying{};
    auto ret = js_get_value_double(env, value, &underlying);
    if (ret == 0) {
      *result = static_cast<uint64_t>(underlying);
    }
    return ret;
  }

  static int as_(js_env_t* env, js_value_t* value, int64_t* result, bool& lossless) {
    return js_get_value_bigint_int64(env, value, result, &lossless);
  }
  static int as_(js_env_t* env, js_value_t* value, uint64_t* result, bool& lossless) {
    return js_get_value_bigint_uint64(env, value, result, &lossless);
  }
};

struct BigInt : Value<BigInt> {
  friend struct Value<BigInt>;
  BigInt(js_env_t* env, js_value_t* value) : Value<BigInt>{env, value} {}

  static constexpr std::string_view typeName() { return js::typeName(js_bigint); }

protected:
  explicit BigInt(js_value_t* value) : Value<BigInt>{value} {}

  static BigInt create_(js_env_t* env, int64_t value) {
    js_value_t* result;
    JS(js_create_bigint_int64(env, value, &result));
    return BigInt{result};
  }
  static BigInt create_(js_env_t* env, uint64_t value) {
    js_value_t* result;
    JS(js_create_bigint_uint64(env, value, &result));
    return BigInt{result};
  }

  static int as_(js_env_t* env, js_value_t* value, int64_t* result) {
    return js_get_value_bigint_int64(env, value, result, nullptr);
  }
  static int as_(js_env_t* env, js_value_t* value, uint64_t* result) {
    return js_get_value_bigint_uint64(env, value, result, nullptr);
  }
};

struct Object : Value<Object> {
  friend struct Value<Object>;
  Object(js_env_t* env, js_value_t* value) : Value<Object>{env, value} {}

  static constexpr std::string_view typeName() { return js::typeName(js_object); }

  void setProperty(js_env_t* env, const char* name, js_value_t* value) {
    JS(js_set_named_property(env, value_, name, value));
  }

  js_value_t* getProperty(js_env_t* env, const char* name) {
    js_value_t* result;
    JS(js_get_named_property(env, value_, name, &result));
    return result;
  }

  js_value_t* getProperty(js_env_t* env, js_value_t* key) {
    js_value_t* result;
    JS(js_get_property(env, value_, key, &result));
    return result;
  }

  template <typename JsType>
  auto getProperty(js_env_t* env, const char* name) {
    auto result = getProperty(env, name);
    if ( !js::is<JsType>(env, result) ) {
      // Handle incomplete types that don't have typeName()
      std::string_view typeName;
      if constexpr (std::is_same_v<JsType, Int32>) {
        typeName = "int32";
      } else if constexpr (std::is_same_v<JsType, Uint32>) {
        typeName = "uint32";
      } else {
        typeName = JsType::typeName();
      }
      throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, formatAccessError(name, typeName).c_str());
    }
    
    // Handle incomplete types that don't have fromValue()
    if constexpr (std::is_same_v<JsType, Int32>) {
      return Number::fromValue(result);
    } else if constexpr (std::is_same_v<JsType, Uint32>) {
      return Number::fromValue(result);
    } else {
      return JsType::fromValue(result);
    }
  }

  template <typename JsType>
  std::optional<JsType> getOptionalProperty(js_env_t* env, const char* name) {
    auto result = getProperty(env, name);
    if ( js::is<Undefined>(env, result) || js::is<Null>(env, result) ) {
      return std::nullopt;
    }
    if ( !js::is<JsType>(env, result) ) {
      throw qvac_errors::StatusError(qvac_errors::general_error::InvalidArgument, formatAccessError(name, JsType::typeName()).c_str());
    }
    return JsType::fromValue(result);
  }

  template <typename JsType, typename CppT>
  CppT getPropertyAs(js_env_t* env, const char* name) {
    return getProperty<JsType>(env, name).template as<CppT>(env);
  }

  template <typename JsType, typename CppT>
  std::optional<CppT> getOptionalPropertyAs(js_env_t* env, const char* name) {
    std::optional<JsType> optionalJsProperty =
        getOptionalProperty<JsType>(env, name);
    if (optionalJsProperty.has_value()) {
      return optionalJsProperty.value().template as<CppT>(env);
    }
    return std::nullopt;
  }

protected:
  explicit Object(js_value_t* value) : Value<Object>{value} {}

  static int create_(js_env_t* env, js_value_t** result) {
    return js_create_object(env, result);
  }

private:
  std::string formatAccessError(const char* name, std::string_view expected) {
    std::string msg = "Expected property ";
    msg += name;
    msg += " to be of type ";
    msg += expected;
    return msg;
  }

};

struct Array : Value<Array> {
  friend struct Value<Array>;
  Array(js_env_t* env, js_value_t* value) : Value<Array>{env, value} {}

  using Value<Array>::create;

  static Array create(js_env_t* env, std::span<const js_value_t*> elements) {
    auto array = Array::create(env, elements.size());
    array.set(env, elements);
    return array;
  }

  static constexpr std::string_view typeName() { return "array"; }

  uint32_t size(js_env_t* env) {
    uint32_t result;
    JS(js_get_array_length(env, value_, &result));
    return result;
  }

  bool has(js_env_t* env, uint32_t index) {
    bool result;
    JS(js_has_element(env, value_, index, &result));
    return result;
  }

  template <typename JsType>
  JsType get(js_env_t* env, uint32_t index) {
    js_value_t* result;
    JS(js_get_element(env, value_, index, &result));
    return JsType{env, result};
  }

  void set(js_env_t* env, std::span<const js_value_t*> elements, size_t offset = 0) {
    JS(js_set_array_elements(env, value_, elements.data(), elements.size(), offset));
  }

  void set(js_env_t* env, uint32_t index, js_value_t* value) {
    JS(js_set_element(env, value_, index, value));
  }

  void remove(js_env_t* env, uint32_t index) {
    JS(js_delete_element(env, value_, index, nullptr));
  }

protected:
  explicit Array(js_value_t* value) : Value<Array>{value} {}

  static int create_(js_env_t* env, js_value_t** result) {
    return js_create_array(env, result);
  }

  static int create_(js_env_t* env, size_t len, js_value_t** result) {
    return js_create_array_with_length(env, len, result);
  }

  static int as_(js_env_t* env, js_value_t* value, std::vector<js_value_t*>* result) {
    auto array = Array::fromValue(value);
    size_t len = array.size(env), offset = 0;
    result->resize(len);
    return js_get_array_elements(env, array, result->data(), len, offset, nullptr);
  }

};

struct External : Value<External> {
  friend struct Value<External>;
  External(js_env_t* env, js_value_t* value) : Value<External>{env, value} {}

  static constexpr std::string_view typeName() { return js::typeName(js_external); }

protected:
  explicit External(js_value_t* value) : Value<External>{value} {}

  static int create_(js_env_t* env, void* value, js_value_t** result) {
    return js_create_external(env, value, nullptr, nullptr, result);
  }

  static int as_(js_env_t* env, js_value_t* value, void** result) {
    return js_get_value_external(env, value, result);
  }
};

struct Function : Value<Function> {
  friend struct Value<Function>;
  Function(js_env_t* env, js_value_t* value) : Value<Function>{env, value} {}

  static constexpr std::string_view typeName() { return js::typeName(js_function); }

protected:
  explicit Function(js_value_t* value) : Value<Function>{value} {}
};

template <typename SubType>
struct TypedArray : Value<TypedArray<SubType>> {
  friend struct Value<TypedArray<SubType>>;
  explicit TypedArray(js_env_t* env, js_value_t* value) : Value<TypedArray<SubType>>{env, value} {}

  static constexpr std::string_view typeName() {
    if constexpr (std::is_same_v<SubType, int8_t>) return "int8array";
    else if constexpr (std::is_same_v<SubType, uint8_t>) return "uint8array";
    else if constexpr (std::is_same_v<SubType, int16_t>) return "int16array";
    else if constexpr (std::is_same_v<SubType, uint16_t>) return "uint16array";
    else if constexpr (std::is_same_v<SubType, int32_t>) return "int32array";
    else if constexpr (std::is_same_v<SubType, uint32_t>) return "uint32array";
    else if constexpr (std::is_same_v<SubType, float>) return "float32array";
    else if constexpr (std::is_same_v<SubType, double>) return "float64array";
    else if constexpr (std::is_same_v<SubType, int64_t>) return "bigint64array";
    else if constexpr (std::is_same_v<SubType, uint64_t>) return "biguint64array";
    else {
      static_assert(sizeof(SubType)==0, "Invalid typed array subtype");
    }
  }

  static constexpr js_typedarray_type_t jsArrayT() {
    if constexpr (std::is_same_v<SubType, int8_t>)
      return js_int8array;
    else if constexpr (std::is_same_v<SubType, uint8_t>)
      return js_uint8array;
    else if constexpr (std::is_same_v<SubType, int16_t>)
      return js_int16array;
    else if constexpr (std::is_same_v<SubType, uint16_t>)
      return js_uint16array;
    else if constexpr (std::is_same_v<SubType, int32_t>)
      return js_int32array;
    else if constexpr (std::is_same_v<SubType, uint32_t>)
      return js_uint32array;
    else if constexpr (std::is_same_v<SubType, float>)
      return js_float32array;
    else if constexpr (std::is_same_v<SubType, double>)
      return js_float64array;
    else if constexpr (std::is_same_v<SubType, int64_t>)
      return js_bigint64array;
    else if constexpr (std::is_same_v<SubType, uint64_t>)
      return js_biguint64array;
    else {
      static_assert(sizeof(SubType) == 0, "Invalid typed array subtype");
    }
  }

  template <typename CppT>
  static TypedArray<SubType>
  create(js_env_t* env, std::span<const CppT>& data) {
    js_value_t* arrayBuffer = nullptr;
    void* arrayBufferData = nullptr;
    JS(js_create_arraybuffer(
        env, data.size() * sizeof(CppT), &arrayBufferData, &arrayBuffer));

    std::memcpy(arrayBufferData, data.data(), data.size() * sizeof(CppT));

    js_value_t* typedArray = nullptr;
    JS(js_create_typedarray(
        env, jsArrayT(), data.size(), arrayBuffer, 0, &typedArray));

    return TypedArray<SubType>{env, typedArray};
  }

  template <typename CppType,
    std::enable_if_t<
      std::is_same_v<typename CppType::value_type, SubType>
      || std::is_same_v<typename CppType::value_type, char>, bool> = true>
  CppType as(js_env_t* env) {
    typename CppType::value_type* data;
    size_t dataSz;
    JS(js_get_typedarray_info(
        env, Value<TypedArray<SubType>>::value_, nullptr, (void**)&data, &dataSz, nullptr, nullptr));
    return CppType(data, data + dataSz);
  }

protected:
  explicit TypedArray(js_value_t* value) : Value<TypedArray<SubType>>{value} {}

};

inline std::vector<js_value_t*> getArguments(js_env_t* env, js_callback_info_t* info) {
  size_t argc;
  JS(js_get_callback_info(env, info, &argc, NULL, NULL, NULL));

  std::vector<js_value_t*> args{ argc };

  JS(js_get_callback_info(env, info, &argc, args.data(), NULL, NULL));

  return args;
}

class UniqueRefDeleter {
public:
  virtual int js_delete_ref(js_env_t *env, js_ref_t *ref) = 0;
};

class ImmediateUniqueRefDeleter : public UniqueRefDeleter {
public:
  inline int js_delete_ref(js_env_t *env, js_ref_t *ref) override {
    return js_delete_reference(env, ref);
  }
};

/// @brief Will delay the deletion of the reference until .clear() is called
/// from the same thread that created the deleter. Can be useful to pass
/// references to a different thread but still destroy the reference in the same
/// thread that created the reference.
class ThreadQueuedRefDeleter : public UniqueRefDeleter {
private:
#ifndef NDEBUG
  std::thread::id threadId = std::this_thread::get_id();
#endif
  std::mutex delayedDeletionsMutex;
  std::vector<std::pair<js_env_t *, js_ref_t *>> delayedDeletions{};

  inline void _clear() {
    for (auto [env_ptr, ref_ptr] : delayedDeletions) {
      JS(js_delete_reference(env_ptr, ref_ptr));
    }
    delayedDeletions.clear();
  }

public:
  template <bool force_sync = false> void clear() {
    assert(this->threadId == std::this_thread::get_id());
    if constexpr (force_sync) {
      std::lock_guard<std::mutex> lock(delayedDeletionsMutex);
      _clear();
    } else {
      if (!delayedDeletionsMutex.try_lock()) {
        return;
      }
      std::lock_guard<std::mutex> lock(delayedDeletionsMutex, std::adopt_lock);
      _clear();
    }
  }
  inline int js_delete_ref(js_env_t *env, js_ref_t *ref) override {
    std::lock_guard<std::mutex> lock(delayedDeletionsMutex);
    delayedDeletions.push_back({env, ref});
    return 0;
  }
};

/// @brief A unique reference to a JS value that will prevent automatic garbage
/// collection.
/// @note The reference counter to the underlying js_value is kept to 1. Only
/// move operations are allowed.
template <typename JsType> struct UniqueJsRef {

  /// @brief Default constructor for nullptr reference
  UniqueJsRef() = default;

  // store env used for construction for the destructor
  /// @param env The environment to use for the reference destruction when going
  /// out of scope
  UniqueJsRef(js_env_t *env, js_value_t *value,
              UniqueRefDeleter *deleter = nullptr)
      : env_(env), deleter(deleter) {
    JS(js_create_reference(env, value, 1, &reference_));
  }

  ~UniqueJsRef() {
    if (reference_ && deleter) {
      if(deleter->js_delete_ref(env_, reference_) != 0) {
        // noexcept in destructor, just print a warning
        fprintf(stderr, "Warning: Failed to delete reference %p\n", reference_);
      }
    }
  }

  UniqueJsRef(const UniqueJsRef &other) = delete;

  UniqueJsRef &operator=(const UniqueJsRef &other) = delete;

  UniqueJsRef(UniqueJsRef &&other) noexcept
      : env_(other.env_), reference_(other.reference_), deleter(other.deleter) {
    other.reference_ = nullptr;
    other.deleter = nullptr;
  }

  UniqueJsRef &operator=(UniqueJsRef &&other) noexcept {
    if (this != &other) {
      if (reference_ && deleter) {
        JS(deleter->js_delete_ref(env_, reference_));
      }
      env_ = other.env_;
      reference_ = other.reference_;
      deleter = other.deleter;
      other.reference_ = nullptr;
      other.deleter = nullptr;
    }
    return *this;
  }

  /// @brief Move the reference to a new environment
  /// @param env The new environment to use for the reference destruction when
  /// going out of scope
  /// @return A reference to the moved UniqueJsRef
  UniqueJsRef &&move_into_env(js_env_t *env) {
    env_ = env;
    return std::move(*this);
  }

  /// @brief Get a fresh js_value_t* from the reference
  JsType get() const {
    js_value_t *result = nullptr;
    if (reference_) {
      JS(js_get_reference_value(env_, reference_, &result));
    }
    return JsType{env_, result};
  }

  template <typename JsPropertyType>
  std::optional<JsPropertyType> getOptionalProperty(const char *name) {
    return get().template getOptionalProperty<JsPropertyType>(env_, name);
  }

  template <typename JsPropertyType>
  JsPropertyType getProperty(const char *name) {
    return get().template getProperty<JsPropertyType>(env_, name);
  }

  js_env_t *env() const { return env_; }

private:
  js_env_t *env_;
  js_ref_t *reference_ = nullptr;
  UniqueRefDeleter *deleter;
};

template <typename JsType, typename CppType>
std::vector<CppType> toVector(js_env_t* env, Array array) {
  std::vector<CppType> result;
  auto arraySz = array.size(env);
  result.reserve(arraySz);
  for (auto i = 0; i != arraySz; ++i) {
    result.emplace_back(array.get<JsType>(env, i).template as<CppType>(env));
  }
  return result;
}

} // namespace qvac_lib_inference_addon_cpp::js
