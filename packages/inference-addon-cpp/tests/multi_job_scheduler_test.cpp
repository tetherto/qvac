#include <algorithm>
#include <any>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "inference-addon-cpp/job/JobId.hpp"
#include "inference-addon-cpp/job/MultiJobScheduler.hpp"
#include "inference-addon-cpp/queue/OutputCallbackInterface.hpp"
#include "inference-addon-cpp/queue/OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

namespace {

class MockOutputCallback : public OutputCallBackInterface {
  std::atomic_bool stopped_{false};

public:
  void initializeProcessingThread(
      std::shared_ptr<OutputQueue> /*outputQueue*/) override {}
  void notify() override {}
  void stop() override { stopped_ = true; }
};

/// Samples a probe (the scheduler's activeJobs()) at every notify(), i.e. at
/// the exact moment an event becomes observable to the consumer. notify()
/// runs on the scheduler's worker thread, which holds no scheduler lock while
/// publishing, so sampling activeJobs() here is deadlock-free.
class ActiveJobsProbeCallback final : public MockOutputCallback {
  std::function<std::size_t()> sample_;
  mutable std::mutex mtx_;
  std::vector<std::size_t> samples_;

public:
  void setSampler(std::function<std::size_t()> sample) {
    sample_ = std::move(sample);
  }

  void notify() override {
    if (sample_) {
      const std::size_t value = sample_();
      std::lock_guard lock(mtx_);
      samples_.push_back(value);
    }
  }

  std::vector<std::size_t> samples() const {
    std::lock_guard lock(mtx_);
    return samples_;
  }

  /// Blocks until at least @p count samples were recorded or the timeout
  /// lapses. The publishing happens after the slot release, so waitForIdle
  /// alone cannot guarantee the samples are already recorded.
  bool waitForSamples(std::size_t count, std::chrono::milliseconds timeout) {
    const std::chrono::steady_clock::time_point deadline =
        std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
      {
        std::lock_guard lock(mtx_);
        if (samples_.size() >= count) {
          return true;
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds{1});
    }
    std::lock_guard lock(mtx_);
    return samples_.size() >= count;
  }
};

/// Throws from the first notify() only: exercises a terminal-publication
/// failure without also blowing up the queueException() the worker publishes
/// from its catch (that second notify() must succeed).
class ThrowOnceCallback final : public MockOutputCallback {
  std::atomic_bool thrown_{false};

public:
  void notify() override {
    if (!thrown_.exchange(true)) {
      throw std::runtime_error("notify failed");
    }
  }
};

/// Concurrent test model whose per-job process() blocks until its id is
/// cancelled (cancelById), every job is cancelled (cancel), or its configured
/// duration elapses. Tracks peak overlap so a test can assert that jobs were
/// genuinely in flight together. Exercises both cancellation surfaces the
/// scheduler routes to: per-id cancelById() and whole-model cancel().
class ConcurrentTestModel : public model::IModel,
                            public model::IModelMultiprocessor,
                            public model::IModelCancel,
                            public model::IModelCancelById,
                            public model::IModelJobLifecycle {
  const std::chrono::milliseconds processTime_;

  mutable std::mutex mtx_;
  std::unordered_set<JobId> cancelledIds_;
  std::unordered_set<JobId> throwIds_;
  bool cancelAllRequested_{false};
  int active_{0};
  int peakActive_{0};

public:
  explicit ConcurrentTestModel(std::chrono::milliseconds processTime)
      : processTime_(processTime) {}

  std::string getName() const override { return "ConcurrentTestModel"; }

  RuntimeStats runtimeStats() const override { return RuntimeStats{}; }

  // IModel single-job entry is unused by the multi-job path.
  std::any process(const std::any& input) override { return input; }

  /// Make process() for @p id throw instead of running, to exercise the
  /// scheduler's per-job exception isolation.
  void throwForId(JobId id) {
    std::lock_guard lock(mtx_);
    throwIds_.insert(id);
  }

  std::any process(const std::any& input, JobId id) override {
    {
      std::lock_guard lock(mtx_);
      if (throwIds_.count(id) != 0) {
        throw std::runtime_error(
            "ConcurrentTestModel: injected failure for job");
      }
      ++active_;
      peakActive_ = std::max(peakActive_, active_);
    }

    const std::chrono::steady_clock::time_point start =
        std::chrono::steady_clock::now();
    while (std::chrono::steady_clock::now() - start < processTime_) {
      {
        std::lock_guard lock(mtx_);
        if (cancelledIds_.count(id) != 0 || cancelAllRequested_) {
          break;
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds{2});
    }

    {
      std::lock_guard lock(mtx_);
      --active_;
    }
    return input;
  }

  void cancel() const override {
    auto* self = const_cast<ConcurrentTestModel*>(this);
    std::lock_guard lock(self->mtx_);
    self->cancelAllRequested_ = true;
  }

  void cancelById(JobId id) const override {
    auto* self = const_cast<ConcurrentTestModel*>(this);
    std::lock_guard lock(self->mtx_);
    self->cancelledIds_.insert(id);
  }

  /// Satisfies the ctor's cancelById-requires-lifecycle contract. Nothing to
  /// register: this fake's cancelById accepts ids it has never seen.
  void jobStarting(JobId /*id*/) override {}

  int peakActive() const {
    std::lock_guard lock(mtx_);
    return peakActive_;
  }

  int active() const {
    std::lock_guard lock(mtx_);
    return active_;
  }
};

/// ConcurrentTestModel that additionally records which ids reached process(),
/// so the queued-cancellation tests can assert a dropped job never started.
/// Kept out of the base model: only those tests need start tracking.
class StartTrackingTestModel final : public ConcurrentTestModel {
  mutable std::mutex startedMtx_;
  std::unordered_set<JobId> startedIds_;
  /// Ids in the order process() was entered, so a test can assert FIFO
  /// admission — not merely that a job started.
  std::vector<JobId> startOrder_;

public:
  using ConcurrentTestModel::ConcurrentTestModel;

  std::any process(const std::any& input, JobId id) override {
    {
      std::lock_guard lock(startedMtx_);
      startedIds_.insert(id);
      startOrder_.push_back(id);
    }
    return ConcurrentTestModel::process(input, id);
  }

  /// Whether process() was ever entered for @p id.
  bool started(JobId id) const {
    std::lock_guard lock(startedMtx_);
    return startedIds_.count(id) != 0;
  }

  /// Ids in the order process() was entered.
  std::vector<JobId> startOrder() const {
    std::lock_guard lock(startedMtx_);
    return startOrder_;
  }
};

/// ConcurrentTestModel that additionally implements IModelJobStats, so the
/// jobEnded tests can assert the output queue appends per-job observed stats
/// to a tagged job's terminal snapshot. Kept out of the base model: only the
/// per-job stats tests need it.
class JobStatsTestModel final : public ConcurrentTestModel,
                                public model::IModelJobStats {
  mutable std::mutex statsMtx_;
  mutable std::vector<JobId> consumedIds_;
  mutable std::unordered_set<JobId> knownIds_;

public:
  using ConcurrentTestModel::ConcurrentTestModel;

  /// Make consumeJobStats(id) return a non-empty per-job snapshot.
  void addJobStats(JobId id) {
    std::lock_guard lock(statsMtx_);
    knownIds_.insert(id);
  }

  /// Take-once, mirroring the real contract (IModelJobStats::consumeJobStats):
  /// a known id's entry is erased on the call that hands it over.
  RuntimeStats consumeJobStats(JobId id) const override {
    std::lock_guard lock(statsMtx_);
    consumedIds_.push_back(id);
    if (knownIds_.erase(id) == 0) {
      return RuntimeStats{};
    }
    // The job's complete terminal snapshot: model-level entry plus the job's
    // own figure under the shared key name.
    return RuntimeStats{{"globalStat", int64_t{1}}, {"TPS", 42.0}};
  }

  std::vector<JobId> consumedIds() const {
    std::lock_guard lock(statsMtx_);
    return consumedIds_;
  }

  /// Whether @p id still has an unconsumed per-job stats entry.
  bool hasJobStats(JobId id) const {
    std::lock_guard lock(statsMtx_);
    return knownIds_.count(id) != 0;
  }

  /// Global snapshot with an aggregate-only marker and a key the per-job
  /// entries collide with.
  RuntimeStats runtimeStats() const override {
    return RuntimeStats{{"globalStat", int64_t{1}}, {"TPS", 1.0}};
  }
};

/// Emulates a registration-gated model (the real LlamaModel): cancel() and
/// cancelById() land ONLY on jobs the model already knows about, and the only
/// way it learns about a job before process(input, id) is the scheduler's
/// jobStarting() announcement. A cancel for an unknown id is silently dropped,
/// exactly like the run-counter / cancel-registry guards in the real model —
/// so these tests fail whenever the scheduler lets a cancel fall between
/// dequeue and the announcement.
class RegistrationGatedTestModel final : public model::IModel,
                                         public model::IModelMultiprocessor,
                                         public model::IModelCancel,
                                         public model::IModelCancelById,
                                         public model::IModelJobLifecycle {
  const std::chrono::milliseconds processTime_;

  mutable std::mutex mtx_;
  std::unordered_set<JobId> announced_;
  std::vector<JobId> announceOrder_;
  std::unordered_set<JobId> entered_;
  /// Ids whose process() started while the job was still unannounced — each
  /// one is an ordering violation of the jobStarting contract.
  std::unordered_set<JobId> enteredUnannounced_;
  std::unordered_set<JobId> cancelled_;
  int active_{0};

public:
  explicit RegistrationGatedTestModel(std::chrono::milliseconds processTime)
      : processTime_(processTime) {}

  std::string getName() const override {
    return "RegistrationGatedTestModel";
  }

  RuntimeStats runtimeStats() const override { return RuntimeStats{}; }

  std::any process(const std::any& input) override { return input; }

  void jobStarting(JobId id) override {
    std::lock_guard lock(mtx_);
    announced_.insert(id);
    announceOrder_.push_back(id);
  }

  std::any process(const std::any& input, JobId id) override {
    {
      std::lock_guard lock(mtx_);
      entered_.insert(id);
      if (announced_.count(id) == 0) {
        enteredUnannounced_.insert(id);
      }
      ++active_;
    }
    const std::chrono::steady_clock::time_point start =
        std::chrono::steady_clock::now();
    bool sawCancel = false;
    while (std::chrono::steady_clock::now() - start < processTime_) {
      {
        std::lock_guard lock(mtx_);
        if (cancelled_.count(id) != 0) {
          sawCancel = true;
          break;
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds{2});
    }
    {
      std::lock_guard lock(mtx_);
      --active_;
    }
    return std::string(sawCancel ? "cancelled" : "ran-to-completion");
  }

  /// Whole-model cancel: lands on announced jobs only, mirroring the real
  /// model's "only work it knows about" guard.
  void cancel() const override {
    auto* self = const_cast<RegistrationGatedTestModel*>(this);
    std::lock_guard lock(self->mtx_);
    for (const JobId id : self->announced_) {
      self->cancelled_.insert(id);
    }
  }

  /// Per-id cancel: unknown ids are dropped, like the real cancel registry.
  void cancelById(JobId id) const override {
    auto* self = const_cast<RegistrationGatedTestModel*>(this);
    std::lock_guard lock(self->mtx_);
    if (self->announced_.count(id) != 0) {
      self->cancelled_.insert(id);
    }
  }

  bool announced(JobId id) const {
    std::lock_guard lock(mtx_);
    return announced_.count(id) != 0;
  }

  /// How many times the scheduler announced @p id (must be exactly once for a
  /// started job, zero for a dropped queued job).
  std::size_t announceCount(JobId id) const {
    std::lock_guard lock(mtx_);
    std::size_t count = 0;
    for (const JobId seen : announceOrder_) {
      if (seen == id) {
        ++count;
      }
    }
    return count;
  }

  /// Whether the job was announced strictly before process(input, id) ran.
  bool announcedBeforeEntered(JobId id) const {
    std::lock_guard lock(mtx_);
    return entered_.count(id) != 0 && enteredUnannounced_.count(id) == 0;
  }

  bool entered(JobId id) const {
    std::lock_guard lock(mtx_);
    return entered_.count(id) != 0;
  }

  int active() const {
    std::lock_guard lock(mtx_);
    return active_;
  }
};

/// Lifecycle model whose jobStarting() throws for seeded ids: exercises the
/// worker's exception boundary around the dequeue-time announcement. Its
/// process(input, id) records entry and echoes the input.
class ThrowingLifecycleTestModel final : public model::IModel,
                                         public model::IModelMultiprocessor,
                                         public model::IModelJobLifecycle {
  mutable std::mutex mtx_;
  std::unordered_set<JobId> throwIds_;
  std::unordered_set<JobId> entered_;

public:
  void throwOnStart(JobId id) {
    std::lock_guard lock(mtx_);
    throwIds_.insert(id);
  }

  std::string getName() const override { return "ThrowingLifecycleTestModel"; }

  RuntimeStats runtimeStats() const override { return RuntimeStats{}; }

  std::any process(const std::any& input) override { return input; }

  void jobStarting(JobId id) override {
    std::lock_guard lock(mtx_);
    if (throwIds_.count(id) != 0) {
      throw std::runtime_error("jobStarting failed");
    }
  }

  std::any process(const std::any& input, JobId id) override {
    std::lock_guard lock(mtx_);
    entered_.insert(id);
    return input;
  }

  bool entered(JobId id) const {
    std::lock_guard lock(mtx_);
    return entered_.count(id) != 0;
  }
};

/// Blocks until @p target jobs are concurrently active on the gated model or
/// the timeout lapses.
int waitForGatedActive(const RegistrationGatedTestModel& model, int target,
                       std::chrono::milliseconds timeout) {
  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + timeout;
  while (model.active() < target &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{1});
  }
  return model.active();
}

/// Blocks until @p target jobs are concurrently active or the timeout lapses,
/// returning the active count observed at exit.
int waitForActive(const ConcurrentTestModel& model, int target,
                  std::chrono::milliseconds timeout) {
  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + timeout;
  while (model.active() < target &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{1});
  }
  return model.active();
}

/// Blocks until the scheduler reports no admitted jobs (in-flight + queued
/// drained) or the timeout lapses.
void waitForIdle(
    const MultiJobScheduler& scheduler, std::chrono::milliseconds timeout) {
  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + timeout;
  while (scheduler.activeJobs() != 0 &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{2});
  }
}

