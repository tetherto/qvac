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
/// A job may be live before it is cancellable (announced by the scheduler at
/// dequeue via jobStarting, or admitted but still queued for an engine slot):
/// cancel(id) — and a whole-model parkAll() — on such a job is parked and
/// handed back when add()/bind() arms it, so no cancel is lost in that window.
class JobCancelRegistry {
public:
  using JobId = qvac_lib_inference_addon_cpp::JobId;
  using CancelAction = std::function<void()>;

  /// Register a live job that is not yet cancellable (no engine slot yet);
  /// cancel(id) requests are parked until add()/bind() arms it.
  void add(JobId id) {
    std::lock_guard<std::mutex> lock(mtx_);
    jobs_.try_emplace(id);
  }

  /// Arm a live job with its cancel action, creating the entry when the job
  /// was never announced (single-job scheduler path). Returns true when a
  /// cancel was parked before the action existed — the caller must apply it.
  [[nodiscard]] bool add(JobId id, CancelAction action) {
    std::lock_guard<std::mutex> lock(mtx_);
    Entry& entry = jobs_[id];
    entry.action = std::move(action);
    return std::exchange(entry.cancelRequested, false);
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

  /// Park a cancel on every live job (whole-model cancel). Park-only by
  /// design: armed jobs are already stoppable through their engines by the
  /// caller's counter-guarded stops, and running actions here could take
  /// engine locks the caller cannot afford (a whole-model cancel may be
  /// issued from a streaming callback on the engine's own worker thread).
  /// The flag matters for jobs still unarmed — they consume it when they arm
  /// and cancel before their first decode.
  void parkAll() {
    std::lock_guard<std::mutex> lock(mtx_);
    for (auto& job : jobs_) {
      job.second.cancelRequested = true;
    }
  }

  /// Take a parked cancel for @p id without arming the job (paths that never
  /// arm an action, e.g. batch groups). False for unknown ids or when no
  /// cancel is parked.
  [[nodiscard]] bool consumeParked(JobId id) {
    std::lock_guard<std::mutex> lock(mtx_);
    const auto found = jobs_.find(id);
    if (found == jobs_.end()) {
      return false;
    }
    return std::exchange(found->second.cancelRequested, false);
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
