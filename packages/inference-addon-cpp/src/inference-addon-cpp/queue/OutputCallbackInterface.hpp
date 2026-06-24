#pragma once

#include <memory>

namespace qvac_lib_inference_addon_cpp {
class OutputQueue;

struct OutputCallBackInterface {
  virtual ~OutputCallBackInterface() = default;
  OutputCallBackInterface() = default;
  OutputCallBackInterface(OutputCallBackInterface&) = delete;
  OutputCallBackInterface& operator=(OutputCallBackInterface&) = delete;

  /// @brief Initialize the processing thread which will be used to process the
  /// outputs and call the callback function.
  virtual void
  initializeProcessingThread(std::shared_ptr<OutputQueue> outputQueue) = 0;

  /// @brief Notify the callback that a new output is available.
  virtual void notify() = 0;

  /// @brief Stop the callback; no further outputs will be processed.
  /// Call before destruction for clean shutdown.
  virtual void stop() = 0;
};
} // namespace qvac_lib_inference_addon_cpp
