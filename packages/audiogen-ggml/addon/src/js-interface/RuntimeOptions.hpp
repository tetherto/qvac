#pragma once

#include <string>

#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsUtils.hpp>

namespace qvac::audiogenggml {

inline std::string readRuntimeString(
    qvac_lib_inference_addon_cpp::js::Object object, js_env_t* env,
    const char* name) {
  namespace js = qvac_lib_inference_addon_cpp::js;
  js_value_t* value = object.getProperty(env, name);
  if (js::is<js::Undefined>(env, value)) {
    return {};
  }
  if (!js::is<js::String>(env, value)) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string(name) + " must be a string without NUL characters");
  }
  auto text = js::String::fromValue(value).as<std::string>(env);
  if (text.find('\0') != std::string::npos) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string(name) + " must be a string without NUL characters");
  }
  return text;
}

} // namespace qvac::audiogenggml
