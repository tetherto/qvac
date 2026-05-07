#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

#include "model-interface/supertonic/SupertonicConfig.hpp"

namespace tts_cpp::supertonic {
class Engine;
}

namespace qvac::ttsggml::supertonic {

class SupertonicModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel {
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

  std::atomic_bool jobInProgress_{false};

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  double tokensPerSecond_ = 0.0;
  size_t textLength_ = 0;
  int sampleRate_ = 44100;

  int backendDevice_ = 0;
  int backendId_ = 0;
  std::string backendName_ = "CPU";
};

}
