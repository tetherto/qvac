#include <any>
#include <atomic>
#include <chrono>
#include <future>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "inference-addon-cpp/JobRunner.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "inference-addon-cpp/queue/OutputCallbackInterface.hpp"
#include "inference-addon-cpp/queue/OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

class MockOutputCallback : public OutputCallBackInterface {
  std::atomic_bool stopped_{false};

public:
  void initializeProcessingThread(
      std::shared_ptr<OutputQueue> /*outputQueue*/) override {}
  void notify() override {}
  void stop() override { stopped_ = true; }
};

class JobRunnerTestModel : public model::IModel, public model::IModelCancel {
  mutable std::atomic_bool cancel_requested_{false};
  mutable std::atomic_int access_count_{0};
  mutable std::atomic_bool is_processing_{false};
  std::chrono::milliseconds process_time_;
  bool access_input_multiple_times_;

public:
  explicit JobRunnerTestModel(
      std::chrono::milliseconds process_time = std::chrono::milliseconds{100},
      bool access_input_multiple_times = false)
      : process_time_(process_time),
        access_input_multiple_times_(access_input_multiple_times) {}

  std::string getName() const override { return "JobRunnerTestModel"; }

  std::any process(const std::any& input) override {
    is_processing_ = true;

    if (access_input_multiple_times_) {
      for (int i = 0; i < 20 && !cancel_requested_.load(); ++i) {
        try {
          (void)std::any_cast<std::string>(input);
          access_count_++;
          std::this_thread::sleep_for(std::chrono::milliseconds{10});
        } catch (...) {
          is_processing_ = false;
          throw std::runtime_error("Input was invalidated during processing");
        }
      }
    } else {
      std::chrono::steady_clock::time_point start =
          std::chrono::steady_clock::now();
      while (!cancel_requested_.load()) {
        std::chrono::steady_clock::duration elapsed =
            std::chrono::steady_clock::now() - start;
        if (elapsed >= process_time_) {
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds{10});
      }
    }

    cancel_requested_ = false;
    is_processing_ = false;
    return std::string("result");
  }

  RuntimeStats runtimeStats() const override { return RuntimeStats{}; }

  void cancel() const override { cancel_requested_ = true; }

  int getAccessCount() const { return access_count_.load(); }

  bool isProcessing() const { return is_processing_.load(); }

  bool waitForProcessingToComplete(std::chrono::milliseconds timeout) const {
    std::chrono::steady_clock::time_point deadline =
        std::chrono::steady_clock::now() + timeout;
    while (is_processing_.load() &&
           std::chrono::steady_clock::now() < deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds{1});
    }
    return !is_processing_.load();
  }
};

class JobRunnerTest : public ::testing::Test {
protected:
  std::unique_ptr<MockOutputCallback> callback_;
  std::unique_ptr<JobRunnerTestModel> model_;
  std::shared_ptr<OutputQueue> outputQueue_;
  std::unique_ptr<JobRunner> jobRunner_;

  void SetUp() override {
    callback_ = std::make_unique<MockOutputCallback>();
    model_ = std::make_unique<JobRunnerTestModel>();
    outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
    jobRunner_ =
        std::make_unique<JobRunner>(model_.get(), model_.get());
    jobRunner_->start(outputQueue_);
  }

  void TearDown() override {
    jobRunner_.reset();
    outputQueue_.reset();
    model_.reset();
    callback_.reset();
  }
};

// Test basic job execution
TEST_F(JobRunnerTest, BasicJobExecution) {
  model_ = std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{50});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  jobRunner_->runJob(std::string("test input"), kNoJobId);

  // Wait for job to complete
  std::this_thread::sleep_for(std::chrono::milliseconds{200});

  auto outputs = outputQueue_->clear();
  EXPECT_GT(outputs.size(), 0);
}

// Test cancel without deadlock - this is the critical test
TEST_F(JobRunnerTest, CancelDuringProcessingNoDeadlock) {
  // Create a model with longer processing time
  model_ = std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{500});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  // Start a job
  jobRunner_->runJob(std::string("test input"), kNoJobId);

  // Give it a moment to start processing
  std::this_thread::sleep_for(std::chrono::milliseconds{50});

  // Try to cancel from another thread with a timeout
  auto cancel_future = std::async(
      std::launch::async, [this]() { jobRunner_->cancel(kNoJobId); });

  // Wait for cancel to complete with timeout
  auto status = cancel_future.wait_for(std::chrono::seconds{2});

  // If we hit the timeout, we have a deadlock
  ASSERT_NE(status, std::future_status::timeout)
      << "Deadlock detected: cancel() did not complete within timeout";

  // Verify cancel completed successfully
  EXPECT_EQ(status, std::future_status::ready);
}

