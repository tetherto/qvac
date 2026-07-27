#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"

#include "model-interface/acestep/AcestepConfig.hpp"

namespace tts_cpp::acestep {
class Engine;
}

namespace qvac::audiogenggml::acestep {

// One progress tick surfaced mid-generation. `stage` is "lm" | "dit" | "vae";
// `step`/`total` count within that stage (the DiT stage streams every Euler
// step, which is the bulk of the work). Emitted through the same output queue
// as PCM so the JS side receives it via the output callback.
struct AcestepProgress {
  std::string stage;
  int         step  = 0;
  int         total = 0;
};

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

  struct AnyInput {
    std::string caption;
    std::string lyrics = "[Instrumental]";
    std::string vocalLanguage;
    long long   seed = -1;      // <0 = random (uint32 range, torch/philox parity)
    int         bpm = 0;        // 0 => let the LM infer
    std::string keyscale;       // optional, e.g. "C minor"
    std::string timesignature;  // optional, e.g. "4/4"
    float       duration = 0.0F;  // 0 => keep engine default / let LM decide
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
  void setProgressSink(std::function<void(const AcestepProgress&)> sink) {
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
  std::atomic_bool jobInProgress_{false};

  std::function<void(const AcestepProgress&)> progressSink_;

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  int sampleRate_ = 0;  // populated from the engine result in generate()
  int channels_ = 0;    // populated from the engine result in generate()

  std::string backendName_ = "CPU";
};

}  // namespace qvac::audiogenggml::acestep
