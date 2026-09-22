#pragma once
#include <cstdio>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include <algorithm>

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

/// Applies a load's settings, in llama's own CLI spelling, by dispatching each
/// through llama's argument table, so tensor splits, MoE placement and tensor
/// buffer overrides are parsed exactly as the loader reads them.
///
/// Returns a reason when the load cannot be represented, empty on success.
inline std::optional<std::string> applyLlamaLoadParams(
    js_env_t* env,
    qvac_lib_inference_addon_cpp::js::Object request,
    common_params& params) {
  namespace js = qvac_lib_inference_addon_cpp::js;

  auto supplied = request.getOptionalProperty<js::Object>(env, "params");
  if (!supplied.has_value()) {
    return std::nullopt;
  }

  auto parser = common_params_parser_init(
      params, LLAMA_EXAMPLE_COMMON, [](int, char**) {});

  std::unordered_map<std::string, common_arg*> options;
  std::unordered_map<std::string, bool> polarity;
  for (common_arg& option : parser.options) {
    for (const char* arg : option.args) {
      options[arg] = &option;
      polarity[arg] = true;
    }
    for (const char* arg : option.args_neg) {
      options[arg] = &option;
      polarity[arg] = false;
    }
  }

  js_value_t* names = nullptr;
  JS(js_get_property_names(env, *supplied, &names));
  auto keys = js::Array::fromValue(names);
  const size_t count = keys.size(env);

  for (size_t index = 0; index < count; ++index) {
    const std::string key =
        keys.get<js::String>(env, index).as<std::string>(env);
    const std::string value =
        supplied->getProperty<js::String>(env, key.c_str()).as<std::string>(env);
    const std::string arg = "--" + key;

    const auto found = options.find(arg);
    if (found == options.end()) {
      return "unsupported-config";
    }

    common_arg& option = *found->second;
    try {
      if (option.handler_bool != nullptr) {
        const bool requested = value.empty() || common_arg_utils::is_truthy(value);
        option.handler_bool(params, polarity.at(arg) ? requested : !requested);
      } else if (option.handler_void != nullptr) {
        // A valueless flag can only assert itself, so a load asking for its
        // opposite describes a placement this path cannot express.
        if (!value.empty() && !common_arg_utils::is_truthy(value)) {
          return "unsupported-config";
        }
        option.handler_void(params);
      } else if (option.handler_int != nullptr) {
        option.handler_int(params, std::stoi(value));
      } else if (option.handler_string != nullptr) {
        option.handler_string(params, value);
      } else {
        return "unsupported-config";
      }
    } catch (const std::exception&) {
      return "unsupported-config";
    }
  }

  // llama reads both lists to their terminator rather than by size.
  if (!params.tensor_buft_overrides.empty()) {
    params.tensor_buft_overrides.push_back({nullptr, nullptr});
  }
  if (!params.kv_overrides.empty()) {
    params.kv_overrides.emplace_back();
    params.kv_overrides.back().key[0] = '\0';
  }
  return std::nullopt;
}

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
  // The handle holds the reference count for the call: a model unloading on
  // another thread would otherwise free the backend underneath it.
  auto backendsDir = request.getOptionalProperty<js::String>(env, "backendsDir");
  LlamaBackendsHandle backendsHandle(
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

  common_params loadParams;
  loadParams.embedding = true;
  if (auto applied = applyLlamaLoadParams(env, request, loadParams);
      applied.has_value()) {
    return errorResult(applied->c_str());
  }

  llama_model_params mparams = common_model_params_to_llama(loadParams);
  llama_context_params cparams = common_context_params_to_llama(loadParams);

  const uint32_t minCtx = number("minCtxSize").has_value()
                              ? static_cast<uint32_t>(*number("minCtxSize"))
                              : 0;
  const size_t marginBytes =
      number("marginBytes").has_value()
          ? static_cast<size_t>(*number("marginBytes"))
          : 0;

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
  std::vector<size_t> margins(llama_max_devices(), marginBytes);

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
        false,
        GGML_LOG_LEVEL_INFO);
  } catch (const std::exception&) {
    // A load llama cannot build a context for is a configuration this
    // projection cannot answer, not a failure of the caller's request.
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
