#pragma once

#include <any>
#include <memory>
#include <span>
#include <string>
#include <vector>

#include <js.h>
#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <whisper.h>

#include "model-interface/WhisperTypes.hpp"
#include "model-interface/whisper.cpp/WhisperModel.hpp"
#include "src/js-interface/JSAdapter.hpp"

namespace qvac_lib_inference_addon_whisper {

namespace js = qvac_lib_inference_addon_cpp::js;
using qvac_lib_inference_addon_cpp::OutputQueue;

inline void disableWhisperLogs(
    enum ggml_log_level /*level*/, const char* /*text*/, void* /*userData*/) {}

inline WhisperConfig
createWhisperConfig(js_env_t* env, const js::Object& configurationParams) {
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

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  whisper_log_set(disableWhisperLogs, nullptr);
  JsArgsParser args(env, info);
  auto configurationParams = args.getJsObject(1, "configurationParams");

  unique_ptr<model::IModel> model =
      make_unique<WhisperModel>(createWhisperConfig(env, configurationParams));

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
  auto inputObj = args.getJsObject(1, "inputObj");

  if (type != "audio") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  string audioFormat = "s16le";
  auto maybeAudioFormat =
      inputObj.getOptionalProperty<js::String>(env, "audio_format");
  if (maybeAudioFormat.has_value()) {
    audioFormat = maybeAudioFormat.value().as<std::string>(env);
  }

  vector<uint8_t> audioBytes =
      js::TypedArray<uint8_t>(env, jsInput).as<std::vector<uint8_t>>(env);
  auto samples = WhisperModel::preprocessAudioData(audioBytes, audioFormat);
  return instance.runJob(std::any(std::move(samples)));
}
JSCATCH

inline js_value_t* reload(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  auto configurationParams = args.getJsObject(1, "configurationParams");
  WhisperConfig config = createWhisperConfig(env, configurationParams);

  return js::JsAsyncTask::run(
      env,
      [addonCpp = instance.addonCpp, config = std::move(config)]() mutable {
        auto* whisperModel =
            dynamic_cast<WhisperModel*>(&addonCpp->model.get());
        if (whisperModel == nullptr) {
          throw std::runtime_error("Invalid model type for reload");
        }
        whisperModel->setConfig(config);
      });
}
JSCATCH

} // namespace qvac_lib_inference_addon_whisper
