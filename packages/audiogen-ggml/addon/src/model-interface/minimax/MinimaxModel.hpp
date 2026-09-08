#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "audiogen-cpp/gpu_fallback.h"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "model-interface/AudioGenProgress.hpp"
#include "model-interface/minimax/MinimaxConfig.hpp"

namespace tts_cpp::minimax {
class Engine;
}

namespace qvac::audiogenggml::minimax {

inline constexpr int64_t K_DEFAULT_MAX_FRAMES = 300;

class MinimaxModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using Output = std::vector<int16_t>;

  struct AnyInput {
    std::string caption;
    std::string lyrics = "[Instrumental]";
    int64_t maxFrames = K_DEFAULT_MAX_FRAMES;
    int64_t seed = -1;
    int inferenceSteps = 0;
    float cfgScale = 0.0F;
  };

  explicit MinimaxModel(MinimaxConfig config);
  ~MinimaxModel() noexcept override;

  std::string getName() const override { return "MinimaxModel"; }
  std::any process(const std::any& input) override;
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;

  void cancel() const override;
  void load();
  void unload();
  void reload(MinimaxConfig config);
  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(
      const std::string&,
      std::unique_ptr<std::basic_streambuf<char>>&&) override {}

  void setProgressSink(std::function<void(const AudioGenProgress&)> sink) {
    progressSink_ = std::move(sink);
  }

  int sampleRate() const { return sampleRate_; }
  int channels() const { return channels_; }

private:
  Output generate(const AnyInput& input);
  static void validateConfig(const MinimaxConfig& config);
  void loadLocked();
  void unloadLocked();

  MinimaxConfig config_;
  std::mutex operationMutex_;
  mutable std::mutex engineMutex_;
  std::shared_ptr<tts_cpp::minimax::Engine> engine_;
  mutable std::atomic_bool cancelRequested_{false};
  std::function<void(const AudioGenProgress&)> progressSink_;
  double totalTimeMs_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  int sampleRate_ = 0;
  int channels_ = 0;
  std::string backendName_ = "CPU";
  tts_cpp::GpuFallbackReason gpuFallbackReason_ =
      tts_cpp::GpuFallbackReason::not_requested;
};

} // namespace qvac::audiogenggml::minimax
