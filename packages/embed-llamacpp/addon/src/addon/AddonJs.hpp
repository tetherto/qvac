#pragma once
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <common/arg.h>
#include <common/common.h>
#include <common/fit.h>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "model-interface/BertModel.hpp"
#include "model-interface/LlamaLazyInitializeBackend.hpp"

namespace qvac_lib_inference_addon_embed {

// ── assessFit ────────────────────────────────────────────────────────────
//
// Projects one model against the memory free right now. Args: [request].
//
// Takes no instance and loads nothing: the fitter reads GGUF metadata only. A
// model it cannot read is an "error" status rather than a throw.
//
// `common_fit_params` rewrites only the parameters it had to change, and
// restores every one of them on a status other than success. On
// `does-not-fit` the figures therefore describe the load as asked for, which
// is the demand that exceeded the machine. It is not thread safe, so the call
// is serialised here.

inline js_value_t* assessFit(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  static std::mutex fitMutex;

  JsArgsParser args(env, info);
  auto request = args.getJsObject(0, "request");

  const std::string modelPath =
      request.getProperty<js::String>(env, "modelPath").as<std::string>(env);

  auto number = [&](const char* name) -> std::optional<double> {
    auto value = request.getOptionalProperty<js::Number>(env, name);
    if (!value.has_value()) {
      return std::nullopt;
    }
    return value->as<double>(env);
  };

  // The config map `loadModel` takes, parsed below by the code that load itself
  // runs.
  std::unordered_map<std::string, std::string> configFilemap;
  if (auto config = request.getOptionalProperty<js::Object>(env, "config");
      config.has_value()) {
    js_value_t* names = nullptr;
    JS(js_get_property_names(env, *config, &names));
    auto keys = js::Array::fromValue(names);
    const size_t count = keys.size(env);
    for (size_t index = 0; index < count; ++index) {
      const std::string key =
          keys.get<js::String>(env, index).as<std::string>(env);
      configFilemap[key] = config->getProperty<js::String>(env, key.c_str())
                               .as<std::string>(env);
    }
  }

  // `BertModel::init` takes both out of the map before parsing.
  const auto takeConfig = [&configFilemap](const char* key) {
    std::string value;
    if (auto it = configFilemap.find(key); it != configFilemap.end()) {
      value = it->second;
      configFilemap.erase(it);
    }
    return value;
  };
  const std::string backendsDir = takeConfig("backendsDir");
  const std::string openclCacheDir = takeConfig("openclCacheDir");

  // `common_fit_params` reads ggml's global device registry and loads nothing
  // itself, so whatever is registered here is its whole view of the machine.
  // The handle holds the reference count for the call: a model unloading on
  // another thread would otherwise free the backend underneath it.
  LlamaBackendsHandle backendsHandle(backendsDir, openclCacheDir);

  auto errorResult = [&](const char* reason) {
    auto result = js::Object::create(env);
    result.setProperty(
        env, "status", js::String::create(env, std::string("error")));
    result.setProperty(
        env, "reason", js::String::create(env, std::string(reason)));
    result.setProperty(env, "gpuLayers", js::Number::create(env, 0));
    result.setProperty(env, "ctxSize", js::Number::create(env, 0));
    result.setProperty(env, "devices", js::Array::create(env));
    result.setProperty(env, "deviceBytes", js::Number::create(env, 0));
    result.setProperty(env, "hostBytes", js::Number::create(env, 0));
    result.setProperty(env, "trainCtxSize", js::Number::create(env, 0));
    result.setProperty(env, "expertCount", js::Number::create(env, 0));
    return result;
  };

  // An empty registry would still yield a verdict, measured against a machine
  // the fitter cannot see.
  if (ggml_backend_dev_count() == 0) {
    return errorResult("no-backend-device");
  }

  // A path llama cannot open reaches it as a `runtime_error` carrying no
  // filename, which reports as a model it could not read either way. Naming
  // the cause here keeps that distinct from a load it cannot represent.
  if (std::FILE* file = std::fopen(modelPath.c_str(), "rb")) {
    std::fclose(file);
  } else {
    return errorResult("model-unreadable");
  }

  // The fitter measures device memory, and a cpu load's weights stay
  // file-backed, so it would project `fits` for nearly any model.
  if (auto device = configFilemap.find("device");
      device != configFilemap.end() && device->second == "cpu") {
    return errorResult("unsupported-config");
  }

  common_params loadParams;
  try {
    loadParams = setupParams(modelPath, std::move(configFilemap)).params;
  } catch (const std::exception&) {
    return errorResult("unsupported-config");
  }
  loadParams.embedding = true;

  // A second resident file the projection does not count, so a load carrying
  // one would come back understated.
  if (!loadParams.lora_adapters.empty()) {
    return errorResult("unsupported-config");
  }

  // `BertModel::init` applies both to every embedding load: a non-causal model
  // decodes one ubatch at a time, and a single sequence needs no split cache.
  loadParams.n_ubatch = loadParams.n_batch;
  if (loadParams.n_parallel == 1) {
    loadParams.kv_unified = true;
  }

  // The fitter reduces the context only when it is 0, so an embedding load
  // left unset would be projected at a reduced context it never runs at.
  // `BertModel::init` pins it to the trained context, or caps it there.
  // A file the metadata reader rejects is reported by the fit below, which
  // owns the unreadable-model verdict.
  try {
    ModelMetaData metadata;
    metadata.parse(
        modelPath, {}, false, qvac_lib_infer_llamacpp_embed::errors::ADDON_ID);
    const auto architecture = metadata.tryGetString("general.architecture");
    if (architecture.has_value() && !architecture->empty()) {
      const auto trainedCtx =
          metadata.tryGetU32((*architecture + ".context_length").c_str());
      if (trainedCtx.has_value() && *trainedCtx > 0) {
        const auto trained = static_cast<int32_t>(*trainedCtx);
        if (loadParams.n_ctx == 0 || loadParams.n_ctx > trained) {
          loadParams.n_ctx = trained;
        }
      }
    }
  } catch (const std::exception&) {
  }

  llama_model_params mparams = common_model_params_to_llama(loadParams);
  llama_context_params cparams = common_context_params_to_llama(loadParams);

  // `fit-ctx 0` stores `UINT32_MAX` in the signed field to mean "do not
  // reduce", so the round trip through unsigned restores the sentinel.
  auto requestedMinCtx = number("minCtxSize");
  if (requestedMinCtx.has_value() &&
      (!std::isfinite(*requestedMinCtx) || *requestedMinCtx < 0)) {
    return errorResult("unsupported-config");
  }
  const uint32_t minCtx =
      requestedMinCtx.has_value()
          ? static_cast<uint32_t>(*requestedMinCtx)
          : static_cast<uint32_t>(loadParams.fit_params_min_ctx);

  auto requestedMargin = number("marginBytes");
  if (requestedMargin.has_value() &&
      (!std::isfinite(*requestedMargin) || *requestedMargin < 0)) {
    return errorResult("unsupported-config");
  }

  // In/out: the fitter rewrites only the entries still holding a llama
  // default, so a placement the load pinned survives into the projection.
  std::vector<float> tensorSplit(
      std::begin(loadParams.tensor_split),
      std::begin(loadParams.tensor_split) + llama_max_devices());
  std::vector<llama_model_tensor_buft_override> buftOverrides(
      llama_max_tensor_buft_overrides());
  // llama walks this array to its `{nullptr, nullptr}` terminator, so a list
  // that does not fit with the terminator would be read past its end.
  if (loadParams.tensor_buft_overrides.size() > buftOverrides.size()) {
    return errorResult("unsupported-config");
  }
  std::copy_n(
      loadParams.tensor_buft_overrides.begin(),
      loadParams.tensor_buft_overrides.size(),
      buftOverrides.begin());
  // `fit_params_target` already holds one entry per device, and `fit-target`
  // fills it, so it carries both llama's default and the load's own override.
  // A caller's margin answers a different question — what the models already
  // resident need — so the stricter of the two binds.
  std::vector<size_t> margins = loadParams.fit_params_target;
  if (requestedMargin.has_value()) {
    const auto requested = static_cast<size_t>(*requestedMargin);
    for (size_t& margin : margins) {
      margin = std::max(margin, requested);
    }
  }

  // Without the fitter the load places nothing, so there is no verdict.
  if (!loadParams.fit_params) {
    return errorResult("unsupported-config");
  }

  common_params_fit_status status{};
  try {
    const std::lock_guard<std::mutex> lock(fitMutex);
    status = common_fit_params(
        modelPath.c_str(),
        &mparams,
        &cparams,
        tensorSplit.data(),
        buftOverrides.data(),
        margins.data(),
        minCtx,
        nullptr,
        false,
        GGML_LOG_LEVEL_INFO,
        // The load's fit passes it too, so `moe-cache-mib: auto` sizes the
        // same expert cache in the projection as in the load.
        loadParams.moe_cache_auto_explicit);
  } catch (const std::exception&) {
    // `common_fit_params` answers its own failures with a status, so a throw
    // escaping it came from the setup around the probe.
    return errorResult("unsupported-config");
  }

  const char* statusName = "error";
  if (status == COMMON_PARAMS_FIT_STATUS_SUCCESS) {
    statusName = "fits";
  } else if (status == COMMON_PARAMS_FIT_STATUS_FAILURE) {
    statusName = "does-not-fit";
  }

  if (status == COMMON_PARAMS_FIT_STATUS_ERROR) {
    return errorResult("model-unreadable");
  }

  auto result = js::Object::create(env);
  result.setProperty(
      env, "status", js::String::create(env, std::string(statusName)));
  result.setProperty(
      env,
      "reason",
      js::String::create(
          env,
          std::string(
              status == COMMON_PARAMS_FIT_STATUS_SUCCESS ? "fits"
                                                         : "does-not-fit")));
  // The per-device breakdown is a second no-alloc probe, so it costs about
  // what the fit cost and only runs once a projection exists.
  std::vector<ggml_backend_dev_t> devices;
  uint32_t resolvedLayers = 0;
  uint32_t trainCtx = 0;
  uint32_t expertCount = 0;
  common_device_memory_data_vec breakdown;
  bool measured = true;
  try {
    breakdown = common_get_device_memory_data(
        modelPath.c_str(),
        &mparams,
        &cparams,
        devices,
        resolvedLayers,
        trainCtx,
        expertCount,
        GGML_LOG_LEVEL_INFO);
  } catch (const std::exception&) {
    // The fit already reached a verdict; this probe only breaks it down, so a
    // failure here leaves the verdict standing without per-device figures.
    measured = false;
    devices.clear();
    breakdown.clear();
  }

  // The probe returns one row per device the model was assigned to, then a
  // trailing host row: the CPU device is counted among the devices but its
  // demand lands on the host.
  auto perDevice = js::Array::create(env);
  double deviceBytes = 0;
  double hostBytes = 0;
  for (size_t i = 0; i < breakdown.size(); ++i) {
    const auto& row = breakdown[i];
    const bool isHost = i >= devices.size();
    const double used = static_cast<double>(row.model) +
                        static_cast<double>(row.context) +
                        static_cast<double>(row.compute);
    if (isHost) {
      hostBytes += used;
    } else {
      deviceBytes += used;
    }

    auto entry = js::Object::create(env);
    entry.setProperty(
        env,
        "name",
        js::String::create(
            env,
            std::string(isHost ? "host" : ggml_backend_dev_name(devices[i]))));
    entry.setProperty(
        env,
        "totalBytes",
        js::Number::create(env, static_cast<double>(row.total)));
    entry.setProperty(
        env,
        "freeBytes",
        js::Number::create(env, static_cast<double>(row.free)));
    entry.setProperty(
        env,
        "modelBytes",
        js::Number::create(env, static_cast<double>(row.model)));
    entry.setProperty(
        env,
        "contextBytes",
        js::Number::create(env, static_cast<double>(row.context)));
    entry.setProperty(
        env,
        "computeBytes",
        js::Number::create(env, static_cast<double>(row.compute)));
    perDevice.set(env, i, entry);
  }

  // A fitted 0 names the trained context rather than a usable load. Only the
  // breakdown probe reads the trained context, so without it a fitted 0 stays
  // 0 instead of being read as an unreadable model.
  uint32_t fittedCtx = cparams.n_ctx;
  if (fittedCtx == 0 && measured) {
    if (trainCtx == 0) {
      return errorResult("model-unreadable");
    }
    fittedCtx = trainCtx;
  }

  result.setProperty(
      env, "ctxSize", js::Number::create(env, static_cast<double>(fittedCtx)));
  // A load that fits whole leaves llama's -1 in place. llama resolves that to
  // every layer plus the output layer, and to none when the placement holds no
  // device; the probe's device list never holds the CPU.
  //
  // `resolvedLayers` omits an MTP model's nextn layers unless the load asked
  // for them, so such a model reports short of what llama would offload.
  double gpuLayers = static_cast<double>(mparams.n_gpu_layers);
  if (mparams.n_gpu_layers < 0 && measured) {
    gpuLayers = devices.empty() ? 0.0 : static_cast<double>(resolvedLayers) + 1;
  }
  result.setProperty(env, "gpuLayers", js::Number::create(env, gpuLayers));
  result.setProperty(env, "devices", perDevice);
  result.setProperty(env, "deviceBytes", js::Number::create(env, deviceBytes));
  result.setProperty(env, "hostBytes", js::Number::create(env, hostBytes));
  result.setProperty(
      env,
      "trainCtxSize",
      js::Number::create(env, static_cast<double>(trainCtx)));
  result.setProperty(
      env,
      "expertCount",
      js::Number::create(env, static_cast<double>(expertCount)));

  return result;
}
JSCATCH

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);

  auto model = make_unique<BertModel>(
      args.getMapEntry(1, "path"),
      args.getSubmap(1, "config"),
      args.getMapEntry(1, "backendsDir"));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(
      make_shared<out_handl::Js2DArrayOutputHandler<BertEmbeddings, float>>());
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

  auto parseSequences = [&](js::Object inputObj) -> std::vector<std::string> {
    if (!js::is<js::Array>(env, inputObj)) {
      throw StatusError{
          general_error::InvalidArgument, "Expected array for sequences type"};
    }
    std::vector<std::string> sequences;
    js::Array arr{env, inputObj};
    size_t len = arr.size(env);
    sequences.reserve(len);
    for (size_t i = 0; i < len; i++) {
      auto elem = arr.get<js::String>(env, i);
      sequences.push_back(elem.as<std::string>(env));
    }
    return sequences;
  };

  JsArgsParser args(env, info);
  any input;
  {
    auto [type, jsInput] = JsInterface::getInput(args);
    if (type == "text") {
      input = js::String(env, jsInput).as<std::string>(env);
    } else if (type == "sequences") {
      input = parseSequences(js::Object(env, jsInput));
    } else {
      throw StatusError(
          general_error::InvalidArgument, "Unknown input type: " + type);
    }
  }
  return JsInterface::getInstance(env, args.get(0, "instance"))
      .runJob(std::move(input));
}
JSCATCH

} // namespace qvac_lib_inference_addon_embed
