#pragma once

#include <memory>
#include <unordered_map>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackInterface.hpp>

#include "model-interface/BertModel.hpp"

namespace qvac_lib_inference_addon_embed {

struct AddonInstance {
  std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp> addon;
  std::shared_ptr<qvac_lib_inference_addon_cpp::out_handl::
                      CppQueuedOutputHandler<BertEmbeddings>>
      outputHandler;
};

/// @brief Creates a pure C++ Addon (no Js dependencies). Can be used on CLI or
/// C++ tests.
inline AddonInstance createInstance(
    std::string&& path, std::unordered_map<std::string, std::string>&& config,
    std::string&& backendsDir) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  auto model = make_unique<BertModel>(
      std::move(path), std::move(config), std::move(backendsDir));

  auto outHandler =
      make_shared<out_handl::CppQueuedOutputHandler<BertEmbeddings>>();
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outHandlers;
  outHandlers.add(outHandler);
  unique_ptr<OutputCallBackInterface> callback =
      make_unique<OutputCallBackCpp>(std::move(outHandlers));

  auto addon = make_unique<AddonCpp>(std::move(callback), std::move(model));

  return {.addon = std::move(addon), .outputHandler = std::move(outHandler)};
}
} // namespace qvac_lib_inference_addon_embed
