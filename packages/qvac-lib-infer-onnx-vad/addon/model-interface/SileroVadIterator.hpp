#pragma once

#include "onnxruntime/onnxruntime_cxx_api.h"

#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"

#include <span>
#include <vector>
#include <string>
#include <limits>
#include <functional>
#include <array>
#include <sstream>
#include <iomanip>

namespace qvac_lib_inference_addon_onnx_silerovad {

struct Timestamp {
  int start;
  int end;

  explicit Timestamp(int start = -1, int end = -1);
  Timestamp(const Timestamp &) = default;
  Timestamp(Timestamp&&) = default;
  auto operator=(const Timestamp &a) -> Timestamp& = default;
  auto operator=(Timestamp&&) -> Timestamp& = default;
  ~Timestamp() = default;

  auto operator==(const Timestamp &a) const -> bool;
  [[nodiscard]] auto c_str() const -> std::string;
};

struct VadIteratorOutput {
public:
  VadIteratorOutput() = default;

  VadIteratorOutput(size_t input_samples, std::vector<Timestamp> speeches)
    : input_samples_(input_samples)
    , speeches_(std::move(speeches)) {
    for (const auto& timestamp : speeches_) {
      const auto validSamples = static_cast<size_t>(static_cast<long long>(timestamp.end)
                                                    - static_cast<long long>(timestamp.start)
                                                    + 1LL);
      nb_valid_samples_ += validSamples;
      maximum_valid_samples_streak_ = (std::max)(maximum_valid_samples_streak_, validSamples);
    }
  }

  ///
  /// \brief Gets a const ref to the speeches of the VAD operation to the caller
  /// @return The processed input
  ///
  [[nodiscard]] auto getSpeeches() const -> const std::vector<Timestamp>& { return speeches_; }

  ///
  /// \brief Moves the speeches of the VAD operation to the caller
  /// @return The processed input
  ///
  [[nodiscard]] auto consumeSpeeches() -> std::vector<Timestamp> { return std::move(speeches_); }

private:
  size_t input_samples_ = 0;
  size_t nb_valid_samples_ = 0;
  size_t maximum_valid_samples_streak_ = 0;

  std::vector<Timestamp> speeches_;
};

struct VadConfig {
  static constexpr int kDefaultSampleRate_ = 16000;
  static constexpr int kDefaultWindowFrameSize_ = 64;
  static constexpr float kDefaultThreshold_ = 0.5F;
  static constexpr int kDefaultMinSilenceDurationMs_ = 0;
  static constexpr int kDefaultSpeechPadMs_ = 64;
  static constexpr int kDefaultMinSpeechDurationMs_ = 64;

  int sampleRate = kDefaultSampleRate_;
  int windowFrameSize = kDefaultWindowFrameSize_;
  float threshold = kDefaultThreshold_;
  int minSilenceDurationMs = kDefaultMinSilenceDurationMs_;
  int speechPadMs = kDefaultSpeechPadMs_;
  int minSpeechDurationMs = kDefaultMinSpeechDurationMs_;
  float maxSpeechDurationS = std::numeric_limits<float>::infinity();
};

class VadIterator {
public:
  using ValueType = float;
  using Input = std::vector<ValueType>;
  using InputView = std::span<const ValueType>;
  using Output = std::vector<ValueType>;

  // Defaults for constructor parameters (avoid magic numbers)
  static constexpr int defaultSampleRate_ = 16000;
  static constexpr int defaultWindowFrameSize_ = 64;
  static constexpr float defaultThreshold_ = 0.5F;
  static constexpr int defaultMinSilenceDurationMs_ = 0;
  static constexpr int defaultSpeechPadMs_ = 64;
  static constexpr int defaultMinSpeechDurationMs_ = 64;

  explicit VadIterator(const std::string &model_path, VadConfig cfg = {});

  ///
  /// \brief Apply the VAD by modifying `input_wav` in-place
  /// @param[in] input A vector of floats (PCM32 values) on which to apply the VAD
  ///
  void process(Input& input_wav);

  void reset();
  [[nodiscard]] auto runtimeStats() const -> qvac_lib_inference_addon_cpp::RuntimeStats;

  // Transcription addon specific
  float start_ = 0.0F;
  float end_ = -1.0F;
  float prev_end_ = -1.0F;
  float first_speech_ts_ = -1.0F;
  float last_silence_start_ts_ = -1.0F;
  float last_silence_end_ts_ = -1.0F;
  void init_onnx_model(const std::string &model_path);

  void resetStates();
  void predict(std::span<ValueType> data);
  // Extracted helpers to simplify predict()
  void handleAboveThreshold(float speechProb);
  void handleExceededMaxSpeech();
  void handleNearThreshold(float speechProb);
  void handleBelowThreshold(float speechProb);
  void zeroOutSilences(Input& input_wav) const;
  // ONNXRuntime resources
  Ort::Env env;
  Ort::SessionOptions session_options;
  std::shared_ptr<Ort::Session> session = nullptr;
  Ort::AllocatorWithDefaultOptions allocator;
  Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeCPU);

  // model config
  unsigned int window_size_samples{0}; // Assign when init, support 256 512 768 for 8k; 512 1024 1536 for 16k.
  int sample_rate{0};             // Assign when init support 16000 or 8000
  unsigned int sr_per_ms{0};               // Assign when init, support 8 or 16
  float threshold{0.0F};
  unsigned int min_silence_samples{0};               // sr_per_ms * #ms
  unsigned int min_silence_samples_at_max_speech{0}; // sr_per_ms * #98
  int min_speech_samples{0};                // sr_per_ms * #ms
  float max_speech_samples{0.0F};
  int speech_pad_samples{0}; // usually a
  int audio_length_samples = 0;

  double totalInputLengthMs = 0.0;
  double totalProcessingTimeMs = 0.0;

  // model states
  bool triggered = false;
  unsigned int temp_end = 0;
  unsigned int current_sample = 0;
  // MAX 4294967295 samples / 8sample per ms / 1000 / 60 = 8947 minutes
  int prev_end = 0;
  int next_start = 0;

  // Output timestamp
  std::vector<Timestamp> speeches;
  Timestamp current_speech;

  // Onnx model
  // Inputs
  std::vector<Ort::Value> ort_inputs;

  std::vector<const char *> input_node_names = {"input", "sr", "h", "c"};
  std::vector<int64_t> sr;
  static constexpr unsigned int hcLayers_ = 2U;
  static constexpr unsigned int hcBatch_ = 1U;
  static constexpr unsigned int hcWidth_ = 64U;
  static constexpr unsigned int size_hc_ = hcLayers_ * hcBatch_ * hcWidth_; // It's FIXED.
  std::vector<float> _h;
  std::vector<float> _c;

  std::array<int64_t, 2> input_node_dims{ };
  std::array<int64_t, 1> sr_node_dims{1};
  std::array<int64_t, 3> hc_node_dims{static_cast<int64_t>(hcLayers_), static_cast<int64_t>(hcBatch_), static_cast<int64_t>(hcWidth_)};

  // Outputs
  std::vector<Ort::Value> ort_outputs;
  std::vector<const char *> output_node_names = {"output", "hn", "cn"};
};

} // namespace qvac_lib_inference_addon_onnx_silerovad
