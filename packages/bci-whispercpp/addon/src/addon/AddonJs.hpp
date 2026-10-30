#pragma once

#include <any>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
#include <os/proc.h>
#endif
#endif

#include <ggml-backend.h>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <js.h>
#include <whisper.h>

#include "addon/AppMemoryBudget.hpp"
#include "model-interface/BCITypes.hpp"
#include "model-interface/bci/BCIModel.hpp"
#include "model-interface/bci/BciFit.hpp"
#include "model-interface/bci/EmbedderFit.hpp"
#include "src/js-interface/JSAdapter.hpp"

namespace qvac_lib_inference_addon_bci {

namespace js = qvac_lib_inference_addon_cpp::js;
using qvac_lib_inference_addon_cpp::OutputQueue;

inline BCIConfig
createBCIConfig(js_env_t* env, const js::Object& configurationParams) {
  JSAdapter adapter;
  return adapter.loadFromJSObject(configurationParams, env);
}

struct JsTranscriptOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<Transcript> {
  JsTranscriptOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            Transcript>([this](const Transcript& output) -> js_value_t* {
          auto jsTranscript = js::Object::create(this->env_);
          jsTranscript.setProperty(
              this->env_, "text", js::String::create(this->env_, output.text));
          jsTranscript.setProperty(
              this->env_,
              "toAppend",
              js::Boolean::create(this->env_, output.toAppend));
          jsTranscript.setProperty(
              this->env_,
              "start",
              js::Number::create(this->env_, output.start));
          jsTranscript.setProperty(
              this->env_, "end", js::Number::create(this->env_, output.end));
          jsTranscript.setProperty(
              this->env_,
              "id",
              js::Number::create(this->env_, static_cast<uint64_t>(output.id)));
          return jsTranscript;
        }) {}
};

struct JsTranscriptArrayOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<Transcript>> {
  JsTranscriptArrayOutputHandler()
      : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
            std::vector<Transcript>>(
            [this](const std::vector<Transcript>& output) -> js_value_t* {
              auto jsOutput = js::Array::create(this->env_);
              for (size_t i = 0; i < output.size(); ++i) {
                auto jsTranscript = js::Object::create(this->env_);
                jsTranscript.setProperty(
                    this->env_,
                    "text",
                    js::String::create(this->env_, output[i].text));
                jsTranscript.setProperty(
                    this->env_,
                    "toAppend",
                    js::Boolean::create(this->env_, output[i].toAppend));
                jsTranscript.setProperty(
                    this->env_,
                    "start",
                    js::Number::create(this->env_, output[i].start));
                jsTranscript.setProperty(
                    this->env_,
                    "end",
                    js::Number::create(this->env_, output[i].end));
                jsTranscript.setProperty(
                    this->env_,
                    "id",
                    js::Number::create(
                        this->env_, static_cast<uint64_t>(output[i].id)));
                jsOutput.set(this->env_, i, jsTranscript);
              }
              return jsOutput;
            }) {}
};

// ── assessFit ────────────────────────────────────────────────────────────
//
// Projects one BCI load against the memory free right now. Args: [request],
// carrying the model and embedder paths and the workload. Either path may be
// the file itself or the registry's weightless description of it; with no
// embedder path the embedder is read beside the model, as a load reads it.
//
// Takes no instance and loads nothing. Returns a Promise: the request is read
// on the JS thread, the projection runs on a worker thread, and the result is
// built back on the JS thread. Resolves to "fits" or "does-not-fit" with the
// memory the load takes on each device, or "unknown" for a load the fitter
// cannot size. A model or embedder that cannot be read, or an invalid request,
// rejects.

struct FitDevice {
  std::string id;
  std::string name;
  bool unified;
  double usedBytes;
  double freeBytes;
  double totalBytes;
};

struct FitResult {
  std::string status;
  std::vector<FitDevice> devices;
};

// The PCI bus ID when the backend reports one, so the same GPU matches across
// addons built on different backends; the device name otherwise.
//
// Unified marks memory the host owns: the CPU, an integrated GPU, a GPU that
// shares host memory, Android's OpenCL GPU, and a device that reports no
// memory of its own. A unified device that reports none takes the CPU's
// figures.
inline FitDevice fitDevice(
    ggml_backend_dev_t device, const std::string& name, bool sharesHostMemory,
    double usedBytes, double freeBytes, double totalBytes) {
  std::string id = name;
  std::string deviceName = name;
  const bool reportsNoMemory = totalBytes == 0;
  bool unified = sharesHostMemory || reportsNoMemory;
  if (device != nullptr) {
    ggml_backend_dev_props props{};
    ggml_backend_dev_get_props(device, &props);
    id = props.device_id != nullptr ? props.device_id : props.name;
    deviceName = props.name;
    unified = unified || props.memory_unified ||
              props.type == GGML_BACKEND_DEVICE_TYPE_IGPU ||
              props.type == GGML_BACKEND_DEVICE_TYPE_CPU;
#if defined(__ANDROID__)
    const char* registry =
        ggml_backend_reg_name(ggml_backend_dev_backend_reg(device));
    unified = unified ||
              (registry != nullptr && std::strcmp(registry, "OpenCL") == 0);
#endif
  }
  if (unified && reportsNoMemory) {
    if (ggml_backend_dev_t host =
            ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU)) {
      size_t hostFree = 0;
      size_t hostTotal = 0;
      ggml_backend_dev_memory(host, &hostFree, &hostTotal);
      freeBytes = static_cast<double>(hostFree);
      totalBytes = static_cast<double>(hostTotal);
    }
  }
  return {id, deviceName, unified, usedBytes, freeBytes, totalBytes};
}

