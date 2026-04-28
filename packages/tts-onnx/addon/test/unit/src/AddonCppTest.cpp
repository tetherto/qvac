#include <atomic>
#include <chrono>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>

#include <gtest/gtest.h>
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>
#include <qvac-lib-inference-addon-cpp/addon/AddonCpp.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackInterface.hpp>

namespace {

using namespace qvac_lib_inference_addon_cpp;

class FakeModel : public model::IModel, public model::IModelCancel {
public:
  explicit FakeModel(
      std::chrono::milliseconds workDuration = std::chrono::milliseconds(50))
      : workDuration_(workDuration) {}

  std::string getName() const override { return "FakeModel"; }

  std::any process(const std::any &input) override {
    if (input.type() != typeid(std::string)) {
      throw std::runtime_error("Invalid input type");
    }

    cancelRequested_.store(false);
    const auto deadline = std::chrono::steady_clock::now() + workDuration_;
    while (std::chrono::steady_clock::now() < deadline) {
      if (cancelRequested_.load()) {
        throw std::runtime_error("Job cancelled");
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return std::vector<int16_t>{1, 2, 3, 4};
  }

  RuntimeStats runtimeStats() const override {
    return {{"totalTime", 0.1}, {"totalSamples", static_cast<int64_t>(4)}};
  }

  void cancel() const override { cancelRequested_.store(true); }

private:
  std::chrono::milliseconds workDuration_;
  mutable std::atomic_bool cancelRequested_{false};
};

struct AddonFixture {
  std::unique_ptr<AddonCpp> addon;
  std::shared_ptr<out_handl::CppQueuedOutputHandler<std::vector<int16_t>>>
      outputHandler;
};

AddonFixture createFixture(std::chrono::milliseconds workDuration) {
  auto model = std::make_unique<FakeModel>(workDuration);
  auto outputHandler =
      std::make_shared<out_handl::CppQueuedOutputHandler<std::vector<int16_t>>>();
  out_handl::OutputHandlers<out_handl::OutputHandlerInterface<void>> handlers;
  handlers.add(outputHandler);

  std::unique_ptr<OutputCallBackInterface> callback =
      std::make_unique<OutputCallBackCpp>(std::move(handlers));
  auto addon = std::make_unique<AddonCpp>(std::move(callback), std::move(model));
  return {std::move(addon), std::move(outputHandler)};
}

TEST(AddonCppTest, RunJobProducesAudioOutput) {
  auto fixture = createFixture(std::chrono::milliseconds(20));
  fixture.addon->activate();

  ASSERT_TRUE(fixture.addon->runJob(std::string("hello")));
  auto output = fixture.outputHandler->tryPop(std::chrono::seconds(2));
  ASSERT_TRUE(output.has_value());
  EXPECT_EQ(output->size(), 4);
}

TEST(AddonCppTest, RejectSecondJobWhenBusy) {
  auto fixture = createFixture(std::chrono::milliseconds(300));
  fixture.addon->activate();

  ASSERT_TRUE(fixture.addon->runJob(std::string("job-1")));
  EXPECT_FALSE(fixture.addon->runJob(std::string("job-2")));
}

TEST(AddonCppTest, CancelDuringProcessingAllowsSubsequentJob) {
  auto fixture = createFixture(std::chrono::milliseconds(500));
  fixture.addon->activate();

  ASSERT_TRUE(fixture.addon->runJob(std::string("long-job")));
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_NO_THROW(fixture.addon->cancelJob());

  bool accepted = false;
  for (int i = 0; i < 50; ++i) {
    if (fixture.addon->runJob(std::string("short-job"))) {
      accepted = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  EXPECT_TRUE(accepted);
}

TEST(AddonCppTest, CancelWhenIdleDoesNotThrow) {
  auto fixture = createFixture(std::chrono::milliseconds(20));
  fixture.addon->activate();
  EXPECT_NO_THROW(fixture.addon->cancelJob());
}

} // namespace
