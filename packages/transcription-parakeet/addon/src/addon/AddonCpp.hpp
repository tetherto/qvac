#pragma once

#include <memory>
#include <vector>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp>

#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/parakeet/ParakeetConfig.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"

namespace qvac_lib_infer_parakeet {

struct AddonInstance {
  std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp> addon;
  std::shared_ptr<
      qvac_lib_inference_addon_cpp::out_handl::CppQueuedOutputHandler<
          std::vector<Transcript>>>
      transcriptOutput;
  std::shared_ptr<
      qvac_lib_inference_addon_cpp::out_handl::CppQueuedOutputHandler<
          qvac_lib_inference_addon_cpp::RuntimeStats>>
      statsOutput;
  std::shared_ptr<
      qvac_lib_inference_addon_cpp::out_handl::CppQueuedOutputHandler<
          qvac_lib_inference_addon_cpp::Output::Error>>
      errorOutput;
};

inline AddonInstance createInstance(ParakeetConfig&& config) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  unique_ptr<model::IModel> model =
      make_unique<ParakeetModel>(std::move(config));

  auto transcriptOutput =
      make_shared<out_handl::CppQueuedOutputHandler<vector<Transcript>>>();
  auto statsOutput = make_shared<out_handl::CppQueuedOutputHandler<RuntimeStats>>();
  auto errorOutput = make_shared<out_handl::CppQueuedOutputHandler<Output::Error>>();

  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>> outputHandlers;
  outputHandlers.add(transcriptOutput);
  outputHandlers.add(statsOutput);
  outputHandlers.add(errorOutput);

  unique_ptr<OutputCallBackInterface> callback =
      make_unique<OutputCallBackCpp>(std::move(outputHandlers));
  auto addon = make_unique<AddonCpp>(std::move(callback), std::move(model));

  return {
      std::move(addon),
      std::move(transcriptOutput),
      std::move(statsOutput),
      std::move(errorOutput)};
}

} // namespace qvac_lib_infer_parakeet
