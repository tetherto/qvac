#pragma once

#include <cmath>
#include <map>
#include <optional>
#include <string>
#include <type_traits>
#include <vector>

#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsUtils.hpp>

#include "js-interface/NumberConversion.hpp"

namespace qvac::ttsggml::detail {

namespace js = qvac_lib_inference_addon_cpp::js;

inline auto optionError(const char* key, const char* expected) {
  return qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      std::string(key) + " must be " + expected);
}

template <typename T>
auto checkedOptionNumber(double value, const char* key) -> T {
  if constexpr (std::is_same_v<T, int>) {
    const auto converted = intFromJsNumber(value);
    if (converted && std::trunc(value) == value)
      return *converted;
    throw optionError(key, "an array of 32-bit integers");
  } else {
    const auto converted = floatFromJsNumber(value);
    if (converted && std::isfinite(value))
      return *converted;
    throw optionError(key, "an array of finite floats");
  }
}

inline auto readExactInt(js::Object object, js_env_t* env, const char* key)
    -> std::optional<int> {
  auto* value = object.getProperty(env, key);
  if (js::is<js::Undefined>(env, value))
    return std::nullopt;
  if (!js::is<js::Number>(env, value))
    throw optionError(key, "a 32-bit integer");
  return checkedOptionNumber<int>(
      js::Number::fromValue(value).as<double>(env), key);
}

template <typename T>
auto readOptionElements(js::Array array, js_env_t* env, const char* key)
    -> std::vector<T> {
  std::vector<T> values;
  const auto size = array.size(env);
  values.reserve(size);
  for (uint32_t i = 0; i < size; ++i) {
    js_value_t* value = nullptr;
    if (js_get_element(env, array, i, &value) != 0 ||
        !js::is<js::Number>(env, value)) {
      throw optionError(key, "an array of numbers");
    }
    values.push_back(
        checkedOptionNumber<T>(
            js::Number::fromValue(value).as<double>(env), key));
  }
  return values;
}

inline auto checkedFloatVector(std::vector<float> values, const char* key)
    -> std::vector<float> {
  for (const auto number : values)
    checkedOptionNumber<float>(number, key);
  return values;
}

template <typename T>
auto readOptionArray(js::Object object, js_env_t* env, const char* key)
    -> std::vector<T> {
  auto* value = object.getProperty(env, key);
  if (js::is<js::Undefined>(env, value))
    return {};
  if constexpr (std::is_same_v<T, float>) {
    if (js::is<js::TypedArray<float>>(env, value)) {
      return checkedFloatVector(
          js::TypedArray<float>::fromValue(value).as<std::vector<float>>(env),
          key);
    }
  }
  if (!js::is<js::Array>(env, value))
    throw optionError(key, "an array of numbers");
  return readOptionElements<T>(js::Array::fromValue(value), env, key);
}

inline auto readStringMapElements(
    js::Object object, js::Array keys, js_env_t* env, const char* key)
    -> std::map<std::string, std::string> {
  std::map<std::string, std::string> result;
  for (uint32_t i = 0; i < keys.size(env); ++i) {
    auto name = keys.get<js::String>(env, i);
    auto* value = object.getProperty(env, name);
    if (!js::is<js::String>(env, value))
      throw optionError(key, "an object with string values");
    result.emplace(
        name.as<std::string>(env),
        js::String::fromValue(value).as<std::string>(env));
  }
  return result;
}

inline auto readStringMap(js::Object object, js_env_t* env, const char* key)
    -> std::map<std::string, std::string> {
  auto* value = object.getProperty(env, key);
  if (js::is<js::Undefined>(env, value))
    return {};
  if (!js::is<js::Object>(env, value) || js::is<js::Array>(env, value)) {
    throw optionError(key, "an object with string values");
  }
  const auto source = js::Object::fromValue(value);
  js_value_t* names = nullptr;
  if (js_get_property_names(env, source, &names) != 0)
    throw optionError(key, "readable");
  return readStringMapElements(source, js::Array::fromValue(names), env, key);
}

} // namespace qvac::ttsggml::detail
