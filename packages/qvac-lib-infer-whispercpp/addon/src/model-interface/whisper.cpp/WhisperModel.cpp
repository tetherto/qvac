#include "WhisperModel.hpp"

#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <thread>

#include "WhisperConfig.hpp"
#include "WhisperHandlers.hpp"
#include "addon/WhisperErrors.hpp"
#include "model-interface/WhisperTypes.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_whisper {

struct CallbackUserData {
  WhisperModel::OutputCallback* callback;
  WhisperModel* whisper;
};

WhisperModel::WhisperModel(const WhisperConfig& config) : cfg_(config) {}

WhisperModel::~WhisperModel() { unload(); }

bool WhisperModel::isCaptionModeEnabled() const {
  auto it = cfg_.miscConfig.find("caption_enabled");
  if (it == cfg_.miscConfig.end()) {
    // Default to false if not specified
    return false;
  }
  return std::get<bool>(it->second);
}

auto WhisperModel::formatCaptionOutput(Transcript& transcript) -> void {
  transcript.text = "<|" + std::to_string(static_cast<int>(transcript.start)) +
                    "|>" + transcript.text + "<|" +
                    std::to_string(static_cast<int>(transcript.end)) + "|>";
}

void WhisperModel::load() {
  if (!ctx_) {

    whisper_context_params context_params = toWhisperContextParams(cfg_);

    auto it = cfg_.whisperContextCfg.find("model");
    if (it == cfg_.whisperContextCfg.end()) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Model path not specified in whisperContextCfg");
      throw std::runtime_error("Model path not specified in whisperContextCfg");
    }
    auto modelPath = std::get<std::string>(it->second);

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::INFO,
        "Loading Whisper model from: " + modelPath);
    ctx_.reset(
        whisper_init_from_file_with_params(modelPath.c_str(), context_params));

    if (ctx_ == nullptr) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Failed to initialize Whisper context");
      throw std::runtime_error("Failed to initialize Whisper context");
    }

    state_.reset(whisper_init_state(ctx_.get()));
    if (state_ == nullptr) {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Failed to initialize Whisper state");
      throw std::runtime_error("Failed to initialize Whisper state");
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

qvac_lib_inference_addon_cpp::RuntimeStats WhisperModel::runtimeStats() {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;

  // Keep keys stable because integration tooling reads these.
  // Times are in seconds (totalTime) or milliseconds (audioDurationMs).
  const double audioDurationSec =
      totalSamples_ > 0 ? (double)totalSamples_ / 16000.0 : 0.0;
  const int64_t audioDurationMs =
      static_cast<int64_t>(audioDurationSec * 1000.0);
  const double totalTimeSec = totalWallMs_ / 1000.0;
  const double rtf =
      audioDurationSec > 0.0 ? (totalTimeSec / audioDurationSec) : 0.0;
  const double tps =
      totalTimeSec > 0.0 ? ((double)totalTokens_ / totalTimeSec) : 0.0;

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
    whisper_context* ctx, whisper_state* state, int n_new, void* user_data) {

  auto* ud = static_cast<CallbackUserData*>(user_data);
  if (!ud || !ud->callback || !(*ud->callback)) {
    return;
  }

  int n_segments = whisper_full_n_segments_from_state(state);
  int start = n_segments - n_new;

  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "New segments detected: " + std::to_string(n_new) + " segments");

  for (int i = start; i < n_segments; i++) {
    Transcript transcript;
    transcript.text = whisper_full_get_segment_text_from_state(state, i);
    transcript.start = whisper_full_get_segment_t0_from_state(state, i) * 0.01f;
    transcript.end = whisper_full_get_segment_t1_from_state(state, i) * 0.01f;
    transcript.id = i;

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
        "Segment " + std::to_string(i) + ": [" +
            std::to_string(transcript.start) + "s - " +
            std::to_string(transcript.end) + "s] " + transcript.text);

    if (ud->whisper->isCaptionModeEnabled()) {
      ud->whisper->formatCaptionOutput(transcript);
    }

    (*ud->callback)(transcript);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    ud->whisper->addTranscription(transcript);

    // Stats: count tokens/segments as they are emitted
    const int n_tokens = whisper_full_n_tokens_from_state(state, i);
    ud->whisper->recordSegmentStats(n_tokens);
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
  // Generate 0.5s of silent audio (8000 samples at 16kHz)
  std::vector<float> silentAudio(8000, 0.0f);

  // Get minimal params for warmup (no callbacks needed)
  whisper_full_params params = toWhisperFullParams(cfg_);

  // Disable callbacks for warmup to avoid triggering output events
  params.new_segment_callback = nullptr;
  params.new_segment_callback_user_data = nullptr;

  // Run warmup inference to "heat up" the model
  whisper_full_with_state(
      ctx_.get(),
      state_.get(),
      params,
      silentAudio.data(),
      static_cast<int>(silentAudio.size()));
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
      "Model warmup completed");
}

