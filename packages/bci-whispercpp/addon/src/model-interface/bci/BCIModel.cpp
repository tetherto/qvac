#include "BCIModel.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <ranges>
#include <utility>

#include "BCIConfig.hpp"
#include "addon/BCIErrors.hpp"
#include "model-interface/BCITypes.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"

namespace qvac_lib_inference_addon_bci {

namespace {
constexpr float K_SEGMENT_TIMESTAMP_SCALE = 0.01F;
constexpr int K_WARMUP_SAMPLE_COUNT = 8000;
constexpr int K_DUMMY_AUDIO_30S = 16000 * 30;
} // namespace

static bool shouldAbortWhisper(void* userData) {
  const auto* cancelRequested = static_cast<const std::atomic_bool*>(userData);
  return cancelRequested != nullptr &&
         cancelRequested->load(std::memory_order_relaxed);
}

// Called right before the encoder runs. Replaces the mel spectrogram
// (computed from dummy silence) with our neural-signal-derived features.
static bool onEncoderBegin(
    whisper_context* ctx, whisper_state* state, void* userData) {
  auto* cbData = static_cast<BCIModel::EncoderCallbackData*>(userData);
  if (cbData == nullptr || cbData->melData == nullptr) {
    return true;
  }

  int result = whisper_set_mel_with_state(
      cbData->ctx, state,
      cbData->melData, cbData->melFrames, cbData->melBins);

  if (result != 0) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
         "whisper_set_mel_with_state failed: " + std::to_string(result));
    return false;
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Injected neural mel features: " +
           std::to_string(cbData->melFrames) + " frames x " +
           std::to_string(cbData->melBins) + " bins");
  return true;
}

BCIModel::BCIModel(BCIConfig config)
    : cfg_(std::move(config)), neuralProcessor_() {}

BCIModel::~BCIModel() noexcept {
  try {
    unload();
  } catch (...) {
    is_loaded_ = false;
  }
}

void BCIModel::loadEmbedderIfNeeded() {
  if (neuralProcessor_.hasWeights()) {
    return;
  }

  // Look for embedder weights next to the model file
  auto modelPathIt = cfg_.whisperContextCfg.find("model");
  if (modelPathIt == cfg_.whisperContextCfg.end()) {
    return;
  }
  const auto modelPath = std::get<std::string>(modelPathIt->second);

  auto lastSep = modelPath.find_last_of("/\\");
  auto dir = (lastSep != std::string::npos)
                 ? modelPath.substr(0, lastSep)
                 : ".";
  auto embedderPath = dir + "/bci-embedder.bin";

  if (neuralProcessor_.loadEmbedderWeights(embedderPath)) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
         "Loaded BCI embedder weights from: " + embedderPath);
  } else {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::EmbedderWeightsNotFound,
        "BCI embedder weights not found at: " + embedderPath +
        ". This file is required for neural signal preprocessing. "
        "Generate it with: python3 scripts/convert-model.py --checkpoint <ckpt>");
  }
}

void BCIModel::load() {
  if (ctx_) return;

  whisper_context_params contextParams = toWhisperContextParams(cfg_);

  const auto modelPathIt = cfg_.whisperContextCfg.find("model");
  if (modelPathIt == cfg_.whisperContextCfg.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Model path not specified in contextParams");
  }
  const auto modelPath = std::get<std::string>(modelPathIt->second);

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
       "Loading BCI model from: " + modelPath);

  auto* rawCtx = whisper_init_from_file_with_params(modelPath.c_str(), contextParams);
  if (rawCtx == nullptr) {
    throw qvac_errors::bci_error::makeStatus(
        qvac_errors::bci_error::Code::FailedToLoadModel,
        "Failed to initialize Whisper context from: " + modelPath);
  }

  try {
    ctx_.reset(rawCtx);
    loadEmbedderIfNeeded();
    if (!is_warmed_up_) {
      warmup();
      is_warmed_up_ = true;
    }
    is_loaded_ = true;
  } catch (...) {
    ctx_.reset();
    is_loaded_ = false;
    throw;
  }
}

