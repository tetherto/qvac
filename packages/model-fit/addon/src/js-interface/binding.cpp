#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>

#include <bare.h>
// For GGML_TYPE_COUNT: the typeK/typeV bound is taken from the same header the
// addon is compiled against, so it tracks an upstream ggml_type addition rather
// than being duplicated as a literal that silently goes stale.
#include <ggml.h>
#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <js.h>

#include "fit/FitParams.hpp"
#include "fit/LlamaLoadConfig.hpp"

namespace model_fit::bindings {

namespace addon_cpp = qvac_lib_inference_addon_cpp;
namespace jsu = qvac_lib_inference_addon_cpp::js;

using qvac_errors::StatusError;
using qvac_errors::general_error::InvalidArgument;

namespace {

constexpr double UINT32_LIMIT = 4294967295.0;
constexpr double INT32_LIMIT = 2147483647.0;
constexpr double INT32_MIN_LIMIT = -2147483648.0;
constexpr int32_t SPLIT_MODE_NONE = 0;

void requireAllowedProperties(
    js_env_t* env, jsu::Object object,
    const std::unordered_set<std::string_view>& allowed) {
  js_value_t* propertyNames;
  JS(js_get_property_names(env, object, &propertyNames));
  auto names = jsu::Array::fromValue(propertyNames);
  const size_t count = names.size(env);
  for (size_t index = 0; index < count; ++index) {
    const std::string key =
        names.get<jsu::String>(env, index).as<std::string>(env);
    if (!allowed.contains(key)) {
      throw StatusError(
          InvalidArgument, "model-fit: unknown top-level field '" + key + "'");
    }
  }
}

std::optional<int64_t> aliasedInteger(
    const LlamaConfigMap& config, const char* hyphenKey,
    const char* underscoreKey) {
  const auto hyphen = config.find(hyphenKey);
  const auto underscore = config.find(underscoreKey);
  if (hyphen != config.end() && underscore != config.end()) {
    throw StatusError(
        InvalidArgument,
        std::string("model-fit: use only one of '") + hyphenKey + "' and '" +
            underscoreKey + "'");
  }
  const auto selected = hyphen != config.end() ? hyphen : underscore;
  if (selected == config.end()) {
    return std::nullopt;
  }
  size_t consumed = 0;
  try {
    const int64_t value = std::stoll(selected->second, &consumed);
    if (consumed != selected->second.size()) {
      throw std::invalid_argument("trailing input");
    }
    return value;
  } catch (const std::exception&) {
    throw StatusError(
        InvalidArgument,
        std::string("model-fit: config.") + hyphenKey +
            " must be an integer string");
  }
}

/// Rejects fractions and out-of-range values before they are narrowed to
/// uint32_t/int32_t, where a fraction truncates and an out-of-range value
/// wraps.
///
/// These checks duplicate `index.js` deliberately: `./binding.js` is a public
/// export, so a caller can reach `paramsFit` without ever passing through the
/// JS wrapper, and the native side must not depend on validation it cannot
/// guarantee ran.
double requireBoundedSignedInteger(
    double value, double min, double max, const char* key) {
  if (!std::isfinite(value) || value != std::trunc(value)) {
    throw StatusError(
        InvalidArgument,
        std::string("model-fit: '") + key + "' must be an integer");
  }
  if (value < min || value > max) {
    throw StatusError(
        InvalidArgument,
        std::string("model-fit: '") + key + "' is out of range");
  }
  return value;
}

/// Unsigned fields: everything except nGpuLayers, where a negative would wrap
/// rather than mean anything.
double requireBoundedInteger(double value, double max, const char* key) {
  return requireBoundedSignedInteger(value, 0.0, max, key);
}

/// Stable strings, not the enum's numeric values — these cross into JS as part
/// of the public result and must not shift if the enum is reordered.
const char* reasonName(FitReason reason) {
  switch (reason) {
  case FitReason::Fits:
    return "fits";
  case FitReason::DoesNotFit:
    return "does-not-fit";
  case FitReason::ModelUnreadable:
    return "model-unreadable";
  case FitReason::NoBackendDevice:
    return "no-backend-device";
  case FitReason::UnsupportedConfig:
    return "unsupported-config";
  }
  return "model-unreadable";
}

js_value_t* fitResultObject(js_env_t* env, const FitResult& result) {
  auto out = jsu::Object::create(env);
  out.setProperty(
      env,
      "status",
      jsu::Number::create(env, static_cast<int32_t>(result.status)));
  out.setProperty(env, "fits", jsu::Boolean::create(env, result.fits));
  out.setProperty(
      env, "reason", jsu::String::create(env, reasonName(result.reason)));
  out.setProperty(
      env, "nGpuLayers", jsu::Number::create(env, result.nGpuLayers));
  out.setProperty(env, "nCtx", jsu::Number::create(env, result.nCtx));
  out.setProperty(env, "nBatch", jsu::Number::create(env, result.nBatch));
  out.setProperty(env, "nUbatch", jsu::Number::create(env, result.nUbatch));
  out.setProperty(env, "splitMode", jsu::Number::create(env, result.splitMode));
  out.setProperty(env, "mainGpu", jsu::Number::create(env, result.mainGpu));
  out.setProperty(env, "typeK", jsu::Number::create(env, result.typeK));
  out.setProperty(env, "typeV", jsu::Number::create(env, result.typeV));
  out.setProperty(
      env, "flashAttnType", jsu::Number::create(env, result.flashAttnType));
  out.setProperty(
      env,
      "maxDevices",
      jsu::Number::create(env, static_cast<uint32_t>(result.maxDevices)));
  out.setProperty(
      env,
      "nDevices",
      jsu::Number::create(env, static_cast<uint32_t>(result.nDevices)));
  out.setProperty(
      env,
      "nGpuDevices",
      jsu::Number::create(env, static_cast<uint32_t>(result.nGpuDevices)));

  auto split = jsu::Array::create(env);
  for (size_t index = 0; index < result.tensorSplit.size(); ++index) {
    split.set(
        env,
        index,
        jsu::Number::create(
            env, static_cast<double>(result.tensorSplit[index])));
  }
  out.setProperty(env, "tensorSplit", split);

  auto overrides = jsu::Array::create(env);
  for (size_t index = 0; index < result.buftOverrides.size(); ++index) {
    auto entry = jsu::Object::create(env);
    entry.setProperty(
        env,
        "pattern",
        jsu::String::create(env, result.buftOverrides[index].pattern.c_str()));
    entry.setProperty(
        env,
        "bufferType",
        jsu::String::create(
            env, result.buftOverrides[index].bufferType.c_str()));
    overrides.set(env, index, entry);
  }
  out.setProperty(env, "buftOverrides", overrides);
  return out;
}

} // namespace

/// `paramsFit(config)` — synchronous memory-fit preflight. Reads a plain config
/// object, runs `common_fit_params` (no weights are loaded), and returns the
/// fitted "load plan" as a JS object. Throwing goes through `JSCATCH`, which
/// converts C++ exceptions into JS errors.
inline js_value_t* paramsFit(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  auto config = args.getJsObject(0, "config");

  FitRequest req;
  req.modelPath =
      config.getProperty<jsu::String>(env, "modelPath").as<std::string>(env);
  if (req.modelPath.empty()) {
    throw StatusError(
        InvalidArgument,
        "model-fit: 'modelPath' is required and must be a non-empty string "
        "pointing at the GGUF weights file");
  }

  if (auto v = config.getOptionalProperty<jsu::String>(env, "backendsDir")) {
    req.backendsDir = v->as<std::string>(env);
  }

  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nCtx")) {
    req.nCtx = static_cast<uint32_t>(
        requireBoundedInteger(v->as<double>(env), UINT32_LIMIT, "nCtx"));
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nCtxMin")) {
    req.nCtxMin = static_cast<uint32_t>(
        requireBoundedInteger(v->as<double>(env), UINT32_LIMIT, "nCtxMin"));
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nBatch")) {
    req.nBatch = static_cast<uint32_t>(
        requireBoundedInteger(v->as<double>(env), UINT32_LIMIT, "nBatch"));
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nUbatch")) {
    req.nUbatch = static_cast<uint32_t>(
        requireBoundedInteger(v->as<double>(env), UINT32_LIMIT, "nUbatch"));
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nGpuLayers")) {
    // Signed: llama.h documents a negative value as "all layers", so the whole
    // int32 range is meaningful input.
    req.nGpuLayers = static_cast<int32_t>(requireBoundedSignedInteger(
        v->as<double>(env), INT32_MIN_LIMIT, INT32_LIMIT, "nGpuLayers"));
    req.hasNGpuLayers = true;
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "marginMiB")) {
    req.marginMiB = static_cast<uint32_t>(
        requireBoundedInteger(v->as<double>(env), UINT32_LIMIT, "marginMiB"));
  }

  // Intended-load fields. Bounded to their enum domains rather than the width
  // of the int they are narrowed to: an out-of-range split mode or attention
  // type would otherwise reach llama as a garbage enum value.
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "splitMode")) {
    req.splitMode = static_cast<int32_t>(
        requireBoundedSignedInteger(v->as<double>(env), 0.0, 3.0, "splitMode"));
    req.hasSplitMode = true;
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "mainGpu")) {
    req.mainGpu = static_cast<int32_t>(requireBoundedSignedInteger(
        v->as<double>(env), -1.0, INT32_LIMIT, "mainGpu"));
    req.hasMainGpu = true;
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "typeK")) {
    req.typeK = static_cast<int32_t>(requireBoundedSignedInteger(
        v->as<double>(env), 0.0, GGML_TYPE_COUNT - 1, "typeK"));
    req.hasTypeK = true;
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "typeV")) {
    req.typeV = static_cast<int32_t>(requireBoundedSignedInteger(
        v->as<double>(env), 0.0, GGML_TYPE_COUNT - 1, "typeV"));
    req.hasTypeV = true;
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "flashAttnType")) {
    req.flashAttnType = static_cast<int32_t>(requireBoundedSignedInteger(
        v->as<double>(env), -1.0, 1.0, "flashAttnType"));
    req.hasFlashAttnType = true;
  }
  js_value_t* swaFull = config.getProperty(env, "swaFull");
  if (!jsu::is<jsu::Undefined>(env, swaFull)) {
    if (!jsu::is<jsu::Boolean>(env, swaFull)) {
      throw StatusError(
          InvalidArgument, "model-fit: 'swaFull' must be a boolean");
    }
    req.swaFull = jsu::Boolean::fromValue(swaFull).as<bool>(env);
    req.hasSwaFull = true;
  }

  if (req.nBatch > 0 && req.nUbatch > 0 && req.nUbatch > req.nBatch) {
    throw StatusError(
        InvalidArgument, "model-fit: 'nUbatch' must not exceed 'nBatch'");
  }
  if (req.nCtx > 0 && req.nCtxMin > 0 && req.nCtxMin > req.nCtx) {
    throw StatusError(
        InvalidArgument, "model-fit: 'nCtxMin' must not exceed 'nCtx'");
  }
  if (req.hasMainGpu && req.mainGpu == -1 &&
      (!req.hasNGpuLayers || req.nGpuLayers != 0 || !req.hasSplitMode ||
       req.splitMode != SPLIT_MODE_NONE)) {
    throw StatusError(
        InvalidArgument,
        "model-fit: 'mainGpu' -1 requires 'nGpuLayers' 0 and 'splitMode' NONE");
  }

  const FitResult res = runFit(req);
  return fitResultObject(env, res);
}
JSCATCH