// Test cancel on a job that hasn't started yet
TEST_F(JobRunnerTest, CancelBeforeProcessing) {
  // Don't start a job, just call cancel
  jobRunner_->cancel(kNoJobId);

  // Should complete without issue and quickly (not hang)
  SUCCEED();
}

// Test that cancel before any job has no effect on subsequent job execution
TEST_F(JobRunnerTest, CancelBeforeJobThenRunNormally) {
  model_ = std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{50});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  // Call cancel when no job is running
  jobRunner_->cancel(kNoJobId);

  // Should be able to run a job normally after cancel with no job
  jobRunner_->runJob(std::string("test input"), kNoJobId);

  // Wait for job to complete
  std::this_thread::sleep_for(std::chrono::milliseconds{150});

  auto outputs = outputQueue_->clear();
  EXPECT_GT(outputs.size(), 0);

  // Verify we got a result (not an error)
  bool found_result = false;
  for (const auto& [id, output] : outputs) {
    if (output.type() == typeid(std::string)) {
      found_result = true;
    }
  }
  EXPECT_TRUE(found_result);
}

// Test multiple jobs in sequence
TEST_F(JobRunnerTest, MultipleJobsSequential) {
  model_ = std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{50});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  for (int i = 0; i < 3; ++i) {
    jobRunner_->runJob(
        std::string("test input ") + std::to_string(i), kNoJobId);
    std::this_thread::sleep_for(std::chrono::milliseconds{100});
  }

  auto outputs = outputQueue_->clear();
  EXPECT_GT(outputs.size(), 0);
}

// Test that trying to run a job while one is in progress fails
TEST_F(JobRunnerTest, CannotRunJobWhileProcessing) {
  model_ = std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{200});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  // Start first job
  EXPECT_TRUE(jobRunner_->runJob(std::string("test input 1"), kNoJobId));

  // Immediately try to start another
  EXPECT_FALSE(jobRunner_->runJob(std::string("test input 2"), kNoJobId));
}

// Stress test: multiple rapid cancel calls
TEST_F(JobRunnerTest, MultipleRapidCancels) {
  model_ = std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{100});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  // Start a job
  jobRunner_->runJob(std::string("test input"), kNoJobId);

  // Call cancel multiple times from different threads
  std::vector<std::future<void>> futures;
  for (int i = 0; i < 5; ++i) {
    futures.push_back(std::async(std::launch::async, [this]() {
      jobRunner_->cancel(kNoJobId);
    }));
  }

  // Wait for all cancels with timeout
  for (auto& future : futures) {
    auto status = future.wait_for(std::chrono::seconds{2});
    ASSERT_NE(status, std::future_status::timeout)
        << "Deadlock detected in multiple cancel scenario";
  }
}

// Test cancel during the critical window right after process() returns
// This is the exact scenario that causes the deadlock
TEST_F(JobRunnerTest, CancelInCriticalWindowNoDeadlock) {
  // Create a model with very short processing time
  model_ = std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{50});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  // Run multiple iterations to increase chance of hitting the critical window
  for (int iteration = 0; iteration < 10; ++iteration) {
    // Start a job
    jobRunner_->runJob(std::string("test input"), kNoJobId);

    // Cancel almost immediately - trying to hit the window between
    // model_->process() returning and the lock being reacquired
    std::this_thread::sleep_for(std::chrono::milliseconds{40});

    auto cancel_future = std::async(
        std::launch::async, [this]() { jobRunner_->cancel(kNoJobId); });

    auto status = cancel_future.wait_for(std::chrono::seconds{1});
    ASSERT_NE(status, std::future_status::timeout)
        << "Deadlock detected in iteration " << iteration;

    // Small delay before next iteration
    std::this_thread::sleep_for(std::chrono::milliseconds{50});
  }
}

// Test that cancel() properly waits for processing to complete before returning
// This verifies that ProcessingSync prevents cancel() from resetting job_
// while process() is still executing
TEST_F(JobRunnerTest, CancelWaitsForProcessingToComplete) {
  model_ = std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{200});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  // Start a job
  jobRunner_->runJob(std::string("test input"), kNoJobId);

  // Wait until processing has started
  std::this_thread::sleep_for(std::chrono::milliseconds{50});
  ASSERT_TRUE(model_->isProcessing()) << "Model should be processing";

  // Call cancel while processing - it should block until processing completes
  jobRunner_->cancel(kNoJobId);

  // After cancel() returns, processing must be complete
  EXPECT_FALSE(model_->isProcessing())
      << "Model should not be processing after cancel() returns";
}

