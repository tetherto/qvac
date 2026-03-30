// Pure C++ Callback (no Js dependencies). Can be used on CLI or C++ tests.
#pragma once

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>

#include "../Logger.hpp"
#include "../Utils.hpp"
#include "../handlers/CppOutputHandlerImplementations.hpp"
#include "../handlers/OutputHandler.hpp"
#include "OutputCallbackInterface.hpp"
#include "OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

class OutputCallBackCpp : public OutputCallBackInterface {

  std::mutex mtx_;
  std::condition_variable cv_;
  std::shared_ptr<OutputQueue> outputQueue_ = nullptr;
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outputHandlers_;
  std::atomic<bool> shouldStop_{false};
  std::atomic<bool> awaitingNewOutput_{false};
  std::thread processingThread_;

public:
  OutputCallBackCpp(
      out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>&&
          outputHandlers)
      : outputHandlers_(std::move(outputHandlers)) {
    // Add default handlers
    outputHandlers_.add(
        std::make_shared<out_handl::CppRuntimeStatsOutputHandler>());
    outputHandlers_.add(std::make_shared<out_handl::CppLogMsgOutputHandler>());
    outputHandlers_.add(std::make_shared<out_handl::CppErrorOutputHandler>());
  }

  ~OutputCallBackCpp() { stop(); }

  void
  initializeProcessingThread(std::shared_ptr<OutputQueue> outputQueue) final {
    this->outputQueue_ = outputQueue;
    processingThread_ = std::thread([this]() { processOutputQueue(); });
    std::unique_lock<std::mutex> lock(mtx_);
    cv_.wait(lock, [this]() { return awaitingNewOutput_.load(); });
  }

  void notify() final {
    cv_.notify_one(); // Wake up the processing thread
  }

  void stop() final {
    shouldStop_ = true;
    cv_.notify_one(); // Wake up the thread if it's waiting
    if (processingThread_.joinable()) {
      processingThread_.join();
    }
  }

private:
  /**
   * @brief Process output events using handlers
   */
  void processEvent(const QueuedOutputEvent& outputEvent) {
    if (!outputEvent.payload.has_value()) {
      // e.g. JobStarted events don't have data
      return;
    }

    try {
      out_handl::OutputHandlerInterface<void>& handler =
          outputHandlers_.get(outputEvent.payload);
      handler.handleOutput(outputEvent.payload);
    } catch (const std::exception& e) {
      QLOG(
          logger::Priority::ERROR,
          "Error processing output event: " + std::string(e.what()));
    }
  }

  /**
   * @brief Main processing loop that runs in a separate thread
   */
  void processOutputQueue() {
    std::unique_lock<std::mutex> lock(mtx_);
    while (!shouldStop_.load()) {
      awaitingNewOutput_ = true;
      cv_.notify_all();
      cv_.wait(lock);
      awaitingNewOutput_ = false;

      if (shouldStop_.load()) {
        break;
      }

      while (outputQueue_ != nullptr && !shouldStop_.load()) {
        std::vector<QueuedOutputEvent> outputQueue =
            std::move(outputQueue_->clear());
        lock.unlock();

        for (size_t i = 0; !shouldStop_.load() && i < outputQueue.size(); i++) {
          processEvent(outputQueue[i]);
        }

        lock.lock();
      }
    }
  }
};

} // namespace qvac_lib_inference_addon_cpp
