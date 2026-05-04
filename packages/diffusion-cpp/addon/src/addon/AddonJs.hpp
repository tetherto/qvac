#pragma once

#include <memory>
#include <vector>

#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "handlers/SdCtxHandlers.hpp"
#include "model-interface/SdModel.hpp"

namespace qvac_lib_inference_addon_sd {

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
  config.clipLPath = args.getMapEntry(1, "clipLPath");
  config.clipGPath = args.getMapEntry(1, "clipGPath");
  config.t5XxlPath = args.getMapEntry(1, "t5XxlPath");
  config.llmPath = args.getMapEntry(1, "llmPath");
  config.vaePath = args.getMapEntry(1, "vaePath");

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
  // `endImageBuffer`       -- last frame bytes for Wan flf2vid
  //                           (first-last-frame interpolation). Mutually
  //                           exclusive with all non-flf2vid video modes;
  //                           rejected by SdModel::processVideo() if supplied
  //                           alongside mode="txt2vid" or "img2vid".
  // `controlFramesBuffers` -- VACE control-frame sequence (one PNG/JPEG
  //                           buffer per frame). Optional on every video
  //                           mode; `vace_strength` controls guidance.
  auto endBuf =
      inputObj
          .getOptionalPropertyAs<js::TypedArray<uint8_t>, std::vector<uint8_t>>(
              env, "endImageBuffer");
  if (endBuf.has_value())
    job.endImageBytes = std::move(endBuf.value());

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

} // namespace qvac_lib_inference_addon_sd
