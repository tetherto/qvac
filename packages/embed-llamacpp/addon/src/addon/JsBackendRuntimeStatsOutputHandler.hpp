#pragma once

#include <memory>
#include <string>

#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>

#include "utils/ModelBackendName.hpp"

namespace qvac_lib_inference_addon_embed::backend_reporting {

// The shared stats contract stays numeric. Only this addon's JS output gains
// the model's resolved backend name. Shared ownership keeps the metadata alive
// until queued callbacks have drained, including during model teardown.
class JsBackendRuntimeStatsOutputHandler final
    : public qvac_lib_inference_addon_cpp::out_handl::JsOutputHandlerInterface {
public:
  explicit JsBackendRuntimeStatsOutputHandler(
      std::shared_ptr<const RuntimeBackendName> backendName)
      : backendName_(std::move(backendName)) {}

  void setEnv(js_env_t* env) override {
    env_ = env;
    numericStats_.setEnv(env);
  }

  bool canHandle(const std::any& output) const override {
    return numericStats_.canHandle(output);
  }

  js_value_t* handleOutput(const std::any& output) const override {
    auto* value = numericStats_.handleOutput(output);
    const auto name = backendName_->get();
    if (!name.empty()) {
      qvac_lib_inference_addon_cpp::js::Object object{env_, value};
      object.setProperty(
          env_,
          "backendName",
          qvac_lib_inference_addon_cpp::js::String::create(env_, name));
    }
    return value;
  }

private:
  std::shared_ptr<const RuntimeBackendName> backendName_;
  qvac_lib_inference_addon_cpp::out_handl::JsRuntimeStatsOutputHandler
      numericStats_;
  js_env_t* env_ = nullptr;
};

} // namespace qvac_lib_inference_addon_embed::backend_reporting
