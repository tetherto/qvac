#include "WhisperModel.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <ranges>
#include <thread>
#include <utility>

#include "WhisperConfig.hpp"
#include "WhisperHandlers.hpp"
#include "addon/WhisperErrors.hpp"
#include "model-interface/WhisperTypes.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_whisper {

namespace {
constexpr double K_SAMPLES_PER_SECOND = 16000.0;
constexpr float K_SEGMENT_TIMESTAMP_SCALE = 0.01F;
constexpr int K_WARMUP_SAMPLE_COUNT = 8000;
constexpr std::size_t K_F32_SAMPLE_BYTES = 4;
constexpr std::size_t K_S16_SAMPLE_BYTES = 2;
constexpr unsigned int K_BYTE_SHIFT_8 = 8U;
constexpr unsigned int K_BYTE_SHIFT_16 = 16U;
constexpr unsigned int K_BYTE_SHIFT_24 = 24U;
constexpr float K_S16_NORMALIZATION_DIVISOR = 32768.0F;
} // namespace

static bool shouldAbortWhisper(void* userData) {
  const auto* cancelRequested = static_cast<const std::atomic_bool*>(userData);
  return cancelRequested != nullptr &&
         cancelRequested->load(std::memory_order_relaxed);
}

WhisperModel::WhisperModel(WhisperConfig config) : cfg_(std::move(config)) {}

WhisperModel::~WhisperModel() noexcept {
  try {
    unload();
  } catch (...) {
    is_loaded_ = false;
  }
}

bool WhisperModel::isCaptionModeEnabled() const {
  const auto miscConfigIt = cfg_.miscConfig.find("caption_enabled");
  if (miscConfigIt == cfg_.miscConfig.end()) {
    // Default to false if not specified
    return false;
  }
  return std::get<bool>(miscConfigIt->second);
}

auto WhisperModel::formatCaptionOutput(Transcript& transcript) -> void {
  transcript.text = "<|" + std::to_string(static_cast<int>(transcript.start)) +
                    "|>" + transcript.text + "<|" +
                    std::to_string(static_cast<int>(transcript.end)) + "|>";
}

void WhisperModel::load() {
  if (!ctx_) {

    whisper_context_params contextParams = toWhisperContextParams(cfg_);

    const auto modelPathIt = cfg_.whisperContextCfg.find("model");
    if (modelPathIt == cfg_.whisperContextCfg.end()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Model path not specified in whisperContextCfg");
      throw std::runtime_error("Model path not specified in whisperContextCfg");
    }
    const auto modelPath = std::get<std::string>(modelPathIt->second);

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "Loading Whisper model from: " + modelPath);
    ctx_.reset(
        whisper_init_from_file_with_params(modelPath.c_str(), contextParams));

    if (ctx_ == nullptr) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Failed to initialize Whisper context");
      throw std::runtime_error("Failed to initialize Whisper context");
    }

    is_loaded_ = true;
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "Whisper model loaded successfully");

    // Warm up the model on first load to avoid first-segment delay
    if (!is_warmed_up_) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "Warming up Whisper model");
      warmup();
      is_warmed_up_ = true;
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::INFO,
          "Whisper model warmup completed");
    }
  }
}

void WhisperModel::unload() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Unloading Whisper model");
  resetContext();
  is_loaded_ = false;
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Whisper model unloaded successfully");
}

void WhisperModel::reload() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Reloading Whisper model");
  unload();
  load();
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      "Whisper model reloaded successfully");
}

void WhisperModel::reset() {
  output_.clear();
  stream_ended_ = false;
  totalSamples_ = 0;
  totalTokens_ = 0;
  totalSegments_ = 0;
  processCalls_ = 0;
  totalWallMs_ = 0.0;
  whisperSampleMs_ = 0.0;
  whisperEncodeMs_ = 0.0;
  whisperDecodeMs_ = 0.0;
  whisperBatchdMs_ = 0.0;
  whisperPromptMs_ = 0.0;
}

void WhisperModel::endOfStream() {
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "End of stream signal received");
  stream_ended_ = true;
}

