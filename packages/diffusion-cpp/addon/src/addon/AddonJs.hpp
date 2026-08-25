#pragma once

#include <cmath>
#include <limits>
#include <memory>
#include <string>
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
#include "handlers/WorldSessionHandlers.hpp"
#include "model-interface/EsrganUpscalerModel.hpp"
#include "model-interface/SdModel.hpp"
#include "model-interface/WorldSessionModel.hpp"
#include "utils/BackendLoader.hpp"
#include "utils/BackendSelection.hpp"

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

  // `referenceImagesBuffers` -- LTX IC-LoRA reference images, one encoded
  // PNG/JPEG buffer per reference. Pixel decoding and ownership happen in
  // SdModel::processVideo() so the C API pointers stay valid through sampling.
  auto referenceBufs =
      inputObj.getOptionalProperty<js::Array>(env, "referenceImagesBuffers");
  if (referenceBufs.has_value()) {
    auto arr = referenceBufs.value();
    const uint32_t n = arr.size(env);
    job.referenceImagesBytes.reserve(n);
    for (uint32_t i = 0; i < n; ++i) {
      auto elem = arr.get<js::TypedArray<uint8_t>>(env, i);
      job.referenceImagesBytes.emplace_back(elem.as<std::vector<uint8_t>>(env));
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

/**
 * Create an ABot-World interactive walk-session instance. The session is a
 * standalone model object (own DiT + taehv + scene pack); frames stream
 * through the same string/typed-array output handlers as batch generation.
 * Args: [0] jsHandle map, [1] files+config map, [2] outputCallback
 */
inline js_value_t*
createWorldInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);

  qvac_lib_inference_addon_sd::WorldSessionConfig config{};
  config.ditModelPath = args.getMapEntry(1, "diffusionModelPath");
  config.taehvPath = args.getMapEntry(1, "taehvPath");
  config.scenePath = args.getMapEntry(1, "scenePath");

  // config sub-object: flat string key/values (coerced in addon.js), routed
  // through the validated handler map like every other instance constructor
  // here - numeric booleans ("1"/"0") parse, bad values throw typed
  // InvalidArgument instead of raw stoi errors or silent no-ops.
  applyWorldSessionHandlers(config, args.getSubmap(1, "config"));

  auto model = make_unique<WorldSessionModel>(std::move(config));

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

/**
 * Run one walk step: generate the next block under the given action mask and
 * stream its decoded frames as PNG byte arrays -- or JPEG when the session's
 * frameJpegQuality is 1..100 -- (plus one progress JSON).
 * Args: [0] instance handle, [1] { input: { type: 'text', data: paramsJson } }
 * paramsJson: { "actionMask": <0..255> }
 */
inline js_value_t*
runWorldStepJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto [type, jsInput] = JsInterface::getInput(args);
  if (type != "text") {
    throw StatusError(
        general_error::InvalidArgument,
        "runWorldStepJob expects a single text input with JSON params");
  }
  const string paramsJson = js::String(env, jsInput).as<std::string>(env);

  picojson::value parsed;
  const std::string parseErr = picojson::parse(parsed, paramsJson);
  if (!parseErr.empty() || !parsed.is<picojson::object>()) {
    throw StatusError(
        general_error::InvalidArgument,
        "world step params must be a JSON object: " + parseErr);
  }
  double mask = 0;
  const auto& obj = parsed.get<picojson::object>();
  if (auto it = obj.find("actionMask");
      it != obj.end() && it->second.is<double>()) {
    mask = it->second.get<double>();
  }
  if (mask < 0 || mask > 255 || std::floor(mask) != mask) {
    throw StatusError(
        general_error::InvalidArgument,
        "actionMask must be an integer in [0, 255]");
  }

  WorldSessionModel::WalkStepJob job;
  job.actionMask = static_cast<uint32_t>(mask);
  // Lifetime contract: identical to runJob above -- destroyInstance() joins
  // the JobRunner before the AddonJs is freed.
  job.progressCallback = [&instance](const std::string& progressJson) {
    instance.addonCpp->outputQueue->queueResult(std::any(progressJson));
  };
  job.outputCallback = [&instance](const std::vector<uint8_t>& imageBytes) {
    instance.addonCpp->outputQueue->queueResult(std::any(imageBytes));
  };

  return instance.runJob(std::any(std::move(job)));
}
JSCATCH

/**
 * Create a scene pack natively (umT5-XXL prompt encode + Wan2.2 VAE
 * first-frame encode -> scene.safetensors). Standalone: does not require the
 * session to be loaded; the pack is loaded later via `scenePath`.
 * Args: [0] instance handle,
 *       [1] { input: { type: 'text', data: paramsJson }, initImageBuffer }
 * paramsJson: { prompt, width, height, t5Path, vaePath, outputPath }
 */
inline js_value_t*
runWorldSceneJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto [type, jsInput] = JsInterface::getInput(args);
  if (type != "text") {
    throw StatusError(
        general_error::InvalidArgument,
        "runWorldSceneJob expects a single text input with JSON params");
  }
  const string paramsJson = js::String(env, jsInput).as<std::string>(env);

  picojson::value parsed;
  const std::string parseErr = picojson::parse(parsed, paramsJson);
  if (!parseErr.empty() || !parsed.is<picojson::object>()) {
    throw StatusError(
        general_error::InvalidArgument,
        "scene params must be a JSON object: " + parseErr);
  }
  const auto& obj = parsed.get<picojson::object>();
  auto getString = [&obj](const char* key) -> std::string {
    auto it = obj.find(key);
    return (it != obj.end() && it->second.is<std::string>())
               ? it->second.get<std::string>()
               : std::string();
  };
  auto getInt = [&obj](const char* key, int fallback) -> int {
    auto it = obj.find(key);
    return (it != obj.end() && it->second.is<double>())
               ? static_cast<int>(it->second.get<double>())
               : fallback;
  };

  WorldSessionModel::SceneCreateJob job;
  job.prompt = getString("prompt");
  job.width = getInt("width", 832);
  job.height = getInt("height", 480);
  job.t5Path = getString("t5Path");
  job.vaePath = getString("vaePath");
  job.outputPath = getString("outputPath");
  if (job.prompt.empty() || job.t5Path.empty() || job.vaePath.empty() ||
      job.outputPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "scene params require prompt, t5Path, vaePath and outputPath");
  }

  auto inputObj = args.getJsObject(1, "inputObj");
  auto imgBuf =
      inputObj
          .getOptionalPropertyAs<js::TypedArray<uint8_t>, std::vector<uint8_t>>(
              env, "initImageBuffer");
  if (!imgBuf.has_value() || imgBuf.value().empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "scene creation requires initImageBuffer (PNG/JPEG bytes)");
  }
  job.imageBytes = std::move(imgBuf.value());

  job.progressCallback = [&instance](const std::string& progressJson) {
    instance.addonCpp->outputQueue->queueResult(std::any(progressJson));
  };

  return instance.runJob(std::any(std::move(job)));
}
JSCATCH

/**
 * Load the walk session (DiT + taehv + scene). Mirrors activate()/
 * activateUpscaler(): WorldSessionModel does not implement IModelAsyncLoad.
 * Args: [0] instance handle
 */
inline js_value_t* activateWorld(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));

  auto* worldModel =
      dynamic_cast<WorldSessionModel*>(&instance.addonCpp->model.get());
  if (worldModel == nullptr) {
    throw StatusError(
        general_error::InternalError,
        "activateWorld: model is not a WorldSessionModel");
  }

  worldModel->load();

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

} // namespace qvac_lib_inference_addon_sd
