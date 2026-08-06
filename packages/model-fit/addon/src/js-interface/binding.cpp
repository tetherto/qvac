#include <cmath>
#include <cstdint>
#include <string>

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

namespace model_fit::bindings {

namespace addon_cpp = qvac_lib_inference_addon_cpp;
namespace jsu = qvac_lib_inference_addon_cpp::js;

using qvac_errors::StatusError;
using qvac_errors::general_error::InvalidArgument;

namespace {

constexpr double UINT32_LIMIT = 4294967295.0;
constexpr double INT32_LIMIT = 2147483647.0;
constexpr double INT32_MIN_LIMIT = -2147483648.0;

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
  }
  return "model-unreadable";
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
    req.mainGpu = static_cast<int32_t>(
        requireBoundedInteger(v->as<double>(env), INT32_LIMIT, "mainGpu"));
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

  if (req.nBatch > 0 && req.nUbatch > 0 && req.nUbatch > req.nBatch) {
    throw StatusError(
        InvalidArgument, "model-fit: 'nUbatch' must not exceed 'nBatch'");
  }
  if (req.nCtx > 0 && req.nCtxMin > 0 && req.nCtxMin > req.nCtx) {
    throw StatusError(
        InvalidArgument, "model-fit: 'nCtxMin' must not exceed 'nCtx'");
  }

  const FitResult res = runFit(req);

  auto out = jsu::Object::create(env);
  out.setProperty(
      env,
      "status",
      jsu::Number::create(env, static_cast<int32_t>(res.status)));
  out.setProperty(env, "fits", jsu::Boolean::create(env, res.fits));
  out.setProperty(
      env, "reason", jsu::String::create(env, reasonName(res.reason)));
  out.setProperty(env, "nGpuLayers", jsu::Number::create(env, res.nGpuLayers));
  out.setProperty(env, "nCtx", jsu::Number::create(env, res.nCtx));
  out.setProperty(env, "nBatch", jsu::Number::create(env, res.nBatch));
  out.setProperty(env, "nUbatch", jsu::Number::create(env, res.nUbatch));
  out.setProperty(env, "splitMode", jsu::Number::create(env, res.splitMode));
  out.setProperty(env, "mainGpu", jsu::Number::create(env, res.mainGpu));
  out.setProperty(env, "typeK", jsu::Number::create(env, res.typeK));
  out.setProperty(env, "typeV", jsu::Number::create(env, res.typeV));
  out.setProperty(
      env, "flashAttnType", jsu::Number::create(env, res.flashAttnType));
  out.setProperty(
      env,
      "maxDevices",
      jsu::Number::create(env, static_cast<uint32_t>(res.maxDevices)));
  out.setProperty(
      env,
      "nDevices",
      jsu::Number::create(env, static_cast<uint32_t>(res.nDevices)));
  out.setProperty(
      env,
      "nGpuDevices",
      jsu::Number::create(env, static_cast<uint32_t>(res.nGpuDevices)));

  auto split = jsu::Array::create(env);
  for (size_t i = 0; i < res.tensorSplit.size(); ++i) {
    split.set(
        env,
        i,
        jsu::Number::create(env, static_cast<double>(res.tensorSplit[i])));
  }
  out.setProperty(env, "tensorSplit", split);

  auto overrides = jsu::Array::create(env);
  for (size_t i = 0; i < res.buftOverrides.size(); ++i) {
    auto entry = jsu::Object::create(env);
    entry.setProperty(
        env,
        "pattern",
        jsu::String::create(env, res.buftOverrides[i].pattern.c_str()));
    entry.setProperty(
        env,
        "bufferType",
        jsu::String::create(env, res.buftOverrides[i].bufferType.c_str()));
    overrides.set(env, i, entry);
  }
  out.setProperty(env, "buftOverrides", overrides);

  return out;
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

#undef V
  // NOLINTEND(cppcoreguidelines-macro-usage)

  return exports;
}

BARE_MODULE(model_fit, model_fit_exports)
