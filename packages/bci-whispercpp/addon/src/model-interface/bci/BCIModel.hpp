#pragma once

#include <any>
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <whisper.h>

#include "BCIConfig.hpp"
#include "NeuralProcessor.hpp"
#include "model-interface/BCITypes.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

namespace qvac_lib_inference_addon_bci {

class BCIModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using OutputCallback = std::function<void(const Transcript&)>;
  using ValueType = float;
  using Input = std::vector<uint8_t>;
  using Output = std::vector<Transcript>;

  struct AnyInput {
    Input input;
    OutputCallback outputCallback = nullptr;
  };

  // Data passed to encoder_begin_callback so it can inject mel features.
  struct EncoderCallbackData {
    whisper_context* ctx = nullptr;
    const float* melData = nullptr;
    int melFrames = 0;
    int melBins = 0;
  };

  explicit BCIModel(BCIConfig config);
  ~BCIModel() noexcept;

  void initializeBackend() {}
  void setConfig(const BCIConfig& config);

  auto setOnSegmentCallback(const OutputCallback& callback) -> void {
    on_segment_ = callback;
  }
  auto addTranscription(const Transcript& transcript) -> void {
    output_.push_back(transcript);
  }
  auto hasSegmentCallback() const -> bool {
    return static_cast<bool>(on_segment_);
  }
  auto emitSegment(const Transcript& transcript) -> void {
    if (on_segment_) {
      on_segment_(transcript);
    }
  }

  std::string getName() const override { return "BCIModel"; }
  std::any process(const std::any& input) override;
  void cancel() const override;

  void process(const Input& input);

  void load();
  void unload();
  void unloadWeights() { unload(); }
  void reload();
  void reset();
  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(
      const std::string&,
      std::unique_ptr<std::basic_streambuf<char>>&&) override {}
  bool isLoaded() const { return is_loaded_; }
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;
  void warmup();

  void saveLoadParams(const BCIConfig& config);
  template <typename T, typename... Args>
  std::enable_if_t<!std::is_same_v<std::decay_t<T>, BCIConfig>, void>
  saveLoadParams(T&&, Args&&...) {}

  void recordSegmentStats(int nTokens) {
    totalSegments_ += 1;
    if (nTokens > 0) {
      totalTokens_ += static_cast<int64_t>(nTokens);
    }
  }

private:
  static bool configContextIsChanged(
      const BCIConfig& oldCfg, const BCIConfig& newCfg);
  void resetContext();
  void loadEmbedderIfNeeded();

  BCIConfig cfg_;
  NeuralProcessor neuralProcessor_;
  OutputCallback on_segment_;
  Output output_;

  struct WhisperContextDeleter {
    void operator()(whisper_context* ctx) const noexcept {
      if (ctx != nullptr) {
        whisper_free(ctx);
      }
    }
  };

  std::unique_ptr<whisper_context, WhisperContextDeleter> ctx_{nullptr};
  bool is_loaded_ = false;
  bool is_warmed_up_ = false;

  int64_t totalTokens_ = 0;
  int64_t totalSegments_ = 0;
  int64_t processCalls_ = 0;
  double totalWallMs_ = 0.0;

  // whisper.cpp internal stage timings aggregated across process() calls.
  double whisperSampleMs_ = 0.0;
  double whisperEncodeMs_ = 0.0;
  double whisperDecodeMs_ = 0.0;
  double whisperBatchdMs_ = 0.0;
  double whisperPromptMs_ = 0.0;

  // 30 s of silent audio reused on every process() call; whisper.cpp does
  // the actual encode via our encoder_begin_callback, but it still requires
  // a padding buffer of the right shape. Hoisted to a member so we don't
  // reallocate ~1.9 MB per call.
  std::vector<float> dummyAudioPad_;

  mutable std::atomic_bool cancelRequested_{false};
};

} // namespace qvac_lib_inference_addon_bci