using Outputs = std::vector<std::pair<JobId, std::any>>;

/// A worker frees a job's slot BEFORE publishing its terminal events, so
/// waitForIdle returning cannot guarantee those events are already queued.
/// Keeps draining the output queue, accumulating every event, until
/// @p published(everything drained so far) holds or the timeout lapses;
/// returns the accumulated events either way.
Outputs drainUntil(
    OutputQueue& queue, const std::function<bool(const Outputs&)>& published,
    std::chrono::milliseconds timeout) {
  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + timeout;
  Outputs drained;
  for (;;) {
    Outputs batch = queue.clear();
    for (std::pair<JobId, std::any>& entry : batch) {
      drained.push_back(std::move(entry));
    }
    if (published(drained) || std::chrono::steady_clock::now() >= deadline) {
      return drained;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds{1});
  }
}

/// Terminal events among @p outputs: a jobEnded stats snapshot (success) or an
/// Output::Error (failure / cancelled while queued) — exactly one per admitted
/// job. The success result payload (the echoed input) is not terminal.
int countTerminalEvents(const Outputs& outputs) {
  int terminal = 0;
  for (const std::pair<JobId, std::any>& entry : outputs) {
    if (entry.second.type() == typeid(RuntimeStats) ||
        entry.second.type() == typeid(Output::Error)) {
      ++terminal;
    }
  }
  return terminal;
}

} // namespace

// The scheduler mints job ids itself: 1, 2, 3, ... in admission order, per
// instance (pinned by MintsMonotonicIdsStartingAtOne). Tests that must seed
// per-id behaviour before admission (throwForId, addJobStats) rely on that
// determinism; submitting from the single test thread makes the sequence
// exact.
class MultiJobSchedulerTest : public ::testing::Test {
protected:
  std::unique_ptr<MockOutputCallback> callback_;
  std::unique_ptr<ConcurrentTestModel> model_;
  std::unique_ptr<RegistrationGatedTestModel> gatedModel_;
  std::shared_ptr<OutputQueue> outputQueue_;
  std::unique_ptr<MultiJobScheduler> scheduler_;

  void build(unsigned maxConcurrency, std::chrono::milliseconds processTime) {
    buildWithQueue(maxConcurrency, 0, processTime);
  }

