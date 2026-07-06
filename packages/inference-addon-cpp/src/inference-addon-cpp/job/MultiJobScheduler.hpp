#pragma once

#include <any>
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <list>
#include <map>
#include <memory>
#include <mutex>
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
/// This is the tagged path: every job must carry a unique, non-sentinel id.
/// runJob/runExclusiveJob reject kNoJobId and any id already live (queued or in
/// flight), so outputs stay correlatable and cancel(id) always targets the one
/// job that owns the id. An id becomes reusable once its job ends.
///
/// Cancelling a job still waiting in the queue is the scheduler's concern (the
/// model cannot know ids it never received): the job is unlinked in O(1) via
/// queuedIndex_, its slot and exclusivity released, and a "Job cancelled" error
/// queued as its terminal event. In-flight cancellation routes to the model:
/// cancel(id) via cancelById(), cancelAll() via the whole-model cancel(); that
/// id -> internal-slot mapping is the model's concern.
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
  const unsigned maxConcurrency_;
  /// Waiting room beyond the worker pool. Jobs admitted here sit in queued_
  /// until a worker frees; 0 restores strict reject-at-pool back-pressure.
  const unsigned queueCapacity_;

  mutable std::mutex mtx_;
  mutable std::condition_variable workCv_;
  std::list<PendingJob> queued_;
  /// id -> queued_ node, so cancelling a not-yet-started job unlinks it in O(1)
  /// instead of scanning the queue. Ids are unique across the scheduler, so
  /// every queued job has exactly one entry here.
  std::map<JobId, std::list<PendingJob>::iterator> queuedIndex_;
  /// Ids currently being processed by a worker (dequeued but not yet finished).
  /// Together with queuedIndex_ (queued ids) it is the set of live ids, against
  /// which admission enforces uniqueness.
  std::set<JobId> inFlight_;
  /// Admitted (queued + in-flight) job count; the figure admission is capped
  /// against. Decremented when a job finishes.
  std::size_t admittedCount_{0};
  /// Set while an exclusive job (e.g. finetune) is queued or in flight. Blocks
  /// every other admission until that job ends, giving it the model to itself.
  bool exclusiveActive_{false};
  std::vector<std::thread> workers_;
  std::atomic_bool running_{false};
  unsigned readyCount_{0};

  void runResult(std::any&& output, JobId id) {
    outputQueue_->queueResult(std::move(output), id);
    outputQueue_->queueJobEnded(id);
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

  /// Worker body. Per-job input/id are copied onto the stack while the lock is
  /// held, then process() runs unlocked so cancel() and peer workers progress.
  void workerLoop() {
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
      lock.unlock();

      try {
        std::any output = multiprocessor_->process(job.input, job.id);
        runResult(std::move(output), job.id);
      } catch (const std::exception& exception) {
        outputQueue_->queueException(exception, job.id);
      } catch (...) {
        outputQueue_->queueException(
            std::runtime_error("Unknown exception in processing loop"), job.id);
      }

      {
        std::lock_guard relock(mtx_);
        --admittedCount_;
        inFlight_.erase(job.id);
        // Release exclusivity here, after process() has fully returned or
        // thrown, so a stuck flag can never wedge admission if an exclusive job
        // (finetune) fails.
        if (job.exclusive) {
          exclusiveActive_ = false;
        }
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
  MultiJobScheduler(
      model::IModelMultiprocessor* multiprocessor, unsigned maxConcurrency,
      model::IModelCancel* cancel, model::IModelCancelById* cancelById,
      unsigned queueCapacity = DEFAULT_MAX_CAPACITY)
      : multiprocessor_(multiprocessor), cancel_(cancel),
        cancelById_(cancelById), maxConcurrency_(maxConcurrency),
        queueCapacity_(queueCapacity) {
    if (multiprocessor_ == nullptr) {
      throw std::invalid_argument("multiprocessor must not be null");
    }
    if (maxConcurrency_ == 0) {
      throw std::invalid_argument("maxConcurrency must be > 0");
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
    {
      std::lock_guard lock(mtx_);
      running_.store(false);
    }
    workCv_.notify_all();
    for (std::thread& worker : workers_) {
      if (worker.joinable()) {
        worker.join();
      }
    }
    if (outputQueue_ == nullptr) {
      return; // never started, nothing was admitted
    }
    // Workers are gone; fail whatever never started so no accepted job ends
    // without a terminal event.
    for (const JobId id : dropQueued()) {
      outputQueue_->queueException(
          std::runtime_error("Job cancelled: scheduler destroyed"), id);
    }
  }

  bool runJob(std::any input, JobId id) override {
    std::unique_lock lock(mtx_);
    // The multi-job path is the tagged path: an untagged sentinel carries no
    // identity to correlate or cancel by, and a live-duplicate id would make
    // its outputs indistinguishable and un-cancellable via the queued fast
    // path. Reject either (false, the "false = rejected" idiom).
    if (id == kNoJobId || queuedIndex_.count(id) != 0 ||
        inFlight_.count(id) != 0) {
      return false;
    }
    // Widen before adding so the cap cannot wrap for extreme ctor arguments.
    if (exclusiveActive_ ||
        admittedCount_ >= std::size_t{maxConcurrency_} + queueCapacity_) {
      // Pool + queue full, or an exclusive job (finetune) holds the model:
      // reject so no output is ever queued for this job.
      return false;
    }
    ++admittedCount_;
    queued_.push_back(PendingJob{std::move(input), id});
    queuedIndex_.emplace(id, std::prev(queued_.end()));
    lock.unlock();
    workCv_.notify_one();
    return true;
  }

  bool runExclusiveJob(std::any input, JobId id) override {
    std::unique_lock lock(mtx_);
    if (id == kNoJobId) {
      // Tagged path: the untagged sentinel is not a valid job identity.
      return false;
    }
    if (exclusiveActive_ || admittedCount_ > 0) {
      // An exclusive job must run with the model to itself: refuse while
      // anything is queued or in flight (peer jobs, or another exclusive job).
      return false;
    }
    exclusiveActive_ = true;
    ++admittedCount_;
    queued_.push_back(PendingJob{std::move(input), id, /*exclusive=*/true});
    queuedIndex_.emplace(id, std::prev(queued_.end()));
    lock.unlock();
    workCv_.notify_one();
    return true;
  }

  void cancel(JobId id) override {
    bool dropped = false;
    {
      std::lock_guard lock(mtx_);
      const auto indexed = queuedIndex_.find(id);
      if (indexed != queuedIndex_.end()) {
        if (indexed->second->exclusive) {
          exclusiveActive_ = false;
        }
        queued_.erase(indexed->second);
        queuedIndex_.erase(indexed);
        --admittedCount_;
        dropped = true;
      }
    }
    if (dropped) {
      // Never reached the model, so there is nothing to cancel there; this
      // error is the job's terminal event.
      outputQueue_->queueException(std::runtime_error("Job cancelled"), id);
      return;
    }
    if (cancelById_ != nullptr) {
      cancelById_->cancelById(id);
      return;
    }
    QLOG(logger::Priority::WARNING,
        "Model does not support per-job cancellation (cancelById)");
  }

  void cancelAll() override {
    for (const JobId id : dropQueued()) {
      outputQueue_->queueException(std::runtime_error("Job cancelled"), id);
    }
    if (cancel_ != nullptr) {
      cancel_->cancel();
      return;
    }
    QLOG(logger::Priority::WARNING, "Model does not support cancellation (of all jobs in a single-call)");
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