qvac_lib_inference_addon_cpp::RuntimeStats WhisperModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;

  // Keep keys stable because integration tooling reads these.
  // Times are in seconds (totalTime) or milliseconds (audioDurationMs).
  const double audioDurationSec =
      totalSamples_ > 0
          ? static_cast<double>(totalSamples_) / K_SAMPLES_PER_SECOND
          : 0.0;
  const auto audioDurationMs = static_cast<int64_t>(audioDurationSec * 1000.0);
  const double totalTimeSec = totalWallMs_ / 1000.0;
  const double rtf =
      audioDurationSec > 0.0 ? (totalTimeSec / audioDurationSec) : 0.0;
  const double tps = totalTimeSec > 0.0
                         ? (static_cast<double>(totalTokens_) / totalTimeSec)
                         : 0.0;

  stats.emplace_back("totalTime", totalTimeSec);
  stats.emplace_back("realTimeFactor", rtf);
  stats.emplace_back("tokensPerSecond", tps);
  stats.emplace_back("audioDurationMs", audioDurationMs);
  stats.emplace_back("totalSamples", totalSamples_);

  // Additional useful counters
  stats.emplace_back("totalTokens", totalTokens_);
  stats.emplace_back("totalSegments", totalSegments_);
  stats.emplace_back("processCalls", processCalls_);

  // Whisper internal timings (ms) accumulated across process() calls
  stats.emplace_back("whisperSampleMs", whisperSampleMs_);
  stats.emplace_back("whisperEncodeMs", whisperEncodeMs_);
  stats.emplace_back("whisperDecodeMs", whisperDecodeMs_);
  stats.emplace_back("whisperBatchdMs", whisperBatchdMs_);
  stats.emplace_back("whisperPromptMs", whisperPromptMs_);
  stats.emplace_back("totalWallMs", totalWallMs_);
  return stats;
}

static void onNewSegment(
    [[maybe_unused]] whisper_context* ctx, whisper_state* state, int nNew,
    void* userData) {

  auto* whisper = static_cast<WhisperModel*>(userData);
  if (whisper == nullptr || state == nullptr) {
    return;
  }

  const int nSegments = whisper_full_n_segments_from_state(state);
  if (nNew <= 0 || nSegments <= 0) {
    return;
  }
  const int startIndex = std::max(0, nSegments - nNew);

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "New segments detected: " + std::to_string(nNew) + " segments");

  for (int i = startIndex; i < nSegments; i++) {
    Transcript transcript;
    const char* text = whisper_full_get_segment_text_from_state(state, i);
    transcript.text = text != nullptr ? text : "";
    transcript.start =
        static_cast<float>(whisper_full_get_segment_t0_from_state(state, i)) *
        K_SEGMENT_TIMESTAMP_SCALE;
    transcript.end =
        static_cast<float>(whisper_full_get_segment_t1_from_state(state, i)) *
        K_SEGMENT_TIMESTAMP_SCALE;
    transcript.id = i;

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "Segment " + std::to_string(i) + ": [" +
            std::to_string(transcript.start) + "s - " +
            std::to_string(transcript.end) + "s] " + transcript.text);

    if (whisper->isCaptionModeEnabled()) {
      WhisperModel::formatCaptionOutput(transcript);
    }

    whisper->emitSegment(transcript);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    whisper->addTranscription(transcript);

    // Stats: count tokens/segments as they are emitted
    const int nTokens = whisper_full_n_tokens_from_state(state, i);
    whisper->recordSegmentStats(nTokens);
  }
}

void WhisperModel::warmup() {
  if (!ctx_) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "Cannot warmup - context not initialized");
    return;
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Starting model warmup");
  // Generate 0.5s of silent audio at 16kHz.
  std::vector<float> silentAudio(K_WARMUP_SAMPLE_COUNT, 0.0F);

  // Get minimal params for warmup (no callbacks needed)
  whisper_full_params params = toWhisperFullParams(cfg_);

  // Disable callbacks for warmup to avoid triggering output events
  params.new_segment_callback = nullptr;
  params.new_segment_callback_user_data = nullptr;

  // Run warmup inference to "heat up" the model
  whisper_full(
      ctx_.get(),
      params,
      silentAudio.data(),
      static_cast<int>(silentAudio.size()));
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Model warmup completed");
}

