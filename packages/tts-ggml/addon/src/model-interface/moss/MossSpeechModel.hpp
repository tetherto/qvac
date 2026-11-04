#pragma once

#include <any>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "model-interface/moss/MossSpeechConfig.hpp"

namespace tts_cpp::moss {
class SpeechEngine;
struct SpeechOptions;
struct SpeechRequest;
struct SpeechResult;
} // namespace tts_cpp::moss

namespace qvac::ttsggml::moss {

inline constexpr int MOSS_SPEECH_NATIVE_SAMPLE_RATE = 24000;

class MossSpeechModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using Output = MossSpeechReply;

  struct AnyInput {
    MossSpeechCall call;
  };

  explicit MossSpeechModel(MossSpeechConfig config);
  ~MossSpeechModel() noexcept override;

  std::string getName() const override { return "MossSpeechModel"; }
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

  void reloadWith(MossSpeechConfig config);
  MossSpeechConfig config() const {
    std::lock_guard lk(engineMu_);
    return cfg_;
  }

  int sampleRate() const { return MOSS_SPEECH_NATIVE_SAMPLE_RATE; }

  static void validateConfig(const MossSpeechConfig& cfg);
  static tts_cpp::moss::SpeechOptions
  toEngineOptions(const MossSpeechConfig& cfg);
  static tts_cpp::moss::SpeechRequest
  toRequest(const MossSpeechConfig& cfg, const MossSpeechCall& call);

private:
  static const AnyInput& requireAnyInput(const std::any& input);
  void claimJob();
  std::shared_ptr<tts_cpp::moss::SpeechEngine> snapshot() const;
  void requireNotCancelled() const;
  void requireCompleted(const tts_cpp::moss::SpeechResult& result) const;
  tts_cpp::moss::SpeechResult runEngine(
      tts_cpp::moss::SpeechEngine& engine, const MossSpeechCall& call) const;
  Output respond(const MossSpeechCall& call);
  void recordStats(double seconds, const tts_cpp::moss::SpeechResult& result);

  void loadLocked();
  void unloadLocked();

  MossSpeechConfig cfg_;

  mutable std::mutex engineMu_;
  std::shared_ptr<tts_cpp::moss::SpeechEngine> engine_;

  std::atomic_bool jobInProgress_{false};
  mutable std::atomic_bool cancelRequested_{false};

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  int64_t promptTokens_ = 0;
  int64_t generatedTokens_ = 0;
  int64_t replyTokens_ = 0;
  bool truncated_ = false;
  double encodeMs_ = 0.0;
  double prefillMs_ = 0.0;
  double generateMs_ = 0.0;
  double decodeMs_ = 0.0;

  int backendDevice_ = 0;
  int backendId_ = 0;
  std::string backendName_ = "CPU";
  bool gpuUnsupported_ = false;
};

} // namespace qvac::ttsggml::moss