void WhisperModel::process(const Input& input) {

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

  const auto t0 = std::chrono::steady_clock::now();

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

  CallbackUserData ud{&on_segment_, this};
  params.new_segment_callback = onNewSegment;
  params.new_segment_callback_user_data = &ud;

  int result = whisper_full_with_state(
      ctx_.get(),
      state_.get(),
      params,
      input.data(),
      static_cast<int>(input.size()));

  const auto t1 = std::chrono::steady_clock::now();
  totalWallMs_ += std::chrono::duration<double, std::milli>(t1 - t0).count();

  // Accumulate whisper internal timings for this call (they were reset at
  // start).
  if (ctx_ != nullptr) {
    if (auto* wt = whisper_get_timings(ctx_.get()); wt != nullptr) {
      whisperSampleMs_ += wt->sample_ms;
      whisperEncodeMs_ += wt->encode_ms;
      whisperDecodeMs_ += wt->decode_ms;
      whisperBatchdMs_ += wt->batchd_ms;
      whisperPromptMs_ += wt->prompt_ms;
    }
  }

  if (result != 0) {
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

// Overload with callback for ModelInterface compatibility
WhisperModel::Output WhisperModel::process(
    const Input& input, std::function<void(const Output&)> callback) {
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

bool WhisperModel::configContextIsChanged(
    const WhisperConfig& oldCfg, const WhisperConfig& newCfg) {
  // Context parameters that require reload: model, use_gpu, flash_attn,
  // gpu_device
  const std::vector<std::string> contextKeys = {
      "model", "use_gpu", "flash_attn", "gpu_device"};

  for (const auto& key : contextKeys) {
    const auto& oldIt = oldCfg.whisperContextCfg.find(key);
    const auto& newIt = newCfg.whisperContextCfg.find(key);

    if (oldIt != oldCfg.whisperContextCfg.end() &&
        newIt != newCfg.whisperContextCfg.end()) {
      if (oldIt->second != newIt->second) {
        return true;
      }
    }
    // If one exists and the other doesn't, context changed
    else if (
        (oldIt != oldCfg.whisperContextCfg.end()) !=
        (newIt != newCfg.whisperContextCfg.end())) {
      return true;
    }
  }

  return false;
}

void WhisperModel::resetContext() {
  ctx_.reset();
  state_.reset();
}

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
    if ((audioData.size() % 4) != 0) {
      throw qvac_errors::whisper_error::makeStatus(
          qvac_errors::whisper_error::Code::MisalignedBuffer,
          "f32le buffer length must be a multiple of 4");
    }
    samples.reserve(audioData.size() / 4);

    for (size_t i = 0; i < audioData.size(); i += 4) {
      uint32_t bits = (uint32_t)audioData[i] |
                      ((uint32_t)audioData[i + 1] << 8) |
                      ((uint32_t)audioData[i + 2] << 16) |
                      ((uint32_t)audioData[i + 3] << 24);
      float sample = *reinterpret_cast<float*>(&bits);
      if (!std::isfinite(sample)) {
        throw qvac_errors::whisper_error::makeStatus(
            qvac_errors::whisper_error::Code::NonFiniteSample,
            "Encountered non-finite f32 sample");
      }
      samples.push_back(sample);
    }
  } else if (audioFormat == "s16le") {
    if ((audioData.size() % 2) != 0) {
      throw qvac_errors::whisper_error::makeStatus(
          qvac_errors::whisper_error::Code::MisalignedBuffer,
          "s16le buffer length must be a multiple of 2");
    }
    samples.reserve(audioData.size() / 2);

    for (size_t i = 0; i < audioData.size(); i += 2) {
      int16_t sample = (int16_t)(audioData[i] | (audioData[i + 1] << 8));
      samples.push_back(sample / 32768.0f);
    }
  } else {
    throw qvac_errors::whisper_error::makeStatus(
        qvac_errors::whisper_error::Code::UnsupportedAudioFormat,
        std::string("Unsupported audio_format: ") + audioFormat);
  }

  return samples;
}

} // namespace qvac_lib_inference_addon_whisper
