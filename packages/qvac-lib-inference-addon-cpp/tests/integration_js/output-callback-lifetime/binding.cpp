#include <any>
#include <chrono>
#include <memory>
#include <string>
#include <thread>

#include <bare.h>
#include <js.h>

#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"
#include "qvac-lib-inference-addon-cpp/JsUtils.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/addon/AddonJs.hpp"
#include "qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp"

namespace {

namespace addon_cpp = qvac_lib_inference_addon_cpp;
namespace js = qvac_lib_inference_addon_cpp::js;

class EchoModel : public addon_cpp::model::IModel {
public:
  std::string getName() const override { return "EchoModel"; }

  std::any process(const std::any& input) override {
    return std::any_cast<std::string>(input);
  }

  addon_cpp::RuntimeStats runtimeStats() const override { return {}; }
};

js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);

  addon_cpp::out_handl::OutputHandlers<
      addon_cpp::out_handl::JsOutputHandlerInterface>
      outputHandlers;
  outputHandlers.add(
      std::make_shared<addon_cpp::out_handl::JsStringOutputHandler>());

  auto outputCallback = std::make_unique<addon_cpp::OutputCallBackJs>(
      env,
      args.get(0, "jsHandle"),
      args.getFunction(1, "outputCallback"),
      std::move(outputHandlers));

  auto addon = std::make_unique<addon_cpp::AddonJs>(
      env, std::move(outputCallback), std::make_unique<EchoModel>());

  return addon_cpp::JsInterface::createInstance(env, std::move(addon));
}
JSCATCH

js_value_t* runJob(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  auto& instance =
      addon_cpp::JsInterface::getInstance(env, args.get(0, "instance"));
  auto input = js::String(env, args.get(1, "input")).as<std::string>(env);
  instance.addonCpp->runJob(std::any(std::move(input)));
  return nullptr;
}
JSCATCH

js_value_t* blockEventLoop(js_env_t* env, js_callback_info_t* info) try {
  addon_cpp::JsArgsParser args(env, info);
  const auto ms =
      js::Number(env, args.get(0, "milliseconds")).as<int32_t>(env);
  std::this_thread::sleep_for(std::chrono::milliseconds(ms));
  return nullptr;
}
JSCATCH

js_value_t* outputCallbackLifetimeExports(js_env_t* env, js_value_t* exports) {
#define V(name, fn)                                                            \
  {                                                                            \
    js_value_t* val;                                                           \
    if (js_create_function(env, name, -1, fn, nullptr, &val) != 0) {           \
      return nullptr;                                                          \
    }                                                                          \
    if (js_set_named_property(env, exports, name, val) != 0) {                 \
      return nullptr;                                                          \
    }                                                                          \
  }

  V("createInstance", createInstance)
  V("runJob", runJob)
  V("blockEventLoop", blockEventLoop)
  V("destroyInstance", addon_cpp::JsInterface::destroyInstance)
#undef V

  return exports;
}

} // namespace

BARE_MODULE(output_callback_lifetime, outputCallbackLifetimeExports)
