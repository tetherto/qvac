#pragma once

#include <any>
#include <memory>
#include <mutex>
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
              this->env_, "toAppend",
              js::Boolean::create(this->env_, output.toAppend));
          jsTranscript.setProperty(
              this->env_, "start",
              js::Number::create(this->env_, output.start));
          jsTranscript.setProperty(
              this->env_, "end",
              js::Number::create(this->env_, output.end));
          jsTranscript.setProperty(
              this->env_, "id",
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
                    this->env_, "text",
                    js::String::create(this->env_, output[i].text));
                jsTranscript.setProperty(
                    this->env_, "toAppend",
                    js::Boolean::create(this->env_, output[i].toAppend));
                jsTranscript.setProperty(
                    this->env_, "start",
                    js::Number::create(this->env_, output[i].start));
                jsTranscript.setProperty(
                    this->env_, "end",
                    js::Number::create(this->env_, output[i].end));
                jsTranscript.setProperty(
                    this->env_, "id",
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

  static std::once_flag whisperLogOnce;
  std::call_once(whisperLogOnce, []() {
    whisper_log_set(
        [](enum ggml_log_level level, const char* text, void*) {
          if (text == nullptr) return;
          auto prio = (level == GGML_LOG_LEVEL_ERROR)
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
        auto* bciModel =
            dynamic_cast<BCIModel*>(&addonCpp->model.get());
        if (bciModel == nullptr) {
          throw std::runtime_error("Invalid model type for reload");
        }
        bciModel->setConfig(config);
      });
}
JSCATCH

} // namespace qvac_lib_inference_addon_bci
