#pragma once

#include <cmath>
#include <cstddef>
#include <limits>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <picojson/picojson.h>

#include "handlers/SdCtxHandlers.hpp"
#include "model-interface/EsrganUpscalerModel.hpp"
#include "model-interface/LamAudio2ExpressionModel.hpp"
#include "model-interface/SdModel.hpp"
#include "utils/BackendLoader.hpp"
#include "utils/BackendSelection.hpp"
#include "utils/LoggingMacros.hpp"

namespace qvac_lib_inference_addon_sd {

inline int parseStandaloneUpscaleRepeats(const std::string& paramsJson) {
  picojson::value v;
  const std::string parseErr = picojson::parse(v, paramsJson);
  if (!parseErr.empty()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Failed to parse ESRGAN upscale params JSON: " + parseErr);
  }
  if (!v.is<picojson::object>()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "ESRGAN upscale params must be a JSON object");
  }

  const auto& obj = v.get<picojson::object>();
  auto it = obj.find("repeats");
  if (it == obj.end() || it->second.is<picojson::null>()) {
    return 1;
  }
  if (!it->second.is<double>()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "upscale.repeats must be a positive integer");
  }

  const double raw = it->second.get<double>();
  if (!std::isfinite(raw) || raw <= 0 || std::floor(raw) != raw ||
      raw > static_cast<double>(std::numeric_limits<int>::max())) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "upscale.repeats must be a positive integer");
  }

  return static_cast<int>(raw);
}

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);

  // -- Step 1: Extract model file paths from JS args[1] --------------------
  // index.js selects which field to populate based on model family:
  //   "path"               -> model_path          (SD1.x / SDXL all-in-one
  //   checkpoint) "diffusionModelPath" -> diffusion_model_path (FLUX.2 [klein]
  //   standalone GGUF; Wan 2.1 single expert; Wan 2.2 low-noise expert)
  //   "highNoiseDiffusionModelPath" -> high_noise_diffusion_model_path (Wan
  //   2.2 high-noise expert; empty for Wan 2.1 and all non-Wan models)
  // Exactly one of model_path / diffusion_model_path must be non-empty;
  // SdModel::load() passes all paths to sd_ctx_params_t and the library
  // uses whichever are set.
  SdCtxConfig config{};

  config.modelPath = args.getMapEntry(1, "path");
  config.diffusionModelPath = args.getMapEntry(1, "diffusionModelPath");
  config.highNoiseDiffusionModelPath =
      args.getMapEntry(1, "highNoiseDiffusionModelPath");
  config.uncondDiffusionModelPath =
      args.getMapEntry(1, "uncondDiffusionModelPath");
  config.clipLPath = args.getMapEntry(1, "clipLPath");
  config.clipGPath = args.getMapEntry(1, "clipGPath");
  config.t5XxlPath = args.getMapEntry(1, "t5XxlPath");
  config.llmPath = args.getMapEntry(1, "llmPath");
  config.vaePath = args.getMapEntry(1, "vaePath");
  config.clipVisionPath = args.getMapEntry(1, "clipVisionPath");
  config.esrganPath = args.getMapEntry(1, "esrganPath");
  // LTX-2 (LTXAV) extras: audio VAE + text-embedding connectors. Empty for
  // every non-LTX model (getMapEntry returns "" for absent keys).
  config.audioVaePath = args.getMapEntry(1, "audioVaePath");
  config.embeddingsConnectorsPath =
      args.getMapEntry(1, "embeddingsConnectorsPath");

  // -- Step 2: Apply SD_CTX_HANDLERS to the "config" sub-object -------------
  // configMap holds the flat key/value pairs from the second constructor arg
  // (e.g. { threads: "8", flash_attn: "true", ... }).
  // All values arrive as JS strings (coerced in addon.js).
  auto configMap = args.getSubmap(1, "config");
  applySdCtxHandlers(config, configMap);

  // -- Step 3: Construct the model with the fully resolved config ------------
  auto model = make_unique<SdModel>(std::move(config));

  // -- Step 4: Register output handlers -------------------------------------
  // Progress updates are JSON strings; image frames are uint8 byte arrays.
  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<out_handl::JsStringOutputHandler>());
  outHandlers.add(make_shared<out_handl::JsTypedArrayOutputHandler<uint8_t>>());

  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t*
createUpscalerInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);

  SdCtxConfig config{};
  config.esrganPath = args.getMapEntry(1, "esrganPath");

  auto configMap = args.getSubmap(1, "config");
  applySdCtxHandlers(config, configMap);

  auto model = make_unique<EsrganUpscalerModel>(std::move(config));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<out_handl::JsTypedArrayOutputHandler<uint8_t>>());

  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto [type, jsInput] = JsInterface::getInput(args);

  if (type != "text")
    throw StatusError(
        general_error::InvalidArgument,
        "stable-diffusion runJob expects a single text input with JSON params");

  const string paramsJson = js::String(env, jsInput).as<std::string>(env);

  SdModel::GenerationJob job;
  job.paramsJson = paramsJson;

  auto inputObj = args.getJsObject(1, "inputObj");
  auto initBuf =
      inputObj
          .getOptionalPropertyAs<js::TypedArray<uint8_t>, std::vector<uint8_t>>(
              env, "initImageBuffer");
  if (initBuf.has_value())
    job.initImageBytes = std::move(initBuf.value());

  // Multi-reference ("fusion") input: a JS Array of Uint8Array, forwarded by
  // addon.js as `initImageBuffers`. FLUX2 supports attending to >=1 reference
  // image in-context; the JS layer already rejects this for non-FLUX models
  // and mutual-exclusion with initImageBuffer is enforced in SdModel::process.
  auto initBufs =
      inputObj.getOptionalProperty<js::Array>(env, "initImageBuffers");
  if (initBufs.has_value()) {
    auto arr = initBufs.value();
    const uint32_t n = arr.size(env);
    job.initImagesBytes.reserve(n);
    for (uint32_t i = 0; i < n; ++i) {
      auto elem = arr.get<js::TypedArray<uint8_t>>(env, i);
      job.initImagesBytes.emplace_back(elem.as<std::vector<uint8_t>>(env));
    }
  }

  // -- Video-specific inputs ------------------------------------------------
  // `controlFramesBuffers` -- VACE control-frame sequence (one PNG/JPEG
  //                           buffer per frame). Optional on every video
  //                           mode; `vace_strength` controls guidance.
  auto controlBufs =
      inputObj.getOptionalProperty<js::Array>(env, "controlFramesBuffers");
  if (controlBufs.has_value()) {
    auto arr = controlBufs.value();
    const uint32_t n = arr.size(env);
    job.controlFramesBytes.reserve(n);
    for (uint32_t i = 0; i < n; ++i) {
      auto elem = arr.get<js::TypedArray<uint8_t>>(env, i);
      job.controlFramesBytes.emplace_back(elem.as<std::vector<uint8_t>>(env));
    }
  }

  // Lifetime contract for the `[&instance]` captures below:
  //
  //   `instance` is a reference into the AddonJs that the inference-addon-cpp
  //   parent framework holds in a stable storage slot keyed by `js_env_t`.
  //   The framework destroys that slot only on `destroyInstance()`, and
  //   `destroyInstance()` first joins / drains the JobRunner, which means
  //   the async job consuming these callbacks is guaranteed to have
  //   finished before the AddonJs is freed. As long as that invariant
  //   holds, capturing by reference is safe.
  //
  //   If the parent framework ever changes that ordering (e.g. allows
  //   destroyInstance during an in-flight job), these captures must be
  //   converted to a refcounted handle (e.g. shared_ptr to AddonCpp) or
  //   to a stable-key copy. Update both callbacks together.
  //
  // Progress updates are queued as JSON strings (JsStringOutputHandler).
  job.progressCallback = [&instance](const std::string& progressJson) {
    instance.addonCpp->outputQueue->queueResult(std::any(progressJson));
  };

  // Image frames are queued as uint8 byte vectors (JsTypedArrayOutputHandler).
  job.outputCallback = [&instance](const std::vector<uint8_t>& imageBytes) {
    instance.addonCpp->outputQueue->queueResult(std::any(imageBytes));
  };

  return instance.runJob(std::any(std::move(job)));
}
JSCATCH

inline js_value_t* runUpscaleJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto [type, jsInput] = JsInterface::getInput(args);
  if (type != "image") {
    throw StatusError(
        general_error::InvalidArgument,
        "ESRGAN runUpscaleJob expects a single image input");
  }

  auto inputObj = args.getJsObject(1, "inputObj");
  const string paramsJson =
      inputObj.getOptionalPropertyAs<js::String, std::string>(env, "params")
          .value_or("{}");

  EsrganUpscalerModel::UpscaleJob job;
  job.imageBytes =
      js::TypedArray<uint8_t>(env, jsInput).as<std::vector<uint8_t>>(env);
  job.repeats = parseStandaloneUpscaleRepeats(paramsJson);
  job.outputCallback = [&instance](const std::vector<uint8_t>& imageBytes) {
    instance.addonCpp->outputQueue->queueResult(std::any(imageBytes));
  };

  return instance.runJob(std::any(std::move(job)));
}
JSCATCH

/**
 * Activate the addon -- loads model weights by calling SdModel::load()
 * directly. SdModel does not implement IModelAsyncLoad, so we bypass
 * AddonCpp::activate() (which routes through that interface) and call load()
 * here instead. Args: [0] instance handle
 */
inline js_value_t* activate(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto* sdModel = dynamic_cast<SdModel*>(&instance.addonCpp->model.get());
  if (sdModel == nullptr) {
    throw StatusError(
        general_error::InternalError, "activate: model is not an SdModel");
  }

  sdModel->load();

  js_value_t* result = nullptr;
  js_get_undefined(env, &result);
  return result;
}
JSCATCH