// Test that cancel() while accessing input multiple times doesn't cause crashes
// This tests the race condition where job_ could be reset while being accessed
TEST_F(JobRunnerTest, CancelWhileAccessingInputNoCrash) {
  // Use a model that accesses input data multiple times
  auto model_with_access = std::make_unique<JobRunnerTestModel>(
      std::chrono::milliseconds{100}, true /* access_input_multiple_times */);
  auto* model_ptr = model_with_access.get();

  auto local_output_queue =
      std::make_shared<OutputQueue>(*callback_, *model_with_access);
  auto local_job_runner = std::make_unique<JobRunner>(
      model_with_access.get(), model_with_access.get());
  local_job_runner->start(local_output_queue);

  // Run multiple iterations to increase chance of hitting the race condition
  for (int iteration = 0; iteration < 5; ++iteration) {
    // Start a job with input data
    local_job_runner->runJob(std::string("test input with data"), kNoJobId);

    // Cancel quickly while model is accessing input
    std::this_thread::sleep_for(std::chrono::milliseconds{20});
    local_job_runner->cancel(kNoJobId);

    // After cancel returns, processing must be complete
    EXPECT_FALSE(model_ptr->isProcessing())
        << "Model should not be processing after cancel() in iteration "
        << iteration;

    // Small delay before next iteration
    std::this_thread::sleep_for(std::chrono::milliseconds{50});
  }

  // Verify that the model was able to access input at least once
  EXPECT_GT(model_ptr->getAccessCount(), 0)
      << "Model should have accessed input at least once";
}

// High-contention test to detect race between unlock() and setActive(true)
// Uses many threads and iterations to increase probability of hitting the race
// window
TEST_F(
    JobRunnerTest,
    DetectRaceConditionBetweenUnlockAndSetActive_HighContention) {
  // Use minimal processing time to maximize throughput
  model_ = std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{0});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  std::atomic_bool stop{false};
  std::atomic_int iterations{0};

  // Spawn multiple cancel threads that continuously try to cancel
  std::vector<std::future<void>> cancel_threads;
  for (int t = 0; t < 4; ++t) {
    cancel_threads.push_back(std::async(std::launch::async, [this, &stop]() {
      while (!stop.load()) {
        jobRunner_->cancel(kNoJobId);
        std::this_thread::yield(); // Give other threads a chance
      }
    }));
  }

  // Main thread submits jobs rapidly
  for (int i = 0; i < 200; ++i) {
    jobRunner_->runJob(std::string("test"), kNoJobId);
    iterations++;

    // Occasionally yield to give cancel threads a chance to run
    if (i % 10 == 0) {
      std::this_thread::yield();
    }
  }

  stop = true;

  // Wait for all cancel threads to finish
  for (auto& f : cancel_threads) {
    auto status = f.wait_for(std::chrono::seconds{2});
    if (status == std::future_status::timeout) {
      FAIL()
          << "Cancel thread timed out - possible deadlock from race condition";
    }
  }

  // Wait a bit for any pending operations
  std::this_thread::sleep_for(std::chrono::milliseconds{100});

  // Check output queue for bad_optional_access errors
  auto outputs = outputQueue_->clear();
  for (const auto& [id, output] : outputs) {
    if (output.type() == typeid(Output::Error)) {
      Output::Error error = std::any_cast<Output::Error>(output);
      if (error.find("bad_optional_access") != std::string::npos ||
          error.find("optional") != std::string::npos) {
        FAIL() << "BUG DETECTED: bad_optional_access in output after "
               << iterations.load() << " iterations.\nError: " << error
               << "\n\nThis indicates lock.unlock() happened before "
                  "processingSync_.setActive(true)."
               << "\nThe race: cancel() ran after unlock() but before "
                  "setActive(true),"
               << "\nso it saw active_=false, reset job_, then process() tried "
                  "to access job_.value().";
      }
    }
  }
}

// Test multiple cancel calls in sequence (not concurrent)
TEST_F(JobRunnerTest, MultipleCancelsInSequence) {
  model_ = std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{100});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  // Start a job
  jobRunner_->runJob(std::string("test input"), kNoJobId);
  std::this_thread::sleep_for(std::chrono::milliseconds{20});

  // Cancel it
  jobRunner_->cancel(kNoJobId);

  // Call cancel again - should be safe even though no job is running
  jobRunner_->cancel(kNoJobId);

  // And again
  jobRunner_->cancel(kNoJobId);

  // Should complete without hanging or crashing
  SUCCEED();
}

