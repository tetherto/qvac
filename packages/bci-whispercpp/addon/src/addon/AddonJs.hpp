#pragma once

#include <any>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <optional>
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
#include <js.h>
#include <whisper.h>

#include "model-interface/BCITypes.hpp"
#include "model-interface/bci/BCIModel.hpp"
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
// built back on the JS thread. A model or embedder that cannot be read
// resolves to an "error" status carrying the reason.

constexpr const char* K_FIT_STATUS_FITS = "fits";
constexpr const char* K_FIT_STATUS_DOES_NOT_FIT = "does-not-fit";
constexpr const char* K_FIT_STATUS_ERROR = "error";
constexpr const char* K_EMBEDDER_UNREADABLE = "embedder-unreadable";
constexpr double K_BYTES_PER_MIB = 1024.0 * 1024.0;
constexpr size_t K_REPORT_LINE_BYTES = 128;

inline uint64_t saturatingAdd(uint64_t a, uint64_t b) {
  return a > UINT64_MAX - b ? UINT64_MAX : a + b;
}

struct BciFit {
  whisper_fit_result whisper{};
  uint64_t marginBytes = 0;
  bool embedderReadable = true;
  uint64_t embedderBytes = 0;

  [[nodiscard]] uint64_t hostBytes() const {
    return saturatingAdd(whisper.host_bytes, embedderBytes);
  }

  [[nodiscard]] bool embedderFitsBesideModel() const {
    if (!whisper.device_shares_host_memory) {
      return true;
    }
    const uint64_t required = saturatingAdd(
        saturatingAdd(whisper.device.total_bytes, marginBytes), hostBytes());
    return required <= whisper.device_free_bytes;
  }

  [[nodiscard]] const char* status() const {
    if (whisper.status == WHISPER_FIT_ERROR || !embedderReadable) {
      return K_FIT_STATUS_ERROR;
    }
    return whisper.status == WHISPER_FIT_SUCCESS && embedderFitsBesideModel()
               ? K_FIT_STATUS_FITS
               : K_FIT_STATUS_DOES_NOT_FIT;
  }

  [[nodiscard]] const char* reason() const {
    if (whisper.status == WHISPER_FIT_ERROR) {
      return whisper.reason;
    }
    if (!embedderReadable) {
      return K_EMBEDDER_UNREADABLE;
    }
    return status();
  }

  [[nodiscard]] std::string report() const {
    char line[K_REPORT_LINE_BYTES];
    std::snprintf(
        line,
        sizeof(line),
        "bci embedder: %.1f MiB host%s\nverdict with embedder: %s\n",
        static_cast<double>(embedderBytes) / K_BYTES_PER_MIB,
        whisper.device_shares_host_memory ? " (same RAM pool)" : "",
        status());
    return std::string(whisper.report) + line;
  }
};

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

inline js_value_t* fitResultObject(js_env_t* env, const BciFit& fit) {
  auto result = js::Object::create(env);
  auto text = [&](const char* name, const std::string& value) {
    result.setProperty(env, name, js::String::create(env, value));
  };
  auto bytes = [&](const char* name, uint64_t value) {
    result.setProperty(
        env, name, js::Number::create(env, static_cast<double>(value)));
  };
  const whisper_fit_result& whisper = fit.whisper;

  text("status", fit.status());
  text("reason", fit.reason());
  text("modelType", whisper.model_type);
  text("deviceName", whisper.device_name);
  text("report", fit.report());
  result.setProperty(
      env, "deviceIsCpu", js::Boolean::create(env, whisper.device_is_cpu));
  result.setProperty(
      env,
      "deviceSharesHostMemory",
      js::Boolean::create(env, whisper.device_shares_host_memory));
  bytes("deviceFreeBytes", whisper.device_free_bytes);
  bytes("deviceTotalBytes", whisper.device_total_bytes);
  bytes("deviceBytes", whisper.device.total_bytes);
  bytes("weightsBytes", whisper.device.weights_bytes);
  bytes("kvBytes", whisper.device.kv_bytes);
  bytes("computeBytes", whisper.device.compute_bytes);
  bytes("hostOverflowBytes", whisper.device.host_overflow_bytes);
  bytes("hostBytes", fit.hostBytes());
  bytes("embedderBytes", fit.embedderBytes);
  return result;
}

// Runs on the fit worker thread, so it makes no js_* call. It reads only the
// owned request and ggml's device registry, which lives for the whole process,
// so no instance unload can free state underneath it. Fits run one at a time:
// each initializes the resolved device's backends and ggml's global timer.
inline BciFit runFit(const FitRequest& request) {
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
  return fit;
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