inline js_value_t*
activateUpscaler(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto* upscalerModel =
      dynamic_cast<EsrganUpscalerModel*>(&instance.addonCpp->model.get());
  if (upscalerModel == nullptr) {
    throw StatusError(
        general_error::InternalError,
        "activateUpscaler: model is not an EsrganUpscalerModel");
  }

  upscalerModel->load();

  js_value_t* result = nullptr;
  js_get_undefined(env, &result);
  return result;
}
JSCATCH

/**
 * Query expected ESRGAN RuntimeStats.backendDevice for a config.device value,
 * using the same backend policy as native load. Args: [device] or
 * [device, backendsDir].
 */
inline js_value_t*
getExpectedEsrganBackendDevice(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  const std::vector<js_value_t*> argv = js::getArguments(env, info);
  if (argv.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "getExpectedEsrganBackendDevice: device argument is required");
  }

  const std::string device = js::String{env, argv[0]}.as<std::string>(env);
  std::string backendsDir;
  if (argv.size() > 1 && !js::is<js::Undefined>(env, argv[1]) &&
      !js::is<js::Null>(env, argv[1])) {
    backendsDir = js::String{env, argv[1]}.as<std::string>(env);
  }

  loadBackendModulesOnce(backendsDir);
  const std::string expected =
      sd_backend_selection::expectedEsrganBackendDeviceForConfig(device);
  return js::String::create(env, expected);
}
JSCATCH

// -- LAM audio2expression --------------------------------------------------

/**
 * Apply the LAM audio2expression configMap ("identityIndex", "nThreads",
 * "device", "backendsDir", "verbosity") to a LamAudio2ExpressionConfig.
 * Unknown keys are silently ignored (forward compatibility), mirroring
 * applySdCtxHandlers.
 */
inline void applyLamA2eConfigMap(
    LamAudio2ExpressionConfig& config,
    const std::unordered_map<std::string, std::string>& configMap) {
  for (const auto& [key, value] : configMap) {
    if (key == "identityIndex") {
      try {
        config.identityIndex = std::stoi(value);
      } catch (...) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            "identityIndex must be an integer, got: '" + value + "'");
      }
    } else if (key == "nThreads") {
      int parsed = 0;
      std::size_t parsedChars = 0;
      try {
        parsed = std::stoi(value, &parsedChars);
      } catch (...) {
        parsedChars = 0;
      }
      if (parsedChars != value.size() || !(parsed == -1 || parsed > 0)) {
        throw qvac_errors::StatusError(
            qvac_errors::general_error::InvalidArgument,
            "nThreads must be -1 (auto) or a positive integer, got: '" +
                value + "'");
      }
      config.nThreads = parsed;
    } else if (key == "device") {
      config.device = value;
    } else if (key == "backendsDir") {
      config.backendsDir = value;
    } else if (key == "verbosity") {
      std::unordered_map<std::string, std::string> m{{"verbosity", value}};
      logging::setVerbosityLevel(m);
    }
    // Unknown keys are silently ignored for forward compatibility.
  }
}

inline js_value_t*
createA2eInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);

  LamAudio2ExpressionConfig config{};
  config.modelPath = args.getMapEntry(1, "modelPath");

  auto configMap = args.getSubmap(1, "config");
  applyLamA2eConfigMap(config, configMap);

  auto model = make_unique<LamAudio2ExpressionModel>(std::move(config));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(make_shared<out_handl::JsStringOutputHandler>());

  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* activateA2e(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto* a2eModel =
      dynamic_cast<LamAudio2ExpressionModel*>(&instance.addonCpp->model.get());
  if (a2eModel == nullptr) {
    throw StatusError(
        general_error::InternalError,
        "activateA2e: model is not a LamAudio2ExpressionModel");
  }

  a2eModel->load();

  js_value_t* result = nullptr;
  js_get_undefined(env, &result);
  return result;
}
JSCATCH

inline js_value_t* runA2eJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto [type, jsInput] = JsInterface::getInput(args);
  if (type != "audio") {
    throw StatusError(
        general_error::InvalidArgument,
        "LAM audio2expression runA2eJob expects a single audio (PCM) input");
  }

  auto inputObj = args.getJsObject(1, "inputObj");

  LamAudio2ExpressionModel::ProcessJob job;
  job.pcm = js::TypedArray<float>(env, jsInput).as<std::vector<float>>(env);
  job.sampleRate =
      inputObj.getOptionalPropertyAs<js::Number, int32_t>(env, "sampleRate")
          .value_or(16000);
  job.identityIndex =
      inputObj.getOptionalPropertyAs<js::Number, int32_t>(
          env, "identityIndex");

  // See the runJob() lifetime note above: `instance` is safe to capture by
  // reference under the same AddonCpp teardown-ordering invariant.
  job.outputCallback = [&instance](const std::string& framesJson) {
    instance.addonCpp->outputQueue->queueResult(std::any(framesJson));
  };

  return instance.runJob(std::any(std::move(job)));
}
JSCATCH

} // namespace qvac_lib_inference_addon_sd
