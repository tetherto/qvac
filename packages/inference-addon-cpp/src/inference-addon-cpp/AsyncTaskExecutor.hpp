#pragma once

#include <cstdint>
#include <functional>

namespace qvac_lib_inference_addon_cpp {

/// Threads owned by an addon that run `js::JsAsyncTask` work, passed to
/// `JsAsyncTask::runOn()`. Without one, `JsAsyncTask::run()` starts a thread
/// per task. An addon uses an executor to bound how many tasks run at once, or
/// to keep long tasks from holding up short ones.
///
/// JsAsyncTask may call cancel() for a task until the task's completion has
/// reached the JS thread, so the executor must outlive each task posted to it
/// until the task's Promise settles or its environment has been torn down. An
/// executor that is destroyed on the JS thread, once it holds no tasks and its
/// threads have finished, meets this. Every task that post() accepts must run,
/// unless cancel() removes it first: an executor must not drop queued tasks,
/// for example when it shuts down, or their Promises never settle and their
/// environments can never finish tearing down.
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
  /// cancelling a finished task's ticket cannot remove a later task. Must not
  /// throw: a failure, such as running out of memory for the queue, is
  /// reported by returning 0.
  virtual std::uint64_t post(std::function<void()> task) noexcept = 0;

  /// Removes the task with @p ticket if it has not started, and destroys it
  /// without running it. Returns true when the task was removed. Returns false
  /// when it has started or finished, or the ticket is unknown. Called on the
  /// JS thread from an environment teardown hook, so it must not throw or
  /// block on the task.
  virtual bool cancel(std::uint64_t ticket) noexcept = 0;
};

} // namespace qvac_lib_inference_addon_cpp
