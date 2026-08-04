#pragma once

#include <any>
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <exception>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

#include "../Logger.hpp"
#include "../ModelInterfaces.hpp"
#include "../queue/OutputQueue.hpp"
#include "IJobScheduler.hpp"
#include "JobId.hpp"

namespace qvac_lib_inference_addon_cpp {

/// Admits up to maxConcurrency jobs at once onto a fixed pool of worker
/// threads, each driving the model's process(input, id) in parallel. Beyond the
/// pool, up to queueCapacity further jobs may wait — they start only once a
/// worker (hence a model slot) frees, so the queue never over-subscribes the
/// model. Admission is bounded: runJob rejects (back-pressure) once
/// in-flight + queued would exceed maxConcurrency + queueCapacity, so the
/// consumer never sees output for a job it was told was rejected. A queueCapacity
/// of 0 means reject-at-pool (no waiting room). Per-job state lives only inside
/// the worker stack, so one job's throw can never tear another's slot.
///
/// This is the tagged path: admission mints each job's id itself (monotonic,
/// starting at 1, never reused for the scheduler's lifetime) and returns it,
/// so outputs stay correlatable and cancel(id) always targets the one job that
/// ever owned the id. Never recycling an id is also what makes publishing a
/// job's terminal events after its slot release safe: no later job can be
/// admitted under the same id, so events can never be tagged ambiguously.
///
/// Cancelling a job still waiting in the queue is the scheduler's concern (the
/// model cannot know ids it never received): the job is unlinked in O(1) via
/// queuedIndex_, its slot and exclusivity released, and a "Job cancelled" error
/// queued as its terminal event. In-flight cancellation routes to the model:
/// cancel(id) via cancelById(), cancelAll() via per-id cancel of the
/// in-flight snapshot, falling back to the whole-model cancel() on models
/// that only implement it (teardown prefers the whole-model switch); that
/// id -> internal-slot mapping is the model's concern. cancelJobs(liveJobIds())
/// is the snapshot form the JS binding uses for cancel-all, so jobs admitted
/// after the cancel was requested survive it — on a per-id model; the
/// whole-model fallback is indiscriminate, so there a job that became
/// in-flight by dispatch time is swept (and awaited) with the targets.
///
/// Every cancel entry point returns only once each job it delivered a
/// model-side cancel for has fully left the scheduler (its slot released), so
/// a returned cancel means "the job is gone": activeJobs() no longer counts
/// it and an immediate follow-up admission cannot be spuriously refused as
/// busy. This is the guarantee SingleJobScheduler gives by construction
/// (ProcessingSync::waitInactive) and matters for models that apply a per-id
/// cancel on their own worker, later than the cancelById() call. It obliges
/// the model to eventually end a cancelled job, and forbids calling a cancel
/// entry point from a scheduler worker (it would wait on itself); cancels
/// that reach no model (unsupported surface) still return immediately — there
/// is nothing whose completion could be awaited. Dequeue announces the
/// job to the model (IModelJobLifecycle::jobStarting) under the same lock the
/// cancel paths take, so every cancel finds each admitted job either still
/// queued (dropped here) or already announced (cancellable model-side) — never
/// in between. A throwing announcement fails only its own job: the worker
/// releases the job's slot and exclusivity, publishes its terminal error, and
/// moves on to the next job.
///
/// runExclusiveJob admits a job that must run with the model to itself (a
/// finetune reloads weights): it is refused unless the scheduler is idle, and
/// while it runs every runJob admission is refused. This is where the
/// finetune<->inference mutual exclusion is enforced.
class MultiJobScheduler final : public IJobScheduler {
  struct PendingJob {
    std::any input;
    JobId id;
    bool exclusive{false};
  };

  std::shared_ptr<OutputQueue> outputQueue_;
  model::IModelMultiprocessor* const multiprocessor_;
  model::IModelCancel* const cancel_;
  model::IModelCancelById* const cancelById_;
  /// Optional lifecycle surface of the same model (see jobStarting below);
  /// resolved from the multiprocessor so the wiring cannot point at a
  /// different object than the one whose process() runs the job.
  model::IModelJobLifecycle* const lifecycle_;
  const unsigned maxConcurrency_;
  /// Waiting room beyond the worker pool. Jobs admitted here sit in queued_
  /// until a worker frees; 0 restores strict reject-at-pool back-pressure.
  const unsigned queueCapacity_;

