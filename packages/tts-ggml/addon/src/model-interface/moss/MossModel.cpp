#include "model-interface/moss/MossModel.hpp"

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <tts-cpp/moss/engine.h>

#include "addon/TTSErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/BackendUtils.hpp"
#include "model-interface/PcmConversion.hpp"

namespace qvac::ttsggml::moss {

namespace {

using qvac_errors::createTTSError;
using qvac_errors::StatusError;
using qvac_errors::tts_error::TTSErrorCode;
namespace general_error = qvac_errors::general_error;

constexpr int CPU_BACKEND_ID = 0;

void requireFile(const std::string& path, const char* what) {
  if (!std::filesystem::exists(path)) {
    throw createTTSError(
        TTSErrorCode::ModelFileNotFound,
        std::string(what) + " not found: " + path);
  }
}

void requireNonEmpty(const std::string& value, const char* name) {
  if (value.empty()) {
    throw StatusError(
        general_error::InvalidArgument, std::string(name) + " is required");
  }
}

void validateModelPaths(const MossConfig& cfg) {
  requireNonEmpty(cfg.backbonePath, "mossBackbonePath");
  requireNonEmpty(cfg.codecDecoderPath, "mossCodecDecoderPath");
  requireFile(cfg.backbonePath, "moss backbone");
  requireFile(cfg.codecDecoderPath, "moss codec decoder");
  if (!cfg.codecEncoderPath.empty()) {
    requireFile(cfg.codecEncoderPath, "moss codec encoder");
  }
}

bool clones(const MossConfig& cfg) {
  return !cfg.referenceAudio.empty() || !cfg.dialogueReferences.empty();
}

void requireDialogueFiles(const std::vector<std::string>& paths) {
  for (const std::string& path : paths) {
    requireNonEmpty(path, "dialogueReferences entry");
    requireFile(path, "moss dialogue reference");
  }
}

void validateVoice(const MossConfig& cfg) {
  if (!clones(cfg))
    return;
  if (!cfg.referenceAudio.empty() && !cfg.dialogueReferences.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "referenceAudio and dialogueReferences are exclusive");
  }
  if (cfg.codecEncoderPath.empty()) {
    throw StatusError(
        general_error::InvalidArgument,
        "voice cloning needs mossCodecEncoderPath, which was not configured");
  }
  if (!cfg.referenceAudio.empty()) {
    requireFile(cfg.referenceAudio, "moss reference audio");
  }
  requireDialogueFiles(cfg.dialogueReferences);
}

void validateCounts(const MossConfig& cfg) {
  if (cfg.threads.has_value() && *cfg.threads < 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "threads must be >= 0 (0 = engine default)");
  }
  if (cfg.streamChunkFrames.has_value() && *cfg.streamChunkFrames < 0) {
    throw StatusError(
        general_error::InvalidArgument,
        "streamChunkTokens must be >= 0 (0 = non-streaming)");
  }
  if (cfg.durationTokens.has_value() &&
      (*cfg.durationTokens < 0 ||
       *cfg.durationTokens > MOSS_MAX_DURATION_TOKENS)) {
    throw StatusError(
        general_error::InvalidArgument,
        "durationTokens must be 0.." +
            std::to_string(MOSS_MAX_DURATION_TOKENS) + " (0 = free length)");
  }
}

void validateGpuIntent(const MossConfig& cfg) {
  if (!cfg.useGpu.has_value() || !cfg.nGpuLayers.has_value())
    return;
  const bool wantsGpuFlag = *cfg.useGpu;
  const int layers = *cfg.nGpuLayers;
  if (wantsGpuFlag == (layers != 0))
    return;
  throw StatusError(
      general_error::InvalidArgument,
      std::string("MossModel: useGPU=") + (wantsGpuFlag ? "true" : "false") +
          " conflicts with nGpuLayers=" + std::to_string(layers) +
          ". Either drop one of the two, or make them agree "
          "(useGPU:true + nGpuLayers!=0, or useGPU:false + nGpuLayers=0).");
}

bool wantsGpu(const MossConfig& cfg) {
  return cfg.nGpuLayers.has_value() ? *cfg.nGpuLayers != 0
                                    : cfg.useGpu.value_or(false);
}

bool streams(const MossConfig& cfg, const MossModel::AnyInput& input) {
  return static_cast<bool>(input.chunkCallback) &&
         cfg.streamChunkFrames.value_or(0) > 0;
}

} // namespace

