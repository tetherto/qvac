#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <variant>
#include <vector>

#include "audiogen-cpp/gpu_fallback.h"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "model-interface/AudioGenProgress.hpp"
#include "model-interface/acestep/AcestepConfig.hpp"

namespace tts_cpp::acestep {
class Engine;
}

namespace qvac::audiogenggml::acestep {

// Music-generation model interface for the audiogen-ggml addon. Wraps
// tts_cpp::acestep::Engine (text-enc + LM + DiT + VAE) behind the
// inference-addon-cpp IModel surface, exactly like ttsggml's SupertonicModel
// wraps tts_cpp::supertonic::Engine.
class AcestepModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  // Interleaved stereo 48 kHz PCM.
  using Output = std::vector<int16_t>;

  enum class AudioEditOperationType {
    FlowEdit,
    Repaint,
  };

  enum class RepaintMode {
    Conservative,
    Balanced,
    Aggressive,
  };

  struct FlowEditInput {
    static constexpr AudioEditOperationType TYPE =
        AudioEditOperationType::FlowEdit;
    std::string sourceCaption;
    std::string sourceLyrics = "[Instrumental]";
    std::string targetCaption;
    std::string targetLyrics = "[Instrumental]";
    float nMin = 0.0F;
    float nMax = 1.0F;
    int nAvg = 1;
  };

  struct RepaintInput {
    static constexpr AudioEditOperationType TYPE =
        AudioEditOperationType::Repaint;
    std::string caption;
    std::string lyrics = "[Instrumental]";
    float start = 0.0F;
    float end = -1.0F;
    RepaintMode mode = RepaintMode::Balanced;
    float strength = 0.5F;
  };

  using AudioEditOperationInput = std::variant<FlowEditInput, RepaintInput>;

  struct AnyInput {
    std::string caption;
    std::string lyrics = "[Instrumental]";
    std::string vocalLanguage;
    long long seed = -1;  // <0 = random (uint32 range, torch/philox parity)
    int bpm = 0;          // 0 => let the LM infer
    std::string keyscale; // optional, e.g. "C minor"
    std::string timesignature; // optional, e.g. "4/4"
    bool augmentCaptionWithMetadata = false;
    float duration = 0.0F; // 0 => keep engine default / let LM decide
    float lmTemperature = 0.85F;
    float lmTopP = 0.9F;
    int lmTopK = 0;
    float lmCfgScale = 2.0F;
    bool lmPhase1 = true;
    bool simpleMode = false;
    bool normalizeLoudness = true;
    bool computeQualityScore = false;
    bool dcwEnabled = true;
    float dcwScaler = 0.05F;
    float dcwHighScaler = 0.02F;
    std::vector<int>
        audioCodes; // non-empty => skip LM and synthesize these codes
    std::vector<float> referenceAudio;
    std::vector<float> sourceAudio;
    std::string taskType = "text2music";
    std::string track;
    float guidanceScale = 0.0F;
    float audioCoverStrength = 1.0F;
    float coverNoiseStrength = 0.0F;
    std::vector<AudioEditOperationInput> editOperations;
  };

  explicit AcestepModel(AcestepConfig config);
  ~AcestepModel() noexcept override;

  std::string getName() const override { return "AcestepModel"; }
  std::any process(const std::any& input) override;
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;

  void cancel() const override;

  void load();
  void unload();
  void reload();
  bool isLoaded() const {
    std::lock_guard lk(engineMu_);
    return static_cast<bool>(engine_);
  }

  // IModelAsyncLoad: AddonCpp::activate() (wrapped in JsAsyncTask::run) calls
  // this on a worker thread; load() is idempotent.
  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(
      const std::string&,
      std::unique_ptr<std::basic_streambuf<char>>&&) override {}

  void setConfig(AcestepConfig config) { cfg_ = std::move(config); }
  const AcestepConfig& config() const { return cfg_; }

  // Install a sink for mid-generation progress ticks. Set once at construction
  // (before any job runs), invoked on the job worker thread during generate().
  void setProgressSink(std::function<void(const AudioGenProgress&)> sink) {
    progressSink_ = std::move(sink);
  }

  int sampleRate() const { return sampleRate_; }
  int channels() const { return channels_; }

private:
  Output generate(const AnyInput& in);
  static void validateConfig(const AcestepConfig& cfg);
  void loadLocked();
  void unloadLocked();

  AcestepConfig cfg_;

  mutable std::mutex engineMu_;
  std::shared_ptr<tts_cpp::acestep::Engine> engine_;

  mutable std::atomic_bool cancelRequested_{false};

  std::function<void(const AudioGenProgress&)> progressSink_;

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  double qualityScore_ = 0.0;
  bool hasQualityScore_ = false; // set per run; gates the qualityScore stat
  int sampleRate_ = 0; // populated from the engine result in generate()
  int channels_ = 0;   // populated from the engine result in generate()

  std::string backendName_ = "CPU";
  tts_cpp::GpuFallbackReason gpuFallbackReason_ =
      tts_cpp::GpuFallbackReason::not_requested;
};

} // namespace qvac::audiogenggml::acestep
