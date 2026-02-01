#include "qvac-lib-infer-llamacpp-embed.hpp"

#include <memory>
#include <vector>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/Addon.hpp"
#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

using BertInterface = qvac_lib_inference_addon_cpp::JsInterface<
    qvac_lib_infer_llamacpp_embed::Addon>;
using JsLogger = qvac_lib_inference_addon_cpp::logger::JsLogger;

// Specialization of JsInterface methods for Bert addon
namespace qvac_lib_inference_addon_cpp {

template <>
js_value_t*
BertInterface::createInstance(js_env_t* env, js_callback_info_t* info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 4) {
    throw StatusError{general_error::InvalidArgument, "Expected 4 parameters"};
  }
  if (!js::is<js::Object>(env, args[1])) {
    throw StatusError{
        general_error::InvalidArgument,
        "Expected configurationParams as object"};
  }
  if (!js::is<js::Function>(env, args[2])) {
    throw StatusError{
        general_error::InvalidArgument, "Expected output callback as function"};
  }
  js_value_t* prop = nullptr;
  JS(js_get_named_property(env, args[1], "path", &prop));
  auto modelPath = js::String{env, prop}.as<std::string>(env);
  JS(js_get_named_property(env, args[1], "config", &prop));
  auto config = js::String{env, prop}.as<std::string>(env);
  JS(js_get_named_property(env, args[1], "backendsDir", &prop));
  auto backendsDir = js::String{env, prop}.as<std::string>(env);
  std::scoped_lock lockGuard{instancesMtx_};
  auto& handle = instances_.emplace_back(
      std::make_unique<::qvac_lib_infer_llamacpp_embed::Addon>(
          env,
          std::cref(modelPath),
          std::cref(config),
          std::cref(backendsDir),
          args[0],
          args[2],
          args[3]));
  return js::External::create(env, handle.get());
}
JSCATCH

template <>
js_value_t* BertInterface::append(js_env_t* env, js_callback_info_t* info) try {
  auto args = js::getArguments(env, info);
  if (args.size() != 2) {
    throw StatusError{general_error::InvalidArgument, "Expected 2 parameters"};
  }
  auto toAppend = js::Object{env, args[1]};
  auto type =
      toAppend.getProperty<js::String>(env, "type").as<std::string>(env);
  auto& instance = getInstance(env, args[0]);
  if (type == "end of job") {
    return js::Number::create(env, instance.endOfJob());
  }
  if (type == "text") {
    int priority = getAppendPriority(env, toAppend);
    auto input =
        toAppend.getProperty<js::String>(env, "input").as<std::string>(env);
    return js::Number::create(env, instance.append(priority, input));
  }
  if (type == "sequences") {
    int priority = getAppendPriority(env, toAppend);
    auto inputProp = toAppend.getProperty(env, "input");
    if (!js::is<js::Array>(env, inputProp)) {
      throw StatusError{
          general_error::InvalidArgument, "Expected array for sequences type"};
    }
    // Convert JS array to std::vector<std::string>
    std::vector<std::string> sequences;
    js::Array arr{env, inputProp};
    size_t len = arr.size(env);
    sequences.reserve(len);
    for (size_t i = 0; i < len; i++) {
      auto elem = arr.get<js::String>(env, i);
      sequences.push_back(elem.as<std::string>(env));
    }
    return js::Number::create(env, instance.append(priority, sequences));
  }
  throw StatusError{general_error::InvalidArgument, "Invalid type"};
}
JSCATCH

} // namespace qvac_lib_inference_addon_cpp

namespace qvac_lib_infer_llamacpp_embed {
js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::createInstance(env, info);
}

js_value_t* loadWeights(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::loadWeights(env, info);
}

js_value_t* activate(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::activate(env, info);
}

js_value_t* append(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::append(env, info);
}

js_value_t* status(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::status(env, info);
}

js_value_t* pause(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::pause(env, info);
}

js_value_t* stop(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::stop(env, info);
}

js_value_t* cancel(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::cancel(env, info);
}

js_value_t* destroyInstance(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::destroyInstance(env, info);
}

js_value_t* setLogger(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::setLogger(env, info);
}

js_value_t* releaseLogger(js_env_t* env, js_callback_info_t* info) {
  return BertInterface::releaseLogger(env, info);
}
} // namespace qvac_lib_infer_llamacpp_embed
