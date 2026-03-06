#pragma once

#include <memory>
#include <vector>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp>

#include "model-interface/whisper.cpp/WhisperConfig.hpp"
#include "model-interface/whisper.cpp/WhisperModel.hpp"

namespace qvac_lib_inference_addon_whisper {

struct AddonInstance {
  std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp> addon;
  std::shared_ptr<qvac_lib_inference_addon_cpp::out_handl::
                      CppQueuedOutputHandler<Transcript>>
      transcriptOutput;
  std::shared_ptr<qvac_lib_inference_addon_cpp::out_handl::
                      CppQueuedOutputHandler<std::vector<Transcript>>>
      transcriptArrayOutput;
  std::shared_ptr<
      qvac_lib_inference_addon_cpp::out_handl::CppQueuedOutputHandler<
          qvac_lib_inference_addon_cpp::RuntimeStats>>
      statsOutput;
  std::shared_ptr<
      qvac_lib_inference_addon_cpp::out_handl::CppQueuedOutputHandler<
          qvac_lib_inference_addon_cpp::Output::Error>>
      errorOutput;
};

inline AddonInstance createInstance(WhisperConfig&& config) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  unique_ptr<model::IModel> model =
      make_unique<WhisperModel>(std::move(config));

  auto transcriptOutput =
      make_shared<out_handl::CppQueuedOutputHandler<Transcript>>();
  auto transcriptArrayOutput =
      make_shared<out_handl::CppQueuedOutputHandler<std::vector<Transcript>>>();
  auto statsOutput =
      make_shared<out_handl::CppQueuedOutputHandler<RuntimeStats>>();
  auto errorOutput =
      make_shared<out_handl::CppQueuedOutputHandler<Output::Error>>();

  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outputHandlers;
  outputHandlers.add(transcriptOutput);
  outputHandlers.add(transcriptArrayOutput);
  outputHandlers.add(statsOutput);
  outputHandlers.add(errorOutput);

  unique_ptr<OutputCallBackInterface> callback =
      make_unique<OutputCallBackCpp>(std::move(outputHandlers));
  auto addon = make_unique<AddonCpp>(std::move(callback), std::move(model));

  return {
      std::move(addon),
      std::move(transcriptOutput),
      std::move(transcriptArrayOutput),
      std::move(statsOutput),
      std::move(errorOutput)};
}

} // namespace qvac_lib_inference_addon_whisper