// A load the fitter could not measure would still start, so it is unknown. A
// request or model file the fitter refuses rejects as an invalid argument, and
// any other failure as an internal one.
inline FitResult unsizedOrThrow(const std::string& reason) {
  if (reason == "measurement-failed" ||
      reason == "memory-capacity-unavailable" ||
      reason == "backend-memory-unavailable") {
    return FitResult{"unknown", {}};
  }
  const bool invalid = reason == "invalid-arguments" ||
                       reason == "model-unreadable" ||
                       reason == "embedder-unreadable";
  throw qvac_errors::StatusError(
      invalid ? qvac_errors::general_error::InvalidArgument
              : qvac_errors::general_error::InternalError,
      "assessFit: " + reason);
}

// One row for the device the load resolved to, then the host CPU, which holds
// the host-side buffers and the embedder. A load on the CPU is one row holding
// both.
inline FitResult toFitResult(const BciFit& fit) {
  const whisper_fit_result& whisper = fit.whisper;
  if (whisper.status == WHISPER_FIT_ERROR) {
    return unsizedOrThrow(whisper.reason);
  }
  if (!fit.embedderReadable) {
    return unsizedOrThrow("embedder-unreadable");
  }

  FitResult result;
  result.status = fit.fits() ? "fits" : "does-not-fit";

  ggml_backend_dev_t host =
      ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (whisper.device_is_cpu) {
    result.devices.push_back(fitDevice(
        host,
        whisper.device_name,
        true,
        static_cast<double>(
            saturatingAdd(whisper.device.total_bytes, fit.hostBytes())),
        static_cast<double>(whisper.device_free_bytes),
        static_cast<double>(whisper.device_total_bytes)));
    return result;
  }

  result.devices.push_back(fitDevice(
      ggml_backend_dev_by_name(whisper.device_name),
      whisper.device_name,
      whisper.device_shares_host_memory,
      static_cast<double>(whisper.device.total_bytes),
      static_cast<double>(whisper.device_free_bytes),
      static_cast<double>(whisper.device_total_bytes)));

  size_t hostFree = 0;
  size_t hostTotal = 0;
  if (host != nullptr) {
    ggml_backend_dev_memory(host, &hostFree, &hostTotal);
  }
  result.devices.push_back(fitDevice(
      host,
      "CPU",
      true,
      static_cast<double>(fit.hostBytes()),
      static_cast<double>(hostFree),
      static_cast<double>(hostTotal)));
  return result;
}