void BCIModel::unload() {
  resetContext();
  is_loaded_ = false;
  is_warmed_up_ = false;
}

void BCIModel::reload() {
  unload();
  load();
}

void BCIModel::reset() {
  output_.clear();
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

qvac_lib_inference_addon_cpp::RuntimeStats BCIModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;

  const double totalTimeSec = totalWallMs_ / 1000.0;
  const double tps = totalTimeSec > 0.0
                         ? (static_cast<double>(totalTokens_) / totalTimeSec)
                         : 0.0;

  stats.emplace_back("totalTime", totalTimeSec);
  stats.emplace_back("tokensPerSecond", tps);
  stats.emplace_back("totalTokens", totalTokens_);
  stats.emplace_back("totalSegments", totalSegments_);
  stats.emplace_back("processCalls", processCalls_);
  stats.emplace_back("totalWallMs", totalWallMs_);
  stats.emplace_back("whisperSampleMs", whisperSampleMs_);
  stats.emplace_back("whisperEncodeMs", whisperEncodeMs_);
  stats.emplace_back("whisperDecodeMs", whisperDecodeMs_);
  stats.emplace_back("whisperBatchdMs", whisperBatchdMs_);
  stats.emplace_back("whisperPromptMs", whisperPromptMs_);
  return stats;
}

static void onNewSegment(
    [[maybe_unused]] whisper_context* ctx, whisper_state* state, int nNew,
    void* userData) {
  auto* bci = static_cast<BCIModel*>(userData);
  if (bci == nullptr || state == nullptr) return;

  const int nSegments = whisper_full_n_segments_from_state(state);
  if (nNew <= 0 || nSegments <= 0) return;
  const int startIndex = std::max(0, nSegments - nNew);

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

    bci->emitSegment(transcript);
    bci->addTranscription(transcript);

    const int nTokens = whisper_full_n_tokens_from_state(state, i);
    bci->recordSegmentStats(nTokens);
  }
}

void BCIModel::warmup() {
  if (!ctx_) return;

  std::vector<float> silentAudio(K_WARMUP_SAMPLE_COUNT, 0.0F);
  whisper_full_params params = toWhisperFullParams(cfg_);
  params.new_segment_callback = nullptr;
  params.new_segment_callback_user_data = nullptr;

  whisper_full(ctx_.get(), params,
               silentAudio.data(),
               static_cast<int>(silentAudio.size()));
}

