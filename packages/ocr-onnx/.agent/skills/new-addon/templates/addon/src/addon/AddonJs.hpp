#pragma once

#include <any>
#include <memory>
#include <string>

#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>
#include <qvac-lib-inference-addon-cpp/JsUtils.hpp>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>

#include "AddonCpp.hpp"
#include "../model-interface/HelloModel.hpp"

namespace {{CPP_NAMESPACE}} {

// Simple synchronous demo kept from the hello-world scaffold. Useful as a
// "proof of life" and exercised by test/integration/addon.test.js.
inline js_value_t* sayHello(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  std::string name = js::String(env, args.get(0, "name")).as<std::string>(env);

  std::string greeting = HelloWorld::greet(name);

  js_value_t* result = nullptr;
  js_create_string_utf8(
      env,
      reinterpret_cast<const utf8_t*>(greeting.data()),
      greeting.size(),
      &result);
  return result;
}
JSCATCH

// Full AddonJs pattern shared by every real addon (embed/llm/nmt/whisper/…):
// parse args → build Model → register output handler(s) → wrap in
// OutputCallBackJs → construct AddonJs → register via JsInterface.
// Extend by swapping HelloModel for your backend-backed Model and choosing the
// output handler that matches its OutputType.
inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);

  auto model = std::make_unique<HelloModel>();

  out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
  outHandlers.add(std::make_shared<out_handl::JsStringOutputHandler>());

  std::unique_ptr<OutputCallBackInterface> callback =
      std::make_unique<OutputCallBackJs>(
          env,
          args.get(0, "jsHandle"),
          args.getFunction(2, "outputCallback"),
          std::move(outHandlers));

  auto addon =
      std::make_unique<AddonJs>(env, std::move(callback), std::move(model));

  return JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  using namespace qvac_lib_inference_addon_cpp;

  JsArgsParser args(env, info);
  std::any input;
  {
    auto [type, jsInput] = JsInterface::getInput(args);
    if (type == "text") {
      input = js::String(env, jsInput).as<std::string>(env);
    } else {
      throw StatusError(
          general_error::InvalidArgument, "Unknown input type: " + type);
    }
  }
  return JsInterface::getInstance(env, args.get(0, "instance"))
      .runJob(std::move(input));
}
JSCATCH

} // namespace {{CPP_NAMESPACE}}
