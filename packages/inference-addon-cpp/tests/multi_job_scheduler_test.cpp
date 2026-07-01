#include <algorithm>
#include <any>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
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

/// Concurrent test model whose per-job process() blocks until its id is
/// cancelled (cancelById), every job is cancelled (cancel), or its configured
/// duration elapses. Tracks peak overlap so a test can assert that jobs were
/// genuinely in flight together. Exercises both cancellation surfaces the
/// scheduler routes to: per-id cancelById() and whole-model cancel().
class ConcurrentTestModel : public model::IModel,
                            public model::IModelMultiprocessor,
                            public model::IModelCancel,
                            public model::IModelCancelById {
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

  int peakActive() const {
    std::lock_guard lock(mtx_);
    return peakActive_;
  }

  int active() const {
    std::lock_guard lock(mtx_);
    return active_;
  }
};

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

} // namespace

class MultiJobSchedulerTest : public ::testing::Test {
protected:
  std::unique_ptr<MockOutputCallback> callback_;
  std::unique_ptr<ConcurrentTestModel> model_;
  std::shared_ptr<OutputQueue> outputQueue_;
  std::unique_ptr<MultiJobScheduler> scheduler_;

  void build(unsigned maxConcurrency, std::chrono::milliseconds processTime) {
    buildWithQueue(maxConcurrency, 0, processTime);
  }

  void buildWithQueue(
      unsigned maxConcurrency, unsigned queueCapacity,
      std::chrono::milliseconds processTime) {
    callback_ = std::make_unique<MockOutputCallback>();
    model_ = std::make_unique<ConcurrentTestModel>(processTime);
    outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
    scheduler_ = std::make_unique<MultiJobScheduler>(
        model_.get(), maxConcurrency, model_.get(), model_.get(),
        queueCapacity);
    scheduler_->start(outputQueue_);
  }

  void TearDown() override {
    scheduler_.reset();
    outputQueue_.reset();
    model_.reset();
    callback_.reset();
  }
};

// (a) Concurrent admission: N jobs are genuinely in flight at the same time.
TEST_F(MultiJobSchedulerTest, AdmitsJobsConcurrently) {
  constexpr unsigned kConcurrency = 4;
  build(kConcurrency, std::chrono::milliseconds{300});

  for (JobId id = 1; id <= kConcurrency; ++id) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job"), id));
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

  for (JobId id = 1; id <= kConcurrency; ++id) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job"), id));
  }
  // Must observe the pool genuinely full before probing overflow, else a slow
  // machine could reject simply because a job had not started yet.
  ASSERT_EQ(
      waitForActive(*model_, kConcurrency, std::chrono::seconds{2}),
      static_cast<int>(kConcurrency));

  EXPECT_FALSE(scheduler_->runJob(std::string("overflow"), kConcurrency + 1))
      << "Admission must reject once at capacity";

  scheduler_->cancelAll();
}

// (c) Per-job cancel isolation: cancelling one id leaves the others running.
TEST_F(MultiJobSchedulerTest, CancelOneLeavesOthersRunning) {
  constexpr unsigned kConcurrency = 3;
  build(kConcurrency, std::chrono::milliseconds{10000});

  for (JobId id = 1; id <= kConcurrency; ++id) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job"), id));
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

// (d) cancelAll: every in-flight job is cancelled.
TEST_F(MultiJobSchedulerTest, CancelAllStopsEveryJob) {
  constexpr unsigned kConcurrency = 4;
  build(kConcurrency, std::chrono::milliseconds{10000});

  for (JobId id = 1; id <= kConcurrency; ++id) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job"), id));
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
  std::atomic<uint64_t> nextId{1};

  std::vector<std::thread> cancelThreads;
  for (int thread = 0; thread < 4; ++thread) {
    cancelThreads.emplace_back([this, &stop, &nextId] {
      while (!stop.load()) {
        const JobId id = nextId.load();
        if (id > 1) {
          scheduler_->cancel(id - 1);
        }
        scheduler_->cancelAll();
        std::this_thread::yield();
      }
    });
  }

  for (int iteration = 0; iteration < 2000; ++iteration) {
    const JobId id = nextId.fetch_add(1);
    scheduler_->runJob(std::string("job"), id);
    if (iteration % 16 == 0) {
      std::this_thread::yield();
    }
  }

  stop = true;
  for (std::thread& thread : cancelThreads) {
    thread.join();
  }
  std::this_thread::sleep_for(std::chrono::milliseconds{100});

  const std::vector<std::pair<JobId, std::any>> outputs = outputQueue_->clear();
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
}

/// Blocks until the scheduler reports no admitted jobs (in-flight + queued
/// drained) or the timeout lapses.
void waitForIdle(const MultiJobScheduler& scheduler,
                 std::chrono::milliseconds timeout) {
  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + timeout;
  while (scheduler.activeJobs() != 0 &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{2});
  }
}

