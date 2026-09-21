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
#include "model-interface/BackendUtils.hpp"
#include "model-interface/parler/ParlerConfig.hpp"

namespace tts_cpp::parler {
class Engine;
}

namespace tts_cpp::lavasr {
class Enhancer;
class Denoiser;
} // namespace tts_cpp::lavasr

namespace qvac::ttsggml::parler {

class ParlerModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using Input = std::string;
  using Output = std::vector<int16_t>;

  // Per-chunk callback for native streaming; wired onto addonCpp->outputQueue
  // by the JS binding. Non-empty + streamChunkTokens>0 in the config =
  // streaming.
  using ChunkCallback = std::function<void(
      std::vector<int16_t>&& pcm, int chunkIndex, bool isLast)>;

  struct AnyInput {
    std::string text;
    // Per-call description overrides (all-empty = use the constructor
    // config); merge/conflict rules in ParlerModel::synthesize.
    ParlerDescriptionFields desc;
    ChunkCallback chunkCallback;
  };

  explicit ParlerModel(ParlerConfig config);
  ~ParlerModel() noexcept override;

  std::string getName() const override { return "ParlerModel"; }
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

  // IModelAsyncLoad — see the equivalent comment on ChatterboxModel.
  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(
      const std::string&,
      std::unique_ptr<std::basic_streambuf<char>>&&) override {}

  void setConfig(ParlerConfig config);
  const ParlerConfig& config() const { return cfg_; }

  int sampleRate() const { return sampleRate_; }

  static void validateConfig(const ParlerConfig& cfg);
  // The description a config resolves to (explicit text, or the rendered
  // template; all-defaults renders the models' fallback caption). Throws
  // on invalid template values or same-level description conflicts.
  static std::string resolveDescription(const ParlerDescriptionFields& desc);

private:
  struct SynthResult {
    Output pcm;
    bool wasStreaming = false;
  };
  SynthResult synthesize(const AnyInput& input);

  void loadLocked();
  void unloadLocked();

  ParlerConfig cfg_;

  mutable std::mutex engineMu_;
  std::shared_ptr<tts_cpp::parler::Engine> engine_;

  // LavaSR enhancer: loaded alongside the engine when cfg_.enhancerGgufPath is
  // set; null disables enhancement. Held by shared_ptr so an in-flight
  // synthesize() keeps its instance alive across a concurrent reload().
  std::shared_ptr<tts_cpp::lavasr::Enhancer> enhancer_;
  // LavaSR denoiser (runs before the enhancer, rate-preserving): loaded when
  // cfg_.denoiserGgufPath is set; null disables denoising.
  std::shared_ptr<tts_cpp::lavasr::Denoiser> denoiser_;

  std::atomic_bool jobInProgress_{false};

  // Mirrors SupertonicModel::cancelRequested_ (see that header).
  mutable std::atomic_bool cancelRequested_{false};

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  double tokensPerSecond_ = 0.0;
  size_t textLength_ = 0;
  int sampleRate_ = kParlerNativeSampleRate;

  int backendDevice_ = 0;
  int backendId_ = 0;
  std::string backendName_ = "CPU";
  bool gpuUnsupported_ = false;

  // LavaSR enhancer backend, surfaced in runtimeStats so a host / GPU smoke
  // test can tell which device actually ran the enhancement.
  int enhancerBackendDevice_ = kBackendDeviceNone;
  int enhancerBackendId_ = kBackendIdNone;
};

} // namespace qvac::ttsggml::parler
