#pragma once

#include <cstdint>
#include <functional>

namespace qvac_lib_inference_addon_cpp {

/// Threads owned by an addon that run `js::JsAsyncTask` work, passed to
/// `JsAsyncTask::runOn()`. Without one, `JsAsyncTask::run()` starts a thread
/// per task. An addon uses an executor to bound how many tasks run at once, or
/// to keep long tasks from holding up short ones.
///
/// The executor must outlive every task posted to it, until the task's Promise
/// settles or its environment has been torn down.
struct IAsyncTaskExecutor {
  IAsyncTaskExecutor() = default;
  IAsyncTaskExecutor(const IAsyncTaskExecutor&) = delete;
  IAsyncTaskExecutor& operator=(const IAsyncTaskExecutor&) = delete;
  IAsyncTaskExecutor(IAsyncTaskExecutor&&) = delete;
  IAsyncTaskExecutor& operator=(IAsyncTaskExecutor&&) = delete;
  virtual ~IAsyncTaskExecutor() = default;

  /// Queues @p task to run once on one of the executor's threads. Returns a
  /// non-zero ticket that identifies the task for cancel(), or 0 when the task
  /// was not queued, in which case it never runs. Tickets are never reused, so
  /// cancelling a finished task's ticket cannot remove a later task.
  virtual std::uint64_t post(std::function<void()> task) noexcept = 0;

  /// Removes the task with @p ticket if it has not started, and destroys it
  /// without running it. Returns true when the task was removed. Returns false
  /// when it has started or finished, or the ticket is unknown.
  virtual bool cancel(std::uint64_t ticket) noexcept = 0;
};

} // namespace qvac_lib_inference_addon_cpp
