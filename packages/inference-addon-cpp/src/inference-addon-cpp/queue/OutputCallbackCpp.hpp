// Pure C++ Callback (no Js dependencies). Can be used on CLI or C++ tests.
#pragma once

#include <condition_variable>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

#include "../Logger.hpp"
#include "../Utils.hpp"
#include "../handlers/CppOutputHandlerImplementations.hpp"
#include "../handlers/OutputHandler.hpp"
#include "OutputCallbackInterface.hpp"
#include "OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

/**
 * @brief Pure C++ output callback that dispatches queued events to the stock
 * output handlers. This path is effectively single-job: JobIds are dropped at
 * dispatch, so interleaved outputs from concurrent jobs cannot be correlated.
 * Multi-job C++ consumers should supply a custom OutputCallBackInterface and
 * read tagged events via OutputQueue::clear(), which returns (JobId, event)
 * pairs.
 */
class OutputCallBackCpp : public OutputCallBackInterface {

  std::mutex mtx_;
  std::condition_variable cv_;
  std::shared_ptr<OutputQueue> outputQueue_ = nullptr;
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>>
      outputHandlers_;
  /// Guarded by mtx_. wakePending_ latches notify()/stop() wake-ups so one
  /// arriving while the processing thread is draining (not waiting) is not
  /// lost; shouldStop_ is only acted on after a full drain, so events queued
  /// before stop() are always delivered.
  bool wakePending_ = false;
  bool shouldStop_ = false;
  bool awaitingNewOutput_ = false;
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
    cv_.wait(lock, [this]() { return awaitingNewOutput_; });
  }

  void notify() final {
    {
      std::scoped_lock lock{mtx_};
      wakePending_ = true;
    }
    cv_.notify_all();
  }

  void stop() final {
    {
      std::scoped_lock lock{mtx_};
      shouldStop_ = true;
      wakePending_ = true;
    }
    cv_.notify_all();
    if (processingThread_.joinable()) {
      processingThread_.join();
    }
  }

private:
  /**
   * @brief Process output events using handlers
   */
  void processEvent(const std::any& output) {
    if (!output.has_value()) {
      // e.g. JobStarted events don't have data
      return;
    }

    try {
      out_handl::OutputHandlerInterface<void>& handler =
          outputHandlers_.get(output);
      handler.handleOutput(output);
    } catch (const std::exception& e) {
      QLOG(
          logger::Priority::ERROR,
          "Error processing output event: " + std::string(e.what()));
    }
  }

  /**
   * @brief Main processing loop that runs in a separate thread. On every
   * wake-up (new output or stop) it drains the queue completely before
   * deciding whether to exit, so terminal events queued during teardown are
   * delivered even when stop() wins the race against the drain.
   */
  void processOutputQueue() {
    while (true) {
      bool stopping = false;
      {
        std::unique_lock<std::mutex> lock(mtx_);
        awaitingNewOutput_ = true;
        cv_.notify_all(); // release initializeProcessingThread()
        cv_.wait(lock, [this]() { return wakePending_; });
        awaitingNewOutput_ = false;
        wakePending_ = false;
        stopping = shouldStop_;
      }

      // mtx_ is not held here: producers take the OutputQueue mutex and then
      // mtx_ inside notify(), so draining under mtx_ would invert lock order.
      while (outputQueue_ != nullptr) {
        std::vector<std::pair<JobId, std::any>> batch = outputQueue_->clear();
        if (batch.empty()) {
          break;
        }
        for (const auto& entry : batch) {
          /// JobId is ignored here; type-dispatch drives event handling.
          processEvent(entry.second);
        }
      }

      if (stopping) {
        return;
      }
    }
  }
};

} // namespace qvac_lib_inference_addon_cpp