  void buildWithQueue(
      unsigned maxConcurrency, unsigned queueCapacity,
      std::chrono::milliseconds processTime) {
    model_ = std::make_unique<ConcurrentTestModel>(processTime);
    wire(maxConcurrency, queueCapacity);
  }

  /// buildWithQueue with a StartTrackingTestModel instead; returns it
  /// (non-owning) so the test can query started().
  StartTrackingTestModel* buildTrackingWithQueue(
      unsigned maxConcurrency, unsigned queueCapacity,
      std::chrono::milliseconds processTime) {
    auto tracking = std::make_unique<StartTrackingTestModel>(processTime);
    StartTrackingTestModel* raw = tracking.get();
    model_ = std::move(tracking);
    wire(maxConcurrency, queueCapacity);
    return raw;
  }

  /// buildWithQueue with a JobStatsTestModel instead; returns it (non-owning)
  /// so the test can seed and query per-job stats.
  JobStatsTestModel* buildJobStatsWithQueue(
      unsigned maxConcurrency, unsigned queueCapacity,
      std::chrono::milliseconds processTime) {
    auto stats = std::make_unique<JobStatsTestModel>(processTime);
    JobStatsTestModel* raw = stats.get();
    model_ = std::move(stats);
    wire(maxConcurrency, queueCapacity);
    return raw;
  }

  void wire(unsigned maxConcurrency, unsigned queueCapacity) {
    callback_ = std::make_unique<MockOutputCallback>();
    outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
    scheduler_ = std::make_unique<MultiJobScheduler>(
        model_.get(), maxConcurrency, model_.get(), model_.get(),
        queueCapacity);
    scheduler_->start(outputQueue_);
  }

  /// buildWithQueue with a RegistrationGatedTestModel instead; returns it
  /// (non-owning) so the test can query announcements and cancellations. The
  /// scheduler resolves the model's IModelJobLifecycle itself.
  RegistrationGatedTestModel* buildGatedWithQueue(
      unsigned maxConcurrency, unsigned queueCapacity,
      std::chrono::milliseconds processTime) {
    gatedModel_ = std::make_unique<RegistrationGatedTestModel>(processTime);
    callback_ = std::make_unique<MockOutputCallback>();
    outputQueue_ = std::make_shared<OutputQueue>(*callback_, *gatedModel_);
    scheduler_ = std::make_unique<MultiJobScheduler>(
        gatedModel_.get(), maxConcurrency, gatedModel_.get(),
        gatedModel_.get(), queueCapacity);
    scheduler_->start(outputQueue_);
    return gatedModel_.get();
  }

  /// Build a scheduler whose model exposes no per-job cancellation (cancelById
  /// = nullptr), so cancel(id) for an in-flight job hits the unsupported path.
  void buildNoCancelById(
      unsigned maxConcurrency, std::chrono::milliseconds processTime) {
    model_ = std::make_unique<ConcurrentTestModel>(processTime);
    callback_ = std::make_unique<MockOutputCallback>();
    outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
    scheduler_ = std::make_unique<MultiJobScheduler>(
        model_.get(), maxConcurrency, model_.get(), /*cancelById=*/nullptr, 0);
    scheduler_->start(outputQueue_);
  }

  /// Build a scheduler whose model exposes only per-job cancellation (cancel =
  /// nullptr), the shape of a multi-job model with per-job contexts and no
  /// global stop switch, so cancelAll/teardown must reach jobs via cancelById.
  void buildNoWholeModelCancel(
      unsigned maxConcurrency, std::chrono::milliseconds processTime) {
    model_ = std::make_unique<ConcurrentTestModel>(processTime);
    callback_ = std::make_unique<MockOutputCallback>();
    outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
    scheduler_ = std::make_unique<MultiJobScheduler>(
        model_.get(), maxConcurrency, /*cancel=*/nullptr, model_.get(), 0);
    scheduler_->start(outputQueue_);
  }

  void TearDown() override {
    scheduler_.reset();
    outputQueue_.reset();
    model_.reset();
    gatedModel_.reset();
    callback_.reset();
  }
};

// (a) Concurrent admission: N jobs are genuinely in flight at the same time.
TEST_F(MultiJobSchedulerTest, AdmitsJobsConcurrently) {
  constexpr unsigned kConcurrency = 4;
  build(kConcurrency, std::chrono::milliseconds{300});

  for (unsigned job = 0; job < kConcurrency; ++job) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  }

  const int observed =
      waitForActive(*model_, kConcurrency, std::chrono::seconds{2});
  EXPECT_EQ(observed, static_cast<int>(kConcurrency))
      << "All admitted jobs should run at once";
  EXPECT_GE(model_->peakActive(), static_cast<int>(kConcurrency));

  scheduler_->cancelAll();
}

// (b) Back-pressure: the (N+1)th admission is rejected while N are in flight.
TEST_F(MultiJobSchedulerTest, RejectsBeyondCapacity) {
  constexpr unsigned kConcurrency = 3;
  build(kConcurrency, std::chrono::milliseconds{500});

  for (unsigned job = 0; job < kConcurrency; ++job) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  }
  // Must observe the pool genuinely full before probing overflow, else a slow
  // machine could reject simply because a job had not started yet.
  ASSERT_EQ(
      waitForActive(*model_, kConcurrency, std::chrono::seconds{2}),
      static_cast<int>(kConcurrency));

  EXPECT_FALSE(scheduler_->runJob(std::string("overflow")).has_value())
      << "Admission must reject once at capacity";

  scheduler_->cancelAll();
}

// (c) Per-job cancel isolation: cancelling one id leaves the others running.
TEST_F(MultiJobSchedulerTest, CancelOneLeavesOthersRunning) {
  constexpr unsigned kConcurrency = 3;
  build(kConcurrency, std::chrono::milliseconds{10000});

  for (unsigned job = 0; job < kConcurrency; ++job) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  }
  ASSERT_EQ(
      waitForActive(*model_, kConcurrency, std::chrono::seconds{2}),
      static_cast<int>(kConcurrency));

  scheduler_->cancel(2);

  const int target = static_cast<int>(kConcurrency) - 1;
  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds{2};
  while (model_->active() > target &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{2});
  }
  EXPECT_EQ(model_->active(), target)
      << "Exactly the cancelled job should have ended";

  // Peers stay alive long enough to confirm isolation.
  std::this_thread::sleep_for(std::chrono::milliseconds{100});
  EXPECT_EQ(model_->active(), target);

  scheduler_->cancelAll();
}

// (c2) cancel(id) on a model without per-job cancel (cancelById = nullptr) is a
// no-op: the targeted job keeps running. A targeted cancel must never silently
// escalate to cancelAll.
TEST_F(MultiJobSchedulerTest, CancelByIdWithoutCancelByIdModelIsNoOp) {
  constexpr unsigned kConcurrency = 2;
  buildNoCancelById(kConcurrency, std::chrono::milliseconds{10000});

  for (unsigned job = 0; job < kConcurrency; ++job) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  }
  ASSERT_EQ(
      waitForActive(*model_, kConcurrency, std::chrono::seconds{2}),
      static_cast<int>(kConcurrency));

  EXPECT_NO_THROW(scheduler_->cancel(1));

  // Give any (erroneous) cancellation time to land, then confirm both jobs are
  // still in flight: the unsupported per-job cancel must stop nothing.
  std::this_thread::sleep_for(std::chrono::milliseconds{100});
  EXPECT_EQ(model_->active(), static_cast<int>(kConcurrency))
      << "cancel(id) without a cancelById model must not stop any job";

  scheduler_->cancelAll();
}

// (d) cancelAll: every in-flight job is cancelled.
TEST_F(MultiJobSchedulerTest, CancelAllStopsEveryJob) {
  constexpr unsigned kConcurrency = 4;
  build(kConcurrency, std::chrono::milliseconds{10000});

  for (unsigned job = 0; job < kConcurrency; ++job) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  }
  ASSERT_EQ(
      waitForActive(*model_, kConcurrency, std::chrono::seconds{2}),
      static_cast<int>(kConcurrency));

  scheduler_->cancelAll();

  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds{2};
  while (model_->active() > 0 &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{2});
  }
  EXPECT_EQ(model_->active(), 0) << "cancelAll must drain all in-flight jobs";
}

