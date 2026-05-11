#pragma once

#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <js.h>
#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <inference-addon-cpp/queue/OutputQueue.hpp>

#include "model-interface/ClassificationModel.hpp"

namespace classification_ggml::bindings {

namespace addon_cpp = qvac_lib_inference_addon_cpp;
namespace jsu = qvac_lib_inference_addon_cpp::js;

using qvac_errors::StatusError;
using qvac_errors::general_error::InvalidArgument;

/// `QVAC_CLASSIFICATION_TRACE=1` dumps each marshalled entry to stderr.
struct JsClassifyOutputHandler
    : addon_cpp::out_handl::JsBaseOutputHandler<ClassifyOutput> {
  JsClassifyOutputHandler()
      : JsBaseOutputHandler<ClassifyOutput>(
            [this](const ClassifyOutput& cppOut) -> js_value_t* {
              auto array = jsu::Array::create(this->env_);
              const bool trace = []() {
                const char* v = std::getenv("QVAC_CLASSIFICATION_TRACE");
                return v != nullptr && v[0] == '1';
              }();

              for (size_t i = 0; i < cppOut.results.size(); ++i) {
                const std::string& label = cppOut.results[i].label;
                const double confidence =
                    static_cast<double>(cppOut.results[i].confidence);

                if (trace) {
                  std::fprintf(
                      stderr,
                      "[qvac-classify-marshal] i=%zu label='%s' "
                      "confidence=%.9f\n",
                      i,
                      label.c_str(),
                      confidence);
                  std::fflush(stderr);
                }

                auto entry = jsu::Object::create(this->env_);
                entry.setProperty(
                    this->env_,
                    "label",
                    jsu::String::create(this->env_, label));
                entry.setProperty(
                    this->env_,
                    "confidence",
                    jsu::Number::create(this->env_, confidence));
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
  if (modelPath.empty()) {
    throw StatusError(
        InvalidArgument,
        "Configuration 'path' is required and must be a non-empty string "
        "pointing at the FP16 GGUF weights file");
  }

  auto model = std::make_unique<ClassificationModel>(modelPath);

  auto innerConfig =
      configObj.getOptionalProperty<jsu::Object>(env, "config");
  if (innerConfig.has_value()) {
    auto backendsDirOpt =
        innerConfig->getOptionalProperty<jsu::String>(env, "backendsDir");
    if (backendsDirOpt.has_value()) {
      model->setBackendsDir(backendsDirOpt->as<std::string>(env));
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

  // Error wording is a test contract: integration suite asserts on the
  // substrings "required" / "null" / "undefined" for the null-input case.
  auto bufferVal = inputObj.getProperty(env, "content");
  if (!jsu::is<jsu::TypedArray<uint8_t>>(env, bufferVal)) {
    throw StatusError(
        InvalidArgument,
        "Image 'content' is required and must be a Uint8Array / Buffer of "
        "encoded JPEG/PNG bytes or raw RGB bytes (got null, undefined, or "
        "wrong type)");
  }
  auto ta = jsu::TypedArray<uint8_t>(env, bufferVal);
  auto span = ta.as<std::span<const uint8_t>>(env);
  if (span.empty()) {
    throw StatusError(InvalidArgument, "Image 'content' buffer is empty");
  }
  cppInput.data.assign(span.begin(), span.end());

  // {width, height, channels} are an all-or-nothing trio: zero present
  // means encoded JPEG/PNG, three present means raw RGB.
  auto widthOpt = inputObj.getOptionalProperty<jsu::Number>(env, "width");
  auto heightOpt = inputObj.getOptionalProperty<jsu::Number>(env, "height");
  auto channelsOpt =
      inputObj.getOptionalProperty<jsu::Number>(env, "channels");
  const int provided = (widthOpt.has_value() ? 1 : 0) +
                       (heightOpt.has_value() ? 1 : 0) +
                       (channelsOpt.has_value() ? 1 : 0);
  if (provided != 0 && provided != 3) {
    throw StatusError(
        InvalidArgument,
        "Raw RGB input requires all of 'width', 'height', and 'channels' "
        "to be provided together; received " + std::to_string(provided) +
        " of 3");
  }
  if (provided == 3) {
    // bare-runtime's `as<uint32_t>` static_casts negatives to ~4 billion;
    // pull the int32_t view first to range-check meaningfully.
    const int32_t w = widthOpt->as<int32_t>(env);
    const int32_t h = heightOpt->as<int32_t>(env);
    const int32_t c = channelsOpt->as<int32_t>(env);
    if (w <= 0) {
      throw StatusError(
          InvalidArgument,
          "Image 'width' must be a positive integer when passing raw RGB "
          "bytes; got " + std::to_string(w));
    }
    if (h <= 0) {
      throw StatusError(
          InvalidArgument,
          "Image 'height' must be a positive integer when passing raw RGB "
          "bytes; got " + std::to_string(h));
    }
    if (c != 3) {
      throw StatusError(
          InvalidArgument,
          "Image 'channels' must be exactly 3 (RGB) when passing raw RGB "
          "bytes; got " + std::to_string(c));
    }
    cppInput.rawRgb = RawRgbDims{
        static_cast<uint32_t>(w), static_cast<uint32_t>(h),
        static_cast<uint32_t>(c)};
  }

  auto topKOpt = inputObj.getOptionalProperty<jsu::Number>(env, "topK");
  if (topKOpt.has_value()) {
    const int32_t topK = topKOpt->as<int32_t>(env);
    if (topK <= 0) {
      throw StatusError(
          InvalidArgument,
          "Image 'topK' must be a positive integer when provided; got " +
              std::to_string(topK));
    }
    cppInput.topK = static_cast<uint32_t>(topK);
  }

  return instance.runJob(std::any(std::move(cppInput)));
}
JSCATCH

} // namespace classification_ggml::bindings