  mutable std::mutex mtx_;
  mutable std::condition_variable workCv_;
  /// Signalled on every slot release, for cancel callers blocked in
  /// awaitJobsGone() until their cancelled jobs have left the scheduler.
  mutable std::condition_variable jobsGoneCv_;
  std::list<PendingJob> queued_;
  /// id -> queued_ node, so cancelling a not-yet-started job unlinks it in O(1)
  /// instead of scanning the queue. Ids are unique across the scheduler, so
  /// every queued job has exactly one entry here.
  std::map<JobId, std::list<PendingJob>::iterator> queuedIndex_;
  /// Ids currently being processed by a worker (dequeued but not yet finished);
  /// tells cancel(id) an id already left the queue and teardown whether a
  /// model-side cancel is needed.
  std::set<JobId> inFlight_;
  /// Next id to mint, under mtx_. Monotonic and never reset, so no two jobs —
  /// live or finished — ever share an id. Starts at 1 to stay clear of
  /// kNoJobId (0).
  JobId nextJobId_{1};
  /// Admitted (queued + in-flight) job count; the figure admission is capped
  /// against. Decremented when a job finishes.
  std::size_t admittedCount_{0};
  /// Set while an exclusive job (e.g. finetune) is queued or in flight. Blocks
  /// every other admission until that job ends, giving it the model to itself.
  bool exclusiveActive_{false};
  std::vector<std::thread> workers_;
  std::atomic_bool running_{false};
  unsigned readyCount_{0};
  /// Which scheduler (if any) owns the current thread as a worker. Tags every
  /// worker in workerLoop() so the cancel paths can fail fast instead of
  /// deadlocking when called from a worker of this same scheduler (the wait
  /// in awaitJobsGone needs that worker to release its own job's slot).
  /// thread_local, so a worker of another scheduler instance is not
  /// mistaken for one of ours.
  inline static thread_local const MultiJobScheduler* tlWorkerOwner_ = nullptr;

  void runResult(std::any&& output, JobId id) {
    outputQueue_->queueResult(std::move(output), id);
    outputQueue_->queueJobEnded(id);
  }

  /// Backs a job out after its dequeue-time jobStarting() announcement threw:
  /// releases the slot, in-flight id and exclusivity under the still-held
  /// dequeue @p lock, then unlocks so the caller can publish the job's one
  /// terminal error without holding the scheduler lock.
  void dropStartingJob(
      std::unique_lock<std::mutex>& lock, const PendingJob& job) {
    --admittedCount_;
    inFlight_.erase(job.id);
    if (job.exclusive) {
      exclusiveActive_ = false;
    }
    lock.unlock();
    jobsGoneCv_.notify_all();
  }

  /// Unlink @p id if still queued, releasing its slot and exclusivity. Caller
  /// holds mtx_ and queues the terminal error outside the lock.
  bool dropQueuedJob(JobId id) {
    const auto indexed = queuedIndex_.find(id);
    if (indexed == queuedIndex_.end()) {
      return false;
    }
    if (indexed->second->exclusive) {
      exclusiveActive_ = false;
    }
    queued_.erase(indexed->second);
    queuedIndex_.erase(indexed);
    --admittedCount_;
    return true;
  }

  /// Unlinks every still-queued job, releasing its slot and exclusivity;
  /// returns the dropped ids so the caller can queue their terminal errors
  /// outside the lock.
  std::vector<JobId> dropQueued() {
    std::lock_guard lock(mtx_);
    std::vector<JobId> dropped;
    dropped.reserve(queued_.size());
    for (const PendingJob& job : queued_) {
      if (job.exclusive) {
        exclusiveActive_ = false;
      }
      dropped.push_back(job.id);
    }
    admittedCount_ -= queued_.size();
    queued_.clear();
    queuedIndex_.clear();
    return dropped;
  }

