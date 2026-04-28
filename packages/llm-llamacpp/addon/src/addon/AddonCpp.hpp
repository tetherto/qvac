#pragma once

#include <memory>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackInterface.hpp>

#include "model-interface/LlamaModel.hpp"

namespace qvac_lib_inference_addon_llama {

struct AddonInstance {
  std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp> addon;
  std::shared_ptr<qvac_lib_inference_addon_cpp::out_handl::
                      CppQueuedOutputHandler<std::string>>
      outputHandler;
};

/// @brief Creates a pure C++ Addon (no Js dependencies). Can be used on CLI or
/// C++ tests.
inline AddonInstance createInstance(
    std::string&& model_path, std::string&& projector_path,
    std::unordered_map<std::string, std::string>&& config_files) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  unique_ptr<model::IModel> model = make_unique<LlamaModel>(
      std::move(model_path),
      std::move(projector_path),
      std::move(config_files));

  auto outHandler = make_shared<out_handl::CppQueuedOutputHandler<string>>();
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outHandlers;
  outHandlers.add(outHandler);
  unique_ptr<OutputCallBackInterface> callback =
      make_unique<OutputCallBackCpp>(std::move(outHandlers));

  auto addon = make_unique<AddonCpp>(std::move(callback), std::move(model));

  return {std::move(addon), std::move(outHandler)};
}
} // namespace qvac_lib_inference_addon_llama
