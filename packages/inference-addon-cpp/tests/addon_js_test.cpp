#include <any>
#include <atomic>
#include <cstddef>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "helpers_header/js.h"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/addon/AddonJs.hpp"
#include "inference-addon-cpp/job/IJobScheduler.hpp"
#include "inference-addon-cpp/job/JobId.hpp"
#include "inference-addon-cpp/queue/OutputCallbackInterface.hpp"

namespace qvac_lib_inference_addon_cpp {

// Simple mock model for testing AddonJs instantiation
class MockModel : public model::IModel {
public:
  std::string getName() const override { return "MockModel"; }
  RuntimeStats runtimeStats() const override { return {}; }
  std::any process(const std::any& input) override { return input; }
};

// Mock output callback for testing
class MockOutputCallback : public OutputCallBackInterface {
  bool stopped_{false};

public:
  void initializeProcessingThread(
      std::shared_ptr<OutputQueue> /*outputQueue*/) override {}
  void notify() override {}
  void stop() override { stopped_ = true; }
};

// Records which cancellation entry point AddonJs::cancelJob routed to. cancelJob
// runs its work on a detached thread (JsAsyncTask), so the recorded call is
// published through a promise the test waits on before asserting.
class RecordingScheduler : public IJobScheduler {
  std::promise<void> called_;

public:
  std::vector<JobId> liveIds;
  mutable std::atomic_bool liveIdsQueried{false};
  std::optional<JobId> cancelId;
  std::optional<std::vector<JobId>> cancelledJobs;
  bool cancelAllCalled{false};

  std::future<void> awaitCall() { return called_.get_future(); }

  void start(std::shared_ptr<OutputQueue> /*outputQueue*/) override {}
  std::optional<JobId> runJob(std::any /*input*/) override { return kNoJobId; }
  std::optional<JobId> runExclusiveJob(std::any /*input*/) override {
    return kNoJobId;
  }
  void cancel(JobId id) override {
    cancelId = id;
    called_.set_value();
  }
  void cancelAll() override {
    cancelAllCalled = true;
    called_.set_value();
  }
  [[nodiscard]] std::vector<JobId> liveJobIds() const override {
    liveIdsQueried = true;
    return liveIds;
  }
  void cancelJobs(const std::vector<JobId>& ids) override {
    cancelledJobs = ids;
    called_.set_value();
  }
  [[nodiscard]] std::size_t activeJobs() const override { return 0; }

  /// A stub not built against a real model; report bound so AddonCpp adopts it.
  [[nodiscard]] bool isBoundTo(const model::IModel& /*model*/) const override {
    return true;
  }
};

AddonJs createTestAddonJs() {
  js_env_t env;
  auto outputCallback = std::make_unique<MockOutputCallback>();
  auto model = std::make_unique<MockModel>();
  return AddonJs(&env, std::move(outputCallback), std::move(model));
}

TEST(AddonJsTest, CanInstantiateAddonJs) {
  auto addon = createTestAddonJs();

  EXPECT_NE(addon.addonCpp, nullptr);
  EXPECT_EQ(addon.addonCpp->model.get().getName(), "MockModel");
}

TEST(AddonJsTest, AddonCppIsAccessibleViaAddonJs) {
  auto addon = createTestAddonJs();

  // Verify the shared_ptr to AddonCpp is valid and accessible
  ASSERT_NE(addon.addonCpp, nullptr);

  // The model reference should be accessible through AddonCpp
  const model::IModel& modelRef = addon.addonCpp->model.get();
  EXPECT_EQ(modelRef.getName(), "MockModel");
}

TEST(AddonJsTest, RunJobRValue) {
  auto addon = createTestAddonJs();
  std::string testInput = "test-data";
  EXPECT_NO_THROW(addon.runJob(std::any(std::move(testInput))));
}

TEST(AddonJsTest, RunJobUsesMoveSemantics) {
  auto addon = createTestAddonJs();

  // Prepare the test input and wrap it in a std::any
  std::string testInput = "test-data";
  std::any inputAny = testInput;

  // Call runJob with std::move - intentionally moving inputAny
  EXPECT_NO_THROW(addon.runJob(std::move(inputAny)));
}

TEST(AddonJsTest, CancelJobInvokesAddonCppCancelJob) {
  auto addon = createTestAddonJs();
  // No exception should be thrown
  EXPECT_NO_THROW(addon.cancelJob());
}

// Cancel without id is snapshot-based: the live ids are captured synchronously
// on the calling (JS) thread — before cancelJob returns — and exactly that
// snapshot is cancelled later, so jobs admitted after the call are untouched.
TEST(AddonJsTest, CancelWithoutIdCancelsSnapshotOfLiveJobs) {
  js_env_t env;
  auto scheduler = std::make_unique<RecordingScheduler>();
  RecordingScheduler* recorder = scheduler.get();
  auto called = recorder->awaitCall();
  AddonJs addon(
      &env, std::make_unique<MockOutputCallback>(),
      std::make_unique<MockModel>(), std::move(scheduler));

  recorder->liveIds = {7, 9};
  addon.cancelJob();
  EXPECT_TRUE(recorder->liveIdsQueried)
      << "the snapshot must be taken before cancelJob returns";
  called.wait();

  ASSERT_TRUE(recorder->cancelledJobs.has_value());
  EXPECT_EQ(*recorder->cancelledJobs, (std::vector<JobId>{7, 9}));
  EXPECT_FALSE(recorder->cancelAllCalled)
      << "cancel-all must never reach for jobs outside the snapshot";
  EXPECT_FALSE(recorder->cancelId.has_value());
}

TEST(AddonJsTest, CancelWithIdCancelsOnlyThatJob) {
  js_env_t env;
  auto scheduler = std::make_unique<RecordingScheduler>();
  RecordingScheduler* recorder = scheduler.get();
  auto called = recorder->awaitCall();
  AddonJs addon(
      &env, std::make_unique<MockOutputCallback>(),
      std::make_unique<MockModel>(), std::move(scheduler));

  constexpr JobId kTarget = 42;
  addon.cancelJob(kTarget);
  called.wait();

  ASSERT_TRUE(recorder->cancelId.has_value());
  EXPECT_EQ(*recorder->cancelId, kTarget);
  EXPECT_FALSE(recorder->cancelAllCalled);
}

} // namespace qvac_lib_inference_addon_cpp