  /// Publish the "Job cancelled" terminal for every id in @p ids, tolerating
  /// per-id publication failures: each id is already irreversibly unlinked
  /// from the queue, so every remaining terminal must still be attempted
  /// when one publication throws (queueException enqueues the event, then
  /// the consumer callback's notify() may throw). Returns the first failure
  /// instead of throwing so the caller decides — the cancel entry points
  /// rethrow it, the destructor must swallow it (a destructor throw is
  /// std::terminate).
  [[nodiscard]] std::exception_ptr publishCancelledTerminals(
      const std::vector<JobId>& ids, const char* reason) const noexcept {
    std::exception_ptr firstFailure;
    for (const JobId id : ids) {
      try {
        outputQueue_->queueException(std::runtime_error(reason), id);
      } catch (...) {
        if (firstFailure == nullptr) {
          firstFailure = std::current_exception();
        }
      }
    }
    return firstFailure;
  }

  /// Snapshot of the in-flight ids, for the per-id cancel fallback when the
  /// model has no whole-model cancel(). jobStarting is announced under mtx_,
  /// so every id snapshotted here is already known to the model.
  std::vector<JobId> inFlightIds() const {
    std::lock_guard lock(mtx_);
    return {inFlight_.begin(), inFlight_.end()};
  }

  /// Block until none of @p ids is still admitted (queued or in flight).
  /// Called by the cancel paths after a model-side cancel was issued, so the
  /// model is already unwinding these jobs; the workers' slot releases
  /// notify. Ids never recur once gone (monotonic minting), so the predicate
  /// can only flip false -> true. Must not run on a scheduler worker: the
  /// wait needs that worker to release the job's slot.
  void awaitJobsGone(const std::vector<JobId>& ids) const {
    if (tlWorkerOwner_ == this) {
      throw std::logic_error(
          "IJobScheduler cancel entry point called from a scheduler worker "
          "thread; it would deadlock waiting on its own job's departure");
    }
    std::unique_lock lock(mtx_);
    jobsGoneCv_.wait(lock, [this, &ids] {
      for (const JobId id : ids) {
        if (inFlight_.count(id) != 0 || queuedIndex_.count(id) != 0) {
          return false;
        }
      }
      return true;
    });
  }

  /// Worker body. Per-job input/id are copied onto the stack while the lock is
  /// held, then process() runs unlocked so cancel() and peer workers progress.
  void workerLoop() {
    tlWorkerOwner_ = this;
    {
      std::lock_guard lock(mtx_);
      ++readyCount_;
    }
    workCv_.notify_all();

    while (running_.load()) {
      std::unique_lock lock(mtx_);
      workCv_.wait(lock, [this] { return !running_.load() || !queued_.empty(); });
      if (!running_.load()) {
        break;
      }

      const std::list<PendingJob>::iterator front = queued_.begin();
      PendingJob job = std::move(*front);
      // Ids are unique, so the queuedIndex_ entry for this id can only be front.
      queuedIndex_.erase(job.id);
      queued_.erase(front);
      inFlight_.insert(job.id);
      if (lifecycle_ != nullptr) {
        // Announce the job to the model BEFORE the admission lock is
        // released: cancel(id)/cancelAll() serialise on this lock, so a
        // cancel that no longer finds the job queued always finds it
        // registered model-side — no cancel can fall into the gap between
        // dequeue and the model's own bookkeeping in process().
        // The hook is not noexcept and the job is already retained
        // (admittedCount_, inFlight_, exclusivity), so a throw here needs the
        // same per-job isolation as process() — unhandled it would escape the
        // thread entry function and terminate the whole process.
        try {
          lifecycle_->jobStarting(job.id);
        } catch (const std::exception& exception) {
          dropStartingJob(lock, job);
          outputQueue_->queueException(exception, job.id);
          continue;
        } catch (...) {
          dropStartingJob(lock, job);
          outputQueue_->queueException(
              std::runtime_error("Unknown exception in jobStarting"), job.id);
          continue;
        }
      }
      lock.unlock();

      // Release the slot, in-flight entry and exclusivity BEFORE publishing
      // the job's terminal events: a consumer reacting to jobEnded (the JS
      // run loop) may immediately admit a follow-up job, and a stale admitted
      // count would refuse it as busy. process() has fully returned or thrown
      // by the time this runs, so a stuck exclusive flag can never wedge
      // admission if an exclusive job (finetune) fails.
      // Once-only: publication runs inside the try after the release, so a
      // throw during publication (allocation, a custom callback's notify())
      // reaches the catch with the slot already released — a second release
      // would underflow admittedCount_ and wedge admission forever.
      auto releaseSlot = [this, &job, released = false]() mutable {
        if (released) {
          return;
        }
        released = true;
        {
          std::lock_guard relock(mtx_);
          --admittedCount_;
          inFlight_.erase(job.id);
          if (job.exclusive) {
            exclusiveActive_ = false;
          }
        }
        jobsGoneCv_.notify_all();
      };

      try {
        std::any output = multiprocessor_->process(job.input, job.id);
        releaseSlot();
        runResult(std::move(output), job.id);
      } catch (const std::exception& exception) {
        releaseSlot();
        outputQueue_->queueException(exception, job.id);
      } catch (...) {
        releaseSlot();
        outputQueue_->queueException(
            std::runtime_error("Unknown exception in processing loop"), job.id);
      }
    }
  }

public:
  /// Default queueCapacity: nearly unbounded, so a "queue me, don't reject me"
  /// caller is never refused under realistic load, while still capping memory
  /// against a runaway producer. Pass 0 for strict reject-at-pool.
  static constexpr unsigned DEFAULT_MAX_CAPACITY = 16384;

