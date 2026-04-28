#pragma once

#include <memory>
#include <unordered_map>
#include <utility>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonCpp.hpp>
#include <inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackCpp.hpp>
#include <inference-addon-cpp/queue/OutputCallbackInterface.hpp>

#include "src/model-interface/TTSModel.hpp"

namespace qvac_lib_inference_addon_tts {

struct AddonInstance {
  std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp> addon;
  std::shared_ptr<
      qvac_lib_inference_addon_cpp::out_handl::CppQueuedOutputHandler<
          std::vector<int16_t>>>
      outputHandler;
};

inline AddonInstance createInstance(
    std::unordered_map<std::string, std::string> &&configMap,
    std::vector<float> &&referenceAudio = {}) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  unique_ptr<model::IModel> model =
      make_unique<qvac::ttslib::addon_model::TTSModel>(
          std::move(configMap), std::move(referenceAudio));

  auto outHandler =
      make_shared<out_handl::CppQueuedOutputHandler<vector<int16_t>>>();
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>> outHandlers;
  outHandlers.add(outHandler);
  unique_ptr<OutputCallBackInterface> callback =
      make_unique<OutputCallBackCpp>(std::move(outHandlers));

  auto addon = make_unique<AddonCpp>(std::move(callback), std::move(model));

  return {std::move(addon), std::move(outHandler)};
}

} // namespace qvac_lib_inference_addon_tts
