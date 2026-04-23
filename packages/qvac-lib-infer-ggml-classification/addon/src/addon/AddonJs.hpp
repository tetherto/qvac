#pragma once

#include <memory>
#include <string>
#include <vector>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "model-interface/ClassificationModel.hpp"

namespace qvac_lib_infer_ggml_classification::bindings {

namespace addon_cpp = qvac_lib_inference_addon_cpp;
namespace jsu = qvac_lib_inference_addon_cpp::js;

using qvac_errors::StatusError;
using qvac_errors::general_error::InvalidArgument;

/// Handler mapping ClassifyOutput → JS array of { label, confidence }.
struct JsClassifyOutputHandler
    : addon_cpp::out_handl::JsBaseOutputHandler<ClassifyOutput> {
  JsClassifyOutputHandler()
      : JsBaseOutputHandler<ClassifyOutput>(
            [this](const ClassifyOutput& cppOut) -> js_value_t* {
              auto array = jsu::Array::create(this->env_);
              for (size_t i = 0; i < cppOut.results.size(); ++i) {
                auto entry = jsu::Object::create(this->env_);
                entry.setProperty(
                    this->env_, "label",
                    jsu::String::create(this->env_, cppOut.results[i].label));
                entry.setProperty(
                    this->env_, "confidence",
                    jsu::Number::create(
                        this->env_,
                        static_cast<double>(cppOut.results[i].confidence)));
                array.set(this->env_, i, entry);
              }
              return array;
            }) {}
};

inline js_value_t* createInstance(
    js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);

  auto configObj = args.getJsObject(1, "config");
  auto modelPath =
      configObj.getProperty<jsu::String>(env, "path").as<std::string>(env);

  auto model = std::make_unique<ClassificationModel>(modelPath);

  // Optional threads hint nested under `config`.
  auto innerConfig =
      configObj.getOptionalProperty<jsu::Object>(env, "config");
  if (innerConfig.has_value()) {
    auto threadsOpt =
        innerConfig->getOptionalProperty<jsu::Number>(env, "threads");
    if (threadsOpt.has_value()) {
      model->setNumThreads(threadsOpt->as<int32_t>(env));
    }
  }

  model->load();

  addon_cpp::out_handl::OutputHandlers<addon_cpp::out_handl::JsOutputHandlerInterface>
      outHandlers;
  outHandlers.add(std::make_shared<JsClassifyOutputHandler>());

  auto callback = std::make_unique<addon_cpp::OutputCallBackJs>(
      env, args.get(0, "jsHandle"), args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = std::make_unique<addon_cpp::AddonJs>(
      env, std::move(callback),
      std::unique_ptr<addon_cpp::model::IModel>(std::move(model)));

  return addon_cpp::JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  addon_cpp::AddonJs& instance =
      addon_cpp::JsInterface::getInstance(env, args.get(0, "instance"));

  // The JS layer delivers a single message of type "image" carrying the
  // image buffer and, optionally, raw-RGB dimension metadata.
  auto inputObj = args.getJsObject(1, "inputObj");
  auto type =
      inputObj.getProperty<jsu::String>(env, "type").as<std::string>(env);
  if (type != "image") {
    throw StatusError(
        InvalidArgument,
        "Classification addon accepts only 'image' input type, got '" + type +
            "'");
  }

  ClassifyInput cppInput;

  // Image buffer: accept Uint8Array / Buffer (stored as TypedArray on the JS
  // side).
  auto bufferVal = inputObj.getProperty(env, "content");
  if (!jsu::is<jsu::TypedArray<uint8_t>>(env, bufferVal)) {
    throw StatusError(
        InvalidArgument,
        "Image 'content' must be a Uint8Array / Buffer of encoded JPEG/PNG "
        "bytes or raw RGB bytes.");
  }
  auto ta = jsu::TypedArray<uint8_t>(env, bufferVal);
  auto span = ta.as<std::span<const uint8_t>>(env);
  if (span.empty()) {
    throw StatusError(InvalidArgument, "Image 'content' buffer is empty");
  }
  cppInput.data.assign(span.begin(), span.end());

  // Optional dimension metadata for the raw-RGB path.
  auto widthOpt = inputObj.getOptionalProperty<jsu::Number>(env, "width");
  auto heightOpt = inputObj.getOptionalProperty<jsu::Number>(env, "height");
  auto channelsOpt =
      inputObj.getOptionalProperty<jsu::Number>(env, "channels");
  if (widthOpt.has_value()) {
    cppInput.width = widthOpt->as<uint32_t>(env);
  }
  if (heightOpt.has_value()) {
    cppInput.height = heightOpt->as<uint32_t>(env);
  }
  if (channelsOpt.has_value()) {
    cppInput.channels = channelsOpt->as<uint32_t>(env);
  }

  auto topKOpt = inputObj.getOptionalProperty<jsu::Number>(env, "topK");
  if (topKOpt.has_value()) {
    cppInput.topK = topKOpt->as<uint32_t>(env);
  }

  return instance.runJob(std::any(std::move(cppInput)));
}
JSCATCH

} // namespace qvac_lib_infer_ggml_classification::bindings