  /// @throws std::invalid_argument on a null @p multiprocessor or a zero
  /// @p maxConcurrency — zero workers could never drain an admitted job, so
  /// accepting either would only fail later, off in a worker or as a hang.
  /// Also thrown when @p cancelById is wired but the model does not implement
  /// IModelJobLifecycle: cancelById() may no-op for ids the model does not
  /// know yet, so without the jobStarting(id) announcement a cancel landing
  /// between dequeue and the model's own registration is silently lost.
  /// Failing construction turns that race into an immediate wiring error.
  MultiJobScheduler(
      model::IModelMultiprocessor* multiprocessor, unsigned maxConcurrency,
      model::IModelCancel* cancel, model::IModelCancelById* cancelById,
      unsigned queueCapacity = DEFAULT_MAX_CAPACITY)
      : multiprocessor_(multiprocessor), cancel_(cancel),
        cancelById_(cancelById),
        lifecycle_(dynamic_cast<model::IModelJobLifecycle*>(multiprocessor)),
        maxConcurrency_(maxConcurrency), queueCapacity_(queueCapacity) {
    if (multiprocessor_ == nullptr) {
      throw std::invalid_argument("multiprocessor must not be null");
    }
    if (maxConcurrency_ == 0) {
      throw std::invalid_argument("maxConcurrency must be > 0");
    }
    if (cancelById_ != nullptr && lifecycle_ == nullptr) {
      throw std::invalid_argument(
          "cancelById requires the model to implement IModelJobLifecycle: "
          "without jobStarting(id) a cancel can land between dequeue and the "
          "model's own registration and silently no-op");
    }
  }

  void start(std::shared_ptr<OutputQueue> outputQueue) override {
    outputQueue_ = std::move(outputQueue);
    running_.store(true);
    workers_.reserve(maxConcurrency_);
    for (unsigned worker = 0; worker < maxConcurrency_; ++worker) {
      workers_.emplace_back([this] { workerLoop(); });
    }

    // Block until every worker has reached its wait, mirroring SingleJob's
    // start handshake so jobs scheduled right after construction are not lost.
    std::unique_lock lock(mtx_);
    workCv_.wait(lock, [this] { return readyCount_ == maxConcurrency_; });
  }

  ~MultiJobScheduler() override {
    std::vector<JobId> jobsInFlight;
    {
      std::lock_guard lock(mtx_);
      running_.store(false);
      jobsInFlight.assign(inFlight_.begin(), inFlight_.end());
    }
    workCv_.notify_all();
    // Unblock a worker stuck inside model process(): teardown must not wait
    // for the model to finish on its own. Fall back to per-id cancellation
    // when the model has no whole-model cancel(). Cancel only while a job is
    // in flight — an idle scheduler's model may already be destroyed.
    // Cancellation may throw (a throw rejects it, see IModelCancel) and this
    // destructor is noexcept: swallow the failure — escaping here would be
    // std::terminate. On the per-id path each id keeps its own attempt, so
    // one failing cancel does not abandon the remaining jobs. Jobs whose
    // cancel never landed simply run to their natural end before the joins
    // below, which is teardown's semantic anyway.
    if (!jobsInFlight.empty()) {
      if (cancel_ != nullptr) {
        try {
          cancel_->cancel();
        } catch (...) {
          QLOG(logger::Priority::WARNING,
              "Model cancel() threw during scheduler teardown; waiting for "
              "in-flight jobs to end on their own");
        }
      } else if (cancelById_ != nullptr) {
        for (const JobId id : jobsInFlight) {
          try {
            cancelById_->cancelById(id);
          } catch (...) {
            QLOG(logger::Priority::WARNING,
                "Model cancelById() threw during scheduler teardown; waiting "
                "for that job to end on its own");
          }
        }
      }
    }
    for (std::thread& worker : workers_) {
      if (worker.joinable()) {
        worker.join();
      }
    }
    if (outputQueue_ == nullptr) {
      return; // never started, nothing was admitted
    }
    // Workers are gone; fail whatever never started so no accepted job ends
    // without a terminal event. Publication failures are swallowed: every
    // terminal is still attempted, and a destructor throw would terminate.
    static_cast<void>(publishCancelledTerminals(
        dropQueued(), "Job cancelled: scheduler destroyed"));
  }

