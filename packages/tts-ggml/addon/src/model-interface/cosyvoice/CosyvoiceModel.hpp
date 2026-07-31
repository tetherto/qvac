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

#include "model-interface/cosyvoice/CosyvoiceConfig.hpp"

namespace tts_cpp::cosyvoice {
class Engine;
}

namespace qvac::ttsggml::cosyvoice {

class CosyvoiceModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using Output = std::vector<int16_t>;

  // Streaming chunk sink: called per token2wav hop with 16-bit PCM. Mirrors
  // ChatterboxModel's chunkCallback so the native chunk-streaming path flows
  // through the same JS output handler.
  using ChunkCallback =
      std::function<void(std::vector<int16_t>&&, int chunkIndex, bool isLast)>;

  struct AnyInput {
    std::string text;
    ChunkCallback chunkCallback;
  };

  explicit CosyvoiceModel(CosyvoiceConfig config);
  ~CosyvoiceModel() noexcept override;

  std::string getName() const override { return "CosyvoiceModel"; }
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

  // IModelAsyncLoad — the deferred load() runs on a worker thread via
  // AddonCpp::activate(); load() is idempotent.
  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(
      const std::string&,
      std::unique_ptr<std::basic_streambuf<char>>&&) override {}

  void setConfig(CosyvoiceConfig config) { cfg_ = std::move(config); }
  const CosyvoiceConfig& config() const { return cfg_; }

  int sampleRate() const { return sampleRate_; }

private:
  Output synthesize(const std::string& text, const ChunkCallback& onChunk);
  static void validateConfig(const CosyvoiceConfig& cfg);

  void loadLocked();
  void unloadLocked();

  CosyvoiceConfig cfg_;

  mutable std::mutex engineMu_;
  std::shared_ptr<tts_cpp::cosyvoice::Engine> engine_;

  std::atomic_bool jobInProgress_{false};
  mutable std::atomic_bool cancelRequested_{false};

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  double tokensPerSecond_ = 0.0;
  size_t textLength_ = 0;
  int sampleRate_ = 24000;

  int backendDevice_ = 0;
  int backendId_ = 0;
  bool gpuUnsupported_ = false;
  std::string backendName_ = "CPU";
};

} // namespace qvac::ttsggml::cosyvoice