// (e) High-contention stress: rapid submit + per-job cancel must never emit a
// bad_optional_access / slot-tear error (mirrors job_runner_test.cpp:361).
TEST_F(MultiJobSchedulerTest, HighContentionNoSlotTear) {
  constexpr unsigned kConcurrency = 4;
  build(kConcurrency, std::chrono::milliseconds{0});

  std::atomic_bool stop{false};
  std::atomic<JobId> lastAdmitted{kNoJobId};

  std::vector<std::thread> cancelThreads;
  for (int thread = 0; thread < 4; ++thread) {
    cancelThreads.emplace_back([this, &stop, &lastAdmitted] {
      while (!stop.load()) {
        const JobId id = lastAdmitted.load();
        if (id != kNoJobId) {
          scheduler_->cancel(id);
        }
        scheduler_->cancelAll();
        std::this_thread::yield();
      }
    });
  }

  int admitted = 0;
  for (int iteration = 0; iteration < 2000; ++iteration) {
    const std::optional<JobId> id = scheduler_->runJob(std::string("job"));
    if (id.has_value()) {
      ++admitted;
      lastAdmitted.store(*id);
    }
    if (iteration % 16 == 0) {
      std::this_thread::yield();
    }
  }

  stop = true;
  for (std::thread& thread : cancelThreads) {
    thread.join();
  }
  // Poll for a genuine drain instead of guessing with a fixed sleep: with the
  // cancel threads joined only the workers remain, so the admitted count can
  // only fall to zero.
  waitForIdle(*scheduler_, std::chrono::seconds{10});
  EXPECT_EQ(scheduler_->activeJobs(), 0u)
      << "every admitted job must drain (in-flight + queued)";

  // A worker frees the slot before publishing, so idle does not mean every
  // terminal event is observable yet — drain until they all are.
  const Outputs outputs = drainUntil(
      *outputQueue_,
      [admitted](const Outputs& seen) {
        return countTerminalEvents(seen) >= admitted;
      },
      std::chrono::seconds{5});
  for (const std::pair<JobId, std::any>& entry : outputs) {
    if (entry.second.type() == typeid(Output::Error)) {
      const Output::Error error = std::any_cast<Output::Error>(entry.second);
      const bool slotTear =
          error.find("bad_optional_access") != std::string::npos ||
          error.find("optional") != std::string::npos;
      EXPECT_FALSE(slotTear)
          << "Slot tear under contention. Error: " << error;
    }
  }
  EXPECT_EQ(countTerminalEvents(outputs), admitted)
      << "every admitted job must produce exactly one terminal event; a "
         "dropped or duplicated job under contention would break this";
}

// (f) Exclusive admission (finetune <-> inference mutual exclusion): an
// exclusive job is refused while inference is in flight, and while an exclusive
// job runs every inference admission is refused. This is the invariant the old
// single _hasActiveResponse bool gave and that activeJobs() >= maxConcurrency
// lost at parallel >= 2.
TEST_F(MultiJobSchedulerTest, ExclusiveJobRunsAlone) {
  constexpr unsigned kConcurrency = 4;
  build(kConcurrency, std::chrono::milliseconds{10000});

  const std::optional<JobId> first = scheduler_->runJob(std::string("job"));
  const std::optional<JobId> second = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(first.has_value());
  ASSERT_TRUE(second.has_value());
  ASSERT_EQ(
      waitForActive(*model_, 2, std::chrono::seconds{2}), 2);

  // Refused even though 2 of 4 slots are free: exclusivity, not capacity.
  EXPECT_FALSE(scheduler_->runExclusiveJob(std::string("finetune")).has_value())
      << "exclusive job admitted while inference was in flight";

  // Per-id cancel (not cancelAll) so whole-model cancel stays unset and a later
  // exclusive job can still run.
  scheduler_->cancel(*first);
  scheduler_->cancel(*second);
  waitForIdle(*scheduler_, std::chrono::seconds{2});
  ASSERT_EQ(scheduler_->activeJobs(), 0u);

  const std::optional<JobId> finetune =
      scheduler_->runExclusiveJob(std::string("finetune"));
  ASSERT_TRUE(finetune.has_value());
  EXPECT_NE(*finetune, *first);
  EXPECT_NE(*finetune, *second)
      << "an exclusive job must mint a fresh id, never reuse a finished one";
  ASSERT_EQ(
      waitForActive(*model_, 1, std::chrono::seconds{2}), 1);

  EXPECT_FALSE(scheduler_->runJob(std::string("job")).has_value())
      << "inference admitted while an exclusive job was running";

  scheduler_->cancel(*finetune);
}

// (g) Bounded queue: with queueCapacity beyond the worker pool, jobs past the
// pool are admitted and wait (they start only as a worker frees), and only the
// job past pool + queue is rejected. Every admitted job eventually completes.
// This is what makes rejectWhenBusy:false differ from true instead of rejecting
// at the worker count.
TEST_F(MultiJobSchedulerTest, QueuesBeyondWorkerCount) {
  constexpr unsigned kConcurrency = 2;
  constexpr unsigned kQueue = 2;
  buildWithQueue(kConcurrency, kQueue, std::chrono::milliseconds{150});

  for (int job = 1; job <= 4; ++job) {  // pool (2) + queue (2)
    EXPECT_TRUE(scheduler_->runJob(std::string("job")).has_value())
        << "job " << job << " within pool+queue must be admitted";
  }
  EXPECT_FALSE(scheduler_->runJob(std::string("job")).has_value())
      << "admission past pool+queue must be rejected";

  // Only pool-many run at once; the rest wait in the queue.
  ASSERT_EQ(
      waitForActive(*model_, kConcurrency, std::chrono::seconds{2}),
      static_cast<int>(kConcurrency));

  waitForIdle(*scheduler_, std::chrono::seconds{5});
  EXPECT_EQ(scheduler_->activeJobs(), 0u)
      << "all admitted (in-flight + queued) jobs must complete";
}

// (g2) FIFO admission order: queued jobs must start in submission order. A
// single worker makes this deterministic — it always dequeues the front — so
// the observed start order pins the deque contract. A regression to LIFO or
// unordered admission (which the count-only tests would miss) fails here.
TEST_F(MultiJobSchedulerTest, StartsQueuedJobsInFifoOrder) {
  constexpr unsigned kConcurrency = 1;
  constexpr unsigned kQueue = 3;
  StartTrackingTestModel* tracking = buildTrackingWithQueue(
      kConcurrency, kQueue, std::chrono::milliseconds{30});

  std::vector<JobId> admissionOrder;
  for (int job = 1; job <= 4; ++job) { // pool (1) + queue (3)
    const std::optional<JobId> id = scheduler_->runJob(std::string("job"));
    ASSERT_TRUE(id.has_value())
        << "job " << job << " within pool+queue must be admitted";
    admissionOrder.push_back(*id);
  }

  waitForIdle(*scheduler_, std::chrono::seconds{5});
  ASSERT_EQ(scheduler_->activeJobs(), 0u);
  EXPECT_EQ(tracking->startOrder(), admissionOrder)
      << "queued jobs must start in FIFO (submission) order";
}

/// Collects the JobIds for which an Output::Error was queued.
std::unordered_set<JobId> erroredIds(
    const std::vector<std::pair<JobId, std::any>>& outputs) {
  std::unordered_set<JobId> ids;
  for (const std::pair<JobId, std::any>& entry : outputs) {
    if (entry.second.type() == typeid(Output::Error)) {
      ids.insert(entry.first);
    }
  }
  return ids;
}

// (h) Exception isolation: a job whose process() throws must not tear down its
// peers, and its slot must be released (admittedCount_ decremented) so the
// scheduler does not leak capacity.
TEST_F(MultiJobSchedulerTest, OneJobThrowsPeersSurvive) {
  constexpr unsigned kConcurrency = 4;
  build(kConcurrency, std::chrono::milliseconds{50});
  // The second admission below mints id 2 (deterministic minting, see note on
  // the fixture), so the failure can be seeded before the job exists.
  model_->throwForId(2);

  for (unsigned job = 0; job < kConcurrency; ++job) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  }

  waitForIdle(*scheduler_, std::chrono::seconds{5});
  EXPECT_EQ(scheduler_->activeJobs(), 0u)
      << "the throwing job's slot must be released";

  // One terminal event per job (peers' jobEnded stats, the thrower's error);
  // judging the peers before all four are observable could miss a late error.
  const std::unordered_set<JobId> errored = erroredIds(drainUntil(
      *outputQueue_,
      [](const Outputs& seen) { return countTerminalEvents(seen) >= 4; },
      std::chrono::seconds{5}));
  EXPECT_EQ(errored.count(2), 1u) << "the throwing job must surface an error";
  EXPECT_EQ(errored.count(1), 0u);
  EXPECT_EQ(errored.count(3), 0u);
  EXPECT_EQ(errored.count(4), 0u)
      << "peers of the throwing job must complete without error";
}