  std::optional<JobId> runJob(std::any input) override {
    std::unique_lock lock(mtx_);
    // Widen before adding so the cap cannot wrap for extreme ctor arguments.
    if (exclusiveActive_ ||
        admittedCount_ >= std::size_t{maxConcurrency_} + queueCapacity_) {
      // Pool + queue full, or an exclusive job (finetune) holds the model:
      // reject so no output is ever queued for this job.
      return std::nullopt;
    }
    // Mint only after admission is certain, so a rejected call consumes no id.
    const JobId id = nextJobId_++;
    ++admittedCount_;
    queued_.push_back(PendingJob{std::move(input), id});
    queuedIndex_.emplace(id, std::prev(queued_.end()));
    lock.unlock();
    workCv_.notify_one();
    return id;
  }

  std::optional<JobId> runExclusiveJob(std::any input) override {
    std::unique_lock lock(mtx_);
    if (exclusiveActive_ || admittedCount_ > 0) {
      // An exclusive job must run with the model to itself: refuse while
      // anything is queued or in flight (peer jobs, or another exclusive job).
      return std::nullopt;
    }
    const JobId id = nextJobId_++;
    exclusiveActive_ = true;
    ++admittedCount_;
    queued_.push_back(PendingJob{std::move(input), id, /*exclusive=*/true});
    queuedIndex_.emplace(id, std::prev(queued_.end()));
    lock.unlock();
    workCv_.notify_one();
    return id;
  }

  void cancel(JobId id) override {
    bool dropped = false;
    {
      std::lock_guard lock(mtx_);
      dropped = dropQueuedJob(id);
    }
    if (dropped) {
      // Never reached the model, so there is nothing to cancel there; this
      // error is the job's terminal event.
      outputQueue_->queueException(std::runtime_error("Job cancelled"), id);
      return;
    }
    if (cancelById_ != nullptr) {
      cancelById_->cancelById(id);
      // The model may apply the cancel later, on its own worker; only the
      // job's departure makes "cancel returned" mean "job gone".
      awaitJobsGone({id});
      return;
    }
    QLOG(logger::Priority::WARNING,
        "Model does not support per-job cancellation (cancelById)");
  }

  void cancelAll() override {
    if (const std::exception_ptr failure =
            publishCancelledTerminals(dropQueued(), "Job cancelled")) {
      // Every dropped terminal was attempted; reject before cancelling
      // in-flight work the caller now cannot assume was reached.
      std::rethrow_exception(failure);
    }
    // Await only this snapshot: jobs admitted while the wait runs are not
    // cancelled and must not extend it. Per-id cancellation is preferred
    // whenever the model offers it: the scheduler owns the exact in-flight
    // id set, so delivery is precise and point-in-time by construction. The
    // whole-model cancel is the fallback for models offering nothing finer;
    // it is indiscriminate, so it is dispatched under the same lock as the
    // snapshot: a worker needs mtx_ to dequeue a job into inFlight_, so no
    // job admitted after the snapshot can be collaterally swept into this
    // cancel while it is still being dispatched.
    std::vector<JobId> inFlightSnapshot;
    {
      std::lock_guard lock(mtx_);
      inFlightSnapshot.assign(inFlight_.begin(), inFlight_.end());
      if (cancelById_ == nullptr && cancel_ != nullptr) {
        cancel_->cancel();
      }
    }
    if (cancelById_ != nullptr) {
      for (const JobId id : inFlightSnapshot) {
        cancelById_->cancelById(id);
      }
      awaitJobsGone(inFlightSnapshot);
      return;
    }
    if (cancel_ != nullptr) {
      awaitJobsGone(inFlightSnapshot);
      return;
    }
    QLOG(logger::Priority::WARNING, "Model does not support cancellation (of all jobs in a single-call)");
  }

