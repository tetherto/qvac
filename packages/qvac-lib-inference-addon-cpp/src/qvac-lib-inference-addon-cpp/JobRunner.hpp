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

  void process() {
    while (running_) {
      try {
        std::any* job = nullptr;
        {
          std::unique_lock lock(mtx_);

          // Signal that thread is ready for a new job
          ready_ = true;
          processCv_.notify_all();
          processCv_.wait(lock);

          if (!job_.has_value()) {
            continue;
          }

          // Not ready for a new job. Has a job in progress now.
          ready_ = false;
          job = &job_.value();
        }

        std::any output = model_->process(*job);

        {
          std::scoped_lock lock(mtx_);
          // Make sure to reset job before queue result. Client might
          // be waiting to queue a new job as soon as current is ended.
          job_.reset();
          outputQueue_->queueResult(std::move(output));
          outputQueue_->queueJobEnded();
        }
      } catch (const std::exception& e) {
        std::scoped_lock lock(mtx_);
        job_.reset();
        outputQueue_->queueException(e);
      } catch (...) {
        std::scoped_lock lock(mtx_);
        QLOG(
            logger::Priority::DEBUG,
            "process: Unknown exception in processing loop");
        job_.reset();
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
    // Otherwise, the thread might ignore setJobInput notifications.
    std::unique_lock lock(mtx_);
    processCv_.wait(lock, [this]() { return ready_.load(); });
  }

  ~JobRunner() {
    if (running_) {
      QLOG(logger::Priority::DEBUG, "Stopping job");
      running_ = false;
      processCv_.notify_one();
      if (processingThread_.joinable()) {
        processingThread_.join();
      }
    }
  }

  void runJob(std::any input) {
    std::unique_lock lock(mtx_, std::defer_lock);
    if (!lock.try_lock_for(std::chrono::milliseconds{100}) ||
        job_.has_value()) {
      outputQueue_->queueException(
          std::runtime_error(
              "Cannot set new job: a job is already set or being processed"));
      return;
    }
    job_ = std::move(input);
    lock.unlock();
    processCv_.notify_one();
  }

  void cancel() {
    std::scoped_lock lock{mtx_};
    if (modelCancel_ == nullptr) {
      QLOG(logger::Priority::WARNING, "Model does not support cancellation");
    }
    if (job_.has_value() && modelCancel_ != nullptr) {
      modelCancel_->cancel();
      job_.reset();
    }
  }
};
} // namespace qvac_lib_inference_addon_cpp
