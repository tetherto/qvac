#pragma once

#include <memory>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackInterface.hpp>

#include "pipeline/Pipeline.hpp"

namespace qvac_lib_inference_addon_onnx_ocr_fasttext {

struct AddonInstance {
  std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp> addon;
  std::shared_ptr<qvac_lib_inference_addon_cpp::out_handl::
                      CppQueuedOutputHandler<Pipeline::Output>>
      outputHandler;
};

/// @brief Creates a pure C++ Addon (no Js dependencies). Can be used on CLI or
/// C++ tests.
inline AddonInstance createInstance(
    const ORTCHAR_T* pathDetector, const ORTCHAR_T* pathRecognizer,
    std::span<const std::string> langList, bool useGPU = true,
    int timeout = Pipeline::DEFAULT_PIPELINE_TIMEOUT_SECONDS,
    const Pipeline::Config& config = Pipeline::Config{}) {
  using namespace qvac_lib_inference_addon_cpp;
  using namespace std;

  auto model = make_unique<Pipeline>(
      pathDetector, pathRecognizer, langList, useGPU, timeout, config);

  auto outHandler =
      make_shared<out_handl::CppQueuedOutputHandler<Pipeline::Output>>();
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outHandlers;
  outHandlers.add(outHandler);
  unique_ptr<OutputCallBackInterface> callback =
      make_unique<OutputCallBackCpp>(std::move(outHandlers));

  auto addon = make_unique<AddonCpp>(std::move(callback), std::move(model));

  return {std::move(addon), std::move(outHandler)};
}
} // namespace qvac_lib_inference_addon_onnx_ocr_fasttext