  [[nodiscard]] std::vector<JobId> liveJobIds() const override {
    std::lock_guard lock(mtx_);
    std::vector<JobId> ids;
    ids.reserve(queuedIndex_.size() + inFlight_.size());
    for (const auto& entry : queuedIndex_) {
      ids.push_back(entry.first);
    }
    ids.insert(ids.end(), inFlight_.begin(), inFlight_.end());
    return ids;
  }

  /// One lock pass drops every still-queued snapshot id BEFORE any in-flight
  /// cancel is issued or awaited: awaiting a cancel releases that job's slot,
  /// and a queued snapshot id still undropped at that moment would win the
  /// freed slot and run despite having been cancelled while queued. Only then
  /// are the in-flight targets cancelled — per id when the model offers
  /// cancelById, else via one whole-model cancel() (indiscriminate, but the
  /// only cancel such a model offers), dispatched under the same lock as the
  /// in-flight snapshot so no job admitted afterward can be collaterally
  /// swept into it while it is still in flight — and awaited until they
  /// leave. The whole-model path awaits every job that cancel actually
  /// swept (the full in-flight snapshot), not just the requested targets: a
  /// non-target job it cancelled still holds a slot, and returning before
  /// that job leaves would let activeJobs() spuriously refuse an immediate
  /// follow-up admission — the guarantee every cancel entry point gives is
  /// scoped to the jobs it delivered a cancel for, target or not.
  void cancelJobs(const std::vector<JobId>& ids) override {
    std::vector<JobId> dropped;
    std::vector<JobId> inFlightTargets;
    std::vector<JobId> sweptInFlight;
    std::exception_ptr cancelFailure;
    {
      std::lock_guard lock(mtx_);
      for (const JobId id : ids) {
        if (dropQueuedJob(id)) {
          dropped.push_back(id);
        } else if (inFlight_.count(id) != 0) {
          inFlightTargets.push_back(id);
        }
      }
      if (!inFlightTargets.empty() && cancelById_ == nullptr &&
          cancel_ != nullptr) {
        sweptInFlight.assign(inFlight_.begin(), inFlight_.end());
        try {
          cancel_->cancel();
        } catch (...) {
          // The queued targets are already unlinked — irreversibly, no
          // worker can ever run them — so their terminal errors must go
          // out even though the cancel itself failed. Park the failure,
          // publish below, rethrow after.
          cancelFailure = std::current_exception();
        }
      }
    }
    const std::exception_ptr publishFailure =
        publishCancelledTerminals(dropped, "Job cancelled");
    if (cancelFailure != nullptr) {
      // Rethrow before any await: the model-side cancel was not delivered,
      // so waiting on the swept snapshot could wait on jobs nothing will
      // ever end.
      std::rethrow_exception(cancelFailure);
    }
    if (publishFailure != nullptr) {
      // Every dropped terminal was attempted (publishCancelledTerminals
      // continues past failures); reject before dispatching or awaiting
      // anything further.
      std::rethrow_exception(publishFailure);
    }
    if (inFlightTargets.empty()) {
      return;
    }
    if (cancelById_ != nullptr) {
      for (const JobId id : inFlightTargets) {
        cancelById_->cancelById(id);
      }
      awaitJobsGone(inFlightTargets);
      return;
    }
    if (cancel_ != nullptr) {
      awaitJobsGone(sweptInFlight);
      return;
    }
    QLOG(logger::Priority::WARNING, "Model does not support cancellation");
  }

  /// Active jobs (queued + in-flight); the figure admission is capped against.
  [[nodiscard]] std::size_t activeJobs() const override {
    std::lock_guard lock(mtx_);
    return admittedCount_;
  }

  [[nodiscard]] bool isBoundTo(const model::IModel& model) const override {
    return multiprocessor_ ==
        dynamic_cast<const model::IModelMultiprocessor*>(&model);
  }
};

} // namespace qvac_lib_inference_addon_cpp
