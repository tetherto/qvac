#include "js-interface/JSAdapter.hpp"

#include <optional>
#include <string>

#include "inference-addon-cpp/Errors.hpp"

namespace qvac::audiogenggml {

namespace js = qvac_lib_inference_addon_cpp::js;
namespace general_error = qvac_errors::general_error;

namespace {

// Shared numeric property reader: undefined/null -> nullopt, a JS number is
// cast to T, a numeric string is parsed by `parse` (throwing a clear error on
// failure), anything else is rejected. The readRequiredInt/Float wrappers below
// delegate here and turn a nullopt into a "required" error.
template <typename T, typename Parse>
std::optional<T> readOptionalNumber(
    js::Object obj, js_env_t* env, const char* key, Parse parse,
    const char* typeName) {
  js_value_t* raw = obj.getProperty(env, key);
  if (js::is<js::Undefined>(env, raw) || js::is<js::Null>(env, raw)) {
    return std::nullopt;
  }
  if (js::is<js::Number>(env, raw)) {
    return static_cast<T>(js::Number::fromValue(raw).as<double>(env));
  }
  if (js::is<js::String>(env, raw)) {
    const std::string str = js::String::fromValue(raw).as<std::string>(env);
    try {
      return parse(str);
    } catch (const std::exception&) {
      throw qvac_errors::StatusError(
          general_error::InvalidArgument,
          std::string("Property '") + key + "' must be " + typeName +
              " (got \"" + str + "\")");
    }
  }
  throw qvac_errors::StatusError(
      general_error::InvalidArgument,
      std::string("Property '") + key + "' must be a number or numeric string");
}

std::string readOptionalString(
    js::Object obj, js_env_t* env, const char* key) {
  auto v = obj.getOptionalPropertyAs<js::String, std::string>(env, key);
  return v.value_or(std::string{});
}

// Required numeric/bool readers: the config carries no C++ defaults, so a
// missing (undefined/null) value is a contract violation — JS must always send
// every field (it owns the defaults). Throw a clear error instead of silently
// substituting a fallback.
[[noreturn]] void throwMissing(const char* key) {
  throw qvac_errors::StatusError(
      general_error::InvalidArgument,
      std::string("Property '") + key +
          "' is required in the configuration object");
}

int readRequiredInt(js::Object obj, js_env_t* env, const char* key) {
  auto v = readOptionalNumber<int>(
      obj, env, key, [](const std::string& s) { return std::stoi(s); },
      "an integer");
  if (!v.has_value()) throwMissing(key);
  return *v;
}

float readRequiredFloat(js::Object obj, js_env_t* env, const char* key) {
  auto v = readOptionalNumber<float>(
      obj, env, key, [](const std::string& s) { return std::stof(s); },
      "a number");
  if (!v.has_value()) throwMissing(key);
  return *v;
}

bool readRequiredBool(js::Object obj, js_env_t* env, const char* key) {
  // Distinguish a genuinely missing value (undefined/null -> "required") from a
  // present-but-wrong-typed one (e.g. useGPU: 1 -> "must be a boolean"), so the
  // error message matches the actual problem — like the numeric readers above.
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

}  // namespace

acestep::AcestepConfig JSAdapter::buildAcestepConfig(
    js::Object configurationParams, js_env_t* env) {
  acestep::AcestepConfig cfg;
  cfg.modelDir = readOptionalString(configurationParams, env, "modelDir");
  cfg.textEncModelPath =
      readOptionalString(configurationParams, env, "textEncModelPath");
  cfg.lmModelPath = readOptionalString(configurationParams, env, "lmModelPath");
  cfg.ditModelPath = readOptionalString(configurationParams, env, "ditModelPath");
  cfg.vaeModelPath = readOptionalString(configurationParams, env, "vaeModelPath");
  cfg.inferenceSteps = readRequiredInt(configurationParams, env, "inferenceSteps");
  cfg.shift = readRequiredFloat(configurationParams, env, "shift");
  cfg.threads = readRequiredInt(configurationParams, env, "threads");
  cfg.useGpu = readRequiredBool(configurationParams, env, "useGPU");
  cfg.nGpuLayers = readRequiredInt(configurationParams, env, "nGpuLayers");
  // Optional: host-provided prebuilds root for dlopen'd ggml backend modules
  // (see AcestepConfig::backendsDir). Empty when the host omits it; the addon
  // then relies on ggml's built-in search path.
  cfg.backendsDir = readOptionalString(configurationParams, env, "backendsDir");
  return cfg;
}

}  // namespace qvac::audiogenggml