void WhisperModel::process(const Input& input) {

  if (ctx_ == nullptr) {
    load();
  }
  if (ctx_ == nullptr) {
    throw std::runtime_error("Whisper context is not initialized");
  }

  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw std::runtime_error("Job cancelled");
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Processing audio input with " + std::to_string(input.size()) +
          " samples");

  processCalls_ += 1;
  totalSamples_ += static_cast<int64_t>(input.size());

  // Reset internal timings/state before processing to avoid memory issues
  if (ctx_ != nullptr) {
    whisper_reset_timings(ctx_.get());
  }

  const auto startTime = std::chrono::steady_clock::now();

  whisper_full_params params{};
  try {
    params = toWhisperFullParams(cfg_);
  } catch (const std::exception& e) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "Error in full handler: " + std::string(e.what()));
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string("error in full handler: ") + std::string(e.what()));
  }

  params.new_segment_callback = onNewSegment;
  params.new_segment_callback_user_data = this;
  params.abort_callback = shouldAbortWhisper;
  params.abort_callback_user_data = &cancelRequested_;

  int result = whisper_full(
      ctx_.get(), params, input.data(), static_cast<int>(input.size()));

  const auto endTime = std::chrono::steady_clock::now();
  totalWallMs_ +=
      std::chrono::duration<double, std::milli>(endTime - startTime).count();

  // Accumulate whisper internal timings for this call (they were reset at
  // start).
  if (ctx_ != nullptr) {
    if (auto* whisperTimings = whisper_get_timings(ctx_.get());
        whisperTimings != nullptr) {
      whisperSampleMs_ += whisperTimings->sample_ms;
      whisperEncodeMs_ += whisperTimings->encode_ms;
      whisperDecodeMs_ += whisperTimings->decode_ms;
      whisperBatchdMs_ += whisperTimings->batchd_ms;
      whisperPromptMs_ += whisperTimings->prompt_ms;
    }
  }

  if (result != 0) {
    if (cancelRequested_.load(std::memory_order_relaxed)) {
      throw std::runtime_error("Job cancelled");
    }
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
        "whisper_full_with_state failed with code: " + std::to_string(result));
    throw std::runtime_error(
        "Failed to process audio (whisper_full_with_state returned " +
        std::to_string(result) + ")");
  }

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Audio processing completed");
}

std::any WhisperModel::process(const std::any& input) {
  AnyInput modelInput;
  if (const auto* anyInput = std::any_cast<AnyInput>(&input)) {
    modelInput = *anyInput;
  } else if (const auto* inputVector = std::any_cast<Input>(&input)) {
    modelInput.input = *inputVector;
  } else {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string("Invalid input type for WhisperModel::process: ") +
            input.type().name());
  }

  const auto previousOutputCallback = on_segment_;
  const bool shouldOverrideCallback =
      static_cast<bool>(modelInput.outputCallback);
  if (shouldOverrideCallback) {
    on_segment_ = modelInput.outputCallback;
  }

  reset();
  cancelRequested_.store(false, std::memory_order_relaxed);
  try {
    process(modelInput.input);
  } catch (...) {
    if (shouldOverrideCallback) {
      on_segment_ = previousOutputCallback;
    }
    throw;
  }

  if (shouldOverrideCallback) {
    on_segment_ = previousOutputCallback;
  }

  return output_;
}

// Overload with callback for ModelInterface compatibility
WhisperModel::Output WhisperModel::process(
    const Input& input, const std::function<void(const Output&)>& callback) {
  // For testing/compatibility, return empty results
  // Real implementation delegates to WhisperModel's streaming process
  if (!is_loaded_ || input.empty()) {
    return Output{};
  }

  // Call original WhisperModel process (void return)
  process(input);

  // Return empty for now - WhisperModel uses callback-based output
  Output result{};
  if (callback) {
    callback(result);
  }
  return result;
}

void WhisperModel::saveLoadParams(const WhisperConfig& config) {
  // Call setConfig to ensure proper config handling
  setConfig(config);
}

void WhisperModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
}

bool WhisperModel::configContextIsChanged(
    const WhisperConfig& oldCfg, const WhisperConfig& newCfg) {
  // Context parameters that require reload: model, use_gpu, flash_attn,
  // gpu_device
  const std::vector<std::string> contextKeys = {
      "model", "use_gpu", "flash_attn", "gpu_device"};

  return std::ranges::any_of(contextKeys, [&](const std::string& key) {
    const auto oldIt = oldCfg.whisperContextCfg.find(key);
    const auto newIt = newCfg.whisperContextCfg.find(key);

    if (oldIt != oldCfg.whisperContextCfg.end() &&
        newIt != newCfg.whisperContextCfg.end()) {
      return oldIt->second != newIt->second;
    }

    // If one exists and the other doesn't, context changed.
    return (oldIt != oldCfg.whisperContextCfg.end()) !=
           (newIt != newCfg.whisperContextCfg.end());
  });
}

void WhisperModel::resetContext() { ctx_.reset(); }

void WhisperModel::setConfig(const WhisperConfig& config) {
  bool contextChanged = configContextIsChanged(cfg_, config);
  cfg_ = config;

  if (contextChanged) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "Context parameters changed, triggering model reload");
    reload();
  } else {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "Configuration updated without context changes");
  }
}

std::vector<float> WhisperModel::preprocessAudioData(
    const std::vector<uint8_t>& audioData, const std::string& audioFormat) {
  std::vector<float> samples;
  if (audioData.empty()) {
    return samples;
  }

  if (audioFormat == "f32le" || audioFormat == "decoded") {
    if ((audioData.size() % K_F32_SAMPLE_BYTES) != 0) {
      throw qvac_errors::whisper_error::makeStatus(
          qvac_errors::whisper_error::Code::MisalignedBuffer,
          "f32le buffer length must be a multiple of 4");
    }
    samples.reserve(audioData.size() / K_F32_SAMPLE_BYTES);

    for (std::size_t i = 0; i < audioData.size(); i += K_F32_SAMPLE_BYTES) {
      const auto bits =
          static_cast<uint32_t>(audioData.at(i)) |
          (static_cast<uint32_t>(audioData.at(i + 1)) << K_BYTE_SHIFT_8) |
          (static_cast<uint32_t>(audioData.at(i + 2)) << K_BYTE_SHIFT_16) |
          (static_cast<uint32_t>(audioData.at(i + 3)) << K_BYTE_SHIFT_24);
      float sample = 0.0F;
      std::memcpy(&sample, &bits, sizeof(sample));
      if (!std::isfinite(sample)) {
        throw qvac_errors::whisper_error::makeStatus(
            qvac_errors::whisper_error::Code::NonFiniteSample,
            "Encountered non-finite f32 sample");
      }
      samples.push_back(sample);
    }
  } else if (audioFormat == "s16le") {
    if ((audioData.size() % K_S16_SAMPLE_BYTES) != 0) {
      throw qvac_errors::whisper_error::makeStatus(
          qvac_errors::whisper_error::Code::MisalignedBuffer,
          "s16le buffer length must be a multiple of 2");
    }
    samples.reserve(audioData.size() / K_S16_SAMPLE_BYTES);

    for (std::size_t i = 0; i < audioData.size(); i += K_S16_SAMPLE_BYTES) {
      const auto lowByte = static_cast<uint16_t>(audioData.at(i));
      const auto highByte = static_cast<uint16_t>(audioData.at(i + 1));
      const auto bits = static_cast<uint16_t>(
          lowByte | static_cast<uint16_t>(highByte << K_BYTE_SHIFT_8));
      const auto sample = static_cast<int16_t>(bits);
      samples.push_back(
          static_cast<float>(sample) / K_S16_NORMALIZATION_DIVISOR);
    }
  } else {
    throw qvac_errors::whisper_error::makeStatus(
        qvac_errors::whisper_error::Code::UnsupportedAudioFormat,
        std::string("Unsupported audio_format: ") + audioFormat);
  }

  return samples;
}

} // namespace qvac_lib_inference_addon_whisper
