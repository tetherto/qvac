#include "model-interface/chatterbox/ChatterboxModel.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

#include <qvac-tts/chatterbox/engine.h>

#include "addon/TTSErrors.hpp"
#include "qvac-lib-inference-addon-cpp/Errors.hpp"

namespace qvac::ttsggml::chatterbox {

namespace {

using qvac_errors::createTTSError;
using qvac_errors::StatusError;
using qvac_errors::tts_error::TTSErrorCode;
namespace general_error = qvac_errors::general_error;

qvac_tts::chatterbox::EngineOptions toEngineOptions(const ChatterboxConfig& cfg) {
  qvac_tts::chatterbox::EngineOptions opts;
  opts.t3_gguf_path    = cfg.t3ModelPath;
  opts.s3gen_gguf_path = cfg.s3genModelPath;
  opts.reference_audio = cfg.referenceAudio;
  opts.voice_dir       = cfg.voiceDir;
  if (cfg.seed.has_value())    opts.seed         = *cfg.seed;
  if (cfg.threads.has_value()) opts.n_threads    = *cfg.threads;
  if (cfg.nGpuLayers.has_value()) {
    opts.n_gpu_layers = *cfg.nGpuLayers;
  } else if (cfg.useGpu) {
    opts.n_gpu_layers = 99;
  }
  if (cfg.streamChunkTokens.has_value())      opts.stream_chunk_tokens       = *cfg.streamChunkTokens;
  if (cfg.streamFirstChunkTokens.has_value()) opts.stream_first_chunk_tokens = *cfg.streamFirstChunkTokens;
  if (cfg.streamCfmSteps.has_value())         opts.stream_cfm_steps          = *cfg.streamCfmSteps;
  return opts;
}

std::vector<int16_t> pcmFloatToInt16(const float* pcm, size_t samples) {
  std::vector<int16_t> out;
  out.resize(samples);
  for (size_t i = 0; i < samples; ++i) {
    float s = std::clamp(pcm[i], -1.0f, 1.0f);
    out[i] = static_cast<int16_t>(std::lround(s * 32767.0f));
  }
  return out;
}

std::vector<int16_t> pcmFloatToInt16(const std::vector<float>& pcm) {
  return pcmFloatToInt16(pcm.data(), pcm.size());
}

} // namespace

ChatterboxModel::ChatterboxModel(ChatterboxConfig config)
    : cfg_(std::move(config)) {
  validateConfig(cfg_);
  load();
}

ChatterboxModel::~ChatterboxModel() noexcept = default;

void ChatterboxModel::validateConfig(const ChatterboxConfig& cfg) {
  if (cfg.t3ModelPath.empty()) {
    throw StatusError(general_error::InvalidArgument, "t3ModelPath is required");
  }
  if (cfg.s3genModelPath.empty()) {
    throw StatusError(general_error::InvalidArgument, "s3genModelPath is required");
  }
  if (!std::filesystem::exists(cfg.t3ModelPath)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "t3 model not found: " + cfg.t3ModelPath);
  }
  if (!std::filesystem::exists(cfg.s3genModelPath)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "s3gen model not found: " + cfg.s3genModelPath);
  }
  if (!cfg.referenceAudio.empty() &&
      !std::filesystem::exists(cfg.referenceAudio)) {
    throw createTTSError(TTSErrorCode::ModelFileNotFound, "reference audio not found: " + cfg.referenceAudio);
  }
  if (!cfg.voiceDir.empty()) {
    if (!std::filesystem::exists(cfg.voiceDir)) {
      throw createTTSError(TTSErrorCode::ModelFileNotFound, "voice dir not found: " + cfg.voiceDir);
    }
    if (!std::filesystem::is_directory(cfg.voiceDir)) {
      throw StatusError(
          general_error::InvalidArgument,
          "voiceDir path exists but is not a directory: " + cfg.voiceDir);
    }
  }
  // The current Chatterbox GGUF only supports English.  Reject anything
  // else at construction time instead of silently running in English —
  // this makes the mismatch loud for callers who pass a non-"en" locale
  // expecting multilingual behaviour (landing with a later port).
  if (!cfg.language.empty() && cfg.language != "en") {
    throw StatusError(
        general_error::InvalidArgument,
        "language '" + cfg.language + "' is not supported by the current "
        "Chatterbox GGUF; only 'en' is available today");
  }
}

void ChatterboxModel::load() {
  std::lock_guard lk(engineMu_);
  loadLocked();
}

void ChatterboxModel::unload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
}

void ChatterboxModel::reload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
  loadLocked();
}

void ChatterboxModel::loadLocked() {
  if (engine_) return;
  try {
    engine_ = std::make_shared<qvac_tts::chatterbox::Engine>(toEngineOptions(cfg_));
  } catch (const std::exception& e) {
    engine_.reset();
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        std::string("ChatterboxModel::load: ") + e.what());
  }
}

