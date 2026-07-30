#pragma once

// Pure-C++ (no JS runtime) addon entry points, used by the gtest suites.
// One instance-factory per engine: the two engines register different
// output-handler sets (whisper emits single Transcripts alongside arrays;
// parakeet emits arrays only), so the structs stay separate.

#include <memory>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/addon/AddonCpp.hpp>
#include <inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackCpp.hpp>

#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/WhisperTypes.hpp"
#include "model-interface/parakeet/ParakeetConfig.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"
#include "model-interface/whisper/WhisperConfig.hpp"
#include "model-interface/whisper/WhisperModel.hpp"

namespace qvac::asrggml::addon_cpp {

struct WhisperAddonInstance {
  std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp> addon;
  std::shared_ptr<qvac_lib_inference_addon_cpp::out_handl::
                      CppQueuedOutputHandler<whisper::Transcript>>
      transcriptOutput;
  std::shared_ptr<qvac_lib_inference_addon_cpp::out_handl::
                      CppQueuedOutputHandler<std::vector<whisper::Transcript>>>
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

inline WhisperAddonInstance
createWhisperInstance(whisper::WhisperConfig&& config) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  unique_ptr<model::IModel> model =
      make_unique<whisper::WhisperModel>(std::move(config));

  auto transcriptOutput =
      make_shared<out_handl::CppQueuedOutputHandler<whisper::Transcript>>();
  auto transcriptArrayOutput = make_shared<
      out_handl::CppQueuedOutputHandler<std::vector<whisper::Transcript>>>();
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

struct ParakeetAddonInstance {
  std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp> addon;
  std::shared_ptr<qvac_lib_inference_addon_cpp::out_handl::
                      CppQueuedOutputHandler<std::vector<parakeet::Transcript>>>
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

inline ParakeetAddonInstance
createParakeetInstance(parakeet::ParakeetConfig&& config) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  unique_ptr<model::IModel> model =
      make_unique<parakeet::ParakeetModel>(std::move(config));

  auto transcriptOutput = make_shared<
      out_handl::CppQueuedOutputHandler<vector<parakeet::Transcript>>>();
  auto statsOutput =
      make_shared<out_handl::CppQueuedOutputHandler<RuntimeStats>>();
  auto errorOutput =
      make_shared<out_handl::CppQueuedOutputHandler<Output::Error>>();

  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outputHandlers;
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

} // namespace qvac::asrggml::addon_cpp
