#pragma once

#include <any>
#include <cmath>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
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
// Projects one BCI model against the memory free right now. Args: [request],
// carrying the model path and the workload.
//
// Takes no instance and loads nothing: the fitter reads model metadata only. A
// model it cannot read is an "error" status carrying whisper's own reason.
//
// Covers the whisper half of a BCI load. The embedder has no fitter, so its
// file size is reported separately and is not part of the projection.

inline js_value_t* assessFit(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  auto request = args.getJsObject(0, "request");

  const std::string modelPath =
      request.getProperty<js::String>(env, "modelPath").as<std::string>(env);

  // whisper_fit_params reads ggml's global device registry and loads nothing
  // itself, so whatever is registered here is its whole view of the machine.
#if defined(__ANDROID__) || defined(__linux__)
  auto backendsDir =
      request.getOptionalProperty<js::String>(env, "backendsDir");
  ensureBackendsLoaded(
      backendsDir.has_value() ? backendsDir->as<std::string>(env)
                              : std::string());
#endif

  whisper_fit_options options = whisper_fit_default_options();
  options.model_path = modelPath.c_str();

  auto number = [&](const char* name) -> std::optional<double> {
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
  };

  if (auto layers = number("gpuLayers")) {
    options.use_gpu = *layers > 0;
  }
  if (auto device = number("gpuDevice")) {
    options.gpu_device = static_cast<int>(*device);
  }
  if (auto decoders = number("decoders")) {
    options.n_decoders = static_cast<int>(*decoders);
  }
  if (auto seconds = number("audioSeconds")) {
    options.audio_seconds = static_cast<float>(*seconds);
  }
  if (auto margin = number("marginBytes")) {
    options.margin_bytes = static_cast<uint64_t>(*margin);
  }

  whisper_fit_result fit{};
  whisper_fit_params(&options, &fit);

  const char* status = "error";
  if (fit.status == WHISPER_FIT_SUCCESS) {
    status = "fits";
  } else if (fit.status == WHISPER_FIT_FAILURE) {
    status = "does-not-fit";
  }

  uint64_t embedderFileBytes = 0;
  if (auto embedder =
          request.getOptionalProperty<js::String>(env, "embedderPath")) {
    std::error_code error;
    const auto size =
        std::filesystem::file_size(embedder->as<std::string>(env), error);
    if (!error) {
      embedderFileBytes = size;
    }
  }

  auto result = js::Object::create(env);
  auto text = [&](const char* name, const char* value) {
    result.setProperty(env, name, js::String::create(env, std::string(value)));
  };
  auto bytes = [&](const char* name, uint64_t value) {
    result.setProperty(
        env, name, js::Number::create(env, static_cast<double>(value)));
  };

  text("status", status);
  text("reason", fit.reason);
  text("modelType", fit.model_type);
  text("deviceName", fit.device_name);
  text("report", fit.report);
  result.setProperty(
      env, "deviceIsCpu", js::Boolean::create(env, fit.device_is_cpu));
  result.setProperty(
      env,
      "deviceSharesHostMemory",
      js::Boolean::create(env, fit.device_shares_host_memory));
  bytes("deviceFreeBytes", fit.device_free_bytes);
  bytes("deviceTotalBytes", fit.device_total_bytes);
  bytes("deviceBytes", fit.device.total_bytes);
  bytes("weightsBytes", fit.device.weights_bytes);
  bytes("kvBytes", fit.device.kv_bytes);
  bytes("computeBytes", fit.device.compute_bytes);
  bytes("hostOverflowBytes", fit.device.host_overflow_bytes);
  bytes("hostBytes", fit.host_bytes);
  bytes("embedderFileBytes", embedderFileBytes);

  return result;
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