// (i) An exclusive job that throws must still clear exclusivity, so a later
// job is admitted rather than wedged out forever. Guards the exception path of
// the exclusiveActive_ release.
TEST_F(MultiJobSchedulerTest, ExclusiveJobThrowClearsExclusive) {
  constexpr unsigned kConcurrency = 2;
  build(kConcurrency, std::chrono::milliseconds{50});
  // The first admission mints id 1, so the exclusive job's failure can be
  // seeded before it is admitted.
  model_->throwForId(1);

  ASSERT_TRUE(scheduler_->runExclusiveJob(std::string("finetune")).has_value());
  waitForIdle(*scheduler_, std::chrono::seconds{5});

  EXPECT_EQ(scheduler_->activeJobs(), 0u);
  EXPECT_TRUE(scheduler_->runJob(std::string("job")).has_value())
      << "a thrown exclusive job must not leave the scheduler wedged";
  scheduler_->cancelAll();
}

// (j) Cancelling a job still waiting in the queue must drop it: slot released
// immediately, a terminal error emitted, and process() never sees the job.
TEST_F(MultiJobSchedulerTest, CancelQueuedJobNeverRuns) {
  StartTrackingTestModel* tracking =
      buildTrackingWithQueue(1, 1, std::chrono::milliseconds{10000});

  const std::optional<JobId> running = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(running.has_value());
  ASSERT_EQ(waitForActive(*model_, 1, std::chrono::seconds{2}), 1);
  const std::optional<JobId> queued = scheduler_->runJob(std::string("queued"));
  ASSERT_TRUE(queued.has_value());
  ASSERT_EQ(scheduler_->activeJobs(), 2u);

  scheduler_->cancel(*queued);
  EXPECT_EQ(scheduler_->activeJobs(), 1u)
      << "cancelling a queued job must release its admission slot immediately";

  scheduler_->cancel(*running);
  waitForIdle(*scheduler_, std::chrono::seconds{5});
  ASSERT_EQ(scheduler_->activeJobs(), 0u);

  EXPECT_FALSE(tracking->started(*queued))
      << "a cancelled queued job must never reach process()";
  const std::vector<std::pair<JobId, std::any>> outputs = outputQueue_->clear();
  EXPECT_EQ(erroredIds(outputs).count(*queued), 1u)
      << "a cancelled queued job must surface a terminal error";
  for (const std::pair<JobId, std::any>& entry : outputs) {
    if (entry.first == *queued) {
      EXPECT_EQ(entry.second.type(), typeid(Output::Error))
          << "no result/jobEnded may be emitted for a cancelled queued job";
    }
  }
}

// (k) cancelAll must drop queued jobs too (interface contract: "Cancel every
// in-flight and queued job"), not only the in-flight ones.
TEST_F(MultiJobSchedulerTest, CancelAllDropsQueuedJobs) {
  StartTrackingTestModel* tracking =
      buildTrackingWithQueue(1, 2, std::chrono::milliseconds{10000});

  ASSERT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  ASSERT_EQ(waitForActive(*model_, 1, std::chrono::seconds{2}), 1);
  const std::optional<JobId> queuedA =
      scheduler_->runJob(std::string("queued"));
  const std::optional<JobId> queuedB =
      scheduler_->runJob(std::string("queued"));
  ASSERT_TRUE(queuedA.has_value());
  ASSERT_TRUE(queuedB.has_value());
  ASSERT_EQ(scheduler_->activeJobs(), 3u);

  scheduler_->cancelAll();

  waitForIdle(*scheduler_, std::chrono::seconds{5});
  ASSERT_EQ(scheduler_->activeJobs(), 0u);
  EXPECT_FALSE(tracking->started(*queuedA));
  EXPECT_FALSE(tracking->started(*queuedB))
      << "queued jobs must never start after cancelAll";
  const std::unordered_set<JobId> errored = erroredIds(outputQueue_->clear());
  EXPECT_EQ(errored.count(*queuedA), 1u);
  EXPECT_EQ(errored.count(*queuedB), 1u)
      << "dropped queued jobs must surface terminal errors";
}

// (k1) Snapshot cancellation: cancelJobs on a liveJobIds() snapshot taken
// before a later admission must cancel only the snapshot — the later job
// keeps running. This is the JS cancel-all contract: jobs started after the
// cancel was requested survive the deferred cancellation.
TEST_F(MultiJobSchedulerTest, CancelJobsLeavesPostSnapshotJobsRunning) {
  build(3, std::chrono::milliseconds{10000});

  ASSERT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  ASSERT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  ASSERT_EQ(waitForActive(*model_, 2, std::chrono::seconds{2}), 2);

  std::vector<JobId> snapshot = scheduler_->liveJobIds();
  std::sort(snapshot.begin(), snapshot.end());
  ASSERT_EQ(snapshot, (std::vector<JobId>{1, 2}));

  const std::optional<JobId> late = scheduler_->runJob(std::string("late"));
  ASSERT_TRUE(late.has_value());
  ASSERT_EQ(waitForActive(*model_, 3, std::chrono::seconds{2}), 3);

  scheduler_->cancelJobs(snapshot);

  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds{2};
  while (model_->active() > 1 &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{2});
  }
  EXPECT_EQ(model_->active(), 1) << "both snapshot jobs must be cancelled";

  // The survivor stays alive long enough to confirm it was never targeted.
  std::this_thread::sleep_for(std::chrono::milliseconds{100});
  EXPECT_EQ(model_->active(), 1)
      << "a job admitted after the snapshot must keep running";

  scheduler_->cancel(*late);
}

// (k1b) A snapshot spans queued jobs too: cancelJobs drops a still-queued
// snapshot id without it ever reaching process().
TEST_F(MultiJobSchedulerTest, CancelJobsDropsQueuedSnapshotJobs) {
  StartTrackingTestModel* tracking =
      buildTrackingWithQueue(1, 1, std::chrono::milliseconds{10000});

  const std::optional<JobId> running = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(running.has_value());
  ASSERT_EQ(waitForActive(*model_, 1, std::chrono::seconds{2}), 1);
  const std::optional<JobId> queued = scheduler_->runJob(std::string("queued"));
  ASSERT_TRUE(queued.has_value());

  std::vector<JobId> snapshot = scheduler_->liveJobIds();
  std::sort(snapshot.begin(), snapshot.end());
  ASSERT_EQ(snapshot, (std::vector<JobId>{*running, *queued}));

  scheduler_->cancelJobs(snapshot);
  waitForIdle(*scheduler_, std::chrono::seconds{5});
  EXPECT_EQ(scheduler_->activeJobs(), 0u);
  EXPECT_FALSE(tracking->started(*queued))
      << "a queued snapshot job must never reach process()";
  EXPECT_EQ(erroredIds(outputQueue_->clear()).count(*queued), 1u)
      << "a dropped queued job must surface a terminal error";
}

// (k1c) cancelJobs on a model without cancelById falls back to the whole-model
// cancel for the in-flight snapshot ids — the only cancel such a model offers.
TEST_F(MultiJobSchedulerTest, CancelJobsWithoutCancelByIdUsesWholeModelCancel) {
  constexpr unsigned kConcurrency = 2;
  buildNoCancelById(kConcurrency, std::chrono::milliseconds{10000});

  for (unsigned job = 0; job < kConcurrency; ++job) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  }
  ASSERT_EQ(
      waitForActive(*model_, kConcurrency, std::chrono::seconds{2}),
      static_cast<int>(kConcurrency));

  scheduler_->cancelJobs(scheduler_->liveJobIds());

  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds{2};
  while (model_->active() > 0 &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{2});
  }
  EXPECT_EQ(model_->active(), 0)
      << "the fallback must still stop the in-flight snapshot jobs";
}

// (k1d) cancelAll on a model with only per-job cancellation (cancel = nullptr)
// falls back to cancelById for each in-flight id — the scheduler owns the id
// set, so lacking a whole-model cancel must not leave in-flight jobs running.
TEST_F(MultiJobSchedulerTest, CancelAllWithoutWholeModelCancelUsesCancelById) {
  constexpr unsigned kConcurrency = 2;
  buildNoWholeModelCancel(kConcurrency, std::chrono::milliseconds{10000});

  for (unsigned job = 0; job < kConcurrency; ++job) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  }
  ASSERT_EQ(
      waitForActive(*model_, kConcurrency, std::chrono::seconds{2}),
      static_cast<int>(kConcurrency));

  scheduler_->cancelAll();

  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds{2};
  while (model_->active() > 0 &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{2});
  }
  EXPECT_EQ(model_->active(), 0)
      << "cancelAll must stop in-flight jobs via cancelById when the model "
         "has no whole-model cancel";
}