struct FitRequest {
  std::string modelPath;
  std::string embedderPath;
  std::string backendsDir;
  std::optional<double> gpuLayers;
  std::optional<double> gpuDevice;
  std::optional<double> decoders;
  std::optional<double> audioSeconds;
  std::optional<double> marginBytes;
};

inline std::optional<double>
fitCount(js_env_t* env, js::Object request, const char* name) {
  auto value = request.getOptionalProperty<js::Number>(env, name);
  if (!value.has_value()) {
    return std::nullopt;
  }
  const double raw = value->as<double>(env);
  // A count cast from a negative or non-finite double is undefined.
  if (!std::isfinite(raw) || raw < 0) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string("assessFit: ") + name + " must be a non-negative count");
  }
  return raw;
}

inline std::string
fitOptionalString(js_env_t* env, js::Object request, const char* name) {
  auto value = request.getOptionalProperty<js::String>(env, name);
  return value.has_value() ? value->as<std::string>(env) : std::string();
}

inline FitRequest parseFitRequest(js_env_t* env, js_callback_info_t* info) {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  auto request = args.getJsObject(0, "request");

  FitRequest parsed;
  parsed.modelPath =
      request.getProperty<js::String>(env, "modelPath").as<std::string>(env);
  parsed.embedderPath = fitOptionalString(env, request, "embedderPath");
  parsed.backendsDir = fitOptionalString(env, request, "backendsDir");
  parsed.gpuLayers = fitCount(env, request, "gpuLayers");
  parsed.gpuDevice = fitCount(env, request, "gpuDevice");
  parsed.decoders = fitCount(env, request, "decoders");
  parsed.audioSeconds = fitCount(env, request, "audioSeconds");
  parsed.marginBytes = fitCount(env, request, "marginBytes");
  return parsed;
}

inline void
applyFitWorkload(const FitRequest& request, whisper_fit_options& options) {
  if (request.gpuLayers.has_value()) {
    options.use_gpu = *request.gpuLayers > 0;
  }
  if (request.gpuDevice.has_value()) {
    options.gpu_device = static_cast<int>(*request.gpuDevice);
  }
  if (request.decoders.has_value()) {
    options.n_decoders = static_cast<int>(*request.decoders);
  }
  if (request.audioSeconds.has_value()) {
    options.audio_seconds = static_cast<float>(*request.audioSeconds);
  }
  if (request.marginBytes.has_value()) {
    options.margin_bytes = static_cast<uint64_t>(*request.marginBytes);
  }
}

inline void measureFitEmbedder(const std::string& embedderPath, BciFit& fit) {
  const auto footprint = measureEmbedder(embedderPath);
  fit.embedderReadable = footprint.has_value();
  fit.embedderBytes = footprint.has_value() ? footprint->hostBytes() : 0;
}

inline js_value_t* fitResultObject(js_env_t* env, const FitResult& fit) {
  auto result = js::Object::create(env);
  result.setProperty(env, "status", js::String::create(env, fit.status));
  auto devices = js::Array::create(env);
  for (size_t i = 0; i < fit.devices.size(); ++i) {
    const auto& row = fit.devices[i];
    auto entry = js::Object::create(env);
    entry.setProperty(env, "id", js::String::create(env, row.id));
    entry.setProperty(env, "name", js::String::create(env, row.name));
    entry.setProperty(env, "unified", js::Boolean::create(env, row.unified));
    entry.setProperty(env, "usedBytes", js::Number::create(env, row.usedBytes));
    entry.setProperty(env, "freeBytes", js::Number::create(env, row.freeBytes));
    entry.setProperty(
        env, "totalBytes", js::Number::create(env, row.totalBytes));
    devices.set(env, i, entry);
  }
  result.setProperty(env, "devices", devices);
  result.setProperty(env, "stats", js::Object::create(env));
  return result;
}

