#pragma once
#include <cstdio>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

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
// `common_fit_params` rewrites the parameters it was given, so `gpuLayers` and
// `ctxSize` come back as the values that fit rather than the ones asked for.
// It is not thread safe, so the call is serialised here.

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

  // `common_fit_params` reads ggml's global device registry and loads nothing
  // itself, so whatever is registered here is its whole view of the machine.
  auto backendsDir = request.getOptionalProperty<js::String>(env, "backendsDir");
  LlamaLazyInitializeBackend::initialize(
      backendsDir.has_value() ? backendsDir->as<std::string>(env)
                              : std::string());

  auto errorResult = [&](const char* reason) {
    auto result = js::Object::create(env);
    result.setProperty(env, "status", js::String::create(env, std::string("error")));
    result.setProperty(env, "reason", js::String::create(env, std::string(reason)));
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

  // `common_fit_params` dereferences the null model that gguf_init_from_file
  // leaves behind on a path it cannot open.
  if (std::FILE* file = std::fopen(modelPath.c_str(), "rb")) {
    std::fclose(file);
  } else {
    return errorResult("model-unreadable");
  }

  llama_model_params mparams = llama_model_default_params();
  llama_context_params cparams = llama_context_default_params();

  if (auto layers = number("gpuLayers")) {
    mparams.n_gpu_layers = static_cast<int>(*layers);
  }
  if (auto mainGpu = number("mainGpu")) {
    mparams.main_gpu = static_cast<int>(*mainGpu);
  }
  if (auto ctxSize = number("ctxSize")) {
    cparams.n_ctx = static_cast<uint32_t>(*ctxSize);
  }
  if (auto batchSize = number("batchSize")) {
    cparams.n_batch = static_cast<uint32_t>(*batchSize);
  }
  if (auto ubatchSize = number("ubatchSize")) {
    cparams.n_ubatch = static_cast<uint32_t>(*ubatchSize);
  }

  // The fitter rewrites only fields still holding a llama default, so one left
  // unset here is chosen by it rather than matched to the intended load.
  if (auto splitMode = number("splitMode")) {
    mparams.split_mode = static_cast<llama_split_mode>(static_cast<int>(*splitMode));
  }
  if (auto typeK = number("typeK")) {
    cparams.type_k = static_cast<ggml_type>(static_cast<int>(*typeK));
  }
  if (auto typeV = number("typeV")) {
    cparams.type_v = static_cast<ggml_type>(static_cast<int>(*typeV));
  }
  if (auto flashAttn = number("flashAttnType")) {
    cparams.flash_attn_type =
        static_cast<llama_flash_attn_type>(static_cast<int>(*flashAttn));
  }
  if (auto swaFull = request.getOptionalProperty<js::Boolean>(env, "swaFull")) {
    cparams.swa_full = swaFull->as<bool>(env);
  }

  const uint32_t minCtx = number("minCtxSize").has_value()
                              ? static_cast<uint32_t>(*number("minCtxSize"))
                              : 0;
  const size_t marginBytes =
      number("marginBytes").has_value()
          ? static_cast<size_t>(*number("marginBytes"))
          : 0;

  // Writable scratch the fit API requires; the sizes are the library's, not
  // the caller's.
  std::vector<float> tensorSplit(llama_max_devices(), 0.0F);
  std::vector<llama_model_tensor_buft_override> buftOverrides(
      llama_max_tensor_buft_overrides());
  std::vector<size_t> margins(llama_max_devices(), marginBytes);

  common_params_fit_status status{};
  {
    const std::lock_guard<std::mutex> lock(fitMutex);
    status = common_fit_params(
        modelPath.c_str(),
        &mparams,
        &cparams,
        tensorSplit.data(),
        buftOverrides.data(),
        margins.data(),
        minCtx,
        false,
        GGML_LOG_LEVEL_INFO);
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
      env, "reason",
      js::String::create(
          env,
          std::string(
              status == COMMON_PARAMS_FIT_STATUS_SUCCESS ? "fits"
                                                         : "does-not-fit")));
  result.setProperty(
      env, "gpuLayers", js::Number::create(env, mparams.n_gpu_layers));

  // The per-device breakdown is a second no-alloc probe, so it costs about
  // what the fit cost and only runs once a projection exists.
  std::vector<ggml_backend_dev_t> devices;
  uint32_t resolvedLayers = 0;
  uint32_t trainCtx = 0;
  uint32_t expertCount = 0;
  const common_device_memory_data_vec breakdown = common_get_device_memory_data(
      modelPath.c_str(),
      &mparams,
      &cparams,
      devices,
      resolvedLayers,
      trainCtx,
      expertCount,
      GGML_LOG_LEVEL_INFO);

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
            std::string(
                isHost ? "host" : ggml_backend_dev_name(devices[i]))));
    entry.setProperty(
        env, "totalBytes", js::Number::create(env, static_cast<double>(row.total)));
    entry.setProperty(
        env, "freeBytes", js::Number::create(env, static_cast<double>(row.free)));
    entry.setProperty(
        env, "modelBytes", js::Number::create(env, static_cast<double>(row.model)));
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

  // A fitted 0 names the trained context rather than a usable load.
  uint32_t fittedCtx = cparams.n_ctx;
  if (fittedCtx == 0) {
    if (trainCtx == 0) {
      return errorResult("model-unreadable");
    }
    fittedCtx = trainCtx;
  }

  result.setProperty(
      env, "ctxSize", js::Number::create(env, static_cast<double>(fittedCtx)));
  result.setProperty(env, "devices", perDevice);
  result.setProperty(env, "deviceBytes", js::Number::create(env, deviceBytes));
  result.setProperty(env, "hostBytes", js::Number::create(env, hostBytes));
  result.setProperty(
      env, "trainCtxSize", js::Number::create(env, static_cast<double>(trainCtx)));
  result.setProperty(
      env, "expertCount", js::Number::create(env, static_cast<double>(expertCount)));

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
