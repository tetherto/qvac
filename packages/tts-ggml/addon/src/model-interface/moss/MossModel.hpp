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
#include "model-interface/moss/MossConfig.hpp"

namespace tts_cpp::moss {
class Engine;
struct EngineOptions;
struct SynthesisResult;
} // namespace tts_cpp::moss

namespace qvac::ttsggml::moss {

inline constexpr int MOSS_NATIVE_SAMPLE_RATE = 24000;
inline constexpr int MOSS_SAMPLES_PER_FRAME = 1920;
inline constexpr int MOSS_MAX_NEW_TOKENS = 2048;
inline constexpr int MOSS_MAX_CHANNELS = 32;
inline constexpr int MOSS_TERMINATION_ROWS = 2;
inline constexpr int MOSS_MAX_DURATION_TOKENS =
    MOSS_MAX_NEW_TOKENS - (MOSS_MAX_CHANNELS - 1) - MOSS_TERMINATION_ROWS;

class MossModel : public qvac_lib_inference_addon_cpp::model::IModel,
                  public qvac_lib_inference_addon_cpp::model::IModelCancel,
                  public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using Input = std::string;
  using Output = std::vector<int16_t>;

  using ChunkCallback = std::function<void(
      std::vector<int16_t>&& pcm, int chunkIndex, bool isLast)>;

  struct AnyInput {
    std::string text;
    ChunkCallback chunkCallback;
  };

  explicit MossModel(MossConfig config);
  ~MossModel() noexcept override;

  std::string getName() const override { return "MossModel"; }
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

  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(
      const std::string&,
      std::unique_ptr<std::basic_streambuf<char>>&&) override {}

  void setConfig(MossConfig config);
  void reloadWith(MossConfig config);
  MossConfig config() const {
    std::lock_guard lk(engineMu_);
    return cfg_;
  }

  int sampleRate() const { return MOSS_NATIVE_SAMPLE_RATE; }

  static void validateConfig(const MossConfig& cfg);
  static tts_cpp::moss::EngineOptions toEngineOptions(const MossConfig& cfg);
  static int decodedFrames(int64_t samples);

private:
  struct SynthResult {
    Output pcm;
    bool wasStreaming = false;
  };

  struct EngineSnapshot {
    std::shared_ptr<tts_cpp::moss::Engine> engine;
    MossConfig cfg;
  };

  struct StreamProgress {
    int64_t samples = 0;
    int chunks = 0;
  };

  static const AnyInput& requireAnyInput(const std::any& input);
  void claimJob();
  EngineSnapshot snapshot() const;
  void requireNotCancelled() const;
  void requireCompleted(const tts_cpp::moss::SynthesisResult& result) const;
  tts_cpp::moss::SynthesisResult streamChunks(
      tts_cpp::moss::Engine& engine, const AnyInput& input,
      StreamProgress& progress) const;
  tts_cpp::moss::SynthesisResult runEngine(
      tts_cpp::moss::Engine& engine, const AnyInput& input, bool streaming,
      StreamProgress& progress) const;
  SynthResult synthesize(const AnyInput& input);
  void recordStats(double seconds, int64_t samples);

  void loadLocked();
  void unloadLocked();

  MossConfig cfg_;

  mutable std::mutex engineMu_;
  std::shared_ptr<tts_cpp::moss::Engine> engine_;

  std::atomic_bool jobInProgress_{false};
  mutable std::atomic_bool cancelRequested_{false};

  double totalTime_ = 0.0;
  double audioDurationMs_ = 0.0;
  int64_t totalSamples_ = 0;
  double realTimeFactor_ = 0.0;
  double tokensPerSecond_ = 0.0;
  int generatedFrames_ = 0;

  int backendDevice_ = 0;
  int backendId_ = 0;
  std::string backendName_ = "CPU";
  bool gpuUnsupported_ = false;
};

} // namespace qvac::ttsggml::moss