// (k1e) Teardown with an in-flight job on a cancelById-only model must not
// wait for the model to finish on its own: the destructor falls back to
// per-id cancellation before joining its workers.
TEST_F(MultiJobSchedulerTest, DestructorWithoutWholeModelCancelUsesCancelById) {
  buildNoWholeModelCancel(1, std::chrono::milliseconds{10000});

  ASSERT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  ASSERT_EQ(waitForActive(*model_, 1, std::chrono::seconds{2}), 1);

  const std::chrono::steady_clock::time_point start =
      std::chrono::steady_clock::now();
  scheduler_.reset();
  const std::chrono::milliseconds elapsed =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - start);
  EXPECT_LT(elapsed.count(), 5000)
      << "teardown must interrupt the in-flight job instead of waiting the "
         "full process time";
}

// (k2) Dequeue must announce the job to the model (jobStarting) before
// process(input, id) runs — exactly once per started job, and never for a job
// dropped from the queue.
TEST_F(MultiJobSchedulerTest, JobStartingAnnouncesBeforeProcess) {
  RegistrationGatedTestModel* gated =
      buildGatedWithQueue(1, 1, std::chrono::milliseconds{10000});

  const std::optional<JobId> running = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(running.has_value());
  ASSERT_EQ(waitForGatedActive(*gated, 1, std::chrono::seconds{2}), 1);
  EXPECT_TRUE(gated->announcedBeforeEntered(*running))
      << "jobStarting must run before process(input, id)";
  EXPECT_EQ(gated->announceCount(*running), 1u);

  const std::optional<JobId> queued = scheduler_->runJob(std::string("queued"));
  ASSERT_TRUE(queued.has_value());
  scheduler_->cancel(*queued);
  scheduler_->cancel(*running);
  waitForIdle(*scheduler_, std::chrono::seconds{5});
  EXPECT_FALSE(gated->announced(*queued))
      << "a job dropped from the queue never starts, so it must not be "
         "announced";
}

// (k3) Regression for the lost-cancel window (QVAC prefill-cancel CI flake): a
// model that honours cancellation only for jobs it already knows about (the
// real model's run-counter / cancel-registry guards) must still see every
// cancel land. Announcing the job at dequeue — under the same lock the cancel
// paths take — is what guarantees an in-flight job is always known by the time
// any cancel reaches the model. Without jobStarting this test's cancelAll is
// silently dropped and the job runs to completion.
TEST_F(MultiJobSchedulerTest, CancelAllLandsOnRegistrationGatedModel) {
  RegistrationGatedTestModel* gated =
      buildGatedWithQueue(1, 0, std::chrono::milliseconds{10000});

  const std::optional<JobId> job = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(job.has_value());
  ASSERT_EQ(waitForGatedActive(*gated, 1, std::chrono::seconds{2}), 1);

  scheduler_->cancelAll();
  waitForIdle(*scheduler_, std::chrono::seconds{5});
  ASSERT_EQ(scheduler_->activeJobs(), 0u);

  bool sawResult = false;
  const Outputs outputs = drainUntil(
      *outputQueue_,
      [](const Outputs& seen) { return countTerminalEvents(seen) >= 1; },
      std::chrono::seconds{5});
  for (const std::pair<JobId, std::any>& entry : outputs) {
    if (entry.first == *job && entry.second.type() == typeid(std::string)) {
      sawResult = true;
      EXPECT_EQ(std::any_cast<std::string>(entry.second), "cancelled")
          << "the in-flight job must observe the cancel, not run to "
             "completion";
    }
  }
  EXPECT_TRUE(sawResult) << "the cancelled job must still publish its result";
}

// (k4) Same window, per-id flavour: cancel(id) for a job that already left the
// queue routes to cancelById(), which a registration-gated model drops for
// unknown ids — the dequeue-time announcement must make the id known first.
TEST_F(MultiJobSchedulerTest, CancelByIdLandsOnRegistrationGatedModel) {
  RegistrationGatedTestModel* gated =
      buildGatedWithQueue(1, 0, std::chrono::milliseconds{10000});

  const std::optional<JobId> job = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(job.has_value());
  ASSERT_EQ(waitForGatedActive(*gated, 1, std::chrono::seconds{2}), 1);

  scheduler_->cancel(*job);
  waitForIdle(*scheduler_, std::chrono::seconds{5});
  ASSERT_EQ(scheduler_->activeJobs(), 0u);

  bool sawResult = false;
  const Outputs outputs = drainUntil(
      *outputQueue_,
      [](const Outputs& seen) { return countTerminalEvents(seen) >= 1; },
      std::chrono::seconds{5});
  for (const std::pair<JobId, std::any>& entry : outputs) {
    if (entry.first == *job && entry.second.type() == typeid(std::string)) {
      sawResult = true;
      EXPECT_EQ(std::any_cast<std::string>(entry.second), "cancelled")
          << "cancel(id) on a dequeued job must reach it via cancelById";
    }
  }
  EXPECT_TRUE(sawResult) << "the cancelled job must still publish its result";
}

// (k5) A throwing jobStarting() hook must not escape the worker thread (an
// unhandled exception at the std::thread entry calls std::terminate): the job
// it belonged to fails with exactly one terminal error, its slot / id /
// exclusivity are released, process(input, id) is never entered for it, and
// the worker survives to run later jobs.
TEST(MultiJobSchedulerLifecycleTest, ThrowingJobStartingFailsOnlyThatJob) {
  ThrowingLifecycleTestModel model;
  MockOutputCallback callback;
  auto outputQueue = std::make_shared<OutputQueue>(callback, model);
  MultiJobScheduler scheduler(
      &model, 1, /*cancel=*/nullptr, /*cancelById=*/nullptr, 1);
  scheduler.start(outputQueue);

  // The first admission mints id 1 (deterministic minting), so the failure
  // can be seeded before the job exists. Exclusive, so the test also proves
  // the failure releases exclusivity, not just the slot.
  model.throwOnStart(1);
  const std::optional<JobId> doomed =
      scheduler.runExclusiveJob(std::string("doomed"));
  ASSERT_TRUE(doomed.has_value());

  waitForIdle(scheduler, std::chrono::seconds{5});
  EXPECT_EQ(scheduler.activeJobs(), 0u)
      << "the failed job's slot must be released";
  EXPECT_FALSE(model.entered(*doomed))
      << "process() must never run for a job whose jobStarting threw";

  // Slot and exclusivity released, worker alive: a follow-up job must be
  // admitted (not refused as busy/exclusive) and complete normally.
  const std::optional<JobId> follower = scheduler.runJob(std::string("later"));
  ASSERT_TRUE(follower.has_value())
      << "a failed jobStarting must not wedge admission";

  const Outputs outputs = drainUntil(
      *outputQueue,
      [](const Outputs& seen) { return countTerminalEvents(seen) >= 2; },
      std::chrono::seconds{5});
  int doomedErrors = 0;
  for (const std::pair<JobId, std::any>& entry : outputs) {
    if (entry.first == *doomed &&
        entry.second.type() == typeid(Output::Error)) {
      ++doomedErrors;
    }
  }
  EXPECT_EQ(doomedErrors, 1)
      << "the doomed job must surface exactly one terminal error";
  EXPECT_EQ(erroredIds(outputs).count(*follower), 0u);
  EXPECT_TRUE(model.entered(*follower))
      << "the worker must survive to process later jobs";
}

// (l) Destroying the scheduler while a job waits in the queue must fail that
// job with a terminal error, not silently drop it.
TEST_F(MultiJobSchedulerTest, DestructorFailsQueuedJobs) {
  StartTrackingTestModel* tracking =
      buildTrackingWithQueue(1, 1, std::chrono::milliseconds{500});

  ASSERT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  ASSERT_EQ(waitForActive(*model_, 1, std::chrono::seconds{2}), 1);
  const std::optional<JobId> queued = scheduler_->runJob(std::string("queued"));
  ASSERT_TRUE(queued.has_value());

  scheduler_.reset(); // joins while the first job is in flight; second queued

  EXPECT_FALSE(tracking->started(*queued));
  EXPECT_EQ(erroredIds(outputQueue_->clear()).count(*queued), 1u)
      << "a queued job dropped at teardown must surface a terminal error";
}

