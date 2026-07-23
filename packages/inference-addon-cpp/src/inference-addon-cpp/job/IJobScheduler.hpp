#pragma once

#include <any>
#include <cstddef>
#include <memory>
#include <optional>
#include <vector>

#include "JobId.hpp"

namespace qvac_lib_inference_addon_cpp {

class OutputQueue;

namespace model {
struct IModel;
}

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

  /// Admit a job. The scheduler assigns the job's id and returns it: the
  /// tagged path (MultiJobScheduler) mints a fresh id (never kNoJobId, never
  /// reused for the scheduler's lifetime) so outputs stay correlatable and no
  /// two jobs — live or finished — can ever share one; the untagged path
  /// (SingleJobScheduler) identifies its single slot as kNoJobId. Returns
  /// nullopt when at capacity; no output is ever queued for a rejected job.
  virtual std::optional<JobId> runJob(std::any input) = 0;

  /// Admit an exclusive job: one that must run with the model to itself (e.g. a
  /// finetune, which reloads weights). Rejected (nullopt) unless the scheduler
  /// is otherwise idle; while it runs, every runJob admission is rejected.
  virtual std::optional<JobId> runExclusiveJob(std::any input) = 0;

  /// Cancel one job by id. Single-job implementations ignore @p id.
  virtual void cancel(JobId id) = 0;

  /// Cancel every in-flight and queued job.
  virtual void cancelAll() = 0;

  /// Ids of every live (queued + in-flight) job. Pairs with cancelJobs(): a
  /// caller snapshots on its admission thread and cancels the snapshot later,
  /// so jobs admitted in between are never touched — provided ids identify
  /// jobs uniquely (the tagged path). An untagged scheduler can only report
  /// the kNoJobId sentinel, which names its slot rather than a job, so a
  /// deferred cancel of that snapshot may land on the slot's next occupant
  /// (see SingleJobScheduler::liveJobIds).
  [[nodiscard]] virtual std::vector<JobId> liveJobIds() const = 0;

  /// Cancel exactly the jobs in @p ids; finished or unknown ids are no-ops.
  virtual void cancelJobs(const std::vector<JobId>& ids) {
    for (const JobId id : ids) {
      cancel(id);
    }
  }

  /// Number of active jobs (in-flight + queued). The authoritative admission
  /// count consumers can read instead of tracking their own.
  [[nodiscard]] virtual std::size_t activeJobs() const = 0;

  /// True iff this scheduler was constructed against exactly this @p model
  /// instance. A scheduler holds raw pointers into its model, so AddonCpp calls
  /// this before adopting a caller-supplied scheduler and rejects one built
  /// against a different model — a mismatch would be silent undefined
  /// behaviour.
  [[nodiscard]] virtual bool isBoundTo(const model::IModel& model) const = 0;
};

} // namespace qvac_lib_inference_addon_cpp
