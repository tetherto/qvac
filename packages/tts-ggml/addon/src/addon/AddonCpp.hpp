#pragma once

// Generic AddonCpp helper used by the C++ unit tests in addon/tests/.
//
// The production AddonJs path (addon/src/addon/AddonJs.hpp) wires up
// js_value_t* output handlers tied to the Bare runtime; the C++ test
// suite needs an equivalent factory that uses the pure-C++
// CppQueuedOutputHandlers instead so tests can pop synthesis results,
// stats, and errors without spinning up an embedded JS engine.
//
// The helper is generic over `IModel` so AddonCppTest can drive it with
// a mock model (e.g. BlockingBusyModel) — constructing a real
// ChatterboxModel / SupertonicModel from C++ requires a real GGUF on
// disk and is therefore covered by the QVAC_TEST_GGUF-gated
// integration tests in test_chatterbox_config.cpp / test_supertonic_config.cpp.

#include <cstdint>
#include <memory>
#include <utility>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>
#include <inference-addon-cpp/addon/AddonCpp.hpp>
#include <inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp>
#include <inference-addon-cpp/handlers/OutputHandler.hpp>
#include <inference-addon-cpp/queue/OutputCallbackCpp.hpp>

namespace qvac::ttsggml {

struct AddonInstance {
  std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp> addon;
  std::shared_ptr<
      qvac_lib_inference_addon_cpp::out_handl::CppQueuedOutputHandler<
          std::vector<int16_t>>>
      audioOutput;
  std::shared_ptr<
      qvac_lib_inference_addon_cpp::out_handl::CppQueuedOutputHandler<
          qvac_lib_inference_addon_cpp::RuntimeStats>>
      statsOutput;
  std::shared_ptr<
      qvac_lib_inference_addon_cpp::out_handl::CppQueuedOutputHandler<
          qvac_lib_inference_addon_cpp::Output::Error>>
      errorOutput;
};

inline AddonInstance createInstance(
    std::unique_ptr<qvac_lib_inference_addon_cpp::model::IModel> model) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  auto audioOutput =
      make_shared<out_handl::CppQueuedOutputHandler<vector<int16_t>>>();
  auto statsOutput =
      make_shared<out_handl::CppQueuedOutputHandler<RuntimeStats>>();
  auto errorOutput =
      make_shared<out_handl::CppQueuedOutputHandler<Output::Error>>();

  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outputHandlers;
  outputHandlers.add(audioOutput);
  outputHandlers.add(statsOutput);
  outputHandlers.add(errorOutput);

  unique_ptr<OutputCallBackInterface> callback =
      make_unique<OutputCallBackCpp>(std::move(outputHandlers));

  auto addon =
      make_unique<AddonCpp>(std::move(callback), std::move(model));

  return {
      std::move(addon),
      std::move(audioOutput),
      std::move(statsOutput),
      std::move(errorOutput)};
}

}
