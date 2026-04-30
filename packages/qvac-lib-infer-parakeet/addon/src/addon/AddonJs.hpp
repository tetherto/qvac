#pragma once

#include <any>
#include <memory>
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

#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"
#include "js-interface/JSAdapter.hpp"

namespace qvac_lib_infer_parakeet {

namespace js = qvac_lib_inference_addon_cpp::js;

inline ParakeetConfig createParakeetConfig(
    js_env_t* env, const js::Object& configurationParams) {
  JSAdapter adapter;
  return adapter.loadFromJSObject(configurationParams, env);
}

struct JsParakeetOutputHandler
    : qvac_lib_inference_addon_cpp::out_handl::JsBaseOutputHandler<
          std::vector<Transcript>> {
  JsParakeetOutputHandler()
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

  JsArgsParser args(env, info);
  auto configurationParams = args.getJsObject(1, "configurationParams");

  unique_ptr<model::IModel> model =
      make_unique<ParakeetModel>(createParakeetConfig(env, configurationParams));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outputHandlers;
  outputHandlers.add(make_shared<JsParakeetOutputHandler>());

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

  if (type != "audio") {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Unknown input type: " + type);
  }

  vector<float> inputSamples =
      js::TypedArray<float>(env, jsInput).as<vector<float>>(env);
  return instance.runJob(any(std::move(inputSamples)));
}
JSCATCH

} // namespace qvac_lib_infer_parakeet
