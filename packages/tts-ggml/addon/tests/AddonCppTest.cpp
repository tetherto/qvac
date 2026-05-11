// Addon-level integration tests for the tts-ggml shell.
//
// Constructing a real ChatterboxModel / SupertonicModel from C++ requires
// a real GGUF on disk (see test_chatterbox_config.cpp /
// test_supertonic_config.cpp).  These tests instead drive `AddonCpp`
// with a fake `IModel` so we exercise:
//   - the runJob -> outputCallback -> CppQueuedOutputHandler chain
//   - busy rejection when a job is already in flight
//   - cooperative cancel + restart
//
// Mirrors the pattern in qvac-lib-infer-parakeet/addon/tests/AddonCppTest.cpp.

#include <gtest/gtest.h>

#include <any>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <inference-addon-cpp/ModelInterfaces.hpp>
#include <inference-addon-cpp/RuntimeStats.hpp>

#include "addon/AddonCpp.hpp"

namespace {

using qvac::ttsggml::AddonInstance;
using qvac::ttsggml::createInstance;

// IModel that:
//   - returns a fixed PCM buffer for "ok" inputs
//   - blocks on a condvar for "blocking" inputs (so we can race a second
//     runJob and assert it gets rejected)
//   - throws "Job cancelled" when cancel() is invoked while blocked
class StubAudioModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
public:
  std::string getName() const override { return "StubAudioModel"; }

  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override {
    qvac_lib_inference_addon_cpp::RuntimeStats stats;
    stats.emplace_back("totalSamples", static_cast<int64_t>(lastSampleCount_));
    stats.emplace_back("audioDurationMs",
                       static_cast<double>(lastSampleCount_) * 1000.0 / 24000.0);
    stats.emplace_back("totalTime", 0.001);
    return stats;
  }

  std::any process(const std::any& input) override {
    const auto& text = std::any_cast<const std::string&>(input);

    if (text == "blocking") {
      std::unique_lock<std::mutex> lk(mu_);
      blocked_ = true;
      cv_.notify_all();
      cv_.wait(lk, [this] { return !blocked_ || cancelled_; });
      if (cancelled_) {
        cancelled_ = false;
        throw std::runtime_error("Job cancelled");
      }
    }

    std::vector<int16_t> pcm(static_cast<size_t>(text.size()) * 240, 0);
    lastSampleCount_ = pcm.size();
    return std::any(std::move(pcm));
  }

  void cancel() const override {
    std::lock_guard<std::mutex> lk(mu_);
    cancelled_ = true;
    blocked_ = false;
    cv_.notify_all();
  }

  void waitUntilBlocked() {
    std::unique_lock<std::mutex> lk(mu_);
    ASSERT_TRUE(cv_.wait_for(lk, std::chrono::seconds(2),
                             [this] { return blocked_; }));
  }

  void unblock() {
    std::lock_guard<std::mutex> lk(mu_);
    blocked_ = false;
    cv_.notify_all();
  }

private:
  mutable std::mutex mu_;
  mutable std::condition_variable cv_;
  mutable bool blocked_{false};
  mutable bool cancelled_{false};
  std::size_t lastSampleCount_{0};
};

std::pair<AddonInstance, StubAudioModel*> createStubAddon() {
  auto model = std::make_unique<StubAudioModel>();
  auto* modelPtr = model.get();
  auto instance = createInstance(std::move(model));
  return {std::move(instance), modelPtr};
}

}

TEST(TtsGgmlAddonCpp, RunJobEmitsAudioAndStats) {
  auto [instance, model] = createStubAddon();
  ASSERT_TRUE(instance.addon->runJob(std::any(std::string("ok-input"))));

  auto pcm = instance.audioOutput->tryPop(std::chrono::seconds(5));
  ASSERT_TRUE(pcm.has_value());
  EXPECT_FALSE(pcm->empty());

  auto stats = instance.statsOutput->tryPop(std::chrono::seconds(5));
  ASSERT_TRUE(stats.has_value());
  bool sawTotalSamples = false;
  bool sawAudioDurationMs = false;
  for (const auto& [k, _v] : *stats) {
    if (k == "totalSamples") sawTotalSamples = true;
    if (k == "audioDurationMs") sawAudioDurationMs = true;
  }
  EXPECT_TRUE(sawTotalSamples);
  EXPECT_TRUE(sawAudioDurationMs);
}

TEST(TtsGgmlAddonCpp, RejectsSecondRunWhileBusy) {
  auto [instance, model] = createStubAddon();

  ASSERT_TRUE(instance.addon->runJob(std::any(std::string("blocking"))));
  model->waitUntilBlocked();

  EXPECT_FALSE(instance.addon->runJob(std::any(std::string("second"))));

  model->unblock();
  // Drain any remaining outputs so the JobRunner unwinds cleanly.
  instance.audioOutput->tryPop(std::chrono::seconds(2));
  instance.statsOutput->tryPop(std::chrono::seconds(2));
}

TEST(TtsGgmlAddonCpp, CancelInFlightAllowsNextRun) {
  auto [instance, model] = createStubAddon();

  ASSERT_TRUE(instance.addon->runJob(std::any(std::string("blocking"))));
  model->waitUntilBlocked();

  instance.addon->cancelJob();
  auto err = instance.errorOutput->tryPop(std::chrono::seconds(5));
  if (!err.has_value()) {
    instance.audioOutput->tryPop(std::chrono::seconds(1));
    instance.statsOutput->tryPop(std::chrono::seconds(1));
  }

  bool accepted = false;
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (std::chrono::steady_clock::now() < deadline) {
    if (instance.addon->runJob(std::any(std::string("ok-after-cancel")))) {
      accepted = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  ASSERT_TRUE(accepted);

  auto pcm = instance.audioOutput->tryPop(std::chrono::seconds(5));
  ASSERT_TRUE(pcm.has_value());
  EXPECT_FALSE(pcm->empty());
}
