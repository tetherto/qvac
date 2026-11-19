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

std::uint64_t WorkerPool::post(std::function<void()> task) noexcept {
  std::uint64_t ticket = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopping_) {
      return 0;
    }
    ticket = nextTicket_++;
    try {
      queue_.push_back(Task{ticket, std::move(task)});
    } catch (...) {
      return 0;
    }
    if (idle_ < queue_.size() && threads_.size() < maxThreads_) {
      try {
        threads_.emplace_back([this]() { run(); });
      } catch (...) {
        if (threads_.empty()) {
          queue_.pop_back();
          return 0;
        }
      }
    }
  }
  cv_.notify_one();
  return ticket;
}

bool WorkerPool::cancel(std::uint64_t ticket) noexcept {
  // Declared outside the lock's scope, so the task is destroyed after the
  // lock is released.
  std::function<void()> removed;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto it = queue_.begin(); it != queue_.end(); ++it) {
      if (it->ticket == ticket) {
        removed = std::move(it->run);
        queue_.erase(it);
        return true;
      }
    }
  }
  return false;
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
    std::function<void()> task = std::move(queue_.front().run);
    queue_.pop_front();
    lock.unlock();
    task();
    task = nullptr;
    lock.lock();
  }
}

} // namespace turbovec_ggml
