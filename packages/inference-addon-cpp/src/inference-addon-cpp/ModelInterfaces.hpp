#pragma once

#include <any>
#include <memory>
#include <streambuf>
#include <string>

#include "RuntimeStats.hpp"
#include "job/JobId.hpp"

namespace qvac_lib_inference_addon_cpp::model {

struct IModel {
  virtual ~IModel() = default;
  IModel() = default;
  IModel(const IModel&) = delete;
  IModel& operator=(const IModel&) = delete;
  [[nodiscard]] virtual std::string getName() const = 0;
  virtual std::any process(const std::any& input) = 0;
  /// Whole-model, point-in-time read, not per-job.
  /// When jobs are batched this might provide aggregated metrics
  /// such as average tokens per second during a recent processing
  /// window.
  ///
  /// For models driven by IModelMultiprocessor it is the implementer's
  /// responsibility to make runtimeStats() thread-safe: it may be called
  /// concurrently with in-flight process() calls.
  [[nodiscard]] virtual RuntimeStats runtimeStats() const = 0;
};

// Optional interfaces below. Not every model will implement all of them.

struct IModelAsyncLoad {
  virtual ~IModelAsyncLoad() = default;
  IModelAsyncLoad() = default;
  IModelAsyncLoad(const IModelAsyncLoad&) = delete;
  IModelAsyncLoad& operator=(const IModelAsyncLoad&) = delete;
  virtual void waitForLoadInitialization() = 0;
  virtual void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& streambuf) = 0;
};

/// Whole-model cancellation: stop every job in flight at the time of the
/// call. Point-in-time semantics: a model that applies the cancel later (on
/// its own worker, between decode steps) must pin the affected set when
/// cancel() is invoked and must not sweep jobs it is handed afterward — the
/// scheduler dispatches cancel() under its admission lock and awaits exactly
/// the jobs that were in flight at dispatch, so a late application that kills
/// a job admitted after cancel() returned would end a job nobody cancelled
/// and nobody awaited.
///
/// Implementations must be quick — request the stop, do not wait for jobs to
/// end — and must not call back into the scheduler: cancel() may run under
/// the scheduler's admission lock (the same restriction jobStarting already
/// carries), so blocking here stalls every slot release and admission, and a
/// scheduler call would self-deadlock on that lock. A throw rejects the
/// cancellation: the scheduler lets it escape to the caller and does not
/// await jobs a failed cancel never reached.
struct IModelCancel {
  virtual ~IModelCancel() = default;
  IModelCancel() = default;
  IModelCancel(const IModelCancel&) = delete;
  IModelCancel& operator=(const IModelCancel&) = delete;
  virtual void cancel() const = 0;
};

/// Marks a model that can process several jobs at once, as required by a
/// multi-job scheduler. process() may be called concurrently with distinct ids
/// and so must be safe to run in parallel. The @p id tags this call so the
/// model can map it for per-job cancellation (see IModelCancelById); streamed
/// output is tagged by the callback baked into @p input and the final result by
/// the scheduler. How many calls run at once is the scheduler's concern, not
/// something the model advertises.
struct IModelMultiprocessor {
  virtual ~IModelMultiprocessor() = default;
  IModelMultiprocessor() = default;
  IModelMultiprocessor(const IModelMultiprocessor&) = delete;
  IModelMultiprocessor& operator=(const IModelMultiprocessor&) = delete;

  virtual std::any process(const std::any& input, JobId id) = 0;

  // Whole-model runtimeStats() stays an aggregate (see IModel::runtimeStats);
  // a model can additionally implement IModelJobStats to report per-job
  // observed figures on a tagged job's terminal snapshot.
};

/// Per-job runtime stats: the complete terminal snapshot for one finished
/// job, under the same key names as IModel::runtimeStats(), with the job's
/// own observed end-to-end figures (e.g. time to first token, observed decode
/// speed, token counts) where per-job values exist and model-level values for
/// the rest. The output queue uses this as a tagged job's jobEnded payload
/// instead of the generic whole-model snapshot.
///
/// Take-once semantics: a call hands over and erases the entry for @p id;
/// unknown ids return an empty snapshot (the queue then falls back to the
/// generic snapshot). Called from scheduler worker threads, so
/// implementations must synchronize internally.
struct IModelJobStats {
  virtual ~IModelJobStats() = default;
  IModelJobStats() = default;
  IModelJobStats(const IModelJobStats&) = delete;
  IModelJobStats& operator=(const IModelJobStats&) = delete;

  [[nodiscard]] virtual RuntimeStats consumeJobStats(JobId id) const = 0;
};

/// Per-job cancellation: cancel just the in-flight call admitted under @p id.
/// A no-op when the id is unknown (already finished, or never admitted).
/// Same obligations as IModelCancel::cancel(): be quick (record the request,
/// do not wait for the job to end) and never call back into the scheduler.
/// Duplicate delivery must be safe: the scheduler may cancel the same
/// still-active id more than once — an immediate retry after a mid-batch
/// failure re-covers ids the failed call already reached — so repeated calls
/// for a live id are idempotent (re-record or ignore, never an error). This
/// is what lets the scheduler promise that retrying a rejected cancel is
/// always safe.
struct IModelCancelById {
  virtual ~IModelCancelById() = default;
  IModelCancelById() = default;
  IModelCancelById(const IModelCancelById&) = delete;
  IModelCancelById& operator=(const IModelCancelById&) = delete;

  virtual void cancelById(JobId id) const = 0;
};

/// Scheduler-side job lifecycle hook. jobStarting(id) runs on the worker
/// thread while the scheduler still holds its admission lock, after the job
/// left the queue and before process(input, id) is entered. Cancellation
/// (cancel(id) / cancelAll()) serialises on that same lock, so a cancel that
/// no longer finds the job queued is guaranteed to find it already announced
/// here — registering the job with the model in this hook closes the window
/// where a cancel would otherwise fall between dequeue and the model's own
/// registration and silently do nothing. Implementations must be quick and
/// must not call back into the scheduler. A throw from jobStarting(id) fails
/// that job: the scheduler releases the job's slot, publishes its terminal
/// error and never enters process(input, id) for it — the worker (and the
/// process) survive.
struct IModelJobLifecycle {
  virtual ~IModelJobLifecycle() = default;
  IModelJobLifecycle() = default;
  IModelJobLifecycle(const IModelJobLifecycle&) = delete;
  IModelJobLifecycle& operator=(const IModelJobLifecycle&) = delete;

  virtual void jobStarting(JobId id) = 0;
};

} // namespace qvac_lib_inference_addon_cpp::model