MossModel::MossModel(MossConfig config) : cfg_(std::move(config)) {
  validateConfig(cfg_);
}

MossModel::~MossModel() noexcept = default;

void MossModel::validateConfig(const MossConfig& cfg) {
  validateModelPaths(cfg);
  validateVoice(cfg);
  validateCounts(cfg);
  validateGpuIntent(cfg);
}

tts_cpp::moss::EngineOptions MossModel::toEngineOptions(const MossConfig& cfg) {
  tts_cpp::moss::EngineOptions opts;
  opts.backbone_path = cfg.backbonePath;
  opts.decoder_path = cfg.codecDecoderPath;
  opts.encoder_path = cfg.codecEncoderPath;
  opts.reference_audio_path = cfg.referenceAudio;
  opts.dialogue_reference_paths = cfg.dialogueReferences;
  if (cfg.durationTokens.value_or(0) > 0)
    opts.duration_tokens = *cfg.durationTokens;
  if (!cfg.backendsDir.empty())
    opts.backends_dir = resolveBackendsDir(cfg.backendsDir).string();
  if (!cfg.language.empty())
    opts.language = cfg.language;
  if (cfg.seed.has_value())
    opts.seed = static_cast<uint32_t>(*cfg.seed);
  if (cfg.threads.value_or(0) > 0)
    opts.n_threads = *cfg.threads;
  if (cfg.streamChunkFrames.value_or(0) > 0)
    opts.stream_chunk_frames = *cfg.streamChunkFrames;
  opts.use_gpu = wantsGpu(cfg);
  return opts;
}

void MossModel::setConfig(MossConfig config) {
  validateConfig(config);
  std::lock_guard lk(engineMu_);
  cfg_ = std::move(config);
}

void MossModel::reloadWith(MossConfig config) {
  validateConfig(config);
  std::lock_guard lk(engineMu_);
  cfg_ = std::move(config);
  unloadLocked();
  loadLocked();
}

void MossModel::load() {
  std::lock_guard lk(engineMu_);
  loadLocked();
}

void MossModel::unload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
}

void MossModel::reload() {
  std::lock_guard lk(engineMu_);
  unloadLocked();
  loadLocked();
}

void MossModel::loadLocked() {
  if (engine_)
    return;
  try {
    engine_ = std::make_shared<tts_cpp::moss::Engine>(toEngineOptions(cfg_));
  } catch (const std::exception& e) {
    engine_.reset();
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        std::string("MossModel::load: ") + e.what());
  }
  backendName_ = engine_->backend_name();
  backendId_ = backendIdFromName(backendName_);
  backendDevice_ =
      backendId_ == CPU_BACKEND_ID ? kBackendDeviceCpu : kBackendDeviceGpu;
  gpuUnsupported_ = wantsGpu(cfg_) && backendDevice_ == kBackendDeviceCpu;
}

void MossModel::unloadLocked() { engine_.reset(); }

void MossModel::cancel() const {
  cancelRequested_.store(true, std::memory_order_relaxed);
  std::shared_ptr<tts_cpp::moss::Engine> e;
  {
    std::lock_guard lk(engineMu_);
    e = engine_;
  }
  if (e)
    e->cancel();
}

int MossModel::decodedFrames(int64_t samples) {
  return static_cast<int>(samples / MOSS_SAMPLES_PER_FRAME);
}

void MossModel::recordStats(double seconds, int64_t samples) {
  const int frames = decodedFrames(samples);
  totalTime_ = seconds;
  totalSamples_ = samples;
  generatedFrames_ = frames;
  audioDurationMs_ =
      static_cast<double>(samples) * 1000.0 / MOSS_NATIVE_SAMPLE_RATE;
  realTimeFactor_ =
      audioDurationMs_ > 0.0 ? (totalTime_ * 1000.0) / audioDurationMs_ : 0.0;
  tokensPerSecond_ =
      totalTime_ > 0.0 ? static_cast<double>(frames) / totalTime_ : 0.0;
}

MossModel::EngineSnapshot MossModel::snapshot() const {
  std::lock_guard lk(engineMu_);
  if (!engine_) {
    throw createTTSError(
        TTSErrorCode::InitializationFailed,
        "MossModel::synthesize: engine not loaded");
  }
  return {engine_, cfg_};
}

