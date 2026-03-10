#pragma once

#include <any>
#include <atomic>
#include <functional>
#include <list>
#include <memory>
#include <span>
#include <streambuf>
#include <string>
#include <type_traits>
#include <vector>

#include <whisper.h>

#include "WhisperConfig.hpp"
#include "model-interface/WhisperTypes.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

namespace qvac_lib_inference_addon_whisper {

class WhisperModel
    : public qvac_lib_inference_addon_cpp::model::IModel,
      public qvac_lib_inference_addon_cpp::model::IModelCancel,
      public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad {
public:
  using OutputCallback = std::function<void(const Transcript&)>;
  using ValueType = float;
  using Input = std::vector<ValueType>;
  using InputView = std::span<const ValueType>;
  using Output = std::vector<Transcript>;
  struct AnyInput {
    Input input;
    OutputCallback outputCallback = nullptr;
  };

  explicit WhisperModel(WhisperConfig config);
  ~WhisperModel() noexcept;

  // ModelApiTest required methods
  void initializeBackend() {
    // No-op - WhisperModel handles initialization in constructor/load
  }
  // set config from WhisperConfig
  void setConfig(const WhisperConfig& config);

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

  static auto formatCaptionOutput(Transcript& transcript) -> void;

  // Process methods
  std::string getName() const override { return "WhisperModel"; }
  std::any process(const std::any& input) override;
  void cancel() const override;

  void process(const Input& input);
  Output process(
      const Input& input, const std::function<void(const Output&)>& callback);

  void load();
  void unload();
  void unloadWeights() {
    // For WhisperModel, unloading weights is same as unloading model
    unload();
  }
  void reload();
  void reset();
  void endOfStream();
  void waitForLoadInitialization() override { load(); }
  void setWeightsForFile(
      const std::string& /*filename*/,
      std::unique_ptr<std::basic_streambuf<char>>&& /*streambuf*/) override {}
  void set_weights_for_file(
      const std::string& /*filename*/,
      const std::span<const uint8_t>& /*contents*/, bool /*completed*/) {}
  bool isStreamEnded() const { return stream_ended_; }
  bool isLoaded() const { return is_loaded_; }
  bool isCaptionModeEnabled() const;
  qvac_lib_inference_addon_cpp::RuntimeStats runtimeStats() const override;
  void warmup();
  void recordSegmentStats(int nTokens) {
    totalSegments_ += 1;
    if (nTokens > 0) {
      totalTokens_ += static_cast<int64_t>(nTokens);
    }
  }

  static std::vector<float> preprocessAudioData(
      const std::vector<uint8_t>& audioData,
      const std::string& audioFormat = "s16le");

  // saveLoadParams for WhisperConfig - used by Addon::reload
  void saveLoadParams(const WhisperConfig& config); // Implement in .cpp

  // saveLoadParams fallback for other types (no-op) - placed after to ensure
  // WhisperConfig version is preferred
  template <typename T, typename... Args>
  typename std::enable_if<
      !std::is_same<typename std::decay<T>::type, WhisperConfig>::value,
      void>::type
  saveLoadParams(T&&, Args&&...) {}

private:
  static constexpr size_t MAX_CONTEXT_TOKENS = 256;
  // Helper to check if context parameters changed
  static bool configContextIsChanged(
      const WhisperConfig& oldCfg, const WhisperConfig& newCfg);
  void resetContext();

  WhisperConfig cfg_;
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
  bool stream_ended_ = false;
  bool is_loaded_ = false;
  bool is_warmed_up_ = false;

  // Runtime stats accumulated over a job (reset() clears these).
  int64_t totalSamples_ = 0;
  int64_t totalTokens_ = 0;
  int64_t totalSegments_ = 0;
  int64_t processCalls_ = 0;
  double totalWallMs_ = 0.0;
  double whisperSampleMs_ = 0.0;
  double whisperEncodeMs_ = 0.0;
  double whisperDecodeMs_ = 0.0;
  double whisperBatchdMs_ = 0.0;
  double whisperPromptMs_ = 0.0;
  mutable std::atomic_bool cancelRequested_{false};
};

} // namespace qvac_lib_inference_addon_whisper