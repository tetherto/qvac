#pragma once
#include <memory>
#include <unordered_map>

#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "model-interface/BertModel.hpp"

namespace qvac_lib_inference_addon_embed {

inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  JsArgsParser args(env, info);

  auto model = make_unique<BertModel>(
      args.getMapEntry(1, "path"),
      args.getSubmap(1, "config"),
      args.getMapEntry(1, "backendsDir"));

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(
      make_shared<out_handl::Js2DArrayOutputHandler<BertEmbeddings, float>>());
  unique_ptr<OutputCallBackInterface> callback = make_unique<OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(2, "outputCallback"),
      std::move(outHandlers));

  auto addon = make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  auto parseSequences = [&](js::Object inputObj) -> std::vector<std::string> {
    if (!js::is<js::Array>(env, inputObj)) {
      throw StatusError{
          general_error::InvalidArgument, "Expected array for sequences type"};
    }
    std::vector<std::string> sequences;
    js::Array arr{env, inputObj};
    size_t len = arr.size(env);
    sequences.reserve(len);
    for (size_t i = 0; i < len; i++) {
      auto elem = arr.get<js::String>(env, i);
      sequences.push_back(elem.as<std::string>(env));
    }
    return sequences;
  };

  JsArgsParser args(env, info);
  any input;
  {
    auto [type, jsInput] = JsInterface::getInput(args);
    if (type == "text") {
      input = js::String(env, jsInput).as<std::string>(env);
    } else if (type == "sequences") {
      input = parseSequences(js::Object(env, jsInput));
    } else {
      throw StatusError(
          general_error::InvalidArgument, "Unknown input type: " + type);
    }
  }
  return JsInterface::getInstance(env, args.get(0, "instance"))
      .runJob(std::move(input));
}
JSCATCH

} // namespace qvac_lib_inference_addon_embed
