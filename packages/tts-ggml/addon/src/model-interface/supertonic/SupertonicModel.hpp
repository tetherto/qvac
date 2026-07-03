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

#include "model-interface/supertonic/SupertonicConfig.hpp"

namespace tts_cpp::supertonic {
class Engine;
}
namespace tts_cpp::lavasr {
class Enhancer;
}

namespace qvac::ttsggml::supertonic {

class SupertonicModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using Input = std::string;
  using Output = std::vector<int16_t>;

  struct AnyInput {
    std::string text;
  };

  explicit SupertonicModel(SupertonicConfig config);
  ~SupertonicModel() noexcept override;

  std::string getName() const override { return "SupertonicModel"; }
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
  // AddonCpp::activate() (wrapped in JsAsyncTask::run by
  // addon_js::activate) calls this on a worker thread; load() is
  // idempotent.
  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(
      const std::string&,
      std::unique_ptr<std::basic_streambuf<char>>&&) override {}

  void setConfig(SupertonicConfig config) { cfg_ = std::move(config); }
  const SupertonicConfig& config() const { return cfg_; }

  int sampleRate() const { return sampleRate_; }

private:
  Output synthesize(const std::string& text);
  static void validateConfig(const SupertonicConfig& cfg);

  void loadLocked();
  void unloadLocked();

  SupertonicConfig cfg_;

  mutable std::mutex engineMu_;
  std::shared_ptr<tts_cpp::supertonic::Engine> engine_;
  // LavaSR enhancer: loaded alongside the engine when
  // cfg_.enhancerGgufPath is set; null disables enhancement. Holds only
  // const weights, so it is safe to share across concurrent enhance() calls.
  std::shared_ptr<tts_cpp::lavasr::Enhancer> enhancer_;

  std::atomic_bool jobInProgress_{false};

  // Mirrors ChatterboxModel::cancelRequested_: a JS-side cancel issued
  // between two run() calls (or before the first one) sets this flag;
  // process() consumes it on entry so a stale cancel doesn't poison the
  // next synthesis.  cancel() also forwards to the underlying engine,
  // but the per-process reset here is defence-in-depth against
  // tts_cpp::supertonic::Engine ever growing a sticky cancel flag.
  mutable std::atomic_bool cancelRequested_{false};

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  double tokensPerSecond_ = 0.0;
  size_t textLength_ = 0;
  int sampleRate_ = 44100;

  int backendDevice_ = 0;
  int backendId_ = 0;
  bool gpuUnsupported_ = false;
  std::string backendName_ = "CPU";
};

}
