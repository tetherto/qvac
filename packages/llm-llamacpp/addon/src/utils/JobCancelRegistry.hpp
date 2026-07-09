#pragma once

#include <functional>
#include <mutex>
#include <unordered_map>
#include <utility>

#include "inference-addon-cpp/job/JobId.hpp"

/// Live tagged jobs and how to cancel each one. One entry per in-flight job,
/// holding the action that stops that job's engine (scheduler-slot teardown,
/// single-context stop, ...), so cancel(id) needs no knowledge of which path
/// runs the job.
///
/// A job may be live before it is cancellable (admitted by the multi-job
/// scheduler but still queued for an engine slot): cancel(id) on such a job
/// is parked and handed back to bind() when the slot appears, so no cancel is
/// lost in that window.
class JobCancelRegistry {
public:
  using JobId = qvac_lib_inference_addon_cpp::JobId;
  using CancelAction = std::function<void()>;

  /// Register a live job that is not yet cancellable (no engine slot yet);
  /// cancel(id) requests are parked until bind() arms it.
  void add(JobId id) {
    std::lock_guard<std::mutex> lock(mtx_);
    jobs_.try_emplace(id);
  }

  /// Register a live job cancellable via @p action from the start.
  void add(JobId id, CancelAction action) {
    std::lock_guard<std::mutex> lock(mtx_);
    jobs_[id] = Entry{std::move(action), false};
  }

  /// Arm a registered job with its cancel action. Returns true when a cancel
  /// was parked while the job was unarmed: the caller typically runs inside
  /// the engine's admission (its lock held), so it must apply that
  /// cancellation itself — the action is NOT run here. Unknown ids (already
  /// finished) return false.
  bool bind(JobId id, CancelAction action) {
    std::lock_guard<std::mutex> lock(mtx_);
    const auto found = jobs_.find(id);
    if (found == jobs_.end()) {
      return false;
    }
    found->second.action = std::move(action);
    return std::exchange(found->second.cancelRequested, false);
  }

  /// Drop a job (finished, or its engine slot was released). A later
  /// cancel(id) is a no-op, like any unknown id.
  void remove(JobId id) {
    std::lock_guard<std::mutex> lock(mtx_);
    jobs_.erase(id);
  }

  /// Cancel a live job: runs its action, parks the request when the job is
  /// not yet armed, no-op for unknown ids. The action runs outside the
  /// registry lock (it may take engine locks), on a copy — the entry may be
  /// removed concurrently by the finishing job.
  void cancel(JobId id) {
    CancelAction action;
    {
      std::lock_guard<std::mutex> lock(mtx_);
      const auto found = jobs_.find(id);
      if (found == jobs_.end()) {
        return;
      }
      if (!found->second.action) {
        found->second.cancelRequested = true;
        return;
      }
      action = found->second.action;
    }
    action();
  }

private:
  struct Entry {
    CancelAction action;
    bool cancelRequested = false;
  };

  std::mutex mtx_;
  std::unordered_map<JobId, Entry> jobs_;
};
