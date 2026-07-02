#pragma once

#include <any>
#include <cstddef>
#include <memory>

#include "JobId.hpp"

namespace qvac_lib_inference_addon_cpp {

class OutputQueue;

/// Admission strategy for jobs handed to a model's process(). AddonCpp builds a
/// single-job scheduler by default; a caller wanting multi-job admission
/// constructs that scheduler itself and passes it to AddonCpp.
struct IJobScheduler {
  virtual ~IJobScheduler() = default;
  IJobScheduler() = default;
  IJobScheduler(const IJobScheduler&) = delete;
  IJobScheduler& operator=(const IJobScheduler&) = delete;

  /// Bind the output sink and spawn the worker(s). Takes ownership of the
  /// @p outputQueue from here on; must be called once before runJob and block
  /// until ready to admit. AddonCpp builds the queue and calls this in its
  /// constructor, so a caller-supplied scheduler can be built queue-free.
  virtual void start(std::shared_ptr<OutputQueue> outputQueue) = 0;

  /// Admit a job tagged with @p id (kNoJobId for untagged). Returns false when
  /// at capacity; the caller must not queue any output for a rejected job.
  virtual bool runJob(std::any input, JobId id) = 0;

  /// Admit an exclusive job: one that must run with the model to itself (e.g. a
  /// finetune, which reloads weights). Rejected unless the scheduler is
  /// otherwise idle; while it runs, every runJob admission is rejected.
  virtual bool runExclusiveJob(std::any input, JobId id) = 0;

  /// Cancel one job by id. Single-job implementations ignore @p id.
  virtual void cancel(JobId id) = 0;

  /// Cancel every in-flight and queued job.
  virtual void cancelAll() = 0;

  /// Number of active jobs (in-flight + queued). The authoritative admission
  /// count consumers can read instead of tracking their own.
  [[nodiscard]] virtual std::size_t activeJobs() const = 0;
};

} // namespace qvac_lib_inference_addon_cpp