void BCIModel::process(const Input& rawNeuralData) {
  if (ctx_ == nullptr) {
    throw std::runtime_error("BCI Whisper context is not initialized — call load() first");
  }

  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw std::runtime_error("Job cancelled");
  }

  QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
       "Processing neural signal (" +
           std::to_string(rawNeuralData.size()) + " bytes)");

  // Default day_idx = 0 matches NeuralProcessor::processToMel and the public
  // JS/TS docs. The reference fixtures in test/fixtures/manifest.json pass
  // day_idx=1 explicitly; callers that omit bciConfig get day 0.
  int dayIdx = 0;
  auto it = cfg_.bciConfig.find("day_idx");
  if (it != cfg_.bciConfig.end()) {
    if (auto* d = std::get_if<double>(&it->second)) {
      dayIdx = static_cast<int>(*d);
    } else if (auto* i = std::get_if<int>(&it->second)) {
      dayIdx = *i;
    }
  }

  if (neuralProcessor_.hasWeights()) {
    const int maxDay =
        static_cast<int>(neuralProcessor_.getNumDays()) - 1;
    if (maxDay >= 0 && (dayIdx < 0 || dayIdx > maxDay)) {
      QLOG(qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
           "day_idx " + std::to_string(dayIdx) +
               " is outside [0, " + std::to_string(maxDay) +
               "]; it will be clamped");
    }
  }

  auto melFeatures = neuralProcessor_.processToMel(rawNeuralData, dayIdx);
  const int melBins = neuralProcessor_.getMelBins();
  const int melFrames = neuralProcessor_.getMelFrames();

  processCalls_ += 1;

  whisper_reset_timings(ctx_.get());

  const auto startTime = std::chrono::steady_clock::now();

  EncoderCallbackData cbData;
  cbData.ctx = ctx_.get();
  cbData.melData = melFeatures.data();
  cbData.melFrames = melFrames;
  cbData.melBins = melBins;

  whisper_full_params params = toWhisperFullParams(cfg_);
  params.new_segment_callback = onNewSegment;
  params.new_segment_callback_user_data = this;
  params.abort_callback = shouldAbortWhisper;
  params.abort_callback_user_data = &cancelRequested_;
  params.encoder_begin_callback = onEncoderBegin;
  params.encoder_begin_callback_user_data = &cbData;

  if (dummyAudioPad_.size() != static_cast<size_t>(K_DUMMY_AUDIO_30S)) {
    dummyAudioPad_.assign(K_DUMMY_AUDIO_30S, 0.0F);
  }

  int result = whisper_full(
      ctx_.get(), params,
      dummyAudioPad_.data(), static_cast<int>(dummyAudioPad_.size()));

  const auto endTime = std::chrono::steady_clock::now();
  totalWallMs_ +=
      std::chrono::duration<double, std::milli>(endTime - startTime).count();

  if (auto* whisperTimings = whisper_get_timings(ctx_.get());
      whisperTimings != nullptr) {
    whisperSampleMs_ += whisperTimings->sample_ms;
    whisperEncodeMs_ += whisperTimings->encode_ms;
    whisperDecodeMs_ += whisperTimings->decode_ms;
    whisperBatchdMs_ += whisperTimings->batchd_ms;
    whisperPromptMs_ += whisperTimings->prompt_ms;
  }

  if (result != 0) {
    if (cancelRequested_.load(std::memory_order_relaxed)) {
      throw std::runtime_error("Job cancelled");
    }
    throw std::runtime_error(
        "Failed to process neural signal (whisper_full returned " +
        std::to_string(result) + ")");
  }
}

std::any BCIModel::process(const std::any& input) {
  AnyInput modelInput;
  if (auto* anyInput = std::any_cast<AnyInput>(
          const_cast<std::any*>(&input))) {
    modelInput = std::move(*anyInput);
  } else if (auto* inputVector = std::any_cast<Input>(
                 const_cast<std::any*>(&input))) {
    modelInput.input = std::move(*inputVector);
  } else {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        std::string("Invalid input type for BCIModel::process: ") +
            input.type().name());
  }

  const auto previousOutputCallback = on_segment_;
  const bool shouldOverrideCallback =
      static_cast<bool>(modelInput.outputCallback);
  if (shouldOverrideCallback) {
    on_segment_ = modelInput.outputCallback;
  }

  // Clear the cancel flag FIRST so a cancel() call that races with reset()
  // is not silently lost. process(Input&) still checks cancelRequested_ at
  // the top, so a cancel that arrives between these two statements aborts
  // the upcoming whisper_full call via shouldAbortWhisper.
  cancelRequested_.store(false, std::memory_order_relaxed);
  reset();
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

void BCIModel::saveLoadParams(const BCIConfig& config) {
  setConfig(config);
}

void BCIModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
}

bool BCIModel::configContextIsChanged(
    const BCIConfig& oldCfg, const BCIConfig& newCfg) {
  const std::vector<std::string> contextKeys = {
      "model", "use_gpu", "flash_attn", "gpu_device"};
  return std::ranges::any_of(contextKeys, [&](const std::string& key) {
    const auto oldIt = oldCfg.whisperContextCfg.find(key);
    const auto newIt = newCfg.whisperContextCfg.find(key);
    if (oldIt != oldCfg.whisperContextCfg.end() &&
        newIt != newCfg.whisperContextCfg.end()) {
      return oldIt->second != newIt->second;
    }
    return (oldIt != oldCfg.whisperContextCfg.end()) !=
           (newIt != newCfg.whisperContextCfg.end());
  });
}

void BCIModel::resetContext() { ctx_.reset(); }

void BCIModel::setConfig(const BCIConfig& config) {
  bool contextChanged = configContextIsChanged(cfg_, config);
  cfg_ = config;
  if (contextChanged) reload();
}

} // namespace qvac_lib_inference_addon_bci