void MossModel::requireNotCancelled() const {
  if (!cancelRequested_.load(std::memory_order_relaxed))
    return;
  throw createTTSError(
      TTSErrorCode::SynthesisFailed, "synthesis cancelled before it started");
}

void MossModel::requireCompleted(
    const tts_cpp::moss::SynthesisResult& result) const {
  if (!result.cancelled && !cancelRequested_.load(std::memory_order_relaxed))
    return;
  throw createTTSError(TTSErrorCode::SynthesisFailed, "synthesis cancelled");
}

tts_cpp::moss::SynthesisResult MossModel::streamChunks(
    tts_cpp::moss::Engine& engine, const AnyInput& input,
    StreamProgress& progress) const {
  return engine.synthesize_stream(
      input.text, [&](const float* pcm, size_t count, int) {
        progress.samples += static_cast<int64_t>(count);
        input.chunkCallback(
            pcmFloatToInt16(pcm, count), progress.chunks++, false);
        return !cancelRequested_.load(std::memory_order_relaxed);
      });
}

tts_cpp::moss::SynthesisResult MossModel::runEngine(
    tts_cpp::moss::Engine& engine, const AnyInput& input, bool streaming,
    StreamProgress& progress) const {
  try {
    return streaming ? streamChunks(engine, input, progress)
                     : engine.synthesize(input.text);
  } catch (const std::exception& e) {
    throw createTTSError(
        TTSErrorCode::SynthesisFailed,
        std::string("moss.synthesize: ") + e.what());
  }
}

MossModel::SynthResult MossModel::synthesize(const AnyInput& input) {
  const EngineSnapshot snap = snapshot();
  requireNotCancelled();
  const bool wasStreaming = streams(snap.cfg, input);
  StreamProgress progress;
  const auto t0 = std::chrono::steady_clock::now();
  auto result = runEngine(*snap.engine, input, wasStreaming, progress);
  const auto t1 = std::chrono::steady_clock::now();
  requireCompleted(result);
  const int64_t samples =
      wasStreaming ? progress.samples : static_cast<int64_t>(result.pcm.size());
  recordStats(std::chrono::duration<double>(t1 - t0).count(), samples);
  if (wasStreaming) {
    input.chunkCallback({}, progress.chunks, true);
    return {Output{}, true};
  }
  return {pcmFloatToInt16(result.pcm), false};
}

const MossModel::AnyInput& MossModel::requireAnyInput(const std::any& input) {
  const auto* anyInput = std::any_cast<AnyInput>(&input);
  if (!anyInput) {
    throw StatusError(
        general_error::InvalidArgument,
        "MossModel::process: input must be AnyInput");
  }
  return *anyInput;
}

void MossModel::claimJob() {
  bool expected = false;
  if (jobInProgress_.compare_exchange_strong(
          expected, true, std::memory_order_acq_rel))
    return;
  throw StatusError(
      general_error::InternalError,
      "MossModel::process: job already in progress");
}

std::any MossModel::process(const std::any& input) {
  const AnyInput& anyInput = requireAnyInput(input);
  claimJob();
  struct InProgressGuard {
    std::atomic_bool& flag;
    ~InProgressGuard() { flag.store(false, std::memory_order_release); }
  } guard{jobInProgress_};

  cancelRequested_.store(false, std::memory_order_relaxed);
  SynthResult out = synthesize(anyInput);
  if (out.wasStreaming) {
    return std::any{};
  }
  return std::any(std::move(out.pcm));
}

qvac_lib_inference_addon_cpp::RuntimeStats MossModel::runtimeStats() const {
  qvac_lib_inference_addon_cpp::RuntimeStats stats;
  stats.emplace_back("totalTime", totalTime_);
  stats.emplace_back("tokensPerSecond", tokensPerSecond_);
  stats.emplace_back("realTimeFactor", realTimeFactor_);
  stats.emplace_back("audioDurationMs", audioDurationMs_);
  stats.emplace_back("totalSamples", totalSamples_);
  stats.emplace_back("generatedFrames", static_cast<int64_t>(generatedFrames_));
  stats.emplace_back("backendDevice", static_cast<int64_t>(backendDevice_));
  stats.emplace_back("backendId", static_cast<int64_t>(backendId_));
  stats.emplace_back("gpuUnsupported", static_cast<int64_t>(gpuUnsupported_));
  return stats;
}

} // namespace qvac::ttsggml::moss