// Teardown must not wait for the model: the destructor signals model cancel
// before joining, so a worker stuck in a long process() returns promptly.
TEST_F(MultiJobSchedulerTest, DestructorCancelsInFlightJobs) {
  build(1, std::chrono::milliseconds{5000});
  ASSERT_TRUE(scheduler_->runJob(std::string("slow")).has_value());

  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds{2};
  while (model_->active() == 0 &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{2});
  }
  ASSERT_EQ(model_->active(), 1) << "Job never reached the model";

  const auto start = std::chrono::steady_clock::now();
  scheduler_.reset();
  const auto elapsed = std::chrono::steady_clock::now() - start;
  EXPECT_LT(elapsed, std::chrono::milliseconds{1500})
      << "Destructor blocked on the in-flight job";
}

namespace {

/// The RuntimeStats snapshot queued as @p id's jobEnded event, or nullopt when
/// the drained outputs carry none.
std::optional<RuntimeStats> jobEndedStatsFor(
    const std::vector<std::pair<JobId, std::any>>& outputs, JobId id) {
  for (const auto& [outputId, payload] : outputs) {
    if (outputId == id && payload.type() == typeid(RuntimeStats)) {
      return std::any_cast<RuntimeStats>(payload);
    }
  }
  return std::nullopt;
}

bool hasStatKey(const RuntimeStats& stats, const std::string& key) {
  return std::any_of(stats.begin(), stats.end(), [&key](const auto& entry) {
    return entry.first == key;
  });
}

size_t countStatKey(const RuntimeStats& stats, const std::string& key) {
  return static_cast<size_t>(
      std::count_if(stats.begin(), stats.end(), [&key](const auto& entry) {
        return entry.first == key;
      }));
}

double statValue(const RuntimeStats& stats, const std::string& key) {
  for (const auto& [name, value] : stats) {
    if (name == key) {
      return std::holds_alternative<double>(value)
                 ? std::get<double>(value)
                 : static_cast<double>(std::get<int64_t>(value));
    }
  }
  return -1.0;
}

} // namespace

// (l) Per-job stats: a tagged job's jobEnded payload IS the model's per-job
// snapshot (IModelJobStats), consumed exactly once under that job's id — the
// generic whole-model snapshot is not queried at all.
TEST_F(MultiJobSchedulerTest, TaggedJobEndedUsesPerJobStats) {
  JobStatsTestModel* stats =
      buildJobStatsWithQueue(2, 0, std::chrono::milliseconds{20});
  // The first admission mints id 1, so its stats can be seeded up front.
  stats->addJobStats(1);

  const std::optional<JobId> job = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(job.has_value());
  ASSERT_EQ(*job, 1u);
  waitForIdle(*scheduler_, std::chrono::seconds{5});

  const auto snapshot = jobEndedStatsFor(
      drainUntil(
          *outputQueue_,
          [](const Outputs& seen) {
            return jobEndedStatsFor(seen, 1).has_value();
          },
          std::chrono::seconds{5}),
      1);
  ASSERT_TRUE(snapshot.has_value()) << "job 1 must end with a stats snapshot";
  EXPECT_TRUE(hasStatKey(*snapshot, "globalStat"))
      << "the per-job snapshot's model-level entries come through";
  EXPECT_EQ(countStatKey(*snapshot, "TPS"), 1u);
  EXPECT_DOUBLE_EQ(statValue(*snapshot, "TPS"), 42.0)
      << "the payload must be the job's own snapshot, not the generic one";
  EXPECT_EQ(stats->consumedIds(), std::vector<JobId>{1})
      << "per-job stats must be consumed exactly once, under the job's id";
}

// Per-job stats reclaim on error: a tagged job that ends via the throw path
// must not leave its per-job stats entry behind — ids are never reissued, so
// an entry not reclaimed here could never be consumed and would leak.
TEST_F(MultiJobSchedulerTest, ThrownJobReclaimsPerJobStats) {
  JobStatsTestModel* stats =
      buildJobStatsWithQueue(2, 0, std::chrono::milliseconds{20});
  // The first admission mints id 1, so its failure and stats can be seeded up
  // front.
  stats->addJobStats(1);
  stats->throwForId(1);

  const std::optional<JobId> job = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(job.has_value());
  ASSERT_EQ(*job, 1u);
  waitForIdle(*scheduler_, std::chrono::seconds{5});
  // The reclaim happens right before the error event is queued, so once that
  // event is observable the entry must already be gone.
  const Outputs outputs = drainUntil(
      *outputQueue_,
      [](const Outputs& seen) { return erroredIds(seen).count(1) != 0; },
      std::chrono::seconds{5});
  ASSERT_EQ(erroredIds(outputs).count(1), 1u)
      << "the thrown job must surface its terminal error";

  EXPECT_FALSE(stats->hasJobStats(1))
      << "a job that ends in error must not leak its per-job stats entry";
}

// (m) Per-job stats unknown to the model: the tagged jobEnded falls back to
// the generic whole-model snapshot.
TEST_F(MultiJobSchedulerTest, UnknownPerJobStatsFallBackToGenericSnapshot) {
  JobStatsTestModel* stats =
      buildJobStatsWithQueue(2, 0, std::chrono::milliseconds{20});

  const std::optional<JobId> job = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(job.has_value());
  waitForIdle(*scheduler_, std::chrono::seconds{5});

  const JobId id = *job;
  const auto snapshot = jobEndedStatsFor(
      drainUntil(
          *outputQueue_,
          [id](const Outputs& seen) {
            return jobEndedStatsFor(seen, id).has_value();
          },
          std::chrono::seconds{5}),
      id);
  ASSERT_TRUE(snapshot.has_value()) << "the job must end with a stats snapshot";
  EXPECT_TRUE(hasStatKey(*snapshot, "globalStat"));
  EXPECT_DOUBLE_EQ(statValue(*snapshot, "TPS"), 1.0)
      << "with no per-job stats the aggregate values must stay untouched";
  EXPECT_EQ(stats->consumedIds(), std::vector<JobId>{id});
}

// (n) The minting contract: admission assigns ids 1, 2, 3, ... — never the
// kNoJobId sentinel, strictly increasing — and a rejected admission consumes
// no id. The fixture tests that pre-seed per-id behaviour rely on exactly
// this determinism.
TEST_F(MultiJobSchedulerTest, MintsMonotonicIdsStartingAtOne) {
  buildWithQueue(1, 1, std::chrono::milliseconds{100});

  const std::optional<JobId> first = scheduler_->runJob(std::string("job"));
  const std::optional<JobId> second = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(first.has_value());
  ASSERT_TRUE(second.has_value());
  EXPECT_EQ(*first, 1u);
  EXPECT_EQ(*second, 2u);

  // Pool (1) + queue (1) are full: rejected without minting.
  EXPECT_FALSE(scheduler_->runJob(std::string("overflow")).has_value());

  waitForIdle(*scheduler_, std::chrono::seconds{5});
  const std::optional<JobId> third = scheduler_->runJob(std::string("job"));
  ASSERT_TRUE(third.has_value());
  EXPECT_EQ(*third, 3u)
      << "ids continue from the last mint: a finished id is never reissued "
         "and a rejected admission consumes none";
  scheduler_->cancelAll();
}

// (r) An id identifies one job forever: after a job completes, later
// admissions mint fresh ids — the finished id is never reissued, so a
// terminal event published late can never be attributed to a newer job.
TEST_F(MultiJobSchedulerTest, IdNeverReusedAfterCompletion) {
  build(2, std::chrono::milliseconds{20});

  const std::optional<JobId> first = scheduler_->runJob(std::string("first"));
  ASSERT_TRUE(first.has_value());
  waitForIdle(*scheduler_, std::chrono::seconds{5});
  ASSERT_EQ(scheduler_->activeJobs(), 0u);

  const std::optional<JobId> second = scheduler_->runJob(std::string("second"));
  ASSERT_TRUE(second.has_value());
  EXPECT_GT(*second, *first) << "a finished job's id must never be minted again";
  scheduler_->cancelAll();
}

