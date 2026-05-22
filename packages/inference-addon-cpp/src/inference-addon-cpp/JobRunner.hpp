#pragma once

#include <any>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>

#include "Logger.hpp"
#include "ModelInterfaces.hpp"
#include "queue/OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

class JobRunner {
  std::shared_ptr<OutputQueue> outputQueue_;
  model::IModel* const model_;
  model::IModelCancel* const modelCancel_;
  mutable std::timed_mutex mtx_;
  mutable std::condition_variable_any processCv_;
  std::optional<std::any> job_;
  mutable std::thread processingThread_;
  mutable std::atomic_bool running_ = false;
  mutable std::atomic_bool ready_ = false;
  // Coordinates cancel() - finalizeJob(): cancel waits for the active job
  // to drain. Uses `mtx_` rather than a second mutex so there's only one lifetime
  // to worry about during AddonCpp teardown; a dual-mutex pattern with
  // separate `processingSync_.mutex_` raced with destruction on Android
  // and tripped bionic FORTIFY's "destroyed mutex" guard.
  bool inProcessing_ = false;
  mutable std::condition_variable_any cancelCv_;

  void finalizeJob(std::unique_lock<std::timed_mutex>& lock) {
    if (!lock.owns_lock()) {
      lock.lock();
    }
    inProcessing_ = false;
    job_.reset();
    cancelCv_.notify_all();
  }

  void process() {
    while (running_) {
      std::unique_lock lock(mtx_);

      try {
        // Signal that thread is ready for a new job
        ready_ = true;
        processCv_.notify_all();
        processCv_.wait(lock, [this] { return !running_ || job_.has_value(); });

        if (!running_ || !job_.has_value()) {
          continue;
        }

        // Mark in-processing while still holding `lock` for atomicity vs cancel().
        ready_ = false;
        inProcessing_ = true;

        // Unlock main lock so cancel() (and finalizeJob below) can acquire it.
        lock.unlock();

        std::any output = model_->process(job_.value());

        // finalizeJob re-acquires `lock`, clears job_/inProcessing_, and
        // notifies any cancel() waiter.
        finalizeJob(lock);

        outputQueue_->queueResult(std::move(output));
        outputQueue_->queueJobEnded();
      } catch (const std::exception& e) {
        finalizeJob(lock);
        outputQueue_->queueException(e);
      } catch (...) {
        finalizeJob(lock);
        outputQueue_->queueException(
            std::runtime_error("Unknown exception in processing loop"));
      }
    }
  }

public:
  explicit JobRunner(
      std::shared_ptr<OutputQueue> outputQueue, model::IModel* model,
      model::IModelCancel* modelCancel = nullptr)
      : outputQueue_(std::move(outputQueue)), model_(model),
        modelCancel_(modelCancel) {}

  void start() {
    this->running_ = true;
    processingThread_ = std::thread([this]() { this->process(); });

    // Make sure to wait until the thread is ready for a new job.
    // Otherwise, the thread might ignore and lose new jobs quickly scheduled
    // after construction, when its not ready for processing yet.
    std::unique_lock lock(mtx_);
    processCv_.wait(lock, [this]() { return ready_.load(); });
  }

  ~JobRunner() {
    if (running_) {
      QLOG_DEBUG("Stopping job");
      {
        std::lock_guard lock(mtx_);
        running_ = false;
      }
      processCv_.notify_one();
      if (processingThread_.joinable()) {
        processingThread_.join();
      }
    }
  }

  bool runJob(std::any input) {
    std::unique_lock lock(mtx_, std::defer_lock);
    if (!lock.try_lock_for(std::chrono::milliseconds{100}) ||
        job_.has_value()) {
      // Do not queue exception, there could be another job already
      // running and we want to keep the messages on queue matching
      // the valid jobs.
      // Return a boolean instead.
      return false;
    }
    job_ = std::move(input);
    lock.unlock();
    processCv_.notify_one();
    return true;
  }

  void cancel() {
    std::unique_lock lock{mtx_};
    if (modelCancel_ == nullptr) {
      QLOG(logger::Priority::WARNING, "Model does not support cancellation");
      return;
    }
    if (!job_.has_value()) {
      return;
    }
    if (ready_.load()) {
      job_.reset();
      outputQueue_->queueException(std::runtime_error("Job cancelled"));
      return;
    }
    modelCancel_->cancel();
    cancelCv_.wait(lock, [this] { return !inProcessing_; });
  }
};
} // namespace qvac_lib_inference_addon_cpp
