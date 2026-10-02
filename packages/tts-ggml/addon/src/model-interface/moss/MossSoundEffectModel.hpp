#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "model-interface/moss/MossSoundEffectConfig.hpp"

namespace tts_cpp::moss {
class SoundEffectEngine;
struct SoundEffectOptions;
struct SoundEffectRequest;
struct SoundEffectResult;
} // namespace tts_cpp::moss

namespace qvac::ttsggml::moss {

inline constexpr int MOSS_SFX_NATIVE_SAMPLE_RATE = 48000;

class MossSoundEffectModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using Output = std::vector<int16_t>;

  struct AnyInput {
    std::string text;
    MossSoundEffectCall call;
  };

  explicit MossSoundEffectModel(MossSoundEffectConfig config);
  ~MossSoundEffectModel() noexcept override;

  std::string getName() const override { return "MossSoundEffectModel"; }
  std::any process(const std::any& input) override;
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;

  void cancel() const override;

  void load();
  void unload();
  bool isLoaded() const {
    std::lock_guard lk(engineMu_);
    return static_cast<bool>(engine_);
  }

  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(
      const std::string&,
      std::unique_ptr<std::basic_streambuf<char>>&&) override {}

  void reloadWith(MossSoundEffectConfig config);
  MossSoundEffectConfig config() const {
    std::lock_guard lk(engineMu_);
    return cfg_;
  }

  int sampleRate() const { return MOSS_SFX_NATIVE_SAMPLE_RATE; }

  static void validateConfig(const MossSoundEffectConfig& cfg);
  static tts_cpp::moss::SoundEffectOptions
  toEngineOptions(const MossSoundEffectConfig& cfg);
  static tts_cpp::moss::SoundEffectRequest
  toRequest(const MossSoundEffectConfig& cfg, const AnyInput& input);

private:
  static const AnyInput& requireAnyInput(const std::any& input);
  void claimJob();
  std::shared_ptr<tts_cpp::moss::SoundEffectEngine> snapshot() const;
  void requireNotCancelled() const;
  void requireCompleted(const tts_cpp::moss::SoundEffectResult& result) const;
  tts_cpp::moss::SoundEffectResult runEngine(
      tts_cpp::moss::SoundEffectEngine& engine, const AnyInput& input) const;
  Output generate(const AnyInput& input);
  void recordStats(double seconds, int64_t samples);

  void loadLocked();
  void unloadLocked();

  MossSoundEffectConfig cfg_;

  mutable std::mutex engineMu_;
  std::shared_ptr<tts_cpp::moss::SoundEffectEngine> engine_;

  std::atomic_bool jobInProgress_{false};
  mutable std::atomic_bool cancelRequested_{false};

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;

  int backendDevice_ = 0;
  int backendId_ = 0;
  std::string backendName_ = "CPU";
  bool gpuUnsupported_ = false;
};

} // namespace qvac::ttsggml::moss
