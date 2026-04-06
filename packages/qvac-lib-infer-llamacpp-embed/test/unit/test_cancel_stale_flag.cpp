#include <any>
#include <atomic>
#include <chrono>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/RuntimeStats.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackInterface.hpp>

#include "model-interface/BertModel.hpp"

namespace {

using namespace qvac_lib_inference_addon_cpp;

// Fake BertEmbeddings for tests that never touch a real model.
BertEmbeddings makeDummyEmbeddings() {
  std::vector<float> flat = {0.1f, 0.2f, 0.3f};
  return BertEmbeddings(std::move(flat),
                        BertEmbeddings::Layout{.embeddingCount = 1,
                                               .embeddingSize = 3});
}

class StaleFlagModel : public model::IModel, public model::IModelCancel {
  mutable std::atomic<bool> stop_{false};
  mutable std::atomic<int> processCallCount_{0};
  mutable std::atomic<bool> lastRunWasAborted_{false};
  std::chrono::milliseconds workDuration_;

public:
  explicit StaleFlagModel(
      std::chrono::milliseconds workDuration = std::chrono::milliseconds{200})
      : workDuration_(workDuration) {}

  std::string getName() const override { return "StaleFlagModel"; }
  RuntimeStats runtimeStats() const override { return RuntimeStats{}; }

  std::any process(const std::any& /*input*/) override {
    processCallCount_++;
    if (stop_.load()) {
      stop_ = false;
      lastRunWasAborted_ = true;
      return makeDummyEmbeddings();
    }
    lastRunWasAborted_ = false;
    auto start = std::chrono::steady_clock::now();
    while (!stop_.load()) {
      if (std::chrono::steady_clock::now() - start >= workDuration_) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds{1});
    }
    stop_ = false;
    return makeDummyEmbeddings();
  }

  void cancel() const override { stop_ = true; }

  int getProcessCallCount() const { return processCallCount_.load(); }
  bool wasLastRunAborted() const { return lastRunWasAborted_.load(); }
};

struct TestHarness {
  std::unique_ptr<AddonCpp> addon;
  std::shared_ptr<out_handl::CppQueuedOutputHandler<BertEmbeddings>>
      outputHandler;
  StaleFlagModel* modelPtr;
};

TestHarness createTestAddon(std::chrono::milliseconds workDuration) {
  auto model = std::make_unique<StaleFlagModel>(workDuration);
  auto* rawModel = model.get();

  auto outHandler =
      std::make_shared<out_handl::CppQueuedOutputHandler<BertEmbeddings>>();
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>> handlers;
  handlers.add(outHandler);
  auto callback = std::make_unique<OutputCallBackCpp>(std::move(handlers));

  auto addon = std::make_unique<AddonCpp>(std::move(callback), std::move(model));

  return {std::move(addon), std::move(outHandler), rawModel};
}

class CancelStaleFlagTest : public ::testing::Test {};

TEST_F(CancelStaleFlagTest, CancelQueuedJob_DoesNotPoisonNextJob) {
  auto [addon, output, modelPtr] =
      createTestAddon(std::chrono::milliseconds{200});

  addon->runJob(std::string("first"));
  addon->cancelJob();
  std::this_thread::sleep_for(std::chrono::milliseconds{100});

  ASSERT_TRUE(addon->runJob(std::string("second")));
  std::this_thread::sleep_for(std::chrono::milliseconds{400});

  EXPECT_FALSE(modelPtr->wasLastRunAborted())
      << "STALE CANCEL FLAG BUG: cancel() of a queued job set the model's "
         "stop flag, which was never reset. The next job saw the stale flag "
         "and aborted immediately with no real work.";
}

TEST_F(CancelStaleFlagTest, CancelActiveJob_StopsModelWithoutPoisoning) {
  auto [addon, output, modelPtr] =
      createTestAddon(std::chrono::milliseconds{5000});

  ASSERT_TRUE(addon->runJob(std::string("long-running")));
  std::this_thread::sleep_for(std::chrono::milliseconds{100});

  auto before = std::chrono::steady_clock::now();
  addon->cancelJob();
  auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - before);

  EXPECT_LT(elapsed.count(), 2000)
      << "cancelJob() took too long - possible deadlock or cancel not working";

  std::this_thread::sleep_for(std::chrono::milliseconds{200});

  ASSERT_TRUE(addon->runJob(std::string("follow-up")));
  std::this_thread::sleep_for(std::chrono::milliseconds{500});

  EXPECT_FALSE(modelPtr->wasLastRunAborted())
      << "Follow-up job was aborted by a stale stop flag left by "
         "cancel of the previous active job.";
}

TEST_F(CancelStaleFlagTest, CancelWhenIdle_DoesNotPoisonNextJob) {
  auto [addon, output, modelPtr] =
      createTestAddon(std::chrono::milliseconds{200});

  addon->cancelJob();

  ASSERT_TRUE(addon->runJob(std::string("after-idle-cancel")));
  std::this_thread::sleep_for(std::chrono::milliseconds{400});

  EXPECT_FALSE(modelPtr->wasLastRunAborted())
      << "Cancel when idle should be a no-op, but it poisoned the next job.";
}

TEST_F(CancelStaleFlagTest, RepeatedCancelThenRun_NeverPoisons) {
  auto [addon, output, modelPtr] =
      createTestAddon(std::chrono::milliseconds{100});

  constexpr int kIterations = 10;
  for (int i = 0; i < kIterations; ++i) {
    addon->runJob(std::string("cancel-target-" + std::to_string(i)));
    addon->cancelJob();
    std::this_thread::sleep_for(std::chrono::milliseconds{80});

    ASSERT_TRUE(addon->runJob(std::string("follow-up-" + std::to_string(i))));
    std::this_thread::sleep_for(std::chrono::milliseconds{200});

    EXPECT_FALSE(modelPtr->wasLastRunAborted())
        << "Iteration " << i
        << ": follow-up was poisoned by stale cancel flag.";
  }
}

} // namespace

