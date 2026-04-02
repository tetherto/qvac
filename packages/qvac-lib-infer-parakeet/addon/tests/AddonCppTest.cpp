#include <any>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>

#include "addon/AddonCpp.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"
#include "qvac-lib-inference-addon-cpp/handlers/CppOutputHandlerImplementations.hpp"
#include "qvac-lib-inference-addon-cpp/handlers/OutputHandler.hpp"
#include "qvac-lib-inference-addon-cpp/queue/OutputCallbackCpp.hpp"

namespace {

auto makeConfig() -> qvac_lib_infer_parakeet::ParakeetConfig {
  qvac_lib_infer_parakeet::ParakeetConfig config;
  config.modelType = qvac_lib_infer_parakeet::ModelType::TDT;
  config.sampleRate = 16000;
  config.channels = 1;
  return config;
}

auto makeInputSamples(size_t seconds) -> std::vector<float> {
  static constexpr size_t kSampleRate = 16000;
  return std::vector<float>(kSampleRate * seconds, 0.0f);
}

auto hasStatKey(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) -> bool {
  return std::any_of(
      stats.begin(),
      stats.end(),
      [&](const auto& entry) { return entry.first == key; });
}

class BlockingBusyModel : public qvac_lib_inference_addon_cpp::model::IModel,
                          public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  auto getName() const -> std::string override { return "BlockingBusyModel"; }

  auto runtimeStats() const
      -> qvac_lib_inference_addon_cpp::RuntimeStats override {
    return {};
  }

  auto process(const std::any& input) -> std::any override {
    const auto& inputStr = std::any_cast<const std::string&>(input);

    std::unique_lock<std::mutex> lock(mutex_);
    if (inputStr == "blocking") {
      blocked_ = true;
      cv_.notify_all();
      cv_.wait(lock, [this] { return !blocked_ || cancelled_; });
    }

    if (cancelled_) {
      cancelled_ = false;
      throw std::runtime_error("Job cancelled");
    }

    return inputStr;
  }

  void cancel() const override {
    std::lock_guard<std::mutex> lock(mutex_);
    cancelled_ = true;
    blocked_ = false;
    cv_.notify_all();
  }

  void waitUntilBlocked() {
    std::unique_lock<std::mutex> lock(mutex_);
    ASSERT_TRUE(
        cv_.wait_for(lock, std::chrono::seconds(2), [this] { return blocked_; }));
  }

  void unblock() {
    std::lock_guard<std::mutex> lock(mutex_);
    blocked_ = false;
    cv_.notify_all();
  }

private:
  mutable std::mutex mutex_;
  mutable std::condition_variable cv_;
  mutable bool blocked_{false};
  mutable bool cancelled_{false};
};

auto createBlockingAddon() -> std::pair<std::unique_ptr<qvac_lib_inference_addon_cpp::AddonCpp>,
                                        BlockingBusyModel*> {
  auto stringHandler = std::make_shared<
      qvac_lib_inference_addon_cpp::out_handl::CppContainerOutputHandler<
          std::vector<std::string>>>();

  qvac_lib_inference_addon_cpp::out_handl::OutputHandlers<
      qvac_lib_inference_addon_cpp::out_handl::OutputHandlerInterface<void>>
      outputHandlers;
  outputHandlers.add(stringHandler);

  auto outputCallback =
      std::make_unique<qvac_lib_inference_addon_cpp::OutputCallBackCpp>(
          std::move(outputHandlers));
  auto model = std::make_unique<BlockingBusyModel>();
  auto* modelPtr = model.get();

  auto addon = std::make_unique<qvac_lib_inference_addon_cpp::AddonCpp>(
      std::move(outputCallback), std::move(model));

  return {std::move(addon), modelPtr};
}

} // namespace

TEST(ParakeetAddonCppTest, RunJobEmitsOutputAndRuntimeStats) {
  auto instance = qvac_lib_infer_parakeet::createInstance(makeConfig());

  auto input = makeInputSamples(1);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(input))));

  auto maybeOutput = instance.transcriptOutput->tryPop(std::chrono::seconds(5));
  ASSERT_TRUE(maybeOutput.has_value());
  ASSERT_FALSE(maybeOutput->empty());
  EXPECT_FALSE(maybeOutput->front().text.empty());

  auto maybeStats = instance.statsOutput->tryPop(std::chrono::seconds(5));
  ASSERT_TRUE(maybeStats.has_value());
  EXPECT_TRUE(hasStatKey(*maybeStats, "totalTime"));
  EXPECT_TRUE(hasStatKey(*maybeStats, "audioDurationMs"));
  EXPECT_TRUE(hasStatKey(*maybeStats, "totalSamples"));
}

TEST(ParakeetAddonCppTest, RejectsSecondRunWhileBusy) {
  auto [addon, model] = createBlockingAddon();

  ASSERT_TRUE(addon->runJob(std::any(std::string("blocking"))));
  model->waitUntilBlocked();

  EXPECT_FALSE(addon->runJob(std::any(std::string("second"))));

  model->unblock();
}

TEST(ParakeetAddonCppTest, CancelAllowsNextRun) {
  auto instance = qvac_lib_infer_parakeet::createInstance(makeConfig());

  auto firstInput = makeInputSamples(5);
  ASSERT_TRUE(instance.addon->runJob(std::any(std::move(firstInput))));
  instance.addon->cancelJob();

  auto maybeCancelError =
      instance.errorOutput->tryPop(std::chrono::seconds(5));

  if (!maybeCancelError.has_value()) {
    instance.transcriptOutput->tryPop(std::chrono::seconds(1));
    instance.statsOutput->tryPop(std::chrono::seconds(1));
  }

  auto secondInput = makeInputSamples(1);
  bool accepted = false;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (std::chrono::steady_clock::now() < deadline) {
    if (instance.addon->runJob(std::any(secondInput))) {
      accepted = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  ASSERT_TRUE(accepted);

  auto maybeStats = instance.statsOutput->tryPop(std::chrono::seconds(5));
  ASSERT_TRUE(maybeStats.has_value());
}