inline js_value_t* llamaConfigFit(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  auto config = args.getJsObject(0, "config");
  static const std::unordered_set<std::string_view> allowedFields = {
      "loadKind", "modelPath", "params", "backendsDir", "marginMiB", "nCtxMin"};
  requireAllowedProperties(env, config, allowedFields);

  LlamaLoadFitRequest request;
  const std::string loadKind =
      config.getProperty<jsu::String>(env, "loadKind").as<std::string>(env);
  if (loadKind == "completion") {
    request.loadKind = LlamaLoadKind::Completion;
  } else if (loadKind == "embedding") {
    request.loadKind = LlamaLoadKind::Embedding;
  } else {
    throw StatusError(
        InvalidArgument,
        "model-fit: 'loadKind' must be 'completion' or 'embedding'");
  }
  request.modelPath =
      config.getProperty<jsu::String>(env, "modelPath").as<std::string>(env);
  if (request.modelPath.empty() || request.modelPath.size() > 4096) {
    throw StatusError(
        InvalidArgument,
        "model-fit: 'modelPath' must be a non-empty string no longer than 4096 "
        "bytes");
  }
  try {
    request.params = args.getSubmap(0, "params");
  } catch (const std::exception&) {
    throw StatusError(
        InvalidArgument, "model-fit: llama params values must be strings");
  }
  if (request.params.size() > 256) {
    throw StatusError(
        InvalidArgument,
        "model-fit: 'params' must not contain more than 256 entries");
  }
  for (const auto& [key, value] : request.params) {
    if (key.empty() || key.size() > 128) {
      throw StatusError(
          InvalidArgument,
          "model-fit: llama config keys must be 1 to 128 bytes");
    }
    if (value.size() > 4096) {
      throw StatusError(
          InvalidArgument,
          "model-fit: llama config values must not exceed 4096 bytes");
    }
  }
  try {
    validateLlamaLoadFitCriticalIntegers(request.params);
  } catch (const std::invalid_argument& error) {
    throw StatusError(InvalidArgument, error.what());
  }

  if (auto value =
          config.getOptionalProperty<jsu::String>(env, "backendsDir")) {
    request.backendsDir = value->as<std::string>(env);
    if (request.backendsDir.empty() || request.backendsDir.size() > 4096) {
      throw StatusError(
          InvalidArgument,
          "model-fit: 'backendsDir' must be a non-empty string no longer than "
          "4096 bytes");
    }
  }
  if (auto value = config.getOptionalProperty<jsu::Number>(env, "marginMiB")) {
    request.marginMiB = static_cast<uint32_t>(requireBoundedInteger(
        value->as<double>(env), UINT32_LIMIT, "marginMiB"));
  }
  if (auto value = config.getOptionalProperty<jsu::Number>(env, "nCtxMin")) {
    request.nCtxMin = static_cast<uint32_t>(
        requireBoundedInteger(value->as<double>(env), UINT32_LIMIT, "nCtxMin"));
  }

  const std::optional<int64_t> batch =
      aliasedInteger(request.params, "batch-size", "batch_size");
  const std::optional<int64_t> ubatch =
      aliasedInteger(request.params, "ubatch-size", "ubatch_size");
  if (batch.has_value() && ubatch.has_value() &&
      ubatch.value() > batch.value()) {
    throw StatusError(
        InvalidArgument,
        "model-fit: config.ubatch-size must not exceed batch-size");
  }
  const std::optional<int64_t> context =
      aliasedInteger(request.params, "ctx-size", "ctx_size");
  if (context.has_value() && context.value() > 0 && request.nCtxMin > 0 &&
      request.nCtxMin > static_cast<uint64_t>(context.value())) {
    throw StatusError(
        InvalidArgument,
        "model-fit: 'nCtxMin' must not exceed concrete 'ctx-size'");
  }

  return fitResultObject(env, runLlamaFit(request));
}
JSCATCH

} // namespace model_fit::bindings

// NOLINTNEXTLINE(readability-identifier-naming)
js_value_t* model_fit_exports(js_env_t* env, js_value_t* exports) {
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define V(name, fn)                                                            \
  {                                                                            \
    js_value_t* val;                                                           \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {           \
      return nullptr;                                                          \
    }                                                                          \
    if (js_set_named_property(env, exports, name, val) != 0) {                 \
      return nullptr;                                                          \
    }                                                                          \
  }

  V("paramsFit", model_fit::bindings::paramsFit)
  V("llamaConfigFit", model_fit::bindings::llamaConfigFit)

#undef V
  // NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE(model_fit, model_fit_exports)