void ChatterboxModel::unloadLocked() {
  engine_.reset();
}

void ChatterboxModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
  // Grab a local copy of engine_ under the lock so we can invoke
  // cancel() safely even if another thread calls unload()/reload() in
  // parallel.  The Engine itself is responsible for making cancel()
  // thread-safe against its in-flight synthesize().
  std::shared_ptr<qvac_tts::chatterbox::Engine> e;
  {
    std::lock_guard lk(engineMu_);
    e = engine_;
  }
  if (e) e->cancel();
}

ChatterboxModel::Output ChatterboxModel::synthesize(
    const std::string& text, const ChunkCallback& chunkCallback) {
  // Capture the engine under the lock; keep it alive for the duration
  // of synthesize() via the local `engine` shared_ptr even if reload()
  // concurrently swaps a new one in.  Reload's new engine takes effect
  // on the NEXT synthesize call.
  std::shared_ptr<qvac_tts::chatterbox::Engine> engine;
  {
    std::lock_guard lk(engineMu_);
    engine = engine_;
  }
  if (!engine) {
    throw createTTSError(TTSErrorCode::ModelNotLoaded,
                         "ChatterboxModel::synthesize: engine not loaded");
  }
  if (cancelRequested_.load(std::memory_order_relaxed)) {
    throw createTTSError(TTSErrorCode::SynthesisFailed,
                         "synthesis cancelled before it started");
  }

  const auto tStart = std::chrono::steady_clock::now();

  qvac_tts::chatterbox::SynthesisResult result;
  try {
    if (chunkCallback && engine->options().stream_chunk_tokens > 0) {
      result = engine->synthesize(
          text,
          [&chunkCallback](const float* pcm, std::size_t samples,
                           int chunkIndex, bool isLast) {
            chunkCallback(pcmFloatToInt16(pcm, samples), chunkIndex, isLast);
          });
    } else {
      result = engine->synthesize(text);
    }
  } catch (const std::exception& e) {
    throw createTTSError(TTSErrorCode::SynthesisFailed,
                         std::string("engine.synthesize: ") + e.what());
  }

  std::vector<int16_t> pcm = pcmFloatToInt16(result.pcm);

  const auto tEnd = std::chrono::steady_clock::now();
  const double elapsedSec =
      std::chrono::duration<double>(tEnd - tStart).count();

  totalTime_ = elapsedSec;
  totalSamples_ = static_cast<int64_t>(pcm.size());
  audioDurationMs_ = result.sample_rate > 0
      ? (static_cast<double>(pcm.size()) * 1000.0 /
         static_cast<double>(result.sample_rate))
      : 0.0;
  realTimeFactor_ =
      audioDurationMs_ > 0 ? (elapsedSec * 1000.0) / audioDurationMs_ : 0.0;
  textLength_ = text.size();
  tokensPerSecond_ =
      elapsedSec > 0 ? static_cast<double>(textLength_) / elapsedSec : 0.0;

  return pcm;
}

std::any ChatterboxModel::process(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (anyInput == nullptr) {
    throw StatusError(
        general_error::InvalidArgument,
        "ChatterboxModel::process: expected AnyInput (text + chunkCallback)");
  }
  if (anyInput->text.empty()) {
    throw StatusError(
        general_error::InvalidArgument, "ChatterboxModel::process: empty text");
  }

  // Serialize concurrent process() calls.  The outer JobRunner already
  // queues jobs sequentially, but a direct C++ caller (or a future
  // pipeline that bypasses JobRunner) could still overlap — fail fast
  // with a clear error instead of data-racing on engine_ state.
  bool expected = false;
  if (!jobInProgress_.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel)) {
    throw StatusError(
        general_error::InvalidArgument,
        "ChatterboxModel::process: another synthesis job is already in progress");
  }
  struct InProgressGuard {
    std::atomic_bool& flag;
    ~InProgressGuard() { flag.store(false, std::memory_order_release); }
  } guard{jobInProgress_};

  cancelRequested_.store(false, std::memory_order_relaxed);
  auto pcm = synthesize(anyInput->text, anyInput->chunkCallback);
  // Streaming mode: chunks have already been published via chunkCallback
  // → OutputQueue.  Returning the concatenated PCM here would cause a
  // duplicate final `outputArray` event after all the chunks.  Return an
  // empty std::any so no output handler matches — JobRunner still emits
  // JobEnded with runtimeStats on its own.
  const bool streaming =
      anyInput->chunkCallback &&
      engine_ &&
      engine_->options().stream_chunk_tokens > 0;
  if (streaming) return {};
  return std::any(std::move(pcm));
}

qvac_lib_inference_addon_cpp::RuntimeStats ChatterboxModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("tokensPerSecond", tokensPerSecond_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("totalSamples", totalSamples_);
  return stats;
}

} // namespace qvac::ttsggml::chatterbox