TEST_F(JobRunnerTest, CancelWhileActivelyProcessing_ModelReceivesStop) {
  model_ =
      std::make_unique<JobRunnerTestModel>(std::chrono::milliseconds{10000});
  outputQueue_ = std::make_shared<OutputQueue>(*callback_, *model_);
  jobRunner_ =
      std::make_unique<JobRunner>(model_.get(), model_.get());
  jobRunner_->start(outputQueue_);

  EXPECT_TRUE(jobRunner_->runJob(std::string("long job"), kNoJobId));

  std::chrono::steady_clock::time_point wait_deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds{2};
  while (!model_->isProcessing() &&
         std::chrono::steady_clock::now() < wait_deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds{1});
  }
  ASSERT_TRUE(model_->isProcessing());

  std::chrono::steady_clock::time_point before_cancel =
      std::chrono::steady_clock::now();

  jobRunner_->cancel(kNoJobId);

  std::chrono::milliseconds cancel_elapsed =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - before_cancel);

  EXPECT_FALSE(model_->isProcessing())
      << "Model should have stopped after cancel()";

  EXPECT_LT(cancel_elapsed.count(), 2000)
      << "cancel() took " << cancel_elapsed.count()
      << "ms — model did not receive stop signal (would have taken 10000ms "
         "without cancellation)";

  EXPECT_TRUE(jobRunner_->runJob(std::string("follow-up"), kNoJobId))
      << "Job slot should be free after cancel";
  jobRunner_->cancel(kNoJobId);
}

/// Proves SingleJobScheduler satisfies IJobScheduler through a base pointer:
/// runJob returns true on an idle scheduler, false when the slot is occupied,
/// and cancelAll() returns without deadlock.
TEST(PolymorphicSchedulerTest, PolymorphicScheduler_RunRejectCancel) {
  MockOutputCallback cb;
  auto model = std::make_unique<JobRunnerTestModel>(
      std::chrono::milliseconds{500} /* long enough to stay busy */);
  auto queue = std::make_shared<OutputQueue>(cb, *model);

  // Hold the scheduler through the interface pointer to verify polymorphism.
  std::unique_ptr<IJobScheduler> sched =
      std::make_unique<SingleJobScheduler>(model.get(), model.get());
  sched->start(queue);

  // First admit must succeed on an idle scheduler.
  EXPECT_TRUE(sched->runJob(std::string("first"), kNoJobId));

  // Wait briefly so the processing thread picks up the job.
  std::this_thread::sleep_for(std::chrono::milliseconds{50});

  // Second admit must be rejected while the slot is occupied.
  EXPECT_FALSE(sched->runJob(std::string("second"), kNoJobId));

  // cancelAll() must return without deadlock while the job is in flight.
  auto fut = std::async(std::launch::async, [&sched]() { sched->cancelAll(); });
  ASSERT_NE(fut.wait_for(std::chrono::seconds{2}), std::future_status::timeout)
      << "Deadlock detected: cancelAll() did not return within timeout";
}

/// The single-slot scheduler cannot correlate a tagged request to its outputs,
/// so admitting a non-sentinel id is a programming error and must throw.
TEST(PolymorphicSchedulerTest, PolymorphicScheduler_RunJobRejectsTaggedId) {
  MockOutputCallback cb;
  auto model = std::make_unique<JobRunnerTestModel>();
  auto queue = std::make_shared<OutputQueue>(cb, *model);

  std::unique_ptr<IJobScheduler> sched =
      std::make_unique<SingleJobScheduler>(model.get(), model.get());
  sched->start(queue);

  EXPECT_THROW(sched->runJob(std::string("tagged"), 42), std::invalid_argument);
}

/// cancel() with a tagged id cannot map to the single slot; it must be ignored
/// (warned, no throw) and must leave an in-flight untagged job running.
TEST(PolymorphicSchedulerTest, PolymorphicScheduler_CancelIgnoresTaggedId) {
  MockOutputCallback cb;
  auto model = std::make_unique<JobRunnerTestModel>(
      std::chrono::milliseconds{500} /* long enough to stay busy */);
  auto queue = std::make_shared<OutputQueue>(cb, *model);

  std::unique_ptr<IJobScheduler> sched =
      std::make_unique<SingleJobScheduler>(model.get(), model.get());
  sched->start(queue);

  EXPECT_TRUE(sched->runJob(std::string("first"), kNoJobId));
  std::this_thread::sleep_for(std::chrono::milliseconds{50});

  // A tagged cancel does not target the slot, so the job stays occupied.
  EXPECT_NO_THROW(sched->cancel(42));
  EXPECT_FALSE(sched->runJob(std::string("second"), kNoJobId));
}

} // namespace qvac_lib_inference_addon_cpp