// Runs on the fit worker thread, so it makes no js_* call. It reads only the
// owned request and ggml's device registry, which lives for the whole process,
// so no instance unload can free state underneath it. Fits run one at a time:
// each initializes the resolved device's backends and ggml's global timer.
inline FitResult runFit(const FitRequest& request) {
  static std::mutex fitMutex;
  const std::lock_guard<std::mutex> lock(fitMutex);

  // whisper_fit_params reads ggml's global device registry and loads nothing
  // itself, so whatever is registered here is its whole view of the machine.
#if defined(__ANDROID__) || defined(__linux__)
  ensureBackendsLoaded(request.backendsDir);
#endif

  whisper_fit_options options = whisper_fit_default_options();
  options.model_path = request.modelPath.c_str();
  applyFitWorkload(request, options);

  BciFit fit;
  fit.marginBytes = options.margin_bytes;
  whisper_fit_params(&options, &fit.whisper);
  measureFitEmbedder(
      request.embedderPath.empty() ? colocatedEmbedderPath(request.modelPath)
                                   : request.embedderPath,
      fit);
  FitResult result = toFitResult(fit);
#if defined(__APPLE__) && TARGET_OS_IPHONE && !TARGET_OS_SIMULATOR
  // The margin the fitter held back on the device is held back from the app's
  // limit too.
  result.status = applyAppMemoryBudget(
      result.status,
      result.devices,
      static_cast<double>(os_proc_available_memory()),
      static_cast<double>(fit.marginBytes));
#endif
  return result;
}

inline js_value_t* assessFit(js_env_t* env, js_callback_info_t* info) try {
  FitRequest request = parseFitRequest(env, info);
  return js::JsAsyncTask::run(
      env,
      [request = std::move(request)]() { return runFit(request); },
      fitResultObject);
}
JSCATCH

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  static std::once_flag whisperLogOnce;
  std::call_once(whisperLogOnce, []() {
    whisper_log_set(
        [](enum ggml_log_level level, const char* text, void*) {
          if (text == nullptr)
            return;
          auto prio =
              (level == GGML_LOG_LEVEL_ERROR)
                  ? qvac_lib_inference_addon_cpp::logger::Priority::ERROR
              : (level == GGML_LOG_LEVEL_WARN)
                  ? qvac_lib_inference_addon_cpp::logger::Priority::WARNING
                  : qvac_lib_inference_addon_cpp::logger::Priority::DEBUG;
          QLOG(prio, std::string("[whisper.cpp] ") + text);
        },
        nullptr);
  });
  JsArgsParser args(env, info);
  auto configurationParams = args.getJsObject(1, "configurationParams");

  unique_ptr<model::IModel> model =
      make_unique<BCIModel>(createBCIConfig(env, configurationParams));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outputHandlers;
  outputHandlers.add(make_shared<JsTranscriptOutputHandler>());
  outputHandlers.add(make_shared<JsTranscriptArrayOutputHandler>());
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outputHandlers));

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

  if (type != "neural") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type + " (expected 'neural')");
  }

  vector<uint8_t> neuralBytes =
      js::TypedArray<uint8_t>(env, jsInput).as<std::vector<uint8_t>>(env);
  return instance.runJob(std::any(std::move(neuralBytes)));
}
JSCATCH

inline js_value_t* reload(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto configurationParams = args.getJsObject(1, "configurationParams");
  BCIConfig config = createBCIConfig(env, configurationParams);

  return js::JsAsyncTask::run(
      env,
      [addonCpp = instance.addonCpp, config = std::move(config)]() mutable {
        auto* bciModel = dynamic_cast<BCIModel*>(&addonCpp->model.get());
        if (bciModel == nullptr) {
          throw std::runtime_error("Invalid model type for reload");
        }
        bciModel->setConfig(config);
      });
}
JSCATCH

} // namespace qvac_lib_inference_addon_bci
