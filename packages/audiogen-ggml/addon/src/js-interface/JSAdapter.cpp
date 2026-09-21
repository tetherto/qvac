#include "js-interface/JSAdapter.hpp"

#include <cmath>
#include <limits>
#include <optional>
#include <string>

#include "inference-addon-cpp/Errors.hpp"

namespace qvac::audiogenggml {

namespace js = qvac_lib_inference_addon_cpp::js;
namespace general_error = qvac_errors::general_error;

namespace {

[[noreturn]] void throwInvalidNumber(const char* key, const char* typeName) {
  throw qvac_errors::StatusError(
      general_error::InvalidArgument,
      std::string("Property '") + key + "' must be " + typeName);
}

int checkedInteger(double value, const char* key) {
  const double minimum = std::numeric_limits<int>::min();
  const double maximum = std::numeric_limits<int>::max();
  if (!std::isfinite(value) || std::trunc(value) != value || value < minimum ||
      value > maximum) {
    throwInvalidNumber(key, "a finite int32 integer");
  }
  return static_cast<int>(value);
}

int parseInteger(const std::string& value, const char* key) {
  std::size_t consumed = 0;
  long long parsed = 0;
  try {
    parsed = std::stoll(value, &consumed);
  } catch (const std::exception&) {
    throwInvalidNumber(key, "a finite int32 integer");
  }
  if (consumed != value.size() || parsed < std::numeric_limits<int>::min() ||
      parsed > std::numeric_limits<int>::max()) {
    throwInvalidNumber(key, "a finite int32 integer");
  }
  return static_cast<int>(parsed);
}

float checkedFloat(double value, const char* key) {
  const double maximum = std::numeric_limits<float>::max();
  if (!std::isfinite(value) || value < -maximum || value > maximum) {
    throwInvalidNumber(key, "a finite float32 number");
  }
  return static_cast<float>(value);
}

float parseFloat(const std::string& value, const char* key) {
  std::size_t consumed = 0;
  float parsed = 0.0F;
  try {
    parsed = std::stof(value, &consumed);
  } catch (const std::exception&) {
    throwInvalidNumber(key, "a finite float32 number");
  }
  if (consumed != value.size() || !std::isfinite(parsed)) {
    throwInvalidNumber(key, "a finite float32 number");
  }
  return parsed;
}

std::optional<int>
readOptionalInteger(js::Object obj, js_env_t* env, const char* key) {
  js_value_t* raw = obj.getProperty(env, key);
  if (js::is<js::Undefined>(env, raw) || js::is<js::Null>(env, raw)) {
    return std::nullopt;
  }
  if (js::is<js::Number>(env, raw)) {
    return checkedInteger(js::Number::fromValue(raw).as<double>(env), key);
  }
  if (js::is<js::String>(env, raw)) {
    return parseInteger(js::String::fromValue(raw).as<std::string>(env), key);
  }
  throwInvalidNumber(key, "a number or numeric string");
}

std::optional<float>
readOptionalFloat(js::Object obj, js_env_t* env, const char* key) {
  js_value_t* raw = obj.getProperty(env, key);
  if (js::is<js::Undefined>(env, raw) || js::is<js::Null>(env, raw)) {
    return std::nullopt;
  }
  if (js::is<js::Number>(env, raw)) {
    return checkedFloat(js::Number::fromValue(raw).as<double>(env), key);
  }
  if (js::is<js::String>(env, raw)) {
    return parseFloat(js::String::fromValue(raw).as<std::string>(env), key);
  }
  throwInvalidNumber(key, "a number or numeric string");
}

std::string readOptionalString(js::Object obj, js_env_t* env, const char* key) {
  auto v = obj.getOptionalPropertyAs<js::String, std::string>(env, key);
  return v.value_or(std::string{});
}

[[noreturn]] void throwMissing(const char* key) {
  throw qvac_errors::StatusError(
      general_error::InvalidArgument,
      std::string("Property '") + key +
          "' is required in the configuration object");
}

int readRequiredInt(js::Object obj, js_env_t* env, const char* key) {
  auto v = readOptionalInteger(obj, env, key);
  if (!v.has_value())
    throwMissing(key);
  return *v;
}

int readRequiredNonNegativeInt(js::Object obj, js_env_t* env, const char* key) {
  const int value = readRequiredInt(obj, env, key);
  if (value < 0) {
    throw qvac_errors::StatusError(
        general_error::InvalidArgument,
        std::string("Property '") + key + "' must be non-negative");
  }
  return value;
}

float readRequiredFloat(js::Object obj, js_env_t* env, const char* key) {
  auto v = readOptionalFloat(obj, env, key);
  if (!v.has_value())
    throwMissing(key);
  return *v;
}

bool readRequiredBool(js::Object obj, js_env_t* env, const char* key) {
  js_value_t* raw = obj.getProperty(env, key);
  if (js::is<js::Undefined>(env, raw) || js::is<js::Null>(env, raw)) {
    throwMissing(key);
  }
  if (!js::is<js::Boolean>(env, raw)) {
    throw qvac_errors::StatusError(
        general_error::InvalidArgument,
        std::string("Property '") + key + "' must be a boolean");
  }
  return js::Boolean{env, raw}.as<bool>(env);
}

} // namespace

EngineType
JSAdapter::readEngineType(js::Object configurationParams, js_env_t* env) {
  const std::string engineType =
      readOptionalString(configurationParams, env, "engineType");
  if (engineType.empty() || engineType == "acestep") {
    return EngineType::Acestep;
  }
  if (engineType == "minimax") {
    return EngineType::Minimax;
  }
  throw qvac_errors::StatusError(
      general_error::InvalidArgument,
      "engineType must be 'acestep' or 'minimax' (got '" + engineType + "')");
}

acestep::AcestepConfig
JSAdapter::buildAcestepConfig(js::Object configurationParams, js_env_t* env) {
  acestep::AcestepConfig cfg;
  cfg.modelDir = readOptionalString(configurationParams, env, "modelDir");
  cfg.textEncModelPath =
      readOptionalString(configurationParams, env, "textEncModelPath");
  cfg.lmModelPath = readOptionalString(configurationParams, env, "lmModelPath");
  cfg.ditModelPath =
      readOptionalString(configurationParams, env, "ditModelPath");
  cfg.vaeModelPath =
      readOptionalString(configurationParams, env, "vaeModelPath");
  cfg.inferenceSteps =
      readRequiredInt(configurationParams, env, "inferenceSteps");
  cfg.shift = readRequiredFloat(configurationParams, env, "shift");
  cfg.threads = readRequiredNonNegativeInt(configurationParams, env, "threads");
  cfg.useGpu = readRequiredBool(configurationParams, env, "useGPU");
  cfg.nGpuLayers = readRequiredInt(configurationParams, env, "nGpuLayers");
  // Optional: host-provided prebuilds root for dlopen'd ggml backend modules
  // (see AcestepConfig::backendsDir). Empty when the host omits it; the addon
  // then relies on ggml's built-in search path.
  cfg.backendsDir = readOptionalString(configurationParams, env, "backendsDir");
  return cfg;
}

minimax::MinimaxConfig
JSAdapter::buildMinimaxConfig(js::Object configurationParams, js_env_t* env) {
  minimax::MinimaxConfig cfg;
  cfg.modelDir = readOptionalString(configurationParams, env, "modelDir");
  cfg.lmModelPath = readOptionalString(configurationParams, env, "lmModelPath");
  cfg.synthModelPath =
      readOptionalString(configurationParams, env, "synthModelPath");
  cfg.threads = readRequiredNonNegativeInt(configurationParams, env, "threads");
  cfg.useGpu = readRequiredBool(configurationParams, env, "useGPU");
  cfg.backendsDir = readOptionalString(configurationParams, env, "backendsDir");
  return cfg;
}

} // namespace qvac::audiogenggml
