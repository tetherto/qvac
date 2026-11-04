#pragma once

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <inference-addon-cpp/Errors.hpp>
#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>
#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonJs.hpp>
#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <inference-addon-cpp/queue/OutputQueue.hpp>
#include <js.h>

#include "model-interface/ImagePreprocessor.hpp"
#include "model-interface/megaloc/MegaLocModel.hpp"
#include "model-interface/mobilenet/ClassificationModel.hpp"

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

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
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

  auto modelTypeOpt =
      configObj.getOptionalProperty<jsu::String>(env, "modelType");
  const std::string modelType =
      modelTypeOpt ? modelTypeOpt->as<std::string>(env) : "mobilenet";
  std::string backendsDir;
  megaloc::Config megaConfig{modelPath};
  auto innerConfig = configObj.getOptionalProperty<jsu::Object>(env, "config");
  if (innerConfig.has_value()) {
    auto backendsDirOpt =
        innerConfig->getOptionalProperty<jsu::String>(env, "backendsDir");
    if (backendsDirOpt.has_value()) {
      backendsDir = backendsDirOpt->as<std::string>(env);
    }
    if (auto backend =
            innerConfig->getOptionalProperty<jsu::String>(env, "backend")) {
      megaConfig.backend = backend->as<std::string>(env);
    }
    if (auto threads =
            innerConfig->getOptionalProperty<jsu::Number>(env, "threads")) {
      const double value = threads->as<double>(env);
      if (!std::isfinite(value) || value < 1 || value > 1024 ||
          std::floor(value) != value)
        throw StatusError(
            InvalidArgument, "threads must be an integer between 1 and 1024");
      megaConfig.threads = static_cast<int>(value);
    }
  }
  std::unique_ptr<addon_cpp::model::IModel> model;
  if (modelType == "mobilenet") {
    auto classifier = std::make_unique<ClassificationModel>(modelPath);
    classifier->setBackendsDir(backendsDir);
    classifier->load();
    model = std::move(classifier);
  } else if (modelType == "megaloc") {
    megaConfig.backendsDir = backendsDir;
    auto embedding =
        std::make_unique<megaloc::MegaLocModel>(std::move(megaConfig));
    model = std::move(embedding);
  } else {
    throw StatusError(
        InvalidArgument, "Unsupported vision modelType: " + modelType);
  }

  addon_cpp::out_handl::OutputHandlers<
      addon_cpp::out_handl::JsOutputHandlerInterface>
      outHandlers;
  outHandlers.add(std::make_shared<JsClassifyOutputHandler>());
  outHandlers.add(
      std::make_shared<
          addon_cpp::out_handl::JsTypedArrayOutputHandler<float>>());

  auto callback = std::make_unique<addon_cpp::OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = std::make_unique<addon_cpp::AddonJs>(
      env,
      std::move(callback),
      std::unique_ptr<addon_cpp::model::IModel>(std::move(model)));

  return addon_cpp::JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* activate(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  auto& instance =
      addon_cpp::JsInterface::getInstance(env, args.get(0, "instance"));
  auto addon = instance.addonCpp;
  if (dynamic_cast<megaloc::MegaLocModel*>(&addon->model.get())) {
    return jsu::JsAsyncTask::run(env, [addon = std::move(addon)] {
      dynamic_cast<megaloc::MegaLocModel&>(addon->model.get()).load();
    });
  }
  return addon_cpp::JsInterface::activate(env, info);
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  addon_cpp::AddonJs& instance =
      addon_cpp::JsInterface::getInstance(env, args.get(0, "instance"));

  auto inputObj = args.getJsObject(1, "inputObj");
  auto type =
      inputObj.getProperty<jsu::String>(env, "type").as<std::string>(env);
  if (type != "image" && type != "embedding") {
    throw StatusError(
        InvalidArgument,
        "Classification addon accepts only 'image' or 'embedding' input types, "
        "got '" +
            type + "'");
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
  auto channelsOpt = inputObj.getOptionalProperty<jsu::Number>(env, "channels");
  const int provided = (widthOpt.has_value() ? 1 : 0) +
                       (heightOpt.has_value() ? 1 : 0) +
                       (channelsOpt.has_value() ? 1 : 0);
  if (provided != 0 && provided != 3) {
    throw StatusError(
        InvalidArgument,
        "Raw RGB input requires all of 'width', 'height', and 'channels' "
        "to be provided together; received " +
            std::to_string(provided) + " of 3");
  }
  if (provided == 3) {
    // Preserve MobileNet's truncation; embedding dimensions are strict.
    const bool embedding = type == "embedding";
    const auto number = [embedding, env](jsu::Number value) {
      const double raw = value.as<double>(env);
      return embedding ? raw : std::trunc(raw);
    };
    const double w = number(*widthOpt);
    const double h = number(*heightOpt);
    const double c = number(*channelsOpt);
    const double maximum = embedding ? preprocess::MAX_IMAGE_DIMENSION
                                     : std::numeric_limits<int32_t>::max();
    if (!std::isfinite(w) || w <= 0 || std::floor(w) != w || w > maximum) {
      throw StatusError(
          InvalidArgument,
          "Image 'width' must be a positive integer when passing raw RGB "
          "bytes; got " +
              std::to_string(w));
    }
    if (!std::isfinite(h) || h <= 0 || std::floor(h) != h || h > maximum) {
      throw StatusError(
          InvalidArgument,
          "Image 'height' must be a positive integer when passing raw RGB "
          "bytes; got " +
              std::to_string(h));
    }
    if (c != 3) {
      throw StatusError(
          InvalidArgument,
          "Image 'channels' must be exactly 3 (RGB) when passing raw RGB "
          "bytes; got " +
              std::to_string(c));
    }
    cppInput.rawRgb = RawRgbDims{
        static_cast<uint32_t>(w),
        static_cast<uint32_t>(h),
        static_cast<uint32_t>(c)};
  }

  auto topKOpt = inputObj.getOptionalProperty<jsu::Number>(env, "topK");
  if (type == "embedding" && topKOpt)
    throw StatusError(
        InvalidArgument, "topK is not supported for image embeddings");
  if (topKOpt.has_value()) {
    const double topK = std::trunc(topKOpt->as<double>(env));
    if (!std::isfinite(topK) || topK <= 0 ||
        topK > std::numeric_limits<int32_t>::max()) {
      throw StatusError(
          InvalidArgument,
          "Image 'topK' must be a positive integer when provided; got " +
              std::to_string(topK));
    }
    cppInput.topK = static_cast<uint32_t>(topK);
  }

  if (type == "embedding") {
    ImageInput image;
    image.data = std::move(cppInput.data);
    image.rawRgb = cppInput.rawRgb;
    return instance.runJob(std::any(std::move(image)));
  }

  return instance.runJob(std::any(std::move(cppInput)));
}
JSCATCH

} // namespace classification_ggml::bindings
