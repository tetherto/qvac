#pragma once
//
// Fixed-size pool of worker threads for the addon's async jobs. Pure C++ so
// the unit tests can drive it without a JS environment.

#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace turbovec_ggml {

class WorkerPool {
public:
  // Starts no threads until the first task, then one per queued task that
  // finds no idle thread, up to `maxThreads`.
  explicit WorkerPool(size_t maxThreads) noexcept;

  // Runs the tasks already queued, then joins every thread.
  ~WorkerPool();

  WorkerPool(const WorkerPool&) = delete;
  WorkerPool& operator=(const WorkerPool&) = delete;
  WorkerPool(WorkerPool&&) = delete;
  WorkerPool& operator=(WorkerPool&&) = delete;

  // Queues a task. Tasks start in the order they were posted. Returns a
  // ticket for cancel(), or 0 when the task could not be queued or no thread
  // can run it. A task must not throw.
  std::uint64_t post(std::function<void()> task) noexcept;

  // Removes a queued task that has not started. Returns true when it was
  // removed, so it will never run; false when it has started, finished, or
  // the ticket is unknown. The removed task is destroyed on the caller's
  // thread.
  bool cancel(std::uint64_t ticket) noexcept;

  [[nodiscard]] size_t threadCount() const;

private:
  void run();

  const size_t maxThreads_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  struct Task {
    std::uint64_t ticket = 0;
    std::function<void()> run;
  };

  std::deque<Task> queue_;
  std::vector<std::thread> threads_;
  size_t idle_ = 0;
  std::uint64_t nextTicket_ = 1;
  bool stopping_ = false;
};

} // namespace turbovec_ggml
