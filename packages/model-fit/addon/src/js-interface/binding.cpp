#include <cstdint>
#include <string>

#include <bare.h>
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

/// `paramsFit(config)` — synchronous memory-fit preflight. Reads a plain config
/// object, runs `llama_params_fit` (no weights are loaded), and returns the
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

  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nCtx")) {
    req.nCtx = v->as<uint32_t>(env);
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nCtxMin")) {
    req.nCtxMin = v->as<uint32_t>(env);
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nBatch")) {
    req.nBatch = v->as<uint32_t>(env);
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nUbatch")) {
    req.nUbatch = v->as<uint32_t>(env);
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "nGpuLayers")) {
    req.nGpuLayers = v->as<int32_t>(env);
  }
  if (auto v = config.getOptionalProperty<jsu::Number>(env, "marginMiB")) {
    req.marginMiB = v->as<uint32_t>(env);
  }

  const FitResult res = runFit(req);

  auto out = jsu::Object::create(env);
  out.setProperty(
      env,
      "status",
      jsu::Number::create(env, static_cast<int32_t>(res.status)));
  out.setProperty(env, "fits", jsu::Boolean::create(env, res.fits));
  out.setProperty(env, "nGpuLayers", jsu::Number::create(env, res.nGpuLayers));
  out.setProperty(env, "nCtx", jsu::Number::create(env, res.nCtx));
  out.setProperty(env, "nBatch", jsu::Number::create(env, res.nBatch));
  out.setProperty(env, "nUbatch", jsu::Number::create(env, res.nUbatch));
  out.setProperty(
      env,
      "maxDevices",
      jsu::Number::create(env, static_cast<uint32_t>(res.maxDevices)));

  auto split = jsu::Array::create(env);
  for (size_t i = 0; i < res.tensorSplit.size(); ++i) {
    split.set(
        env,
        i,
        jsu::Number::create(env, static_cast<double>(res.tensorSplit[i])));
  }
  out.setProperty(env, "tensorSplit", split);

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