// (s) The ctor contract: a null multiprocessor or zero concurrency is refused
// up front (std::invalid_argument) rather than surfacing as a wedged scheduler
// later. Plain TEST: no started scheduler is needed.
TEST(MultiJobSchedulerCtorTest, RejectsBadArguments) {
  ConcurrentTestModel model{std::chrono::milliseconds{0}};
  EXPECT_THROW(
      MultiJobScheduler(nullptr, 2, &model, &model, 0),
      std::invalid_argument);
  EXPECT_THROW(
      MultiJobScheduler(&model, 0, &model, &model, 0),
      std::invalid_argument);
}

/// Model shape the ctor must refuse when wired with cancelById: per-job
/// cancellation without the jobStarting(id) lifecycle hook, so a cancel
/// arriving between dequeue and the model's own registration could no-op.
struct NoLifecycleModel : model::IModel,
                          model::IModelMultiprocessor,
                          model::IModelCancelById {
  std::string getName() const override { return "NoLifecycleModel"; }
  RuntimeStats runtimeStats() const override { return RuntimeStats{}; }
  std::any process(const std::any& input) override { return input; }
  std::any process(const std::any& input, JobId /*id*/) override {
    return input;
  }
  void cancelById(JobId /*id*/) const override {}
};

// (s2) The ctor contract for the lost-cancel window: cancelById without
// IModelJobLifecycle is refused up front — cancelById() may no-op for ids the
// model has not registered yet, so only the jobStarting(id) announcement makes
// per-job cancel race-free. Without lifecycle the model must not wire
// cancelById (passing nullptr instead stays valid).
TEST(MultiJobSchedulerCtorTest, RejectsCancelByIdWithoutLifecycle) {
  NoLifecycleModel model;
  EXPECT_THROW(
      MultiJobScheduler(&model, 2, /*cancel=*/nullptr, &model, 0),
      std::invalid_argument);
  EXPECT_NO_THROW(
      MultiJobScheduler(&model, 2, /*cancel=*/nullptr, /*cancelById=*/nullptr, 0));
}

// (t) Cancelling a MIDDLE queued job while several wait: the queued_/
// queuedIndex_ erase must drop exactly that job (slot released, one terminal
// error, process() never entered) while its queued peers still run, in FIFO
// order. The queueCapacity=1 cancel test never erases from the middle.
TEST_F(MultiJobSchedulerTest, CancelMiddleQueuedJobKeepsPeers) {
  StartTrackingTestModel* tracking =
      buildTrackingWithQueue(1, 3, std::chrono::milliseconds{400});

  // The first job occupies the single worker long enough to queue three peers
  // and cancel the middle one, then completes on its own so the queue drains.
  const std::optional<JobId> inflight =
      scheduler_->runJob(std::string("inflight"));
  ASSERT_TRUE(inflight.has_value());
  ASSERT_EQ(waitForActive(*model_, 1, std::chrono::seconds{2}), 1);
  const std::optional<JobId> queuedA =
      scheduler_->runJob(std::string("queued"));
  const std::optional<JobId> queuedB =
      scheduler_->runJob(std::string("queued"));
  const std::optional<JobId> queuedC =
      scheduler_->runJob(std::string("queued"));
  ASSERT_TRUE(queuedA.has_value());
  ASSERT_TRUE(queuedB.has_value());
  ASSERT_TRUE(queuedC.has_value());
  ASSERT_EQ(scheduler_->activeJobs(), 4u);

  scheduler_->cancel(*queuedB);
  EXPECT_EQ(scheduler_->activeJobs(), 3u)
      << "cancelling a queued job must release its admission slot immediately";

  waitForIdle(*scheduler_, std::chrono::seconds{5});
  ASSERT_EQ(scheduler_->activeJobs(), 0u);

  EXPECT_FALSE(tracking->started(*queuedB))
      << "a cancelled queued job must never reach process()";
  EXPECT_TRUE(tracking->started(*queuedA));
  EXPECT_TRUE(tracking->started(*queuedC))
      << "queued peers of a cancelled middle job must still run";

  const std::vector<std::pair<JobId, std::any>> outputs = outputQueue_->clear();
  int terminalForCancelled = 0;
  for (const std::pair<JobId, std::any>& entry : outputs) {
    if (entry.first == *queuedB) {
      EXPECT_EQ(entry.second.type(), typeid(Output::Error))
          << "no result/jobEnded may be emitted for a cancelled queued job";
      ++terminalForCancelled;
    }
  }
  EXPECT_EQ(terminalForCancelled, 1)
      << "a cancelled queued job must surface exactly one terminal error";

  EXPECT_EQ(
      tracking->startOrder(),
      (std::vector<JobId>{*inflight, *queuedA, *queuedC}))
      << "survivors must keep FIFO (submission) order after the middle erase";
}

/// A consumer reacting to a job's terminal event (the JS run loop reacting to
/// jobEnded) may immediately admit a follow-up job. If the scheduler still
/// counts the finished job's slot as admitted at that moment, the follow-up
/// admission is spuriously refused as busy. Every published event must
/// therefore observe the slot already released: activeJobs() == 0 at every
/// notify() of a lone job's result and jobEnded events.
TEST_F(MultiJobSchedulerTest, SlotReleasedBeforeTerminalEventsPublished) {
  auto probe = std::make_unique<ActiveJobsProbeCallback>();
  ActiveJobsProbeCallback* probeRaw = probe.get();
  model_ = std::make_unique<ConcurrentTestModel>(std::chrono::milliseconds{5});
  callback_ = std::move(probe);
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  scheduler_ = std::make_unique<MultiJobScheduler>(
      model_.get(), 1, model_.get(), model_.get(), 0);
  probeRaw->setSampler([this] { return scheduler_->activeJobs(); });
  scheduler_->start(outputQueue_);

  ASSERT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  // A successful job publishes two events: its result and its jobEnded.
  ASSERT_TRUE(probeRaw->waitForSamples(2, std::chrono::seconds{5}));

  for (const std::size_t active : probeRaw->samples()) {
    EXPECT_EQ(active, 0u)
        << "an event became observable while the scheduler still counted "
           "the finished job's slot as admitted";
  }
}

/// Same invariant for the error path: the terminal exception event of a
/// throwing job must also observe the slot already released.
TEST_F(MultiJobSchedulerTest, SlotReleasedBeforeErrorEventPublished) {
  auto probe = std::make_unique<ActiveJobsProbeCallback>();
  ActiveJobsProbeCallback* probeRaw = probe.get();
  auto model =
      std::make_unique<ConcurrentTestModel>(std::chrono::milliseconds{5});
  model->throwForId(JobId{1});
  model_ = std::move(model);
  callback_ = std::move(probe);
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  scheduler_ = std::make_unique<MultiJobScheduler>(
      model_.get(), 1, model_.get(), model_.get(), 0);
  probeRaw->setSampler([this] { return scheduler_->activeJobs(); });
  scheduler_->start(outputQueue_);

  ASSERT_TRUE(scheduler_->runJob(std::string("job")).has_value());
  ASSERT_TRUE(probeRaw->waitForSamples(1, std::chrono::seconds{5}));

  for (const std::size_t active : probeRaw->samples()) {
    EXPECT_EQ(active, 0u)
        << "the terminal error event became observable while the scheduler "
           "still counted the failed job's slot as admitted";
  }
}

/// A throw during terminal publication (e.g. a consumer callback's notify())
/// lands in the worker's catch AFTER the slot was already released. The
/// release must be once-only: a second release underflows the size_t admitted
/// count, after which activeJobs() reports garbage and every admission is
/// refused as busy forever.
TEST_F(MultiJobSchedulerTest, PublicationThrowReleasesSlotOnce) {
  model_ = std::make_unique<ConcurrentTestModel>(std::chrono::milliseconds{5});
  callback_ = std::make_unique<ThrowOnceCallback>();
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  scheduler_ = std::make_unique<MultiJobScheduler>(
      model_.get(), 1, model_.get(), model_.get(), 0);
  scheduler_->start(outputQueue_);

  ASSERT_TRUE(scheduler_->runJob(std::string("job")).has_value());

  // The job's first publication throws; once the worker has settled it the
  // admitted count must be back at exactly zero, not underflowed.
  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds{5};
  while (scheduler_->activeJobs() != 0 &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{1});
  }
  EXPECT_EQ(scheduler_->activeJobs(), 0u)
      << "slot released twice: admitted count underflowed";

  EXPECT_TRUE(scheduler_->runJob(std::string("follow-up")).has_value())
      << "admission wedged after a publication throw";
}

} // namespace qvac_lib_inference_addon_cpp