// (f) Exclusive admission (finetune <-> inference mutual exclusion): an
// exclusive job is refused while inference is in flight, and while an exclusive
// job runs every inference admission is refused. This is the invariant the old
// single _hasActiveResponse bool gave and that activeJobs() >= maxConcurrency
// lost at parallel >= 2.
TEST_F(MultiJobSchedulerTest, ExclusiveJobRunsAlone) {
  constexpr unsigned kConcurrency = 4;
  build(kConcurrency, std::chrono::milliseconds{10000});

  EXPECT_TRUE(scheduler_->runJob(std::string("job"), 1));
  EXPECT_TRUE(scheduler_->runJob(std::string("job"), 2));
  ASSERT_EQ(
      waitForActive(*model_, 2, std::chrono::seconds{2}), 2);

  // Refused even though 2 of 4 slots are free: exclusivity, not capacity.
  EXPECT_FALSE(scheduler_->runExclusiveJob(std::string("finetune"), 100))
      << "exclusive job admitted while inference was in flight";

  // Per-id cancel (not cancelAll) so whole-model cancel stays unset and a later
  // exclusive job can still run.
  scheduler_->cancel(1);
  scheduler_->cancel(2);
  waitForIdle(*scheduler_, std::chrono::seconds{2});
  ASSERT_EQ(scheduler_->activeJobs(), 0u);

  EXPECT_TRUE(scheduler_->runExclusiveJob(std::string("finetune"), 100));
  ASSERT_EQ(
      waitForActive(*model_, 1, std::chrono::seconds{2}), 1);

  EXPECT_FALSE(scheduler_->runJob(std::string("job"), 3))
      << "inference admitted while an exclusive job was running";

  scheduler_->cancel(100);
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

  for (JobId id = 1; id <= 4; ++id) {  // pool (2) + queue (2)
    EXPECT_TRUE(scheduler_->runJob(std::string("job"), id))
        << "job " << id << " within pool+queue must be admitted";
  }
  EXPECT_FALSE(scheduler_->runJob(std::string("job"), 5))
      << "admission past pool+queue must be rejected";

  // Only pool-many run at once; the rest wait in the queue.
  ASSERT_EQ(
      waitForActive(*model_, kConcurrency, std::chrono::seconds{2}),
      static_cast<int>(kConcurrency));

  waitForIdle(*scheduler_, std::chrono::seconds{5});
  EXPECT_EQ(scheduler_->activeJobs(), 0u)
      << "all admitted (in-flight + queued) jobs must complete";
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
  model_->throwForId(2);

  for (JobId id = 1; id <= kConcurrency; ++id) {
    EXPECT_TRUE(scheduler_->runJob(std::string("job"), id));
  }

  waitForIdle(*scheduler_, std::chrono::seconds{5});
  EXPECT_EQ(scheduler_->activeJobs(), 0u)
      << "the throwing job's slot must be released";

  const std::unordered_set<JobId> errored =
      erroredIds(outputQueue_->clear());
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
  model_->throwForId(99);

  ASSERT_TRUE(scheduler_->runExclusiveJob(std::string("finetune"), 99));
  waitForIdle(*scheduler_, std::chrono::seconds{5});

  EXPECT_EQ(scheduler_->activeJobs(), 0u);
  EXPECT_TRUE(scheduler_->runJob(std::string("job"), 1))
      << "a thrown exclusive job must not leave the scheduler wedged";
  scheduler_->cancelAll();
}

} // namespace qvac_lib_inference_addon_cpp
