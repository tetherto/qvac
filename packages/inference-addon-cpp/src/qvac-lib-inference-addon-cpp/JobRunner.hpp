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

/**
 * @brief Tracks active processing state for synchronization.
 *
 * Used to synchronize cancel() with process() - cancel waits for processing
 * to complete before returning, ensuring job_ is not reset while in use.
 */
class ProcessingSync {
public:
  void waitInactive() const {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [this] { return !active_; });
  }

  void setActive(bool active) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      active_ = active;
    }
    cv_.notify_all();
  }

private:
  bool active_{false};
  mutable std::mutex mutex_;
  mutable std::condition_variable cv_;
};

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
  mutable ProcessingSync processingSync_;

  void finalizeJob(std::unique_lock<std::timed_mutex>& lock) {
    processingSync_.setActive(false);
    if (!lock.owns_lock()) {
      lock.lock();
    }
    job_.reset();
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

        // Acquire processing while holding the main `lock` for atomicity.
        ready_ = false;
        processingSync_.setActive(true);

        // Unlock main lock to ensure cancel() can acquire without blocking
        lock.unlock();

        std::any output = model_->process(job_.value());

        // Make sure to reset job before queue result. Client might
        // be waiting to queue a new job as soon as current is ended.
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
    if (job_.has_value()) {
      if (ready_.load()) {
        job_.reset();
        outputQueue_->queueException(std::runtime_error("Job cancelled"));
      } else {
        modelCancel_->cancel();
        lock.unlock();
        processingSync_.waitInactive();
      }
    }
  }
};
} // namespace qvac_lib_inference_addon_cpp
