#pragma once

#include <algorithm>
#include <any>
#include <memory>
#include <string>
#include <variant>

#include <inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>

#include "utils/ModelBackendName.hpp"

namespace qvac_lib_inference_addon_llama::backend_reporting {

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
    auto stats =
        std::any_cast<qvac_lib_inference_addon_cpp::RuntimeStats>(output);
    std::string name;
    std::erase_if(stats, [this, &name](const auto& stat) {
      if (stat.first != K_BACKEND_NAME_ID) {
        return false;
      }
      if (const auto* id = std::get_if<int64_t>(&stat.second)) {
        name = backendName_->get(*id);
      }
      return true;
    });
    auto* value = numericStats_.handleOutput(std::any{std::move(stats)});
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

} // namespace qvac_lib_inference_addon_llama::backend_reporting
