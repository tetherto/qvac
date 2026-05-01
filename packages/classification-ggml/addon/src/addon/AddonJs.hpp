#pragma once

#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <js.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>
#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputQueue.hpp>

#include "model-interface/ClassificationModel.hpp"

namespace qvac_lib_infer_ggml_classification::bindings {

namespace addon_cpp = qvac_lib_inference_addon_cpp;
namespace jsu = qvac_lib_inference_addon_cpp::js;

using qvac_errors::StatusError;
using qvac_errors::general_error::InvalidArgument;

/// Handler mapping ClassifyOutput → JS array of { label, confidence }.
///
/// Set `QVAC_CLASSIFICATION_TRACE=1` to dump each marshalled entry to
/// stderr; useful when diagnosing numerical issues end-to-end.
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

  // Single-place parsing & validation of the JS-side configuration
  // object. The JS wrapper passes config straight through; this is
  // where every "is it a string / positive integer / present" rule
  // lives, so there is one source of truth for what counts as a
  // valid construction argument.
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

  // Optional threads hint nested under `config`. When provided it
  // must be a positive integer; bare-runtime's `as<int32_t>` truncates
  // floats and accepts negatives without complaint, so we range-check
  // explicitly.
  auto innerConfig =
      configObj.getOptionalProperty<jsu::Object>(env, "config");
  if (innerConfig.has_value()) {
    auto threadsOpt =
        innerConfig->getOptionalProperty<jsu::Number>(env, "threads");
    if (threadsOpt.has_value()) {
      const int32_t threads = threadsOpt->as<int32_t>(env);
      if (threads < 1) {
        throw StatusError(
            InvalidArgument,
            "Configuration 'config.threads' must be a positive integer "
            "when provided; got " + std::to_string(threads));
      }
      model->setNumThreads(threads);
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

  // Single-place parsing & validation of the JS-side per-call payload.
  // Every "is the argument the right type / range / shape" rule for
  // a classify() call lives here, so the JS wrapper can be a thin
  // pass-through and the model + preprocessor only ever operate on
  // an already-validated `ClassifyInput`.
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

  // Image buffer: accept Uint8Array / Buffer (stored as TypedArray on the
  // JS side). The "is required" wording in the message is the contract
  // surface; existing JS-side tests assert against the substring
  // "required" / "null" / "undefined" for the null-input path.
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

  // Optional dimension metadata for the raw-RGB path. Either:
  //   - none of {width, height, channels} are provided  -> encoded JPEG/PNG
  //   - all three are provided and validated            -> raw RGB
  // Anything in between is a programming error in the caller; reject
  // explicitly rather than letting validateRawRgb produce a confusing
  // size-mismatch error downstream.
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
    // bare-runtime's `as<uint32_t>` does a static_cast on a possibly-
    // negative or fractional JS Number; range-check the int32_t view
    // first so a negative width does not silently wrap to ~4 billion
    // and tunnel into validateRawRgb as a buffer-size mismatch.
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

} // namespace qvac_lib_infer_ggml_classification::bindings
