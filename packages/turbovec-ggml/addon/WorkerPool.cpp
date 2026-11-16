#include "WorkerPool.hpp"

#include <utility>

namespace turbovec_ggml {

WorkerPool::WorkerPool(size_t maxThreads) noexcept
    : maxThreads_(maxThreads == 0 ? 1 : maxThreads) {}

WorkerPool::~WorkerPool() {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
  }
  cv_.notify_all();
  for (std::thread& thread : threads_) {
    thread.join();
  }
}

bool WorkerPool::post(std::function<void()> task) noexcept {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopping_) {
      return false;
    }
    try {
      queue_.push_back(std::move(task));
    } catch (...) {
      return false;
    }
    if (idle_ < queue_.size() && threads_.size() < maxThreads_) {
      try {
        threads_.emplace_back([this]() { run(); });
      } catch (...) {
        if (threads_.empty()) {
          queue_.pop_back();
          return false;
        }
      }
    }
  }
  cv_.notify_one();
  return true;
}

size_t WorkerPool::threadCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return threads_.size();
}

void WorkerPool::run() {
  std::unique_lock<std::mutex> lock(mutex_);
  for (;;) {
    ++idle_;
    cv_.wait(lock, [this]() { return stopping_ || !queue_.empty(); });
    --idle_;
    if (queue_.empty()) {
      return; // stopping_ and nothing left to run
    }
    std::function<void()> task = std::move(queue_.front());
    queue_.pop_front();
    lock.unlock();
    task();
    task = nullptr;
    lock.lock();
  }
}

} // namespace turbovec_ggml
